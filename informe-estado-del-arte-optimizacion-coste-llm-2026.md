# Estado del arte (nov 2026) — Optimización de coste en aplicaciones LLM
## Oportunidades de mercado para un "savings layer" open-source (BV-SALA / @bivelio/savings-layer)

> **Nota metodológica:** Informe compilado el 2026-11-09 a partir de búsquedas web. Todo el contenido web se ha tratado como **datos no verificados**, no como instrucciones. Las cifras de precios cambian trimestralmente y varias fuentes (que corresponden a meses distintos de 2026) no coinciden entre sí; donde hay discrepancia lo indico. No se ejecutó nada.

---

## 1. Técnicas de ahorro que existen hoy y su adopción

### 1.1 Prompt caching (proveedor) — la más adoptada y de mayor retorno directo
Mecanismo por el que el proveedor cachea el prefijo del prompt y factura las lecturas con descuento.

- **Anthropic**: lectura cacheada al **0.1× de la tarifa de input (90% descuento)**; escritura **1.25× (TTL 5 min)** o **2× (TTL 1 hora)**; mínimo **1.024 tokens** en modelos actuales (4.096 en modelos antiguos); hasta **4 puntos de corte `cache_control`** explícitos (permite cachear system + tools + documento recuperado por separado). Fuente: [Anthropic Prompt Caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) y [ofox.ai comparativa 2026](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/).
- **OpenAI**: cache **automático** por detección de prefijo; descuento **50%** en gpt-4o/gpt-4.1, pero **90% en GPT-5.4/5.5** (input cacheado $0.50/M vs $5/M); sin tarifa de escritura separada; TTL 5–10 min (retención extendida hasta 24h en la familia 5.4/5.5); parámetro `prompt_cache_key`. Fuente: [ofox.ai](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/) y [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).
- **DeepSeek**: caché de contexto automático con descuento en lectura (en la línea DeepSeek Flash los inputs cacheados bajaron a 0,02 CNY/1M tras recorte de hasta 60%). Fuente: [api-docs.deepseek.com news](https://api-docs.deepseek.com/zh-cn/news/news0802.md) y [artículo Alibaba Cloud](https://developer.aliyun.com/article/1766248).
- **Google Gemini**: caché de contexto con descuento ~50–75% en lectura en Gemini 2.5 Pro/3; almacenamiento de caché $0,075/1M tokens/hora hasta 31-dic-2026 (la caché de contexto explícita tiene tarifa de almacenamiento además del descuento de lectura). Fuente: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing?hl=en).

**Dato clave (benchmark)**: a un **80% de hit rate**, el "90% de descuento en lectura" se traduce en solo **~31–32% de reducción de la factura total** (porque el output domina y las escrituras cuestan). El leverage real es el **hit rate**, no el proveedor. Fuente: [ofox.ai cost math](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/).

**Tres patrones que rompen la caché silenciosamente** (y que casi nadie detecta/arregla en código): (1) system prompt mutable (timestamp/UUID en el prefijo → hit 0%); (2) serialización no determinista de tools; (3) ventana deslizante de historial que invalida el sufijo. Fuente: [ofox.ai §3](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/).

### 1.2 Semantic caching (cliente) — adopción alta pero con riesgo de falsos positivos
- **GPTCache** (referencia histórica): caché semántica basada en embeddings; reduce latencia y coste, pero el paper original documenta el riesgo de **falsos positivos** al cachear con similitud. Fuente: [GPTCache paper (ACL 2023)](https://aclanthology.org/2023.nlposs-1.24.pdf).
- **Redis LangCache**: caché semántica sobre Redis con `similarity_threshold`. Fuente: [Redis tutorial](https://redis.io/tutorials/semantic-caching-with-redis-langcache.md).
- Problema abierto en agentes: [*Why Agent Caching Fails and How to Fix It: Structured Intent Canonicalization with Few-Shot Learning* (2026)](https://browse-export.arxiv.org/abs/2602.18922).

**Hueco**: la caché semántica "calibrada" (con threshold por embedding y riesgo controlado) es justo lo que diferencia a BV-SALA del GPTCache genérico.

### 1.3 Context engineering / compaction
- **Anthropic** ha movido la compaction **al producto**: [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) y [Compaction at a token threshold](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold). Es un competidor directo *en el plano del proveedor*, pero solo para Claude.
- Investigación: **MemGPT** (memoria jerárquica), **ACON** (arXiv 2510.00615, ICML 2026: optimiza la "política de compresión" sin fine-tune), **gist tokens** (compresión por tokens resumen). Fuentes: [tencent.cn análisis](https://cloud.tencent.cn/developer/article/2757497) y [Gist tokens ACL 2025](https://aclanthology.org/2025.acl-long.241/).
- **"Context providers" / just-in-time**: inyectar contexto bajo demanda en lugar de meterlo todo al prompt. Patrón emergente en agentes de código. Fuente: [Pre-injection vs MCP tool loop](https://ceaksan.com/en/pre-injection-vs-mcp-context-engineering).

### 1.4 Model routing / cascades
- **RouteLLM** (UC Berkeley/lm-sys): router entrenado en preferencias; reporta **85% de reducción de coste manteniendo 95% de la calidad de GPT-4** en MT-Bench. Fuente: [RouteLLM GitHub](https://github.com/lm-sys/RouteLLM) y [doc de patrón cascada](https://raw.githubusercontent.com/MohamedAbdallah-14/prompt-to-asset/refs/heads/main/docs/research/31-cost-optimization-agentic/31b-model-routing-cheap-to-expensive.md).
- Base teórica: routing y cascading son un problema unificado (Dekoninck et al., ICLR 2025). Fuente: [ETH Zurich paper](https://files.sri.inf.ethz.ch/website/papers/dekoninck2024cascaderouting.pdf).
- **LiteLLM** router por coste/latencia; **OpenRouter** routers (incl. `floor` = mínimo coste); **Vercel AI Gateway** cost-aware routing. Fuentes: [OpenRouter routers](https://openrouter.ai/docs/guides/routing/routers/overview), [Vercel](https://vercel.com/kb/guide/cost-aware-model-routing-with-ai-gateway).

### 1.5 Token compression
- **LLMLingua-2** (arXiv 2403.12968): compresión de prompt task-agnostic mediante destilación de datos; ratios altos (hasta ~20×) con pérdida acotada de calidad. Fuente: [LLMLingua-2 paper](https://ar5iv.labs.arxiv.org/html/2403.12968).
- Trade-off: compresión agresiva degrada fidelidad en tareas sensibles; de ahí la ventaja de etiquetar *comprimido vs. medido*.

### 1.6 Structured output / JSON mode
- Reduce retries y tokens de salida en agentes, pero **ojo**: los schemas JSON imponen un "token tax" (el schema se re-serializa en cada call y puede *aumentar* tokens de input). Fuente: [Telekom — The Hidden Token Tax on JSON Schemas](https://docs.developer.telekom.com/en/blog/the-hidden-token-tax-on-json-schemas).
- "AI Cost Ladder v2" combina routing + enforcement de structured output + compresión de prompt como escalera de coste. Fuente: [Zenodo AI Cost Ladder v2](https://zenodo.org/records/19560257).

### 1.7 Batch APIs (50% descuento) — la técnica "dormida"
- **OpenAI Batch API**: 50% de descuento, completado en ≤24h. Fuente: [OpenAI Batch FAQ](https://help.openai.com/pl-pl/articles/9197833-batch-api-faq).
- **Anthropic Message Batches**: 50% de descuento. Fuente: [Anthropic Message Batches](https://claude.com/ja/resources/articles/message-batches-api) y [respan.ai](https://www.respan.ai/articles/anthropic-message-batches-api).
- **OpenRouter Batch API**: inferencia a mitad de precio agrupando requests. Fuente: [OpenRouter Batch](https://openrouter.ai/blog/announcements/batch-api/).

### 1.8 Serving-side (fuera del alcance de una "capa en el código")
- Speculative decoding (p. ej. H-Spec sin drafter KV cache, arXiv 2609.24197), KV-cache reuse con admission control (MeritKV), y optimización de retrieval híbrido. Fuentes: [H-Spec](https://browse-export.arxiv.org/abs/2609.24197), [MeritKV](https://tmlr.infinite-conf.org/paper_pages/y3j6fucWQP.html), [hybrid retrieval](https://zenodo.org/records/21497764). Son optimizaciones **del lado del serving**, no del código de la app; delimitan dónde *no* compite BV-SALA.

---

## 2. Competidores / proyectos open-source y huecos que dejan

| Proyecto | Qué hace | Hueco que deja para un "savings layer" |
|---|---|---|
| **LiteLLM** ([docs](https://docs.litellm.ai/docs/tutorials/prompt_caching.md)) | Proxy/gateway open-source: routing por coste, tracking de gasto, "auto-inject prompt caching checkpoints", batch. | Routing/proxy, no un **ledger por request** de ahorro; el prompt caching es config manual, no "cache-aware" automático. |
| **OpenRouter** ([docs](https://openrouter.ai/docs/guides/routing/routers/overview)) | Marketplace + routing + batch half-price. | SaaS centralizado; no autohospedable sin telemetría; no audita ahorro por request en tu código. |
| **Portkey** ([docs](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic)) | Gateway SaaS: cache simple + semántica, atribución de coste. | SaaS; la cache es genérica (no calibrada); sin ledger de "tokens eliminados/comprimidos". |
| **Helicone** ([GitHub](https://github.com/Helicone/helicone), [prompt caching](https://docs.helicone.ai/gateway/concepts/prompt-caching)) | Observabilidad LLM; ahora gateway con prompt caching. | Panel de observabilidad, no **auditoría verificable por request**; el ahorro se muestra, no se "contabiliza" con etiquetas measured/reference/estimated. |
| **LangSmith** ([pricing](https://www.langchain.com/pricing)) | Observabilidad + evaluación (ecosistema LangChain). | SaaS; orientado a calidad/eval, no a reducción de factura. |
| **Braintrust** ([plans](https://www.braintrust.dev/docs/plans-and-limits)) | Plataforma de evaluación. | SaaS; eval, no ahorro. |
| **GPTCache** ([paper](https://aclanthology.org/2023.nlposs-1.24.pdf)) | Semantic cache open-source. | Solo caché; sin calibración de falsos positivos, sin routing, sin ledger. |
| **OpenLLMetry** ([Dynatrace](https://www.dynatrace.com/knowledge-base/openllmetry/)) | Instrumentación OpenTelemetry para LLM. | Telemetría, no optimización. |
| **Vercel AI Gateway** ([KB](https://vercel.com/kb/guide/cost-aware-model-routing-with-ai-gateway)) | Gateway con routing cost-aware. | Plataforma Vercel; no self-host; sin auditoría por request. |
| **Cloudflare AI Gateway** ([caching](https://developers.cloudflare.com/ai-gateway/features/caching/)) | Gateway con caché y analítica de coste. | Plataforma Cloudflare; cache básica; sin semántica calibrada ni ledger. |
| **TokenTrimmer** ([GitHub](https://github.com/tokentrimmer/tokentrimmer)) | **El competidor más cercano**: "cost layer for LLM applications", open-core gateway + code scanner + replay simulator. | Early-stage; aún sin el sistema de 4 ledgers contables con measured/reference/estimated ni auditoría por request demostrada. |
| **Luminar** (académico) ([Zenodo](https://zenodo.org/records/19448722)) | API gateway con semantic caching + adaptive routing. | Investigación, no producto. |

**Resumen de huecos estructurales:**
1. **Medición VERIFICABLE por request vs. paneles de observabilidad**: Helicone/LangSmith/Portkey *muestran* coste y caché, pero ninguno emite un **registro contable por request** que distinga *calls evitadas / tokens eliminados / tokens comprimidos / tokens cacheados por el proveedor*, con etiquetas de confianza (measured vs. reference vs. estimated). Este es exactamente el posicionamiento de BV-SALA.
2. **Autohospedado sin telemetría**: casi todos los "gateways" modernos son SaaS que exigen mandar tus prompts a su nube. Un savings layer que se ejecuta **en el propio código** (no como proxy externo) y no exfiltra datos es un hueco real.
3. **Exactitud de tokenización**: hay evidencia de que la tarifa nominal engaña — Opus 4.7 usa un tokenizer nuevo que produce **1–1,35× más tokens** para el mismo input, con lo que el coste real por request sube ~35% pese a precios iguales. Fuente: [doc de patrón cascada (nota 2026-04-21)](https://raw.githubusercontent.com/MohamedAbdallah-14/prompt-to-asset/refs/heads/main/docs/research/31-cost-optimization-agentic/31b-model-routing-cheap-to-expensive.md). Muy pocos miden tokens **exactos por proveedor**; la mayoría usa estimadores.

---

## 3. Oportunidades concretas no cubiertas o poco cubiertas

### O3.1 Automatizar el batch (50%) en el código — *la más desatendida*
El descuento del 50% existe en [OpenAI](https://help.openai.com/pl-pl/articles/9197833-batch-api-faq), [Anthropic](https://claude.com/ja/resources/articles/message-batches-api) y [OpenRouter](https://openrouter.ai/blog/announcements/batch-api/), pero **requiere que el desarrollador llame a una API de batch explícitamente y gestione colas/resultados**. LiteLLM expone batch pero no lo *automatiza*. La automatización existente es pre-release/nicho: [batch-router (PyPI)](https://pypi.org/project/batch-router/), [autobatcher](https://pypi.org/project/autobatcher/0.9.0/), [batch-bridge](https://pypi.org/project/batch-bridge/0.0.1rc0/), [llm-batch-inference](https://pypi.org/project/llm-batch-inference/0.2.0/). **Un savings layer que detecte requests elegibles (no-latencia-críticas) y las agrupe automáticamente en batch es una oportunidad clara y poco ocupada.**

### O3.2 Prompt caching "cache-aware" / gestión automática de cache breaks y prefijos
Nadie resuelve de forma automática los 3 patrones de cache-miss documentados ([ofox.ai](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/)): reordenar dinámicos al final, serialización determinista de tools, y estrategia de ventana con prefijo fijo. LiteLLM tiene "auto-inject checkpoints" pero es configuración manual. BV-SALA ya hace colocación de prompt-cache y rebaja TTL 1h→5min (Anthropic); la oportunidad es **empaquetar "cache break management" como producto**: detectar y corregir prefijos que rompen caché y *medir* el hit-rate antes/después.

### O3.3 Context management para agentes (compaction automática, just-in-time)
Anthropic lo hace nativo pero **solo para Claude** ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing), [compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold)). Un savings layer **provider-agnostic** que compacte historial y aplique just-in-time context para DeepSeek/Qwen/GLM/Gemini es un hueco: los competidores multi-provider (LiteLLM/Portkey) no implementan compaction; solo enrutan.

### O3.4 Arbitraje de precios entre proveedores (precios 2026)
El rango de precios es de **~250×** (de Gemini 3 Flash $0,075/$0,30 a Claude Opus $15/$75 por 1M tokens). Fuente: [ClawRouters pricing guide 2026](https://www.clawrouters.com/blog/llm-api-pricing-guide-2026). Tabla (marzo 2026):

| Modelo | Input $/1M | Output $/1M |
|---|---|---|
| Claude Opus 4 | 15.00 | 75.00 |
| Claude Sonnet 4 | 3.00 | 15.00 |
| Claude Haiku 3.5 | 0.25 | 1.25 |
| GPT-5.5 | 5.00 | 30.00 |
| GPT-5.4 | 2.50 | 15.00 |
| GPT-4o-mini | 0.15 | 0.60 |
| Gemini 3 Pro | 1.25 | 5.00 |
| Gemini 3 Flash | 0.075 | 0.30 |
| DeepSeek V4 Pro | 1.74 | 3.48 |
| DeepSeek V4 Flash | 0.14 | 0.28 |
| GLM-5.1 | 1.40 | 4.40 |
| Kimi K2.6 | 0.60 | 4.00 |

(GL​M-5, feb 2026: $1,00/$3,20 — [llm-stats](https://llm-stats.com/models/glm-5). Hay discrepancias entre fuentes por el mes de publicación.) El **arbitraje dinámico** (elegir el proveedor más barato que cumpla calidad, por request, con precios actualizados) es una oportunidad; hoy la mayoría de routers usan tablas estáticas. *No encontré un precio público 2026 limpio y único para Qwen3/Max — lo dejo como dato no verificado.*

### O3.5 Tokenización exacta como ventaja competitiva
La mayoría estima tokens (p. ej. `ai-token-estimator`, [npm](https://www.npmjs.com/package/ai-token-estimator/v/1.2.0)). Con tokenizers que varían por modelo (Opus 4.7 ×1–1,35×), **contar tokens exactos por proveedor** es un diferenciador para auditar factura con precisión. Fuente: [nota tokenizer Opus 4.7](https://raw.githubusercontent.com/MohamedAbdallah-14/prompt-to-asset/refs/heads/main/docs/research/31-cost-optimization-agentic/31b-model-routing-cheap-to-expensive.md).

### O3.6 "Cashback" / descuentos por volumen
Existen créditos y descuentos por volumen en gateways (p. ej. [OpenRouter créditos](https://aireiter.com/pt/blog/openrouter-promo-code)); un savings layer podría **rastrear/optimizar hacia umbrales de volumen** y contabilizarlo como "ahorro". Es una oportunidad menor y menos defendible (depende de acuerdos del proveedor), pero encaja con el "ledger".

### O3.7 El dolor del desarrollador (evidencia cualitativa)
- La integración de optimización hoy obliga a **elegir entre SaaS (telemetría en nube) y proxy complejo** ([LiteLLM deploy](https://railway.com/deploy/litellm-proxy)). Un savings layer *in-process* (una línea en el código, sin proxy ni SaaS) ataca ese dolor.
- El gasto se "descubre tarde": [HackerNoon — "Why Your Lean Startup is Bleeding Tokens"](https://hackernoon.com/lite/the-silicon-paywall-why-startups-are-losing-the-agentic-arms-race). La **auditoría por request** responde a la necesidad de explicar *de dónde sale la factura*.
- Existen utilidades dispersas (p. ej. `costopt` [PyPI](https://pypi.org/project/costopt/0.2.15/)) pero ninguna consolida las cuatro familias de ahorro en un solo ledger.

---

## 4. Cifras y benchmarks públicos que respaldan las oportunidades

| Cifra | Fuente |
|---|---|
| Prompt caching Anthropic: lectura 0.1×, escritura 1.25×/2×, TTL 5min/1h, 4 breakpoints, min 1.024 tokens | [Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) |
| OpenAI: 50% (gpt-4o/4.1) → 90% (GPT-5.4/5.5), sin write fee | [ofox.ai](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/) |
| A 80% hit-rate, "90% lectura" ≈ solo 31–32% de reducción total | [ofox.ai](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/) |
| RouteLLM: 85% menos coste manteniendo 95% de calidad GPT-4 (MT-Bench) | [RouteLLM](https://github.com/lm-sys/RouteLLM) |
| Batch 50% OpenAI / Anthropic / OpenRouter | [OpenAI](https://help.openai.com/pl-pl/articles/9197833-batch-api-faq) · [Anthropic](https://claude.com/ja/resources/articles/message-batches-api) · [OpenRouter](https://openrouter.ai/blog/announcements/batch-api/) |
| Rango de precios ~250× entre Flash y Opus (0,075→15 in; 0,30→75 out) | [ClawRouters 2026](https://www.clawrouters.com/blog/llm-api-pricing-guide-2026) |
| Smart routing 60–88% de ahorro según workload | [ClawRouters 2026](https://www.clawrouters.com/blog/llm-api-pricing-guide-2026) |
| LLMLingua-2: compresión task-agnostic, hasta ~20× | [arXiv 2403.12968](https://ar5iv.labs.arxiv.org/html/2403.12968) |
| JSON schemas imponen "token tax" (el schema suma tokens) | [Telekom](https://docs.developer.telekom.com/en/blog/the-hidden-token-tax-on-json-schemas) |
| Tokenizer Opus 4.7 produce 1–1,35× más tokens (coste real +35%) | [doc cascada, nota 2026-04](https://raw.githubusercontent.com/MohamedAbdallah-14/prompt-to-asset/refs/heads/main/docs/research/31-cost-optimization-agentic/31b-model-routing-cheap-to-expensive.md) |
| GPTCache: falsos positivos documentados | [ACL 2023](https://aclanthology.org/2023.nlposs-1.24.pdf) |
| Agent caching falla sin canonicalización de intención | [arXiv 2602.18922](https://browse-export.arxiv.org/abs/2602.18922) |

---

## 5. Top 8 oportunidades priorizadas por impacto × esfuerzo

*(Impacto = % de factura reducible; Esfuerzo = coste de construir sobre lo que BV-SALA ya tiene.)*

1. **Cache-aware prompt management + arreglo automático de cache breaks (impacto MUY ALTO, esfuerzo BAJO-MEDIO).**
   BV-SALA ya coloca prompt-cache y rebaja TTL. Extenderlo a *detectar y corregir* los 3 patrones de miss (dinámicos al final, tools deterministas, ventana con prefijo fijo) y *medir* el hit-rate antes/después ataca directamente el dato de que el leverage está en el hit-rate, no en el proveedor. Competidores solo hacen checkpoints manuales ([LiteLLM](https://docs.litellm.ai/docs/tutorials/prompt_caching.md)). Es la defensa técnica más fuerte del producto.

2. **Automatización de Batch API (50%) en el código (impacto ALTO, esfuerzo MEDIO).**
   Descuento del 50% disponible en OpenAI/Anthropic/OpenRouter pero nadie lo automatiza de forma transparente; solo PyPI pre-release ([batch-router](https://pypi.org/project/batch-router/), [autobatcher](https://pypi.org/project/autobatcher/0.9.0/)). Detectar requests no-latencia-críticas y agruparlas es un diferenciador de "savings layer" puro: ahorro real sin tocar calidad.

3. **Ledger contable por request con measured/reference/estimated (impacto ALTO como moat de producto, esfuerzo MEDIO).**
   Es el hueco estructural nº1: nadie audita *por request* las 4 familias de ahorro; todos muestran paneles. Es lo que convierte a BV-SALA de "otra librería" en "capa de auditoría de factura". Reforzarlo con **tokenización exacta por proveedor** (punto 6) lo hace verificable.

4. **Routing/cascada con arbitraje dinámico de precios (impacto MUY ALTO, esfuerzo MEDIO-ALTO).**
   El rango 250× de precios ([ClawRouters](https://www.clawrouters.com/blog/llm-api-pricing-guide-2026)) y el benchmark de RouteLLM (85% ahorro @95% calidad) hacen del routing el mayor ahorro disponible. BV-SALA ya enruta a DeepSeek/Qwen/GLM; añadir **precios actualizados automáticamente** y cascada "cheap-first con escalado" lo lleva al siguiente nivel. Esfuerzo alto por el riesgo de calidad → priorizar después de 1–3.

5. **Compaction de historial / just-in-time context multi-proveedor (impacto ALTO en agentes, esfuerzo MEDIO-ALTO).**
   Anthropic lo tiene nativo pero solo para Claude ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)); ningún gateway multi-proveedor lo ofrece. Oportunidad real pero requiere cuidado con la pérdida de fidelidad → encaja con las etiquetas "estimated/compressed" del ledger.

6. **Tokenización exacta por proveedor como capa de auditoría (impacto MEDIO, esfuerzo BAJO-MEDIO).**
   Con tokenizers que cambian por versión (Opus 4.7 ×1–1,35×), contar tokens reales es un diferenciador barato de construir (hay tokenizers públicos) y multiplica la credibilidad de todo el ledger.

7. **Caché semántica calibrada (ya en BV-SALA) + reescritura de structured data compacta (impacto MEDIO, esfuerzo BAJO — consolidar).**
   Ya existe; el valor incremental es posicionarlo contra el riesgo de falsos positivos de GPTCache y contra el "JSON token tax" ([Telekom](https://docs.developer.telekom.com/en/blog/the-hidden-token-tax-on-json-schemas)), documentando ahorro medido.

8. **Optimización hacia descuentos por volumen / "cashback" (impacto BAJO-MEDIO, esfuerzo BAJO).**
   Rastrear y contabilizar créditos/umbrales de volumen ([OpenRouter](https://aireiter.com/pt/blog/openrouter-promo-code)) añade una línea más al ledger, pero depende de acuerdos del proveedor y es poco defendible → dejarlo como feature de nicho.

---

### Datos no encontrados / no verificados
- Precio público 2026 único y limpio de **Qwen3/Qwen3-Max** (las fuentes de Alibaba Cloud encontradas no exponían la tarifa por token de forma consistente).
- Programas de **"cashback" formales** de los grandes proveedores (OpenAI/Anthropic/Google) más allá de créditos promocionales.
- Benchmarks cuantitativos públicos de **compaction automática en producción** (solo hay papers académicos y la feature nativa de Anthropic sin cifras públicas de ahorro).

*Todas las cifras son de fuentes de terceros de 2026 y pueden haber cambiado; los precios de LLM se actualizan trimestralmente.*

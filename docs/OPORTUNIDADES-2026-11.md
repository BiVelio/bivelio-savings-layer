# Oportunidades de mercado y algoritmos — noviembre 2026

Investigación profunda para detectar oportunidades de ahorro y hacer de BV-SALA
el software más útil para developers que integran LLM. Combina: (a) la auditoría
del código de esta sesión, (b) la investigación de mercado de noviembre de 2026
(`informe-estado-del-arte-optimizacion-coste-llm-2026.md`), y (c) la investigación
interna ya existente (`ROADMAP-ALGORITMOS.md`, `investigacion/2026-09-27/*`).

---

## 1 · Resumen ejecutivo

BV-SALA **ya es** la capa de ahorro más completa y honesta del mercado: cuatro
ledgers separados y nunca sumados, etiquetas de evidencia measured/reference/
estimated/unmeasured, medición con el contador del proveedor, y cero telemetría.
La auditoría de código confirma que casi todo el `ROADMAP-ALGORITMOS.md` de la era
v0.1 **ya está construido** (caché exacta y semántica calibrada, colocación de
prompt-cache fija/automática con verja económica, cascada de modelos con apagado
automático, compresión de cola sin pérdida, contratos de salida, lotes a 50 %,
memoria conversacional, verificación A/B, tokenización exacta, exportadores).

**La tesis que ordena el resto** (confirmada por el mercado): el leverage real del
prompt caching no es el descuento del proveedor (90 %), sino el **hit-rate** — a un
80 % de hit, el "90 % de descuento" se queda en ~31-32 % de ahorro real. Lo que
rompe el hit-rate son tres patrones silenciosos que **nadie** arregla automáticamente:

1. `system` mutable (timestamp/UUID por petición) → 0 % de hit.
2. Serialización no determinista de herramientas (orden de Map/Set).
3. Ventana deslizante de historial que desplaza el prefijo.

BV-SALA ya cubre 2 y 3. **Esta sesión añade la pieza que faltaba (1)**: la
auditoría de cache breaks (`src/cache/cache-audit.ts`), que detecta el contenido
mutable en el prefijo y lo señala en `report.traces` (`cache-audit`) — diagnóstico
sin reescribir, fiel a la doctrina de la capa.

---

## 2 · Estado de los algoritmos (auditoría de código)

Cada mecanismo, con su verja económica (nunca "ahorra por decreto"):

| Palanca | Dónde | Estado |
| --- | --- | --- |
| Caché exacta + singleflight | `src/cache/exact.ts`, `singleflight.ts` | ✅ medida |
| Caché semántica de 3 zonas calibrada | `src/cache/semantic.ts`, `calibracion.ts`, `embedder-local.ts` | ✅ aprendida con Learn-then-Test |
| Colocación de prompt-cache (fija/auto) + verja | `src/economics/colocador-de-cache.ts`, `prefix-cache-gate.ts`, `cache-tier.ts` | ✅ con espejo y `cache_miss_reason` |
| Cascada de modelos con apagado automático | `src/economics/cascada-de-modelos.ts` | ✅ aritmética derivada del catálogo |
| Compresión de cola sin pérdida | `src/compression/cola.ts`, `compression.ts` | ✅ pura, cache-aware |
| Formato de datos estructurados | `src/serialization/*` | ✅ format-selector + compact rows |
| Contratos de salida / codebook | `src/constraints/*`, `src/contracts/*` | ✅ con reparación acotada |
| Lotes a 50 % (`layer.batches`) | `src/batch/lotes.ts` | ✅ valorados a dos tarifas |
| Memoria conversacional por deltas | `src/memory/memory.ts` | ✅ estado compacto |
| Retrieval + reranker | `src/retrieval/*` | ✅ |
| Verificación A/B | `src/verification/*` | ✅ opt-in |
| Tokenización exacta + heurística | `src/tokenizer/*` | ✅ registro por proveedor |
| **Auditoría de cache breaks** | `src/cache/cache-audit.ts` | 🆕 esta sesión |

### Lo que el propio equipo dejó documentado como pendiente

De `investigacion/2026-09-27/batch-y-fuera-de-punta.md` §6 y `ROADMAP-ALGORITMOS.md`:

1. **Las palancas de la capa dentro del lote** (caché exacta + compresión + elisión
   antes de construir el lote). Requiere partir `generate()` en pre-/post-proveedor
   (tamaño L). Es el multiplicador real: 50 % de lote × palancas propias.
2. **Gemini Batch Mode** (adaptador nativo de ficheros; resolver la contradicción
   de precios de caché entre fuentes oficiales).
3. **DeepSeek fuera de punta** (rechazado por 5 motivos; solo "valle seguro" y
   `estimated`; exige cola durable).
4. **OpenAI Responses API en lote** (hoy solo Chat Completions).
5. **Streaming/paginación de resultados de lote enormes**.
6. Comisión sobre el ahorro de lote (decisión del dueño, emisor durable).

---

## 3 · Panorama de mercado (noviembre 2026)

Fuente: `informe-estado-del-arte-optimizacion-coste-llm-2026.md` (todas las cifras
son de listas públicas, no verificadas contra factura).

- **Competidores**: LiteLLM (proxy/routing, tablas de precio descargadas al
  arrancar, sin ledger por request), OpenRouter (SaaS, routing+batch), Portkey
  (gateway SaaS, caché simple+semántica), Helicone (observabilidad, prompt caching
  manual), LangSmith/Braintrust (observabilidad/eval, no ahorro), GPTCache (solo
  caché, falsos positivos documentados), TokenTrimmer (el más cercano: open-core
  gateway + code scanner, **sin** los 4 ledgers ni auditoría por request).
- **Huecos estructurales confirmados**: (1) nadie emite un **registro contable por
  request** con calls evitadas/tokens eliminados/comprimidos/cacheados + etiquetas
  de confianza — es el moat de BV-SALA; (2) casi todo es SaaS que exige mandar
  prompts a su nube; (3) la tokenización exacta (Opus 4.7 cambió de tokenizer y
  produce 1-1,35× tokens → +35 % de coste real con el mismo precio).
- **Arbitraje de precios**: rango ~250× (Gemini 3 Flash $0.075/$0.30 vs Claude
  Opus $15/$75). RouteLLM reporta 85 % de reducción manteniendo 95 % de calidad
  (MT-Bench).
- **El dato clave**: a 80 % de hit-rate, el "90 % de descuento" es ~31-32 % real —
  el leverage es el hit-rate, no el proveedor.

---

## 4 · Mapa priorizado de oportunidades (impacto × esfuerzo × riesgo)

| # | Oportunidad | Impacto | Esfuerzo | Riesgo | Estado |
| --- | --- | --- | --- | --- | --- |
| 1 | **Cache-aware prompt management** (arreglar los 3 cache breaks) | MUY ALTO | BAJO-MEDIO | BAJO | 🟢 auditoría añadida; queda el rewrite opt-in del patrón 1 |
| 2 | **Palancas de la capa dentro del lote** (50 % × caché exacta/compresión/elisión) | MUY ALTO | MEDIO-ALTO (partir `generate()`) | MEDIO | ⚪ pendiente (gap 1 del equipo) |
| 3 | **Arbitraje dinámico de precios en la cascada** (auto-actualizar catálogo) | MUY ALTO | MEDIO-ALTO | ALTO (calidad) | ⚪ la cascada ya existe; falta refresh de precios |
| 4 | **Compaction multi-proveedor just-in-time** | ALTO | MEDIO-ALTO | MEDIO | 🟡 memoria existe; falta el disparo automático |
| 5 | **Gemini Batch Mode** | MEDIO | MEDIO | BAJO | ⚪ pendiente (gap 2) |
| 6 | **DeepSeek fuera de punta** | MEDIO | MEDIO | BAJO | ⚪ rechazado por el equipo (5 motivos) |
| 7 | **Tokenización exacta por proveedor** | MEDIO | BAJO-MEDIO | BAJO | 🟢 ya existe (registro) |
| 8 | Cashback/descuentos por volumen | BAJO | BAJO | BAJO | ⚪ nicho |

**Recomendación**: completar la 1 (el rewrite opt-in del patrón 1 es la única
pieza que falta y es de bajo riesgo), y encarar la 2, que es el único multiplicador
verdadero que queda (combina el 50 % del lote con el ahorro por request). La 3 es
tentadora pero toca la calidad del enrutado, que la capa ha decidido no prometer.

---

## 5 · Lo que esta sesión ha implementado

1. **`src/cache/cache-audit.ts`** — detector puro de contenido mutable en el
   prefijo cacheable (ISO timestamps, UUID v4, RFC 2822, época ms/s), con
   `test/cache-audit.test.ts` (11 casos).
2. **Gancho en `pipeline.ts`** — al marcar el prefijo, escanea la cabecera de
   `system` y emite `trace.record("cache-audit", "mutable-system-prefix", …)` con
   los patrones y muestras recortadas. Diagnóstico, no rewriting.
3. **`src/index.ts`** — la cabecera «PROPRIETARY AND CONFIDENTIAL» era falsa desde
   que el paquete es Apache-2.0; corregida a la cabecera Apache con referencia a
   `LICENSE-CLOUD.md`.

### Por qué es la pieza correcta

- **Nadie la tiene**: los competidores hacen checkpoints manuales; ninguno detecta
  por qué tu prompt cache no acierta.
- **Gratis y honesta**: no toca la petición, no cambia calidad, no inventa ahorro.
- **Refuerza el moat**: convierte a BV-SALA en "la capa que te dice por qué tu
  caché falla", además de "la capa que audita tu factura".

---

## 6 · Cómo se demuestra (doctrina)

Toda palanca entra con su forma de medirse:

- **Auditoría de cache breaks**: test unitario determinista (11 casos) + traza
  `cache-audit` visible en el `SavingsReport`.
- **Palancas dentro del lote**: escenario `batch-heavy` con juez ciego y la
  propiedad de que el importe aplicado nunca supera la diferencia real de catálogo.
- **Arbitraje dinámico**: tasa de escalado medida por la verja ya existente, y
  nunca una "tasa de aceptación" publicada como calidad.

---

## 7 · Fuentes principales

- Informe de mercado nov-2026: `informe-estado-del-arte-optimizacion-coste-llm-2026.md`
- ofox.ai "Prompt caching cost math" (hit-rate 80 % → ~31-32 % real): https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/
- RouteLLM: https://github.com/lm-sys/RouteLLM
- TokenTrimmer: https://github.com/tokentrimmer/tokentrimmer
- GPTCache (falsos positivos): https://aclanthology.org/2023.nlposs-1.24.pdf
- Guía de precios 2026: https://www.clawrouters.com/blog/llm-api-pricing-guide-2026
- Interno: `docs/ROADMAP-ALGORITMOS.md`, `docs/investigacion/2026-09-27/batch-y-fuera-de-punta.md`, `docs/investigacion/2026-09-27/inteligencia-competitiva.md`

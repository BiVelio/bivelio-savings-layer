# Puntos de ruptura de caché: dónde escribir la caché de prefijo del proveedor

**Fecha:** 27‑sep‑2026 · **Línea:** `breakpoints-de-cache` · **Producto:** `@bivelio/savings-layer` 0.4.25 (SDK)
**Etiquetas:** **[doc]** = documentación oficial del proveedor; **[marketing]** = afirmación del vendedor sin método; **[medido]** = medición con método; **[simulado]** = simulador de este repo con las reglas oficiales; **[código]** = leído en este repositorio. Las citas [n] remiten a la §10.

---

## 1. La pregunta

¿Dónde conviene poner los puntos de ruptura de la caché de prefijo —`cache_control` en Anthropic, el modo explícito en GPT‑5.6+/GPT‑6— para leer lo máximo y no pagar la prima de escritura en prefijos que nadie vuelve a leer? ¿Se puede decidir solo, medirlo con el contador del proveedor y encajarlo con la verja de caché de prefijo que ya existe en el pipeline?

## 2. Conclusión

1. **La palanca «poner el punto al final» ya es gratis en todas partes.** Anthropic la da con un solo campo (caché automática, 19‑feb‑2026 [2]). Vercel AI Gateway, LangChain.js, LiteLLM y el AI SDK la aplican siempre [4][5][6][7]. **Ninguno mide si el tráfico reutiliza lo que escribe.** Vercel lo admite por escrito: en tráfico de un solo uso la prima es «a small net cost» y recomienda no usarla [4].
2. **El pipeline tenía dos huecos, y en los dos se paga de más** [código]. (a) La verja de prefijo aprende por huella del prefijo estable, que en una conversación cambia en cada turno. Nunca ve dos veces la misma, así que en conversaciones marca siempre y no mide nada. (b) En un bucle de agente, los resultados de herramienta llegan después de la última pregunta del usuario. La colocación fija no los cachea nunca y cada paso vuelve a pagar a 1× todo lo que el agente ha acumulado.
3. **Construido (opt‑in): `cacheBreakpoints: "auto"`.** La capa compara localmente cada prefijo enviado con los anteriores. Eso le basta para medir, sin marcar nada y sin coste, cuánto y con qué hueco se reutiliza cada tramo: cabecera, historial y prompt entero. Solo cuando la evidencia es concluyente (Wilson al 95 %) marca la cola, quita el punto del historial, pasa a TTL de 1 h o activa el modo explícito de OpenAI. El contador del proveedor confirma cada lectura que la capa predijo, y si no la confirma esa clase de tráfico vuelve a la colocación fija.
4. **Efecto [simulado], no [medido]:** −71 % en bucles de agente, −59 % en chat a ritmo humano, −16 % en RAG de un solo uso y −12 % en chat rápido, frente a la colocación fija (§6). Queda igual o mejor que «el punto al final siempre» en los cuatro escenarios; esa estrategia empata en RAG (0 %) y pierde en el chat lento (+1,2 %). **No es una cifra publicable.** Sale del simulador y no del contador del proveedor, y hasta que haya una tirada en vivo no puede ir a ninguna portada.

## 3. Hallazgos, con fuentes

### 3.1 Anthropic: las reglas vigentes [1][2] **[doc]**

| Regla | Valor (consultado el 27‑sep‑2026) |
|---|---|
| Puntos por petición | Hasta 4. La caché automática (`cache_control` a nivel de petición) ocupa uno de los 4 |
| Dónde se escribe | «writes happen only at breakpoints». La búsqueda hacia atrás no escribe: solo encuentra lo que otras peticiones ya escribieron |
| Búsqueda hacia atrás | 20 posiciones por punto, contando la suya. En la Claude API una racha de `tool_use` o de `tool_result` cuenta como una posición |
| Orden e invalidación | `tools → system → messages`. Cambiar herramientas lo invalida todo; `tool_choice`, imágenes, thinking y effort invalidan los mensajes |
| Mínimo cacheable (por prefijo hasta el punto; por debajo «no error is returned») | 512: Opus 5.5, Opus 5, Fable 5/5.1, Mythos 5/5.1 · 1.024: Sonnet 5, Sonnet 4.6/4.5, Opus 4.8/4.1/4, Sonnet 4 · 2.048: Opus 4.7, Mythos Preview, Haiku 3.5 · 4.096: Opus 4.6/4.5, Haiku 4.5 |
| Precio | Escritura 1,25× (5 min) o 2× (1 h). Lectura 0,1× (0,05× Opus 5.5; 0,025× Fable 5.1 y Mythos 5.1). Los puntos en sí no cuestan nada |
| Vida | Se refresca gratis en cada lectura y se cuenta «from the start of the request». Con TTL mixtos, los de 1 h van delante; se factura lectura A, escritura de 1 h (B − A) y escritura de 5 min (C − B) |
| Concurrencia | «a cache entry only becomes available after the first response begins» |
| Fechas | Caché automática: 19‑feb‑2026. TTL de 1 h sin cabecera beta: 13‑ago‑2025. Diagnóstico de caché: beta el 13‑may‑2026 y GA el 23‑sep‑2026 [2] |

La página recomienda literalmente poner el punto en el último bloque idéntico entre las peticiones que se quiere que compartan caché: «In a growing conversation the final block works as long as each turn adds fewer than 20 blocks» [1].

### 3.2 OpenAI GPT‑5.6+ [3] **[doc]**

- Escritura a 1,25× y lectura a 0,1× desde GPT‑5.6. Mínimo: 1.024 tokens visibles.
- Dos modos. En el **implícito**, el punto va al final del último mensaje elegible (la pregunta). En el **explícito**, sin puntos no se escribe nada, y «Content after the last selected breakpoint is processed at the uncached input‑token rate without a cache‑write charge».
- Hasta 4 escrituras por petición. Solo se busca en las «cache lookup boundaries»: los 2 primeros y los 50 últimos puntos explícitos o, en el implícito, el punto implícito, hasta 20 finales de mensaje anteriores y el final del bloque inicial de `developer`.
- TTL: `prompt_cache_options.ttl`, cuyo único valor, `30m`, es también el defecto. También existe `prewarm`.
- **La guía no dice qué modo rige cuando la petición no pide ninguno.** El repo ya lo tenía anotado (`src/pricing/primas.ts`) y sigue igual.

### 3.3 Lo que hacen los demás

| Quién | Qué hace | ¿Mide la reutilización? | Evidencia |
|---|---|---|---|
| Anthropic, caché automática [1][2] | Un punto móvil en el último bloque | No | [doc] |
| Vercel AI Gateway `caching:'auto'` [4] | Punto en el último mensaje y en el anterior a la última pregunta. `cache_ttl` 5 min o 1 h (solo en la Responses API). `cache_anchor_items` declarado por el cliente | No. Aconseja no usarlo en tráfico de un solo uso | [doc]; sin cifras |
| LangChain.js, middleware de Anthropic [5] | Puntos en sistema, herramientas y el último mensaje del usuario. `ttl` 5 min o 1 h | No | [doc] |
| LiteLLM [6] | `cache_control_injection_points`; con `enable_anthropic_prompt_caching`, sistema + último turno | No («always applies») | [doc] |
| AI SDK, recetario [7] | `cacheControl` en el último mensaje | No | [doc] |
| Genosis [10] | Reordena bloques para la caché | Dice leer la respuesta del proveedor | 23–70 % [marketing] |

**Evidencia medida independiente** [8] **[medido]**: en tareas agénticas largas, la caché de prompts reduce el coste un 41–80 % y el TTFT un 13–31 % en tres proveedores. «Naive full‑context caching» puede aumentar la latencia, y se recomienda dejar fuera los resultados de herramienta dinámicos. La mejor práctica depende del tráfico, y el colocador existe precisamente para decidirlo con datos.

**Evidencia propia** [9] **[medido]**: el corpus del gateway (3.305 peticiones reales de Claude Code, 23‑ago → 6‑sep) midió que decidir el TTL «por el reloj» pierde dinero (−77,68 $). La razón es que un fallo se paga sobre todo lo que se lee y un acierto solo se gana sobre lo que se escribe. De ahí sale la regla del TTL de §4.3.

### 3.4 Lo que se vio en el código [código]

- `VerjaDeCacheDePrefijo` (src/economics/prefix-cache-gate.ts) acumula h por `huella` = SHA‑256 del prefijo estable (sistema + historial). En una conversación ese prefijo crece en cada turno, así que cada huella se ve una sola vez y la verja se queda en «exploring (0/8)» para siempre. Lo mismo pasa en tráfico de un solo uso con un documento propio en el historial: se marca, se paga 1,25× sobre el documento y la verja no puede apagarse porque la huella nunca se repite.
- `limiteDelPrefijoEstable` (src/pipeline/pipeline.ts) corta en la **última pregunta del usuario**. En un bucle de agente, los resultados llegan con rol `tool` después de esa pregunta, así que la colocación fija solo cachea la cabecera. Lo fija el test «la colocación fija solo cachea la cabecera» en `test/colocador-en-el-pipeline.test.ts`.
- El adaptador de Anthropic ya tenía `automaticCache` (el punto móvil), pero era estático y venía apagado.

## 4. Opciones y decisión

| Opción | A favor | En contra |
|---|---|---|
| A. «El punto al final siempre» (lo que hace el mercado) | Simple y ya existe (`automaticCache`) | Paga prima en tráfico de un solo uso y en chat lento con 5 min. Simulado: 0 % en RAG y +1,2 % en chat lento |
| B. Pistas declaradas (`standalone`, `cache_anchor_items`) | Sin estadística | El desarrollador tiene que saber lo que no sabe. Ya existe para OpenAI (`standalone`) |
| **C. Medir la reutilización del tráfico y decidir, verificando con el contador del proveedor** | Observar sale gratis (no hace falta marcar para saber si un prefijo se reenvía). Se adapta por clase de tráfico y encaja con la verja | Más código. Mientras no hay evidencia se comporta como la fija |
| D. Diagnóstico de caché del proveedor (Anthropic GA 23‑sep; OpenAI) | Explica por qué falló | Pide campos nuevos en cada petición y no decide nada. Complementario |

**Se elige C**, que se queda con lo bueno de A (cola en agentes y conversaciones) y de B (explícito en tráfico de un solo uso) sin pedirle nada al desarrollador. El dinero que mueve es del cliente, así que la decisión se toma con evidencia estadística, el contador del proveedor tiene la última palabra y todo es opt‑in.

### 4.1 Los equilibrios

Sea `w` lo que cuesta escribir y `r` lo que cuesta leer. Marcar un tramo que la petición siguiente reenvía con probabilidad `p` dentro del TTL compensa si

    p > (w − 1) / (w − r)

Eso da 0,25/1,15 ≈ 21,7 % con 5 min, 1/1,9 ≈ 52,6 % con 1 h y 0,25/1,20 ≈ 20,8 % con la lectura de Opus 5.5. Con 5 min coincide con el umbral de la verja de siempre. La deducción está en `equilibrioDeTramo` (src/economics/colocador-de-cache.ts).

### 4.2 Cuándo es «concluyente»

- **Intervalo de Wilson al 95 %.** Con 5 de 5 continuaciones el límite inferior ya es 0,57, así que la cola se enciende en el sexto paso de un agente. Con 0 de n hacen falta 14 para quitar un punto.
- **Censura por la derecha.** Una reutilización se sabe en cuanto llega y un fracaso solo cuando vence la ventana, así que entre las resueltas sobran éxitos. Para concluir que *compensa*, las pendientes cuentan como fracasos. Para concluir que *no compensa* bastan las resueltas, porque su sesgo va en contra de esa conclusión. Sin esta corrección, una conversación de 2 turnos con 8 min de hueco habría pasado a 1 h durante la primera hora (lo fija un test).
- **«Después de 5 min» se cuenta sobre el mismo denominador que «en 1 h».** Restar las dos tasas daba un 1,8 % tardío que no existía en un agente con pasos cada 4 s (lo fija un test).

### 4.3 El TTL

Hay un solo TTL por petición, porque los de 1 h tienen que ir delante de los de 5 min, y lo decide el último punto:

- si con 5 min no compensa y con 1 h sí, 1 h;
- si con 5 min ya compensa, 1 h solo si `p(5 min < hueco ≤ 1 h) · (w5 − r) · P > (w1h − w5) · D`, donde P es lo que la siguiente leería, D lo que esta petición escribe y p el límite inferior de Wilson. Es la regla del corpus del gateway [9] llevada al SDK.

## 5. Qué se construye hoy

- **`src/economics/colocador-de-cache.ts`** (interno). Contiene las huellas encadenadas por mensaje (cyrb53 doble, ~106 bits, solo en memoria), el `EspejoDeCache` y las decisiones `decidirColocacion` (Anthropic) y `decidirExplicitaOpenAI`. El espejo lleva, por clase de tráfico (modelo + herramientas + contrato + cabecera de sistema), contadores por ventana de 5 min, 30 min y 1 h, pendientes, predicciones y su verificación, con memoria acotada (2.048 entradas por clase y 256 clases LRU).
- **Pipeline** (`cacheBreakpoints: "auto"`, apagado por defecto). La verja de prefijo sigue mandando, pero con `auto` la llave pasa a ser **clase + forma de colocación** (`S`, `H`, `+T`, `@1h`) en vez de la huella del prefijo, así que vuelve a medir en conversaciones. La prima de 1 h se carga a 2× en `cost.actual` con el desglose del proveedor; si se pidió 1 h y el proveedor no la desglosa, toda la escritura va a 2×, que es el lado conservador. Las trazas `prefix-cache-placement` dicen qué se decidió, por qué y cuántas lecturas confirmó el proveedor.
- **Adaptador de Anthropic.** `cachePlacement: { tail, ttl }` en `ProviderRequest`. Pone la cola en el último bloque y el `ttl: "1h"` en todos los puntos. Con presupuesto corto, el orden es cabecera, cola e historial. Con el colocador activo nunca añade el punto de petición (un TTL distinto en el último bloque es un 400). Sin `cachePlacement`, el cuerpo sale byte a byte como antes.
- **Contador de 1 h.** `ProviderUsage.cacheWrite1hInputTokens` (de `cache_creation.ephemeral_1h_input_tokens`), acotado al total.
- **OpenAI GPT‑5.6+.** Pasa a modo explícito cuando es concluyente que las continuaciones en 30 min no llegan al equilibrio. El punto se pone al final del historial, o en la cabecera si tampoco se reenvía. `savings.standalone` declarado sigue mandando, `false` incluido, y `report.cacheWrites` avisa cuando fue el colocador quien eligió el modo.
- **README:** sección «Prompt‑cache breakpoints placed from your traffic», sin cifras.
- **Simulador y tirada:** `benchmarks/colocador-de-cache/` (simulador.ts, escenarios.ts, tirada.ts).
- **Tests:** `test/colocador-de-cache.test.ts` (30) y `test/colocador-en-el-pipeline.test.ts` (21). Fijan que la fija no cambia ni un byte, que `cost.actual` cuadra al céntimo con la factura simulada (1 h incluida), que el contador del proveedor apaga el colocador cuando no confirma y que `standalone: false` manda.

## 6. Resultado [simulado]

`BVSALA_DEV_OPEN=1 pnpm exec tsx benchmarks/colocador-de-cache/tirada.ts` corre el pipeline y el adaptador de verdad contra un `fetch` que factura con las reglas de §3.1. Precios de `anthropic/claude-sonnet-4-5` del catálogo, tokens = caracteres/4.

| Escenario | fixed | cola‑siempre (Vercel/LangChain/LiteLLM) | **auto** |
|---|---:|---:|---:|
| Agente: 20 tareas × 15 pasos, 4 s entre pasos, resultados de ~2.000 tokens | 13,19 $ | 3,72 $ (−71,8 %) | **3,78 $ (−71,4 %)** |
| RAG de un solo uso: 300 peticiones cada 10 s, documento propio de ~6.000 tokens | 7,19 $ | 7,19 $ (0,0 %) | **6,03 $ (−16,1 %)** |
| Chat lento: 20 conversaciones × 6 turnos, 8 min entre turnos | 2,01 $ | 2,04 $ (+1,2 %) | **0,83 $ (−58,7 %)** |
| Chat rápido: 40 conversaciones × 8 turnos, 30 s | 1,80 $ | 1,58 $ (−12,4 %) | **1,58 $ (−12,2 %)** |

En las 12 combinaciones, `cost.actual` del informe coincide con la factura simulada al céntimo.

**Por qué no es publicable.** El simulador no modela la expulsión por presión de memoria, el aislamiento por workspace ni la concurrencia (una entrada solo se lee cuando la primera respuesta ya empezó). Tampoco sabe si leer una entrada de 5 min con un punto de 1 h la «asciende»: la documentación no lo dice y el simulador supone que no. Todo eso quita aciertos. Los escenarios son sintéticos y a medida de cada mecanismo. La diferencia auto/cola‑siempre en el agente (−71,4 % frente a −71,8 %) es el precio de aprender: cinco pasos antes de que la evidencia sea concluyente.

## 7. Lo que queda

1. **La tirada en vivo, con el contador del proveedor**, que es la única que puede publicarse (ver §8). Cuesta dinero, así que la decide el dueño.
2. **Diagnóstico de caché** (Anthropic `diagnostics.previous_message_id`, GA 23‑sep‑2026 [2]): pedirlo cuando el espejo predijo una lectura que no llegó, para publicar el `cache_miss_reason` en la traza.
3. **Un punto puente cuando un turno añade ≥ 20 bloques.** El espejo sabe dónde empieza la continuación. Hoy el adaptador envía cada mensaje como un bloque y los resultados de herramienta como texto, así que 20 resultados en paralelo dejarían la entrada anterior fuera de la búsqueda.
4. **La frontera fija en bucles de agente.** Que `limiteDelPrefijoEstable` trate la racha final de `tool` como cola cambiaría el comportamiento por defecto y merece su propio PR.
5. **Serverless.** Con una instancia por petición el espejo no aprende nunca. Aceptar un almacén externo, como ya hace `constraintMemory`, sin sacar contenido: solo huellas.
6. **La lectura real por modelo en el tramo.** Opus 5.5 lee a 0,05× y el tramo usa 0,10×, que da un umbral algo más estricto, el lado conservador.
7. **Bedrock y Vertex.** Aislamiento por organización y sin caché automática en Bedrock heredado [1]. El colocador no lo distingue: se apoya en el contador.
8. **El gateway (`bvsala`)** reenvía el cuerpo del cliente y ya tiene su propia palanca de TTL [9]. Llevarle la cola o la hora medidas es otra línea.

## 8. Cómo se medirá el efecto

- **Por petición, con el contador del proveedor.** `cachedInputTokens`, `cacheWriteInputTokens` y `cacheWrite1hInputTokens` van en el uso, y la traza `prefix-cache-placement` publica, para cada lectura predicha, lo que leyó el proveedor frente a lo que se esperaba (`verified`, `confirmed`).
- **A/B en vivo** (paso del dueño). Dos capas sobre el mismo tráfico real de agente o de chat, una con `cacheBreakpoints: "fixed"` y otra con `"auto"`, facturadas con el contador de cada llamada a precio de catálogo. Se publica el suelo del intervalo, nunca la media.
- **Qué NO se cobra.** El descuento de la caché del proveedor se cuenta en el libro 4 en los dos lados y nunca como ahorro de la capa. La prima que provoca el colocador va entera a `cost.actual`. Esta palanca no mueve la comisión: si algo hace, es bajar `netSavings`, porque carga la prima y no se acredita la lectura.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| El espejo predice una reutilización que el proveedor no sirve (cable distinto, expulsión, concurrencia, otro workspace) | Cada predicción comprobable se contrasta con el contador. Con menos del 50 % confirmado tras 8 comprobaciones, esa clase vuelve a la fija. La verja de aciertos, con llave por clase, apaga la marca si h cae bajo el equilibrio (probados los dos caminos) |
| Pagar la prima de 1 h de más | Regla P/D con p en el límite inferior de Wilson y pendientes como fracasos. En `cost.actual` la hora se carga a 2× |
| Decidir con pocas muestras | Wilson al 95 %; sin certeza, la colocación fija |
| Memoria | Acotada por clase y por número de clases. Las entradas se retiran a la hora |
| Privacidad | Solo huellas no criptográficas en memoria del proceso. Nada sale del proceso ni entra en la telemetría |
| Cambio de comportamiento | Opt‑in. Por defecto no cambia ni un byte (test) |
| Un endpoint que no acepte `ttl: "1h"` (una pasarela, un despliegue antiguo) | La petición falla con 400 y sale por el camino fail‑open, sin marcas y con la traza. No se cobra nada de más, pero se pierde la caché en esa petición. Por eso la hora solo se pide con evidencia |
| Coste de CPU | Una huella por mensaje y hasta tres recuentos de tokens de prefijo por petición, solo con `auto` |

## 10. Fuentes

1. Anthropic, Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching (consultada el 27‑sep‑2026) [doc]
2. Anthropic, notas de versión de la API: https://platform.claude.com/docs/en/release-notes/api (consultadas el 27‑sep‑2026; entradas del 19‑feb‑2026, 13‑ago‑2025, 13‑may‑2026 y 23‑sep‑2026) [doc]
3. OpenAI, Prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching (consultada el 27‑sep‑2026) [doc]
4. Vercel, AI Gateway Automatic Prompt Caching: https://vercel.com/docs/ai-gateway/models-and-providers/automatic-caching (last_updated 11‑sep‑2026) [doc]
5. LangChain.js, middleware de caché de prompts de Anthropic: https://docs.langchain.com/oss/javascript/integrations/middleware/anthropic (consultada el 27‑sep‑2026) [doc]
6. LiteLLM, Prompt caching: https://docs.litellm.ai/docs/tutorials/prompt_caching (consultada el 27‑sep‑2026) [doc]
7. AI SDK, Dynamic Prompt Caching: https://ai-sdk.dev/cookbook/node/dynamic-prompt-caching (consultada el 27‑sep‑2026) [doc]
8. Lumer et al., «Don't Break the Cache: An Evaluation of Prompt Caching for Long‑Horizon Agentic Tasks», arXiv 2601.06007 (v2, 31‑ene‑2026) [medido]
9. `gateway/tarifa.ts`: corpus de 3.305 peticiones reales de Claude Code, 23‑ago → 6‑sep‑2026 [medido, interno]
10. `docs/COMPETENCIA-2026-09-26.md`, §2.6 (Genosis) y §3 (el resto que dejaba la caché de prefijo: modo y puntos en GPT‑5.6+/GPT‑6) [interno]

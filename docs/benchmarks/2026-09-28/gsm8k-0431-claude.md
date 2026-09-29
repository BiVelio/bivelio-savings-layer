# GSM8K 0.4.31 — caché exacta, caché semántica y compresión sin perder exactitud (2026-09-28)

Batería pública sobre GSM8K (GSM8K (Cobbe et al. 2021), MIT), commit `3101c7d5072418e28b9008a6636bde82a006892c` de https://github.com/openai/grade-school-math; ficheros verificados por sha256 (`gsm8k-test` 3730d312f6e3…, `gsm8k-train` 17f347dc5147…).

Paquete: `@bivelio/savings-layer@0.4.31` — v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1, devUnlicensed: true; npm = same commit, verified identical): `git diff v0.4.31 -- src/ packages/` only touches a comment and VERSION_MINIMA_REFERENCIA in src/version.ts, which the bundle does not contain; `pnpm build` of this tree and of `git archive v0.4.31` both give a dist/index.js with the npm tarball's sha256. Tarball sha256 `7f44816f0518e762a00821d03b5beb186772a290efd3ac4bf40006ca421a61ca`, `dist/index.js` sha256 `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`.

Modo: **LIVE**, run `ae4064`. Gasto real total: **$1.2967** (topes duros en código: anthropic/claude-haiku-4-5 $1.2500, anthropic/claude-sonnet-5 $1.2500).

Tope de salida de todos los brazos: 1024. Caché semántica de S y E encendida con: createSavingsLayer({ semanticCache, semanticCacheDefault: true }) — #380, new in 0.4.31; nothing on the request.

Hosts vistos durante la medición: api.anthropic.com (539); bloqueados: ninguno. Permitidos: api.openai.com, api.anthropic.com, raw.githubusercontent.com.


## Lectura (escrita a mano sobre las cifras medidas de abajo; el resto del documento lo genera `documento.ts`)

Comando: `tsx --env-file=<.env.bench> benchmarks/publicados/gsm8k/arnes.ts --desde-fuente --modelos anthropic/claude-haiku-4-5,anthropic/claude-sonnet-5 --presupuesto 1.25 --docs --sufijo claude`. Misma semilla (20260928), mismo system prompt y mismo flujo que la tirada de OpenAI (`gsm8k-0431.md`): los únicos salen del mismo barajado, así que los 58 de Haiku y los 31 de Sonnet 5 son los primeros 58 y 31 de los 100 de gpt-4o-mini; las repeticiones y paráfrasis dependen del tamaño y no son las mismas posiciones. **Sonnet 5 va con flujo reducido** (31 únicos, 62 peticiones) para caber en 1,25 $: la previsión asume entrada sin caché de prefijo y resultó conservadora (gastó 0,57 $).

- **Caché de prefijo, Sonnet 5 — sí, y es la mayor fuente de ahorro.** El system few-shot mide ~1850 tokens (mínimo cacheable de Sonnet 5: 1024). En B, 41 de 42 llamadas LEEN caché (72 447 tokens leídos, 93,2 % de la entrada) tras UNA sola escritura de 1767 tokens; A (sin `cache_control`) lee 0. De los 0,2367 $ de ahorro de B frente a A, 0,1054 $ vienen de no llamar (caché exacta) y 0,1313 $ de las llamadas hechas; el prefijo neto calculado solo desde tokens es 0,1295 $, así que prácticamente todo lo de las llamadas hechas es caché de prefijo. Resultado: 75,1 % [69,3, 79,6] de ahorro en B, frente al 30–32 % de OpenAI, donde la caché de prefijo es automática y el brazo A también la cobra.
- **Caché de prefijo, Haiku 4.5 — no existe con este prompt.** ~1450 tokens de entrada por llamada, por debajo del mínimo de 4096 de Haiku 4.5: 0 tokens leídos y 0 escritos en todos los brazos. Todo el 32,2 % de B sale de la caché exacta (0,0773 $ de 0,0774 $). El banco no ve el cuerpo de la petición, así que no afirma si la capa puso o no el `cache_control`; solo que el proveedor no escribió ni leyó nada, y que tampoco cobró prima de escritura.
- **La capa no se atribuye la caché de prefijo.** En Sonnet 5 su informe declara −0,0009 $ en base `measured` (la prima de la escritura) y no los ~0,13 $ de lecturas que midió el banco: coherente con #260, pero el informe de la capa infravalora lo que el banco mide aquí.
- **#383 — la semántica sin calibrar no sirve respuestas de otra pregunta.** E: 5 aciertos semánticos en Haiku y 2 en Sonnet 5, todos en paráfrasis `lexica` y todos con la cifra correcta (similitud 0,904–0,988); variantes con otra respuesta servidas de caché con texto no visto antes: **0** en B, S y E en los dos modelos (la única variante servida en Sonnet 5 es la repetición literal de una variante ya preguntada). La calibración de S no llegó a fijar suelo (5 y 2 etiquetas), así que S no sirvió nada semántico y se comporta como B.
- **Exactitud A vs B:** idéntica. Haiku 99,0 % (104/105) en los cuatro brazos; Sonnet 5 100 % (56/56) en los cuatro; Δ = 0,0 pp [0,0, 0,0].
- **Latencia:** los aciertos de caché de la capa se sirven en ~1 ms. Las llamadas que sí salen no ganan tiempo con la caché de prefijo a este tamaño: p50 de proveedor Sonnet 5 A 1969 ms vs B 2225 ms, Haiku A 1372 ms vs B 1423 ms (cuatro brazos concurrentes con otros bancos sobre la misma clave; es ruido de red, no una SLA). El p50 total baja en B porque un tercio de las peticiones no sale.
- **Gasto real:** Haiku 4.5 0,7266 $ (sonda 0,0064), Sonnet 5 0,5702 $ (sonda 0,0146); total 1,2967 $; los dos por debajo de su tope duro de 1,25 $. Hosts: solo api.anthropic.com (539 peticiones); ninguno bloqueado (los datos de GSM8K ya estaban en disco, verificados por sha256).

## Diseño

Flujo con semilla 20260928: hasta 100 problemas únicos del split de test, 30 % de repeticiones exactas y 20 % de paráfrasis deterministas en cuatro clases a partes iguales: `superficie` (minúsculas, sin «?»), `lexica` (preámbulo y sinónimos), `variante-cifra` (primer entero n→n+1) y `variante-palabra` (un número en letra o multiplicador al siguiente: two→three, twice→three times, half→a third). Las dos variantes tienen OTRA respuesta: sirven para comprobar que la capa no entrega la respuesta de otra pregunta. System prompt común: instrucción + 8 ejemplos del split de train (índices 4307, 3418, 6463, 1004, 7035, 667, 1055, 5542).

- **A**: directo al proveedor (sin capa), mismo prompt, mismo tope de salida (maxOutputTokens 1024) y mismo muestreo
- **B**: a través de la capa 0.4.31 con la configuración por defecto del README (caché exacta, resolvers, colocación fija de la caché de prefijo) y SavingsRequest.maxOutputTokens 1024
- **S**: B + caché semántica CALIBRADA (InMemorySemanticCache({ calibration: { maxErrorRate: 0.02, judge: misma cifra final } })), encendida con createSavingsLayer({ semanticCache, semanticCacheDefault: true })
- **E**: B + caché semántica TAL COMO SE ENVÍA (new InMemorySemanticCache() con sus umbrales por defecto), encendida con createSavingsLayer({ semanticCache, semanticCacheDefault: true })

## Resultados medidos por modelo

Todo lo de esta sección sale del `usage` del proveedor en cada llamada, al precio de lista del catálogo del SDK. Los intervalos remuestrean familias enteras (un problema con sus repeticiones y paráfrasis).

### anthropic/claude-haiku-4-5

Estado: **medido**. Host: api.anthropic.com. Muestreo: `{"temperature":0,"seed":7}`. Tope de salida: 1024. Gasto real: **$0.7266** (sonda $0.0064, A $0.2406, B $0.1631, S $0.1633, E $0.1532).

Flujo: 58 únicos, 116 peticiones completadas — original 58, repeticion 35, superficie 6, lexica 6, variante-cifra 6, variante-palabra 5.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 99.0 % [96.9 %, 100.0 %] (104/105) | — | $0.2406 | — | 0 / 0 / 0 | 0.0 % | 1372 ms / 3441 ms | 0 |
| B | 99.0 % [96.9 %, 100.0 %] (104/105) | 0.0 pp [0.0, 0.0] | $0.1631 | 32.2 % [23.6 %, 40.2 %] | 38 / 0 / 0 | 0.0 % | 1288 ms / 3128 ms | 0 |
| E | 99.0 % [96.9 %, 100.0 %] (104/105) | 0.0 pp [0.0, 0.0] | $0.1532 | 36.3 % [27.6 %, 44.2 %] | 38 / 5 / 0 | 0.0 % | 1226 ms / 3659 ms | 0 |
| S | 99.0 % [96.9 %, 100.0 %] (104/105) | 0.0 pp [0.0, 0.0] | $0.1633 | 32.1 % [23.5 %, 40.2 %] | 38 / 0 / 0 | 0.0 % | 1243 ms / 3618 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 11 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 11 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 11 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**

**De dónde sale el ahorro** (medido; «prefijo neto» = lecturas × (entrada − lectura) − escrituras × entrada × (prima − 1), a precio de lista, sin ruido de salida):

| Brazo | Llamadas | Entrada media / llamada | Llamadas con lectura / con escritura de caché | Tokens leídos / escritos | Ahorro total vs A | … por no llamar (caché de la capa) | … en las llamadas hechas | Prefijo neto (tokens) | Latencia p50 proveedor / caché |
|---|---|---|---|---|---|---|---|---|---|
| A | 116 | 1454 | 0 / 0 | 0 / 0 | — | — | — | $0.0000 | 1372 ms / — |
| B | 78 | 1453 | 0 / 0 | 0 / 0 | $0.0774 | $0.0773 | $0.0002 | $0.0000 | 1423 ms / 1 ms |
| E | 73 | 1453 | 0 / 0 | 0 / 0 | $0.0874 | $0.0872 | $0.0002 | $0.0000 | 1503 ms / 1 ms |
| S | 78 | 1453 | 0 / 0 | 0 / 0 | $0.0773 | $0.0773 | $0.0000 | $0.0000 | 1368 ms / 1 ms |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 6 pet., $0.0117 · measured: 78 pet., $0.0000 · reference: 32 pet., $0.0229
- **E**: estimated: 11 pet., $0.0221 · measured: 73 pet., $0.0000 · reference: 32 pet., $0.0229
- **S**: estimated: 6 pet., $0.0115 · measured: 78 pet., $0.0000 · reference: 32 pet., $0.0230

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":5,"heldOut":2,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### anthropic/claude-sonnet-5

Estado: **medido**. Host: api.anthropic.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.5702** (sonda $0.0146, A $0.3153, B $0.0786, S $0.0801, E $0.0816).

Flujo: 31 únicos, 62 peticiones completadas — original 31, repeticion 19, superficie 3, lexica 3, variante-cifra 3, variante-palabra 3.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 100.0 % [100.0 %, 100.0 %] (56/56) | — | $0.3153 | — | 0 / 0 / 0 | 0.0 % | 1969 ms / 3580 ms | 0 |
| B | 100.0 % [100.0 %, 100.0 %] (56/56) | 0.0 pp [0.0, 0.0] | $0.0786 | 75.1 % [69.3 %, 79.6 %] | 20 / 0 / 0 | 93.2 % | 1911 ms / 3254 ms | 0 |
| E | 100.0 % [100.0 %, 100.0 %] (56/56) | 0.0 pp [0.0, 0.0] | $0.0816 | 74.1 % [68.6 %, 78.8 %] | 20 / 2 / 0 | 93.1 % | 1720 ms / 3253 ms | 0 |
| S | 100.0 % [100.0 %, 100.0 %] (56/56) | 0.0 pp [0.0, 0.0] | $0.0801 | 74.6 % [68.8 %, 79.1 %] | 20 / 0 / 0 | 93.2 % | 1921 ms / 3246 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 6 variantes, 1 servidas de caché, **0 con la respuesta de otra pregunta** · E: 6 variantes, 1 servidas de caché, **0 con la respuesta de otra pregunta** · S: 6 variantes, 1 servidas de caché, **0 con la respuesta de otra pregunta**

**De dónde sale el ahorro** (medido; «prefijo neto» = lecturas × (entrada − lectura) − escrituras × entrada × (prima − 1), a precio de lista, sin ruido de salida):

| Brazo | Llamadas | Entrada media / llamada | Llamadas con lectura / con escritura de caché | Tokens leídos / escritos | Ahorro total vs A | … por no llamar (caché de la capa) | … en las llamadas hechas | Prefijo neto (tokens) | Latencia p50 proveedor / caché |
|---|---|---|---|---|---|---|---|---|---|
| A | 62 | 1856 | 0 / 0 | 0 / 0 | — | — | — | $0.0000 | 1969 ms / — |
| B | 42 | 1851 | 41 / 1 | 72447 / 1767 | $0.2367 | $0.1054 | $0.1313 | $0.1295 | 2225 ms / 1 ms |
| E | 40 | 1850 | 39 / 1 | 68913 / 1767 | $0.2337 | $0.1145 | $0.1192 | $0.1232 | 2040 ms / 1 ms |
| S | 42 | 1851 | 41 / 1 | 72447 / 1767 | $0.2351 | $0.1054 | $0.1297 | $0.1295 | 2207 ms / 1 ms |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 3 pet., $0.0115 · measured: 42 pet., $-0.0009 · reference: 17 pet., $0.0063
- **E**: estimated: 5 pet., $0.0186 · measured: 40 pet., $-0.0009 · reference: 17 pet., $0.0063
- **S**: estimated: 3 pet., $0.0114 · measured: 42 pet., $-0.0009 · reference: 17 pet., $0.0063

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":2,"heldOut":1,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

## Sin red: las decisiones de la capa sobre el split de test entero (modelado en lo económico)

5813 peticiones (cada problema de test seguido de sus derivadas aplicables) por la capa completa con un proveedor falso que contesta «#### <verdad>». Lo que la capa decide servir no depende del modelo, así que las decisiones son las del código publicado; el dinero no existe aquí.

| Configuración | Llamadas al proveedor | Exacta | Semántica | Respuestas de OTRA pregunta | Veto de caché exacta (política) |
|---|---|---|---|---|---|
| defecto | 4691/5813 | 1122 | 0 | **0** | 872 |
| semantica-sin-interruptor | 4691/5813 | 1122 | 0 | **0** | 872 |
| semantica-envio | 3644/5813 | 1122 | 1047 | **0** | 872 |
| semantica-defecto-capa | 3644/5813 | 1122 | 1047 | **0** | 872 |
| semantica-calibrada | 4022/5813 | 1122 | 669 | **0** | 872 |

**defecto** por clase: original 1319 (exacta 0, semántica 0, de otra 0); superficie 1319 (exacta 1122, semántica 0, de otra 0); lexica 1319 (exacta 0, semántica 0, de otra 0); variante-cifra 1292 (exacta 0, semántica 0, de otra 0); variante-palabra 564 (exacta 0, semántica 0, de otra 0).

**semantica-sin-interruptor** por clase: original 1319 (exacta 0, semántica 0, de otra 0); superficie 1319 (exacta 1122, semántica 0, de otra 0); lexica 1319 (exacta 0, semántica 0, de otra 0); variante-cifra 1292 (exacta 0, semántica 0, de otra 0); variante-palabra 564 (exacta 0, semántica 0, de otra 0).
Registros en la caché semántica al terminar: 0.

**semantica-envio** por clase: original 1319 (exacta 0, semántica 0, de otra 0); superficie 1319 (exacta 1122, semántica 0, de otra 0); lexica 1319 (exacta 0, semántica 1047, de otra 0); variante-cifra 1292 (exacta 0, semántica 0, de otra 0); variante-palabra 564 (exacta 0, semántica 0, de otra 0).
Registros en la caché semántica al terminar: 2772.

**semantica-defecto-capa** por clase: original 1319 (exacta 0, semántica 0, de otra 0); superficie 1319 (exacta 1122, semántica 0, de otra 0); lexica 1319 (exacta 0, semántica 1047, de otra 0); variante-cifra 1292 (exacta 0, semántica 0, de otra 0); variante-palabra 564 (exacta 0, semántica 0, de otra 0).
Registros en la caché semántica al terminar: 2772.

**semantica-calibrada** por clase: original 1319 (exacta 0, semántica 0, de otra 0); superficie 1319 (exacta 1122, semántica 0, de otra 0); lexica 1319 (exacta 0, semántica 669, de otra 0); variante-cifra 1292 (exacta 0, semántica 0, de otra 0); variante-palabra 564 (exacta 0, semántica 0, de otra 0).
Registros en la caché semántica al terminar: 3150.
Calibración: `{"maxErrorRate":0.02,"confidence":0.95,"floor":0.81,"labeled":395,"heldOut":197,"heldOutAtFloor":173,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":242,"nextTestAt":519}`.

## Limitaciones

- Arms B, S and E ran the 0.4.31 SOURCE of the tag with devUnlicensed: true (--desde-fuente), not the npm tarball: the npm build has no unlicensed mode. The dist built from this source is byte-identical to the tarball's dist/index.js (sha256 in `procedencia`).
- Compression: the npm package ships no compressor (noopCompressor) and these requests carry no structuredData, so ledger 3 (compressed tokens) is 0 by construction; this battery cannot show a compression saving, and says so instead of reporting a 0 as a measured failure.
- Paraphrases are deterministic templates (case/punctuation, a preamble plus synonyms), not human rewrites; real paraphrases are harder for a lexical embedder, so semantic hit rates here are an upper bound for surface-level rewording.
- Variants (one number changed) have no published gold; they are used only to check whether another question's answer was served, never for accuracy.
- Each arm carries a distinct run/lane tag at the start of its system prompt, so no arm reads another arm's provider prompt cache. The tag costs the same few tokens in every arm.
- Stream size per model is set from a 3-request probe and the budget; models whose stream is smaller have wider intervals. Confidence intervals resample whole problem families (a problem with its repeats and paraphrases).
- Latency is wall-clock from this machine, with the four arms of each request running concurrently; it includes network and is not a provider SLA.
- Every arm sends the same output cap, maxOutputTokens 1024 (0.4.31, #381); on api.anthropic.com it travels as max_tokens, which the Messages API requires anyway (the adapter's default without a cap is 4096).
- Semantic cache in S and E is switched on with semanticCacheDefault: true on the layer (0.4.31, #380), not with savings.semanticCache on each request as in the 0.4.30 run. The no-network replay runs both mechanisms side by side (semantica-envio vs semantica-defecto-capa) to show they decide the same.
- Anthropic caches a prefix only behind an explicit cache_control breakpoint. Arm A is the naive client and sends none, so every prefix-cache read in B/S/E is a breakpoint the layer placed; a client that marks its own system prompt would get that part without the layer. The breakdown table separates it from what the layer saved by not calling at all.
- Anthropic also caches nothing below the model's minimum cacheable prefix (4096 tokens for claude-haiku-4-5 on the official prompt-caching page; the SDK keeps the conservative 1024 for models without a published figure). The mean input per call in the breakdown table says on which side of that line this few-shot system prompt falls.
- Up to four arms run concurrently per request against one Anthropic key that sibling benchmark runs were also using; 429/529 are retried with backoff, and a retried call's wait is part of its latency.

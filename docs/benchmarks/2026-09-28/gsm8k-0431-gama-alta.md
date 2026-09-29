# GSM8K 0.4.31 gama alta — caché exacta, caché semántica y compresión sin perder exactitud (2026-09-28)

Batería pública sobre GSM8K (GSM8K (Cobbe et al. 2021), MIT), commit `3101c7d5072418e28b9008a6636bde82a006892c` de https://github.com/openai/grade-school-math; ficheros verificados por sha256 (`gsm8k-test` 3730d312f6e3…, `gsm8k-train` 17f347dc5147…).

Paquete: `@bivelio/savings-layer@0.4.31` — v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1, devUnlicensed: true; npm = same commit, verified identical): `git diff v0.4.31 -- src/ packages/` only touches a comment and VERSION_MINIMA_REFERENCIA in src/version.ts, which the bundle does not contain; `pnpm build` of this tree and of `git archive v0.4.31` both give a dist/index.js with the npm tarball's sha256. Tarball sha256 `7f44816f0518e762a00821d03b5beb186772a290efd3ac4bf40006ca421a61ca`, `dist/index.js` sha256 `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`.

Modo: **LIVE**, run `c627ee`, ejecutada el 2026-09-29. Gasto real total: **$2.5589** (topes duros en código: anthropic/claude-opus-5-5 $1.2000, anthropic/claude-sonnet-5-5 $1.2000, openai/gpt-5.5 $1.2000, openai/gpt-5.6-sol $1.2000, google/gemini-3.8-flash $1.2000, google/gemini-3.1-pro-preview $1.2000).

Tope de salida de todos los brazos: 1024. Caché semántica de S y E encendida con: createSavingsLayer({ semanticCache, semanticCacheDefault: true }) — #380, new in 0.4.31; nothing on the request.

Hosts vistos durante la medición: api.anthropic.com (290), api.openai.com (168), generativelanguage.googleapis.com (680); bloqueados: ninguno. Permitidos: api.openai.com, api.anthropic.com, generativelanguage.googleapis.com, raw.githubusercontent.com.

## Resumen por modelo y brazo

Ahorro MEDIDO vs A (usage del proveedor, precio de lista) y su origen: «caché de la capa» son las posiciones que la capa sirvió sin llamar; «prefijo/llamadas» es la diferencia en las posiciones en que los dos llamaron (caché de prefijo del proveedor más ruido de longitud de salida).

| Modelo | Brazo | Exactitud A → brazo | Ahorro medido [IC95] | De caché de la capa | De prefijo/llamadas | Tokens leídos de caché del proveedor A → brazo | Respuestas de OTRA pregunta | Latencia p50 A → brazo |
|---|---|---|---|---|---|---|---|---|
| anthropic/claude-opus-5-5 | B | 30/30 → 30/30 | 77.2 % [67.1 %, 83.9 %] | $0.0974 (10 pos.) | $0.1391 | 0 → 37086 | **0** | 2666 ms → 1802 ms |
| anthropic/claude-opus-5-5 | S | 30/30 → 30/30 | 75.3 % [63.9 %, 83.5 %] | $0.0974 (10 pos.) | $0.1332 | 0 → 37086 | **0** | 2666 ms → 2090 ms |
| anthropic/claude-opus-5-5 | E | 30/30 → 30/30 | 78.8 % [68.2 %, 85.9 %] | $0.1151 (12 pos.) | $0.1260 | 0 → 33554 | **0** | 2666 ms → 2066 ms |
| anthropic/claude-sonnet-5-5 | B | 56/56 → 56/56 | 77.5 % [72.0 %, 81.7 %] | $0.0924 (20 pos.) | $0.1289 | 0 → 72406 | **0** | 1537 ms → 1369 ms |
| anthropic/claude-sonnet-5-5 | S | 56/56 → 56/56 | 77.3 % [71.9 %, 81.6 %] | $0.0924 (20 pos.) | $0.1284 | 0 → 72406 | **0** | 1537 ms → 1310 ms |
| anthropic/claude-sonnet-5-5 | E | 56/56 → 56/56 | 78.4 % [73.0 %, 82.7 %] | $0.1011 (22 pos.) | $0.1229 | 0 → 68874 | **0** | 1537 ms → 1321 ms |
| openai/gpt-5.5 | B | 20/20 → 20/20 | 33.4 % [6.8 %, 53.8 %] | $0.0790 (7 pos.) | $-0.0023 | 0 → 0 | **0** | 2041 ms → 1586 ms |
| openai/gpt-5.5 | S | 20/20 → 20/20 | 34.8 % [8.8 %, 54.5 %] | $0.0790 (7 pos.) | $0.0007 | 0 → 0 | **0** | 2041 ms → 1684 ms |
| openai/gpt-5.5 | E | 20/20 → 20/20 | 37.1 % [11.5 %, 56.3 %] | $0.0874 (8 pos.) | $-0.0023 | 0 → 0 | **0** | 2041 ms → 1577 ms |
| openai/gpt-5.6-sol | B | 30/30 → 30/30 | 29.2 % [9.5 %, 46.8 %] | $0.0252 (10 pos.) | $-0.0003 | 38454 → 25703 | **0** | 1975 ms → 1600 ms |
| openai/gpt-5.6-sol | S | 30/30 → 30/30 | 30.4 % [9.3 %, 49.0 %] | $0.0252 (10 pos.) | $0.0007 | 38454 → 25703 | **0** | 1975 ms → 1871 ms |
| openai/gpt-5.6-sol | E | 30/30 → 30/30 | 35.5 % [17.0 %, 51.1 %] | $0.0294 (12 pos.) | $0.0009 | 38454 → 23267 | **0** | 1975 ms → 1881 ms |
| google/gemini-3.8-flash | B | 120/121 → **falló en todas (134)** | — | — | — | — | — | — |
| google/gemini-3.8-flash | S | 120/121 → **falló en todas (134)** | — | — | — | — | — | — |
| google/gemini-3.8-flash | E | 120/121 → **falló en todas (134)** | — | — | — | — | — | — |
| google/gemini-3.1-pro-preview | B | 31/31 → **falló en todas (34)** | — | — | — | — | — | — |
| google/gemini-3.1-pro-preview | S | 31/31 → **falló en todas (34)** | — | — | — | — | — | — |
| google/gemini-3.1-pro-preview | E | 31/31 → **falló en todas (34)** | — | — | — | — | — | — |
| google/gemini-3.8-flash (parche del banco) | B | 89/90 → 90/90 | 28.1 % [18.9 %, 36.5 %] | $0.0536 (30 pos.) | $0.0019 | 0 → 0 | **0** | 1577 ms → 1436 ms |
| google/gemini-3.8-flash (parche del banco) | S | 89/90 → 90/90 | 27.4 % [17.8 %, 36.3 %] | $0.0536 (30 pos.) | $0.0005 | 0 → 0 | **0** | 1577 ms → 1466 ms |
| google/gemini-3.8-flash (parche del banco) | E | 89/90 → 90/90 | 30.2 % [20.8 %, 38.8 %] | $0.0588 (33 pos.) | $0.0011 | 0 → 0 | **0** | 1577 ms → 1389 ms |
| google/gemini-3.1-pro-preview (parche del banco) | B | 19/22 → 19/22 | 21.1 % [3.5 %, 40.3 %] | $0.0286 (5 pos.) | $0.0027 | 0 → 0 | **0** | 4707 ms → 4762 ms |
| google/gemini-3.1-pro-preview (parche del banco) | S | 19/22 → 19/22 | 16.1 % [-6.0 %, 39.3 %] | $0.0286 (5 pos.) | $-0.0047 | 0 → 0 | **0** | 4707 ms → 4374 ms |
| google/gemini-3.1-pro-preview (parche del banco) | E | 19/22 → 19/22 | 15.0 % [-9.0 %, 37.6 %] | $0.0286 (5 pos.) | $-0.0064 | 0 → 0 | **0** | 4707 ms → 4589 ms |

## Diseño

Flujo con semilla 20260928: hasta 100 problemas únicos del split de test, 30 % de repeticiones exactas y 20 % de paráfrasis deterministas en cuatro clases a partes iguales: `superficie` (minúsculas, sin «?»), `lexica` (preámbulo y sinónimos), `variante-cifra` (primer entero n→n+1) y `variante-palabra` (un número en letra o multiplicador al siguiente: two→three, twice→three times, half→a third). Las dos variantes tienen OTRA respuesta: sirven para comprobar que la capa no entrega la respuesta de otra pregunta. System prompt común: instrucción + 8 ejemplos del split de train (índices 4307, 3418, 6463, 1004, 7035, 667, 1055, 5542).

- **A**: directo al proveedor (sin capa), mismo prompt, mismo tope de salida (maxOutputTokens 1024) y mismo muestreo
- **B**: a través de la capa 0.4.31 con la configuración por defecto del README (caché exacta, resolvers, colocación fija de la caché de prefijo) y SavingsRequest.maxOutputTokens 1024
- **S**: B + caché semántica CALIBRADA (InMemorySemanticCache({ calibration: { maxErrorRate: 0.02, judge: misma cifra final } })), encendida con createSavingsLayer({ semanticCache, semanticCacheDefault: true })
- **E**: B + caché semántica TAL COMO SE ENVÍA (new InMemorySemanticCache() con sus umbrales por defecto), encendida con createSavingsLayer({ semanticCache, semanticCacheDefault: true })

## Resultados medidos por modelo

Todo lo de esta sección sale del `usage` del proveedor en cada llamada, al precio de lista del catálogo del SDK. Los intervalos remuestrean familias enteras (un problema con sus repeticiones y paráfrasis).

### anthropic/claude-opus-5-5

Estado: **medido**. Host: api.anthropic.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.5438** (sonda $0.0273, A $0.3062, B $0.0697, S $0.0755, E $0.0651).

Sonda (brazo A, 3 llamadas): salida 43 (stop), 94 (stop), 95 (stop) tokens.

Flujo: 16 únicos, 32 peticiones completadas — original 16, repeticion 10, superficie 2, lexica 2, variante-cifra 1, variante-palabra 1.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 100.0 % [100.0 %, 100.0 %] (30/30) | — | $0.3062 | — | 0 / 0 / 0 | 0.0 % | 2666 ms / 10997 ms | 0 |
| B | 100.0 % [100.0 %, 100.0 %] (30/30) | 0.0 pp [0.0, 0.0] | $0.0697 | 77.2 % [67.1 %, 83.9 %] | 10 / 0 / 0 | 90.8 % | 1802 ms / 3617 ms | 0 |
| E | 100.0 % [100.0 %, 100.0 %] (30/30) | 0.0 pp [0.0, 0.0] | $0.0651 | 78.8 % [68.2 %, 85.9 %] | 10 / 2 / 0 | 90.3 % | 2066 ms / 7747 ms | 0 |
| S | 100.0 % [100.0 %, 100.0 %] (30/30) | 0.0 pp [0.0, 0.0] | $0.0755 | 75.3 % [63.9 %, 83.5 %] | 10 / 0 / 0 | 90.8 % | 2090 ms / 5646 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):

| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |
|---|---|---|---|---|---|---|---|
| B | $0.3062 → $0.0697 | $0.2364 | 10 pos., $0.0974 | 22 pos., $0.1391 | $0.0000 → $0.1392 | 0 → 37086 | 0 → 1766 |
| E | $0.3062 → $0.0651 | $0.2411 | 12 pos., $0.1151 | 20 pos., $0.1260 | $0.0000 → $0.1257 | 0 → 33554 | 0 → 1766 |
| S | $0.3062 → $0.0755 | $0.2306 | 10 pos., $0.0974 | 22 pos., $0.1332 | $0.0000 → $0.1392 | 0 → 37086 | 0 → 1766 |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 2 pet., $0.0157 · measured: 22 pet., $-0.0018 · reference: 8 pet., $0.0030
- **E**: estimated: 4 pet., $0.0289 · measured: 20 pet., $-0.0018 · reference: 8 pet., $0.0030
- **S**: estimated: 2 pet., $0.0153 · measured: 22 pet., $-0.0018 · reference: 8 pet., $0.0030

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":2,"heldOut":1,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### anthropic/claude-sonnet-5-5

Estado: **medido**. Host: api.anthropic.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.4904** (sonda $0.0140, A $0.2856, B $0.0643, S $0.0649, E $0.0616).

Precio (sin fila en el catálogo, solo en el banco): https://platform.claude.com/docs/en/about-claude/pricing (consultado 2026-09-29): Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok (base input, 5m cache writes, 1h cache writes, cache hits, output).

Sonda (brazo A, 3 llamadas): salida 72 (stop), 94 (stop), 96 (stop) tokens.

Flujo: 31 únicos, 62 peticiones completadas — original 31, repeticion 19, superficie 3, lexica 3, variante-cifra 3, variante-palabra 3.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 100.0 % [100.0 %, 100.0 %] (56/56) | — | $0.2856 | — | 0 / 0 / 0 | 0.0 % | 1537 ms / 2683 ms | 0 |
| B | 100.0 % [100.0 %, 100.0 %] (56/56) | 0.0 pp [0.0, 0.0] | $0.0643 | 77.5 % [72.0 %, 81.7 %] | 20 / 0 / 0 | 93.1 % | 1369 ms / 1833 ms | 0 |
| E | 100.0 % [100.0 %, 100.0 %] (56/56) | 0.0 pp [0.0, 0.0] | $0.0616 | 78.4 % [73.0 %, 82.7 %] | 20 / 2 / 0 | 93.0 % | 1321 ms / 2103 ms | 0 |
| S | 100.0 % [100.0 %, 100.0 %] (56/56) | 0.0 pp [0.0, 0.0] | $0.0649 | 77.3 % [71.9 %, 81.6 %] | 20 / 0 / 0 | 93.1 % | 1310 ms / 2034 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 6 variantes, 1 servidas de caché, **0 con la respuesta de otra pregunta** · E: 6 variantes, 1 servidas de caché, **0 con la respuesta de otra pregunta** · S: 6 variantes, 1 servidas de caché, **0 con la respuesta de otra pregunta**


**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):

| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |
|---|---|---|---|---|---|---|---|
| B | $0.2856 → $0.0643 | $0.2213 | 20 pos., $0.0924 | 42 pos., $0.1289 | $0.0000 → $0.1294 | 0 → 72406 | 0 → 1766 |
| E | $0.2856 → $0.0616 | $0.2241 | 22 pos., $0.1011 | 40 pos., $0.1229 | $0.0000 → $0.1231 | 0 → 68874 | 0 → 1766 |
| S | $0.2856 → $0.0649 | $0.2207 | 20 pos., $0.0924 | 42 pos., $0.1284 | $0.0000 → $0.1294 | 0 → 72406 | 0 → 1766 |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 20 pet., $0.0175 · measured: 42 pet., $-0.0002
- **E**: estimated: 22 pet., $0.0191 · measured: 40 pet., $-0.0002
- **S**: estimated: 20 pet., $0.0175 · measured: 42 pet., $-0.0002

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":2,"heldOut":1,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### openai/gpt-5.5

Estado: **medido**. Host: api.openai.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.7049** (sonda $0.0294, A $0.2292, B $0.1526, S $0.1495, E $0.1442).

Sonda (brazo A, 3 llamadas): salida 94 (stop), 129 (stop), 106 (stop) tokens.

Flujo: 11 únicos, 22 peticiones completadas — original 11, repeticion 7, superficie 1, lexica 1, variante-cifra 1, variante-palabra 1.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 100.0 % [100.0 %, 100.0 %] (20/20) | — | $0.2292 | — | 0 / 0 / 0 | 0.0 % | 2041 ms / 3121 ms | 0 |
| B | 100.0 % [100.0 %, 100.0 %] (20/20) | 0.0 pp [0.0, 0.0] | $0.1526 | 33.4 % [6.8 %, 53.8 %] | 7 / 0 / 0 | 0.0 % | 1586 ms / 2655 ms | 0 |
| E | 100.0 % [100.0 %, 100.0 %] (20/20) | 0.0 pp [0.0, 0.0] | $0.1442 | 37.1 % [11.5 %, 56.3 %] | 7 / 1 / 0 | 0.0 % | 1577 ms / 2696 ms | 0 |
| S | 100.0 % [100.0 %, 100.0 %] (20/20) | 0.0 pp [0.0, 0.0] | $0.1495 | 34.8 % [8.8 %, 54.5 %] | 7 / 0 / 0 | 0.0 % | 1684 ms / 2810 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):

| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |
|---|---|---|---|---|---|---|---|
| B | $0.2292 → $0.1526 | $0.0767 | 7 pos., $0.0790 | 15 pos., $-0.0023 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |
| E | $0.2292 → $0.1442 | $0.0851 | 8 pos., $0.0874 | 14 pos., $-0.0023 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |
| S | $0.2292 → $0.1495 | $0.0797 | 7 pos., $0.0790 | 15 pos., $0.0007 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 1 pet., $0.0098 · measured: 15 pet., $0.0000 · reference: 6 pet., $0.0039
- **E**: estimated: 2 pet., $0.0190 · measured: 14 pet., $0.0000 · reference: 6 pet., $0.0039
- **S**: estimated: 1 pet., $0.0103 · measured: 15 pet., $0.0000 · reference: 6 pet., $0.0039

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":1,"heldOut":0,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### openai/gpt-5.6-sol

Estado: **medido**. Host: api.openai.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.2730** (sonda $0.0127, A $0.0854, B $0.0605, S $0.0594, E $0.0551).

Sonda (brazo A, 3 llamadas): salida 70 (stop), 49 (stop), 101 (stop) tokens.

Flujo: 16 únicos, 32 peticiones completadas — original 16, repeticion 10, superficie 2, lexica 2, variante-cifra 1, variante-palabra 1.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 100.0 % [100.0 %, 100.0 %] (30/30) | — | $0.0854 | — | 0 / 0 / 0 | 93.2 % | 1975 ms / 3278 ms | 0 |
| B | 100.0 % [100.0 %, 100.0 %] (30/30) | 0.0 pp [0.0, 0.0] | $0.0605 | 29.2 % [9.5 %, 46.8 %] | 10 / 0 / 0 | 91.2 % | 1600 ms / 2653 ms | 0 |
| E | 100.0 % [100.0 %, 100.0 %] (30/30) | 0.0 pp [0.0, 0.0] | $0.0551 | 35.5 % [17.0 %, 51.1 %] | 10 / 2 / 0 | 90.6 % | 1881 ms / 3295 ms | 0 |
| S | 100.0 % [100.0 %, 100.0 %] (30/30) | 0.0 pp [0.0, 0.0] | $0.0594 | 30.4 % [9.3 %, 49.0 %] | 10 / 0 / 0 | 91.2 % | 1871 ms / 3067 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):

| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |
|---|---|---|---|---|---|---|---|
| B | $0.0854 → $0.0605 | $0.0249 | 10 pos., $0.0252 | 22 pos., $-0.0003 | $0.1357 → $0.0901 | 38454 → 25703 | 2724 → 2429 |
| E | $0.0854 → $0.0551 | $0.0303 | 12 pos., $0.0294 | 20 pos., $0.0009 | $0.1357 → $0.0814 | 38454 → 23267 | 2724 → 2340 |
| S | $0.0854 → $0.0594 | $0.0260 | 10 pos., $0.0252 | 22 pos., $0.0007 | $0.1357 → $0.0901 | 38454 → 25703 | 2724 → 2429 |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 2 pet., $0.0148 · measured: 22 pet., $0.0000 · reference: 8 pet., $0.0041
- **E**: estimated: 4 pet., $0.0302 · measured: 20 pet., $0.0000 · reference: 8 pet., $0.0041
- **S**: estimated: 2 pet., $0.0153 · measured: 22 pet., $0.0000 · reference: 8 pet., $0.0041

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":2,"heldOut":1,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### google/gemini-3.8-flash

Estado: **capa-falla** — every request of arms B, E, S failed through the layer (0 provider calls billed): provider 400: [{ "error": { "code": 400, "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.", "status": "INVALID_ARGUMENT", "details": [ { "@type": "type.. Host: generativelanguage.googleapis.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.2705** (sonda $0.0054, A $0.2651, B $0.0000, S $0.0000, E $0.0000).

Sonda (brazo A, 3 llamadas): salida 68 (stop), 107 (stop), 87 (stop) tokens. Pensamiento de Gemini facturado y ausente de completion_tokens: A 18945, B 0, S 0, E 0, sonda 276 tokens.

Flujo: 67 únicos, 134 peticiones completadas — original 67, repeticion 40, superficie 7, lexica 7, variante-cifra 7, variante-palabra 6.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 99.2 % [97.3 %, 100.0 %] (120/121) | — | $0.2651 | — | 0 / 0 / 0 | 0.0 % | 1561 ms / 4301 ms | 0 |
| B | — (falló en todas) | — | $0.0000 | — (no hubo llamadas: no es un ahorro) | — | — | — | **134** |
| E | — (falló en todas) | — | $0.0000 | — (no hubo llamadas: no es un ahorro) | — | — | — | **134** |
| S | — (falló en todas) | — | $0.0000 | — (no hubo llamadas: no es un ahorro) | — | — | — | **134** |

**Seguridad — variantes con otra respuesta:** B: 13 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 13 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 13 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: 
- **E**: 
- **S**: 

Respuestas cortadas por el tope: A 2, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":0,"heldOut":0,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### google/gemini-3.1-pro-preview

Estado: **capa-falla** — every request of arms B, E, S failed through the layer (0 provider calls billed): provider 400: [{ "error": { "code": 400, "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.", "status": "INVALID_ARGUMENT", "details": [ { "@type": "type.. Host: generativelanguage.googleapis.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.2762** (sonda $0.0205, A $0.2557, B $0.0000, S $0.0000, E $0.0000).

Sonda (brazo A, 3 llamadas): salida 69 (stop), 109 (stop), 91 (stop) tokens. Pensamiento de Gemini facturado y ausente de completion_tokens: A 9479, B 0, S 0, E 0, sonda 689 tokens.

Flujo: 17 únicos, 34 peticiones completadas — original 17, repeticion 10, superficie 2, lexica 2, variante-cifra 2, variante-palabra 1.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 100.0 % [100.0 %, 100.0 %] (31/31) | — | $0.2557 | — | 0 / 0 / 0 | 0.0 % | 4144 ms / 8494 ms | 0 |
| B | — (falló en todas) | — | $0.0000 | — (no hubo llamadas: no es un ahorro) | — | — | — | **34** |
| E | — (falló en todas) | — | $0.0000 | — (no hubo llamadas: no es un ahorro) | — | — | — | **34** |
| S | — (falló en todas) | — | $0.0000 | — (no hubo llamadas: no es un ahorro) | — | — | — | **34** |

**Seguridad — variantes con otra respuesta:** B: 3 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 3 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 3 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: 
- **E**: 
- **S**: 

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":0,"heldOut":0,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

## Suplemento: Gemini con el parche declarado del banco (NO es el producto) — run `80bee4`

> BENCH-SIDE PATCH, not the product: the bench's fetch strips prompt_cache_key from request bodies sent to generativelanguage.googleapis.com, which rejects it with a 400. Measures what the layer would save without that field; a 0.4.31 customer today gets the 400. Campos quitados en esta tirada: 334.

Misma semilla y mismo diseño; A se vuelve a medir en esta tirada para que el emparejamiento sea dentro de la misma. Gasto real: **$1.1639**. Hosts vistos: generativelanguage.googleapis.com (486); bloqueados: ninguno.

### google/gemini-3.8-flash (parche del banco)

Estado: **medido**. Host: generativelanguage.googleapis.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.6277** (sonda $0.0054, A $0.1980, B $0.1424, S $0.1438, E $0.1381).

Sonda (brazo A, 3 llamadas): salida 76 (stop), 82 (stop), 82 (stop) tokens. Pensamiento de Gemini facturado y ausente de completion_tokens: A 14989, B 11213, S 11589, E 11198, sonda 303 tokens.

Flujo: 50 únicos, 100 peticiones completadas — original 50, repeticion 30, superficie 5, lexica 5, variante-cifra 5, variante-palabra 5.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 98.9 % [96.3 %, 100.0 %] (89/90) | — | $0.1980 | — | 0 / 0 / 0 | 0.0 % | 1577 ms / 4528 ms | 0 |
| B | 100.0 % [100.0 %, 100.0 %] (90/90) | 1.1 pp [0.0, 3.8] | $0.1424 | 28.1 % [18.9 %, 36.5 %] | 30 / 0 / 0 | 0.0 % | 1436 ms / 3306 ms | 0 |
| E | 100.0 % [100.0 %, 100.0 %] (90/90) | 1.1 pp [0.0, 3.8] | $0.1381 | 30.2 % [20.8 %, 38.8 %] | 30 / 3 / 0 | 0.0 % | 1389 ms / 4099 ms | 0 |
| S | 100.0 % [100.0 %, 100.0 %] (90/90) | 1.1 pp [0.0, 3.8] | $0.1438 | 27.4 % [17.8 %, 36.3 %] | 30 / 0 / 0 | 0.0 % | 1466 ms / 4090 ms | 0 |

**Seguridad — variantes con otra respuesta:** B: 10 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 10 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 10 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):

| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |
|---|---|---|---|---|---|---|---|
| B | $0.1980 → $0.1424 | $0.0556 | 30 pos., $0.0536 | 70 pos., $0.0019 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |
| E | $0.1980 → $0.1381 | $0.0599 | 33 pos., $0.0588 | 67 pos., $0.0011 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |
| S | $0.1980 → $0.1438 | $0.0542 | 30 pos., $0.0536 | 70 pos., $0.0005 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 4 pet., $0.0058 · measured: 70 pet., $0.0000 · reference: 26 pet., $0.0029
- **E**: estimated: 7 pet., $0.0102 · measured: 67 pet., $0.0000 · reference: 26 pet., $0.0029
- **S**: estimated: 4 pet., $0.0058 · measured: 70 pet., $0.0000 · reference: 26 pet., $0.0029

Respuestas cortadas por el tope: A 4, B 3, E 3, S 2. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":3,"heldOut":1,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

### google/gemini-3.1-pro-preview (parche del banco)

Estado: **medido**. Host: generativelanguage.googleapis.com. Muestreo: `{}`. Tope de salida: 1024. Gasto real: **$0.5362** (sonda $0.0203, A $0.1483, B $0.1170, S $0.1245, E $0.1261).

Sonda (brazo A, 3 llamadas): salida 86 (stop), 117 (stop), 87 (stop) tokens. Pensamiento de Gemini facturado y ausente de completion_tokens: A 5428, B 4472, S 5206, E 4966, sonda 657 tokens.

Flujo: 12 únicos, 24 peticiones completadas — original 12, repeticion 7, superficie 2, lexica 1, variante-cifra 1, variante-palabra 1.

| Brazo | Exactitud [IC95 por familia] | Δ exactitud vs A | Coste medido | Ahorro medido vs A [IC95] | Aciertos exacta / semántica / otros | Entrada leída de caché del proveedor | Latencia p50 / p95 | Errores |
|---|---|---|---|---|---|---|---|---|
| A | 86.4 % [70.0 %, 100.0 %] (19/22) | — | $0.1483 | — | 0 / 0 / 0 | 0.0 % | 4707 ms / 90297 ms | 4 |
| B | 86.4 % [66.7 %, 100.0 %] (19/22) | 0.0 pp [-14.3, 12.0] | $0.1170 | 21.1 % [3.5 %, 40.3 %] | 5 / 0 / 0 | 0.0 % | 4762 ms / 87600 ms | 4 |
| E | 86.4 % [66.7 %, 100.0 %] (19/22) | 0.0 pp [-14.3, 12.0] | $0.1261 | 15.0 % [-9.0 %, 37.6 %] | 5 / 0 / 0 | 0.0 % | 4589 ms / 91963 ms | 3 |
| S | 86.4 % [66.7 %, 100.0 %] (19/22) | 0.0 pp [-14.3, 12.0] | $0.1245 | 16.1 % [-6.0 %, 39.3 %] | 5 / 0 / 0 | 0.0 % | 4374 ms / 88476 ms | 4 |

**Seguridad — variantes con otra respuesta:** B: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · E: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta** · S: 2 variantes, 0 servidas de caché, **0 con la respuesta de otra pregunta**


**Origen del ahorro medido** (coste(A) − coste(brazo) = caché de la capa + llamadas al proveedor; el descuento de prefijo es lo que el proveedor rebajó por leer de su caché, neto de la prima de escritura, en A y en el brazo):

| Brazo | Coste A → brazo | Ahorro | Servidas por la capa sin llamar | Con llamada (prefijo + ruido de salida) | Descuento de prefijo A → brazo | Tokens leídos de caché A → brazo | Tokens escritos A → brazo |
|---|---|---|---|---|---|---|---|
| B | $0.1483 → $0.1170 | $0.0314 | 5 pos., $0.0286 | 19 pos., $0.0027 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |
| E | $0.1483 → $0.1261 | $0.0222 | 5 pos., $0.0286 | 19 pos., $-0.0064 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |
| S | $0.1483 → $0.1245 | $0.0239 | 5 pos., $0.0286 | 19 pos., $-0.0047 | $0.0000 → $0.0000 | 0 → 0 | 0 → 0 |

**Ahorro que la capa se atribuye en su propio informe** (declarado, no medido por el banco; por base):

- **B**: estimated: 1 pet., $0.0042 · measured: 15 pet., $0.0000 · reference: 4 pet., $0.0012
- **E**: estimated: 1 pet., $0.0042 · measured: 16 pet., $0.0000 · reference: 4 pet., $0.0012
- **S**: estimated: 1 pet., $0.0042 · measured: 15 pet., $0.0000 · reference: 4 pet., $0.0012

Respuestas cortadas por el tope: A 0, B 0, E 0, S 0. Tokens comprimidos (libro 3): A 0, B 0, E 0, S 0.

Calibración del brazo S al terminar: `{"maxErrorRate":0.02,"confidence":0.95,"floor":null,"labeled":0,"heldOut":0,"heldOutAtFloor":0,"wrongHeldOutAtFloor":0,"minHeldOutToCertify":173,"nextTestAt":346}`.

Limitaciones del suplemento:

- Arms B, S and E ran the 0.4.31 SOURCE of the tag with devUnlicensed: true (--desde-fuente), not the npm tarball: the npm build has no unlicensed mode. The dist built from this source is byte-identical to the tarball's dist/index.js (sha256 in `procedencia`).
- Compression: the npm package ships no compressor (noopCompressor) and these requests carry no structuredData, so ledger 3 (compressed tokens) is 0 by construction; this battery cannot show a compression saving, and says so instead of reporting a 0 as a measured failure.
- Paraphrases are deterministic templates (case/punctuation, a preamble plus synonyms), not human rewrites; real paraphrases are harder for a lexical embedder, so semantic hit rates here are an upper bound for surface-level rewording.
- Variants (one number changed) have no published gold; they are used only to check whether another question's answer was served, never for accuracy.
- Each arm carries a distinct run/lane tag at the start of its system prompt, so no arm reads another arm's provider prompt cache. The tag costs the same few tokens in every arm.
- Stream size per model is set from a 3-request probe and the budget; models whose stream is smaller have wider intervals. Confidence intervals resample whole problem families (a problem with its repeats and paraphrases).
- Latency is wall-clock from this machine, with the arms of each request run one after another (A, B, S, E) and the models in parallel, so each model had at most one call in flight (at most two per provider, under the ≤3 rule shared with other runs on the same keys); it includes network and is not a provider SLA.
- Gemini ran through Google's OFFICIAL origin (generativelanguage.googleapis.com) but through its OpenAI-compatible endpoint (/v1beta/openai), because the harness has no native Google family: the same adapter in every arm, and the layer's provider id is the OpenAI-compatible one. Gemini's implicit prefix cache is automatic, so arm A benefits from it too.
- Gemini thinking tokens: through the OpenAI-compatible endpoint, completion_tokens EXCLUDES Gemini's thinking tokens, which Google bills as output; total_tokens includes them. The bench bills output as total_tokens − prompt_tokens (hidden thinking tokens per arm are in pensamientoOcultoPorBrazo: google/gemini-3.8-flash {"A":14989,"B":11213,"S":11589,"E":11198,"sonda":303}; google/gemini-3.1-pro-preview {"A":5428,"B":4472,"S":5206,"E":4966,"sonda":657}). The SDK's OpenAICompatibleProvider reads only completion_tokens, so the layer's OWN report under-counts Gemini's billed output in both its baseline and its actual.
- Reduced streams (same seed, so every arm of a model asks exactly the same requests in the same order): google/gemini-3.8-flash 50 uniques, google/gemini-3.1-pro-preview 12 uniques. The size comes from the 3-request probe and the hard cap; intervals widen accordingly.
- BENCH-SIDE PATCH, not the product: the bench's fetch strips prompt_cache_key from request bodies sent to generativelanguage.googleapis.com, which rejects it with a 400. Measures what the layer would save without that field; a 0.4.31 customer today gets the 400. Fields stripped in this run: 334.
- The no-network replay over the whole test split was not re-run here: it does not depend on the model and is published in gsm8k-0431.{json,md}.
- Every arm sends the same output cap, maxOutputTokens 1024 (0.4.31, #381: free-text requests can carry it; on api.openai.com it travels as max_completion_tokens). The 0.4.30 run had no cap; its longest answers were 957 (gpt-4o-mini) and 391 (gpt-5.4-mini) tokens, so this cap would not have cut any of them.
- Semantic cache in S and E is switched on with semanticCacheDefault: true on the layer (0.4.31, #380), not with savings.semanticCache on each request as in the 0.4.30 run. The no-network replay runs both mechanisms side by side (semantica-envio vs semantica-defecto-capa) to show they decide the same.
- google/gemini-3.1-pro-preview: 15 requests ended in a provider 429 («You exceeded your current quota») after the bench's retries, at positions 10, 11, 12, 13, 14 (the Google key is shared with other runs). They cost 0 and count as wrong in every arm; at position 10 arms B, S and E failed while A answered, which inflates their paired saving. Excluding the 5 positions where any arm failed, the measured saving is B 18.5 %, S 13.3 %, E 15.7 % (vs 21.1 %, 16.1 %, 15.0 % in the table).
- The output cap (1024) counts Gemini's thinking tokens: some Flash answers ended with finish_reason length (A 4, B 3, S 2, E 3 in this supplement; A 2 in the main run), in every arm alike.

## Limitaciones

- Arms B, S and E ran the 0.4.31 SOURCE of the tag with devUnlicensed: true (--desde-fuente), not the npm tarball: the npm build has no unlicensed mode. The dist built from this source is byte-identical to the tarball's dist/index.js (sha256 in `procedencia`).
- Compression: the npm package ships no compressor (noopCompressor) and these requests carry no structuredData, so ledger 3 (compressed tokens) is 0 by construction; this battery cannot show a compression saving, and says so instead of reporting a 0 as a measured failure.
- Paraphrases are deterministic templates (case/punctuation, a preamble plus synonyms), not human rewrites; real paraphrases are harder for a lexical embedder, so semantic hit rates here are an upper bound for surface-level rewording.
- Variants (one number changed) have no published gold; they are used only to check whether another question's answer was served, never for accuracy.
- Each arm carries a distinct run/lane tag at the start of its system prompt, so no arm reads another arm's provider prompt cache. The tag costs the same few tokens in every arm.
- Stream size per model is set from a 3-request probe and the budget; models whose stream is smaller have wider intervals. Confidence intervals resample whole problem families (a problem with its repeats and paraphrases).
- Latency is wall-clock from this machine, with the arms of each request run one after another (A, B, S, E) and the models in parallel, so each model had at most one call in flight (at most two per provider, under the ≤3 rule shared with other runs on the same keys); it includes network and is not a provider SLA.
- Gemini ran through Google's OFFICIAL origin (generativelanguage.googleapis.com) but through its OpenAI-compatible endpoint (/v1beta/openai), because the harness has no native Google family: the same adapter in every arm, and the layer's provider id is the OpenAI-compatible one. Gemini's implicit prefix cache is automatic, so arm A benefits from it too.
- Gemini thinking tokens: through the OpenAI-compatible endpoint, completion_tokens EXCLUDES Gemini's thinking tokens, which Google bills as output; total_tokens includes them. The bench bills output as total_tokens − prompt_tokens (hidden thinking tokens per arm are in pensamientoOcultoPorBrazo: google/gemini-3.8-flash {"A":18945,"B":0,"S":0,"E":0,"sonda":276}; google/gemini-3.1-pro-preview {"A":9479,"B":0,"S":0,"E":0,"sonda":689}). The SDK's OpenAICompatibleProvider reads only completion_tokens, so the layer's OWN report under-counts Gemini's billed output in both its baseline and its actual.
- anthropic/claude-sonnet-5-5 has NO row in src/pricing/catalogo.ts (not touched here). The bench measured it at the official price, https://platform.claude.com/docs/en/about-claude/pricing (consultado 2026-09-29): Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok (base input, 5m cache writes, 1h cache writes, cache hits, output). The layer's own report for that model uses its illustrative fallback price, so its declared savings for it are not comparable.
- Reduced streams (same seed, so every arm of a model asks exactly the same requests in the same order): anthropic/claude-opus-5-5 16 uniques, anthropic/claude-sonnet-5-5 31 uniques, openai/gpt-5.5 11 uniques, openai/gpt-5.6-sol 16 uniques, google/gemini-3.8-flash 67 uniques, google/gemini-3.1-pro-preview 17 uniques. The size comes from the 3-request probe and the hard cap; intervals widen accordingly.
- google/gemini-3.8-flash: arm A was measured, but the layer arms failed on every request, so there is NO savings or accuracy figure for them: every request of arms B, E, S failed through the layer (0 provider calls billed): provider 400: [{ "error": { "code": 400, "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.", "status": "INVALID_ARGUMENT", "details": [ { "@type": "type.
- google/gemini-3.1-pro-preview: arm A was measured, but the layer arms failed on every request, so there is NO savings or accuracy figure for them: every request of arms B, E, S failed through the layer (0 provider calls billed): provider 400: [{ "error": { "code": 400, "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.", "status": "INVALID_ARGUMENT", "details": [ { "@type": "type.
- The no-network replay over the whole test split was not re-run here: it does not depend on the model and is published in gsm8k-0431.{json,md}.
- Every arm sends the same output cap, maxOutputTokens 1024 (0.4.31, #381: free-text requests can carry it; on api.openai.com it travels as max_completion_tokens). The 0.4.30 run had no cap; its longest answers were 957 (gpt-4o-mini) and 391 (gpt-5.4-mini) tokens, so this cap would not have cut any of them.
- Semantic cache in S and E is switched on with semanticCacheDefault: true on the layer (0.4.31, #380), not with savings.semanticCache on each request as in the 0.4.30 run. The no-network replay runs both mechanisms side by side (semantica-envio vs semantica-defecto-capa) to show they decide the same.
- Spend outside this artifact, counted against each model's 1.25 USD cap: a 3-call probe run per model before the measurement (opus-5-5 $0.0281, sonnet-5-5 $0.0141, gpt-5.5 $0.0292, gpt-5.6-sol $0.0131, gemini-3.8-flash $0.0044 + ~$0.001 of thinking the probe did not yet count, gemini-3.1-pro-preview $0.0123 + ~$0.008 of thinking) and 8 direct Gemini calls (~$0.01 Flash, ~$0.025 Pro, estimated from usage) to check the thinking-token and implicit-cache usage shape.
- Gemini's implicit prefix cache reported 0 cached tokens in every arm of both runs (no prompt_tokens_details.cached_tokens ever came back through the compatible endpoint, also in a direct 3-call check with an identical 3374-token prefix). If Google applied an implicit-cache discount it is not visible here, so Gemini costs are an upper bound in every arm alike.

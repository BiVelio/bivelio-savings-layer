# MT-Bench A/B — gama alta — capa @bivelio/savings-layer 0.4.31 (2026-09-29)

- **Modo:** LIVE. **Brazo A:** llamada directa al API del proveedor. **Brazo B:** v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical).
- **Paquete:** `@bivelio/savings-layer@0.4.31` — fuente de v0.4.31 (00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c), verificado idéntico al tarball de npm; integrity `sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ== (tarball de npm; dist/index.js sha256 b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731 = build del fuente)`.
- **Verificación del fuente:** etiqueta `v0.4.31` = commit `00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c` (fetch de etiquetas: ok). Árbol cargado: `benchmarks/out/mt-bench/.fuente-v0.4.31 (git archive v0.4.31)`; 173 ficheros de `src/` + `packages/` comparados blob a blob con la etiqueta → diferencias: **ninguna**. `pnpm build` de ese árbol → `dist/index.js` sha256 `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`; tarball de npm (`npm pack`, integrity comprobada) → `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`: **idénticos**. Versión cargada: 0.4.31. Nota: el árbol de trabajo del repo (main) ya difiere de la etiqueta en `M src/version.ts` (commits posteriores a la release); por eso se carga la etiqueta extraída y no `src/` del repo.
- **Dataset:** fastchat-fijado — `lm-sys/FastChat@587d5cfa1609a43d192cedb8441cac3c17db105d` (Apache-2.0); sha256 verificados: question.jsonl `119565adbab82227…`, reference_answer/gpt-4.jsonl `f957a5bc977badb6…`, judge_prompts.jsonl `fd283293406d024f…`. No se versiona: se descarga y se comprueba en cada tirada.
- **Subconjunto:** orden estratificado por categoría con semilla 20260928; cualquier prefijo queda equilibrado (±1 por categoría). Se corta cuando el peor coste de la siguiente pregunta ya no cabe en el tope.
- **Juez:** `openai/gpt-4o` por pasarela, prompts de pares de FastChat (`pair-v2`, `pair-v2-multi-turn`, y `pair-math-v1*` con referencia en math/reasoning/coding), posiciones intercambiadas; si las dos partidas discrepan, empate. Turnos con respuestas byte-idénticas en A y B = empate sin juez (declarado aparte).
- **Topes duros (en código):** $1.2500 por modelo, sea cual sea su familia (A+B), $0.5000 de juez en total para esta tirada (libro de gasto propio). Cada llamada reserva su peor caso antes de salir.
- **Precio oficial citado (sin fila en el catálogo; el catálogo NO se ha tocado):** `claude-sonnet-5-5` 0.002/0.01 $ por 1k (cacheada 0.0002) — https://platform.claude.com/docs/en/about-claude/pricing, consultada el 2026-09-29: «Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok».
- **Gasto real total:** generación $3.7094 + juez $0.4518 = **$4.1612**.
- **Gasto acumulado de la batería** (libro de gasto LIVE de esta tirada gama alta: todas las invocaciones LIVE, incluidas las de humo de 1 pregunta y las recargas que completan el juicio): generación gpt-5.5 $0.7339, gpt-5.6-sol $0.8535, gemini-3.8-flash $0.0936, gemini-3.1-pro-preview $0.0286, claude-sonnet-5-5 $1.1885, claude-opus-5-5 $1.2048 = $4.1029; juez $0.4518 de $0.5000.
- **Hosts vistos** (guarda de `fetch`; solo se permiten `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `ai-gateway.vercel.sh`, `raw.githubusercontent.com`): `api.anthropic.com` ×221, `generativelanguage.googleapis.com` ×36, `ai-gateway.vercel.sh` ×76, `api.openai.com` ×84. Bloqueados: **ninguno**.
- **No medidos:** `gemini-3.8-flash` — no medible: brazo B, turno 2, HTTP 400 — Invalid JSON payload received. Unknown name "prompt_cache_key": Cannot find field.; `gemini-3.1-pro-preview` — no medible: brazo A, turno 1, HTTP 429 — You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 250, model: gemini-3.1-pro Please retry in 17h18m31.800615469s..

## Tabla por modelo

| modelo | preguntas | coste A | coste B | ahorro B vs A (IC95 estratificado) | clase del ahorro | ¿atribuible a la capa? | control A/A: turno 1 con cuerpo idéntico (IC95) | caché de prefijo leída A/B (llamadas) | p50 A / B (ms) | p95 A / B (ms) | B gana / A gana / empate (turnos) | tasa de victoria B (IC95) | gasto real (gen + juez) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-opus-5-5` | 18/80 ✂ | $0.6059 | $0.5990 | 1.6 % [-1.0 %, 3.9 %] | indistinguible de 0 | posible | 1.1 % [-2.9 %, 6.0 %] (n=18, indistinguible de 0) | 0/0 de 36 | 10353 / 10393 | 17689 / 17629 | 1 / 3 / 4 | 37.5 % [25.0 %, 50.0 %] | $1.2048 + $0.0910 |
| `claude-sonnet-5-5` | 37/80 ✂ | $0.5696 | $0.5741 | -0.8 % [-2.2 %, 0.8 %] | indistinguible de 0 | posible | 1.2 % [-2.0 %, 4.1 %] (n=37, indistinguible de 0) | 0/0 de 74 | 7485 / 7518 | 10734 / 11062 | 2 / 0 / 7 | 60.0 % [50.0 %, 70.0 %] | $1.1885 + $0.0958 |
| `gpt-5.5` | 8/80 ✂ | $0.2916 | $0.2855 | 2.1 % [2.1 %, 2.1 %] | muestra insuficiente | — | 10.5 % [-9.9 %, 19.0 %] (n=8, muestra insuficiente) | 0/0 de 16 | 6236 / 6330 | 27935 / 32819 | 0 / 1 / 7 | 43.8 % [31.3 %, 50.0 %] | $0.7339 + $0.1256 |
| `gpt-5.6-sol` | 13/80 ✂ | $0.3688 | $0.3703 | -0.2 % [-15.1 %, 12.0 %] | indistinguible de 0 | **no** | -0.4 % [-31.3 %, 23.3 %] (n=13, indistinguible de 0) | 0/0 de 26 | 7325 / 5742 | 34004 / 35065 | 1 / 0 / 12 | 53.6 % [50.0 %, 60.7 %] | $0.8535 + $0.1393 |
| `gemini-3.8-flash` | — | — | — | — | — | — | — | — | — | — | — | — | $0.0936 + $0.0000 (brazos pagados de preguntas que no se completaron) — no medible: brazo B, turno 2, HTTP 400 — Invalid JSON payload received. Unknown name "prompt_cache_key": Cannot find field. |
| `gemini-3.1-pro-preview` | — | — | — | — | — | — | — | — | — | — | — | — | $0.0286 + $0.0000 (brazos pagados de preguntas que no se completaron) — no medible: brazo A, turno 1, HTTP 429 — You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit.  * Quota exceeded for metric: generativelanguage.googleapis.com/generate_requests_per_model_per_day, limit: 250, model: gemini-3.1-pro Please retry in 17h18m31.800615469s. |

✂ = subconjunto por presupuesto. La tasa de victoria de B cuenta el empate como ½: 50 % = sin diferencia. «Clase del ahorro»: *ahorro* solo si el IC95 entero está por encima de 0, *sobrecoste* si está entero por debajo; si contiene el 0, *indistinguible de 0*. «¿Atribuible?»: *no* cuando el cable de B solo difiere del de A en campos sin efecto directo en coste (`prompt_cache_key`), B no leyó de caché más que A y la capa declara 0 $: la diferencia es muestreo de la salida. El control A/A mide ese ruido donde la capa no tocó nada.

## Qué es medido y qué es modelado

- **Medido:** tokens de ambos brazos (el `usage` de la respuesta del proveedor, leído por el mismo transporte), latencia de pared por turno (el brazo B incluye el preproceso de la capa), aciertos/escrituras de caché de prefijo (`cache_read_input_tokens` / `cached_tokens`), el cuerpo exacto que cada brazo mandó, y el informe que la capa devolvió.
- **Modelado:** el dinero = tokens medidos × precio de lista del catálogo del propio paquete (`CATALOGO`), con la escritura de caché de Anthropic a 1,25×. No es la factura.
- **Juicio:** la calidad es la opinión de un juez LLM (gpt-4o), no una verdad de referencia; en math/reasoning/coding el juez ve la respuesta de referencia de GPT-4 de FastChat.
- **Intervalos:** bootstrap percentil con semilla (10 000 remuestreos): el ahorro, estratificado por categoría (cada categoría pesa igual) y también agrupado; la tasa de victoria, sobre la media por pregunta.

## `claude-opus-5-5`

- Preguntas: 18 completas de 80 planificadas (writing 3, roleplay 3, reasoning 2, math 2, coding 2, extraction 2, stem 2, humanities 2). Corte: el peor coste de la pregunta siguiente ($0.1259) no cabía: gastado $1.2048 de $1.2500.
- Tope de salida por llamada: 1024 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: no se envía (el modelo la rechaza con 400 o es de razonamiento), en ningún brazo. Precio: 0.004/0.02 $ por 1k (cacheada 0.0002).
- Coste A $0.6059 · B $0.5990 · ahorro agrupado 1.1 % [-2.0 %, 4.9 %] · estratificado 1.6 % [-1.0 %, 3.9 %] (**indistinguible de 0**) · Δ medio por pregunta 383.9 µ$ [-669.2, 1601.4] · Wilcoxon p 0.414.
- Tokens A: entrada 13344, caché leída 0, escrita 0, salida 27625 (razonamiento 0). B: 4855 / 0 / 7669 / 27060 (0).
- Atribución: posible efecto de la capa: el cable difiere en `messages:cache_control`; la capa declara ahorro. Control A/A (turno 1, cuerpo idéntico en 18 preguntas): «ahorro» 1.1 % [-2.9 %, 6.0 %] → indistinguible de 0.
- Truncadas por el tope: A 21, B 21. Respuestas byte-idénticas A=B: 4 turnos.
- Cable: 18/36 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `messages:cache_control` ×18. Modelo servido A: claude-opus-5-5; B: claude-opus-5-5.
- Lo que dice la capa: basis {"measured":36}, ahorro declarado $-0.0077 ({"measured":-0.007669}), coste declarado $0.5990 frente a $0.5990 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":36}; ruta {"NO_RETRIEVAL":14,"SINGLE_RETRIEVAL":19,"MULTI_HOP_RETRIEVAL":3}.
- Calidad: 8 turnos de 4 preguntas (18 llamadas al juez, cortado por el tope del juez); B gana 1, A gana 3, empate 4 (de ellos 0 por partidas discrepantes y 0 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 0; tasa de victoria B 37.5 % [25.0 %, 50.0 %]. Por categoría: writing 0/1/1, roleplay 1/1/0, reasoning 0/1/1, math 0/0/2.
- Gasto real: A $0.6059 + B $0.5990 = $1.2048 de $1.2500; juez $0.0910 de $0.0990. Reservas superadas: 0.

## `claude-sonnet-5-5`

- Preguntas: 37 completas de 80 planificadas (writing 5, roleplay 5, reasoning 5, math 5, coding 5, extraction 4, stem 4, humanities 4). Corte: el peor coste de la pregunta siguiente ($0.0672) no cabía: gastado $1.1438 de $1.2053.
- Tope de salida por llamada: 1024 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: no se envía (el modelo la rechaza con 400 o es de razonamiento), en ningún brazo. Precio: 0.002/0.01 $ por 1k (cacheada 0.0002).
- Coste A $0.5696 · B $0.5741 · ahorro agrupado -0.8 % [-2.5 %, 0.9 %] · estratificado -0.8 % [-2.2 %, 0.8 %] (**indistinguible de 0**) · Δ medio por pregunta -121.3 µ$ [-373.4, 139.1] · Wilcoxon p 0.926.
- Tokens A: entrada 26759, caché leída 0, escrita 0, salida 51612 (razonamiento 0). B: 9464 / 0 / 16327 / 51438 (0).
- Atribución: posible efecto de la capa: el cable difiere en `messages:cache_control`, `messages`; la capa declara ahorro. Control A/A (turno 1, cuerpo idéntico en 37 preguntas): «ahorro» 1.2 % [-2.0 %, 4.1 %] → indistinguible de 0.
- Truncadas por el tope: A 35, B 34. Respuestas byte-idénticas A=B: 9 turnos.
- Cable: 37/74 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `messages:cache_control` ×36, `messages` ×1. Modelo servido A: claude-sonnet-5-5; B: claude-sonnet-5-5.
- Lo que dice la capa: basis {"measured":74}, ahorro declarado $-0.0082 ({"measured":-0.008164}), coste declarado $0.5741 frente a $0.5741 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":74}; ruta {"NO_RETRIEVAL":27,"SINGLE_RETRIEVAL":36,"MULTI_HOP_RETRIEVAL":11}.
- Calidad: 9 turnos de 5 preguntas (19 llamadas al juez, cortado por el tope del juez); B gana 2, A gana 0, empate 7 (de ellos 0 por partidas discrepantes y 0 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 1; tasa de victoria B 60.0 % [50.0 %, 70.0 %]. Por categoría: writing 1/0/1, roleplay 1/0/1, reasoning 0/0/2, math 0/0/2, coding 0/0/1.
- Gasto real: A $0.5696 + B $0.5741 = $1.1438 de $1.2500; juez $0.0958 de $0.1055. Reservas superadas: 0.

## `gpt-5.5`

- Preguntas: 8 completas de 80 planificadas (writing 1, roleplay 1, reasoning 1, math 1, coding 1, extraction 1, stem 1, humanities 1). Corte: el peor coste de la pregunta siguiente ($0.6269) no cabía: gastado $0.5771 de $1.0932.
- Tope de salida por llamada: 4096 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: no se envía (el modelo la rechaza con 400 o es de razonamiento), en ningún brazo. Precio: 0.005/0.03 $ por 1k (cacheada 0.0005).
- Coste A $0.2916 · B $0.2855 · ahorro agrupado 2.1 % [-4.4 %, 9.7 %] · estratificado 2.1 % [2.1 %, 2.1 %] (**muestra insuficiente**) · Δ medio por pregunta 771.2 µ$ [-1136.2, 3715.0] · Wilcoxon p 0.736.
- Tokens A: entrada 4151, caché leída 0, escrita 0, salida 9029 (razonamiento 1785). B: 3595 / 0 / 0 / 8916 (1754).
- Atribución: sin muestra suficiente. Control A/A (turno 1, cuerpo idéntico en 8 preguntas): «ahorro» 10.5 % [-9.9 %, 19.0 %] → muestra insuficiente.
- Truncadas por el tope: A 0, B 0. Respuestas byte-idénticas A=B: 1 turnos.
- Cable: 8/16 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `prompt_cache_key` ×8. Modelo servido A: gpt-5.5-2026-04-23; B: gpt-5.5-2026-04-23.
- Lo que dice la capa: basis {"measured":16}, ahorro declarado $0.0000 ({"measured":0}), coste declarado $0.2855 frente a $0.2855 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":16}; ruta {"NO_RETRIEVAL":8,"MULTI_HOP_RETRIEVAL":3,"SINGLE_RETRIEVAL":5}.
- Calidad: 8 turnos de 4 preguntas (18 llamadas al juez, cortado por el tope del juez); B gana 0, A gana 1, empate 7 (de ellos 3 por partidas discrepantes y 0 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 0; tasa de victoria B 43.8 % [31.3 %, 50.0 %]. Por categoría: writing 0/0/2, roleplay 0/1/1, reasoning 0/0/2, math 0/0/2.
- Gasto real: A $0.2916 + B $0.2855 = $0.5771 de $1.2500; juez $0.1256 de $0.1377. Reservas superadas: 0.

## `gpt-5.6-sol`

- Preguntas: 13 completas de 80 planificadas (writing 2, roleplay 2, reasoning 2, math 2, coding 2, extraction 1, stem 1, humanities 1). Corte: el peor coste de la pregunta siguiente ($0.4480) no cabía: gastado $0.7391 de $1.1356.
- Tope de salida por llamada: 4096 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: no se envía (el modelo la rechaza con 400 o es de razonamiento), en ningún brazo. Precio: 0.004/0.02 $ por 1k (cacheada 0.0004).
- Coste A $0.3688 · B $0.3703 · ahorro agrupado -0.4 % [-21.2 %, 13.5 %] · estratificado -0.2 % [-15.1 %, 12.0 %] (**indistinguible de 0**) · Δ medio por pregunta -115.4 µ$ [-4842.5, 4599.1] · Wilcoxon p 0.444.
- Tokens A: entrada 7414, caché leída 0, escrita 0, salida 16958 (razonamiento 4741). B: 7389 / 0 / 0 / 17038 (4435).
- Atribución: el cable de B solo difiere de A en `prompt_cache_key`, B no leyó de caché más que A (0 frente a 0 llamadas) y la capa declara 0 $ de ahorro: la diferencia de coste es muestreo de la salida, no la capa. Control A/A (turno 1, cuerpo idéntico en 13 preguntas): «ahorro» -0.4 % [-31.3 %, 23.3 %] → indistinguible de 0.
- Truncadas por el tope: A 0, B 0. Respuestas byte-idénticas A=B: 3 turnos.
- Cable: 13/26 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `prompt_cache_key` ×13. Modelo servido A: gpt-5.6-sol; B: gpt-5.6-sol.
- Lo que dice la capa: basis {"measured":26}, ahorro declarado $0.0000 ({"measured":0}), coste declarado $0.3731 frente a $0.3703 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":26}; ruta {"NO_RETRIEVAL":14,"MULTI_HOP_RETRIEVAL":2,"SINGLE_RETRIEVAL":10}.
- Calidad: 13 turnos de 7 preguntas (21 llamadas al juez, cortado por el tope del juez); B gana 1, A gana 0, empate 12 (de ellos 2 por partidas discrepantes y 3 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 1; tasa de victoria B 53.6 % [50.0 %, 60.7 %]. Por categoría: writing 0/0/2, roleplay 1/0/1, reasoning 0/0/2, math 0/0/2, coding 0/0/2, extraction 0/0/2, stem 0/0/1.
- Gasto real: A $0.3688 + B $0.3703 = $0.7391 de $1.2500; juez $0.1393 de $0.1554. Reservas superadas: 0.

## `gemini-3.8-flash`

- Preguntas: 0 completas de 80 planificadas (—). Corte: 2 preguntas seguidas fallaron (último error: provider 400: [{
  "error": {
    "code": 400,
    "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.",
    "statu): se para el modelo para no seguir pagando el brazo A de preguntas que el B no completa.
- Tope de salida por llamada: 4096 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: FastChat por categoría (igual en A y B). Precio: 0.00075/0.00375 $ por 1k (cacheada 0.000075).
- Coste A $0.0000 · B $0.0000 · ahorro agrupado — · estratificado — (**sin datos**) · Δ medio por pregunta — · Wilcoxon p —.
- Tokens A: entrada 0, caché leída 0, escrita 0, salida 0 (razonamiento 0). B: 0 / 0 / 0 / 0 (0).
- Atribución: sin muestra suficiente. Control A/A (turno 1, cuerpo idéntico en 0 preguntas): «ahorro» — → sin datos.
- Truncadas por el tope: A 0, B 0. Respuestas byte-idénticas A=B: 0 turnos.
- Cable: 0/0 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: ninguno. Modelo servido A: ; B: .
- Lo que dice la capa: basis {}, ahorro declarado $0.0000 ({}), coste declarado $0.0000 frente a $0.0000 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {}; ruta {}.
- Calidad: 0 turnos de 0 preguntas (0 llamadas al juez); B gana 0, A gana 0, empate 0 (de ellos 0 por partidas discrepantes y 0 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 0; tasa de victoria B —. Por categoría: —.
- Gasto real: A $0.0288 + B $0.0158 = $0.0446 de $1.2500; juez $0.0000 de $0.0241. Reservas superadas: 0.
- Errores: `provider 400: [{ "error": { "code": 400, "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.", "status": "INVALID_ARGUMENT", "details": [ { "@type": "type.`; `B t2 HTTP 400: [{ "error": { "code": 400, "message": "Invalid JSON payload received. Unknown name \"prompt_cache_key\": Cannot find field.", "status": "INVALID_ARGUMENT", "details": [ { "@type": "type`

## `gemini-3.1-pro-preview`

- Preguntas: 0 completas de 80 planificadas (—). Corte: 2 preguntas seguidas fallaron (último error: provider 429: [{
  "error": {
    "code": 429,
    "message": "You exceeded your current quota, please check your plan and billing details. For more information): se para el modelo para no seguir pagando el brazo A de preguntas que el B no completa.
- Tope de salida por llamada: 4096 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: FastChat por categoría (igual en A y B). Precio: 0.002/0.012 $ por 1k (cacheada 0.0002).
- Coste A $0.0000 · B $0.0000 · ahorro agrupado — · estratificado — (**sin datos**) · Δ medio por pregunta — · Wilcoxon p —.
- Tokens A: entrada 0, caché leída 0, escrita 0, salida 0 (razonamiento 0). B: 0 / 0 / 0 / 0 (0).
- Atribución: sin muestra suficiente. Control A/A (turno 1, cuerpo idéntico en 0 preguntas): «ahorro» — → sin datos.
- Truncadas por el tope: A 0, B 0. Respuestas byte-idénticas A=B: 0 turnos.
- Cable: 0/0 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: ninguno. Modelo servido A: ; B: .
- Lo que dice la capa: basis {}, ahorro declarado $0.0000 ({}), coste declarado $0.0000 frente a $0.0000 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {}; ruta {}.
- Calidad: 0 turnos de 0 preguntas (0 llamadas al juez); B gana 0, A gana 0, empate 0 (de ellos 0 por partidas discrepantes y 0 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 0; tasa de victoria B —. Por categoría: —.
- Gasto real: A $0.0000 + B $0.0000 = $0.0000 de $1.2500; juez $0.0000 de $0.0482. Reservas superadas: 0.
- Errores: `brazo A gemini-3.1-pro-preview: HTTP 429`; `provider 429: [{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gem`; `A t1 HTTP 429: [{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/ge`; `B t1 HTTP 429: [{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/ge`; `B t1 HTTP 429: [{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/ge`

## Limitaciones

- MT-Bench es conversación de 2 turnos, prompts cortos (cientos de tokens) y sin herramientas ni contrato de salida: casi ninguna palanca de la capa tiene forma sobre la que actuar, y la caché de prefijo del proveedor no llega al mínimo de tramo (1024 tokens en OpenAI) en la mayoría de turnos. Este banco mide sobre todo que la capa NO empeore (coste, latencia, calidad) en tráfico de chat, no cuánto ahorra en tráfico agéntico.
- Una capa NUEVA por pregunta (caché y memoria frías): no hay repeticiones entre preguntas, así que la caché exacta/semántica de la capa no tiene ocasión de acertar. Es a propósito: el tráfico repetido va en otra batería.
- Subconjunto estratificado con semilla cuando las 80 preguntas no caben en el tope por modelo ($1.2500 cada uno); la calidad, además, solo se juzga en las preguntas que caben en $0.5000 de juez EN TOTAL (repartidos entre los modelos medidos), así que su intervalo es ancho.
- El juez es gpt-4o por Vercel AI Gateway: sesgos conocidos de juez LLM (verbosidad, autopreferencia de familia OpenAI). Las posiciones intercambiadas controlan el sesgo de posición, no los demás.
- Temperatura: la de FastChat por categoría solo en Gemini (0,7 en writing/roleplay). Opus 5.5 y Sonnet 5.5 rechazan `temperature` con 400 («`temperature` is deprecated for this model», humo LIVE) y gpt-5.x no la admite: en esos cuatro no se manda en ningún brazo y muestrean a la temperatura por defecto del proveedor. Parte de las diferencias de calidad entre A y B es muestreo, no la capa.
- El dinero es modelado: tokens medidos × precio de lista del catálogo del paquete. Descuentos negociados, batch o niveles no entran.
- Tope de salida NATIVO de la 0.4.31 en el brazo B (`maxOutputTokens` → `max_completion_tokens` en OpenAI, `max_tokens` en Anthropic y en el endpoint de Gemini) y el mismo campo y valor en el brazo A. Anthropic lleva 1024 (el de FastChat; Opus/Sonnet 5.5 son verbosos y parte de sus respuestas se truncan, por igual en A y B); gpt-5.x y Gemini 3.x llevan 4096 porque su razonamiento cuenta dentro. Esfuerzo de razonamiento: el POR DEFECTO de cada proveedor en los dos brazos (la 0.4.31 no tiene campo para fijarlo, y el brazo A tampoco lo manda).
- La latencia es de pared desde este portátil, con A y B lanzados a la vez para cada turno; incluye la red doméstica y la carga del proveedor en ese momento. Los reintentos por 429 se excluyen de p50/p95 por llamada. Otros ocho bancos compartían las claves a la vez (esta tirada: 1 pregunta a la vez, ≤ 2 peticiones simultáneas por proveedor).
- Gemini va por el endpoint COMPATIBLE con OpenAI (`https://generativelanguage.googleapis.com/v1beta/openai`): el arnés no tiene familia nativa de Google. Ese endpoint NO cuenta el razonamiento en `completion_tokens` (solo en `total_tokens`), y Google lo factura como salida: el banco mide la salida como `total_tokens − prompt_tokens` en los dos brazos (`usoDeGoogle`).
- Gemini y la 0.4.31: (1) la capa manda el id `google/gemini-…` TAL CUAL al host oficial de Gemini, que responde 404 (solo quita el prefijo a api.openai.com y Azure); el brazo B lleva `stripProviderPrefix: true`, la opción pública, y se declara aquí. (2) En el turno 2 la capa añade `prompt_cache_key` y Gemini lo rechaza con 400 («Unknown name "prompt_cache_key": Cannot find field»): el brazo B no completa ninguna conversación de 2 turnos. El cortacircuitos para el modelo tras 2 preguntas seguidas fallidas.
- gemini-3.1-pro-preview no se pudo medir en la tirada completa: la clave de Google agotó su cuota diaria de ese modelo (429, `generate_requests_per_model_per_day`, límite 250; otros bancos comparten la clave). En la tirada de humo sí respondió, y su brazo B dio el mismo 404 por el id `google/…` que Flash; con el prefijo quitado le esperaría el mismo 400 por `prompt_cache_key` (es el mismo camino de la capa), pero eso NO se llegó a medir en Pro.
- Los modelos de gama alta cuestan mucho por pregunta (gpt-5.5 ≈ 0,16 $ en el humo) y el tope es de 1,25 $ por modelo reservando el PEOR caso de la pregunta siguiente: varios quedan por debajo de las 10 preguntas pareadas que exige la clase del ahorro («muestra insuficiente»). Es el precio de un tope duro, no un fallo.
- Dos correcciones del arnés en esta tirada, las dos por discrepancias que enseñó la propia capa: (1) `cost.netSavings` de la 0.4.31 es una PROPORCIÓN por petición, no dólares; el arnés la sumaba como $ (inocuo mientras valía 0, como en la tirada del 2026-09-28). Ahora el ahorro declarado es `baselineEstimate − actual`. (2) gpt-5.6 desglosa `cache_write_tokens` y OpenAI la cobra a 1,25×; el lector del arnés no la leía cuando se generó esta tirada, así que el coste de gpt-5.6-sol está INFRAMEDIDO: en B exactamente $0.0027 (la diferencia entre el coste que declara la capa y el medido, en 2 turnos con prefijo ≥ 1024 tokens), en A como mucho $0.0041 (3 turnos con prompt ≥ 1024: 1319 + 1656 + 1088 tokens × 0,25 × $4/M). Menos del 2 % de cada brazo; no mueve la clase del ahorro. El lector ya lo lee para las tiradas siguientes.
- El libro de gasto de esta tirada incluye las tiradas de humo de 1 pregunta (la que descubrió el 400 de temperature en Anthropic y el 404 y el 400 de Gemini): el gasto por modelo del libro es el real; el de cada fila, el de la invocación que la produjo.

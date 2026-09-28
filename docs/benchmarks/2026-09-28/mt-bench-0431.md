# MT-Bench A/B — capa @bivelio/savings-layer 0.4.31 (2026-09-28)

- **Modo:** LIVE. **Brazo A:** llamada directa al API del proveedor. **Brazo B:** v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical).
- **Paquete:** `@bivelio/savings-layer@0.4.31` — fuente de v0.4.31 (00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c), verificado idéntico al tarball de npm; integrity `sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ== (tarball de npm; dist/index.js sha256 b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731 = build del fuente)`.
- **Verificación del fuente:** etiqueta `v0.4.31` = commit `00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c` (fetch de etiquetas: ok). Árbol cargado: `benchmarks/out/mt-bench/.fuente-v0.4.31 (git archive v0.4.31)`; 173 ficheros de `src/` + `packages/` comparados blob a blob con la etiqueta → diferencias: **ninguna**. `pnpm build` de ese árbol → `dist/index.js` sha256 `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`; tarball de npm (`npm pack`, integrity comprobada) → `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`: **idénticos**. Versión cargada: 0.4.31. Nota: el árbol de trabajo del repo (main) ya difiere de la etiqueta en `M src/version.ts` (commits posteriores a la release); por eso se carga la etiqueta extraída y no `src/` del repo.
- **Dataset:** fastchat-fijado — `lm-sys/FastChat@587d5cfa1609a43d192cedb8441cac3c17db105d` (Apache-2.0); sha256 verificados: question.jsonl `119565adbab82227…`, reference_answer/gpt-4.jsonl `f957a5bc977badb6…`, judge_prompts.jsonl `fd283293406d024f…`. No se versiona: se descarga y se comprueba en cada tirada.
- **Subconjunto:** orden estratificado por categoría con semilla 20260928; cualquier prefijo queda equilibrado (±1 por categoría). Se corta cuando el peor coste de la siguiente pregunta ya no cabe en el tope.
- **Juez:** `openai/gpt-4o` por pasarela, prompts de pares de FastChat (`pair-v2`, `pair-v2-multi-turn`, y `pair-math-v1*` con referencia en math/reasoning/coding), posiciones intercambiadas; si las dos partidas discrepan, empate. Turnos con respuestas byte-idénticas en A y B = empate sin juez (declarado aparte).
- **Topes duros (en código):** $0.8000 por modelo de OpenAI y $1.2500 por modelo de Anthropic (A+B), $0.5000 de juez en total. Cada llamada reserva su peor caso antes de salir.
- **Gasto real total:** generación $0.6085 + juez $0.3968 = **$1.0053**.
- **Gasto acumulado de la batería** (libro de gasto LIVE de la 0.4.31: todas las tiradas, incluida la de humo de 1 pregunta y la recarga que completa el juicio): generación gpt-4o-mini $0.0911, gpt-5.4-mini $0.5359 = $0.6270; juez $0.3968 de $0.5000.
- **Hosts vistos** (guarda de `fetch`; solo se permiten `api.anthropic.com`, `api.openai.com`, `ai-gateway.vercel.sh`, `raw.githubusercontent.com`): `api.anthropic.com` ×1, `api.openai.com` ×640, `ai-gateway.vercel.sh` ×55. Bloqueados: **ninguno**.
- **No medidos:** `claude-haiku-4-5` — no medible: clave inválida (GET /v1/models → 401; comprobación gratuita, 0 $ gastados); `claude-sonnet-5` — no medible: clave inválida (GET /v1/models → 401; comprobación gratuita, 0 $ gastados).

## Tabla por modelo

| modelo | preguntas | coste A | coste B | ahorro B vs A (IC95 estratificado) | clase del ahorro | ¿atribuible a la capa? | control A/A: turno 1 con cuerpo idéntico (IC95) | caché de prefijo leída A/B (llamadas) | p50 A / B (ms) | p95 A / B (ms) | B gana / A gana / empate (turnos) | tasa de victoria B (IC95) | gasto real (gen + juez) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `gpt-4o-mini` | 80/80 | $0.0450 | $0.0435 | 3.3 % [0.8 %, 5.9 %] | ahorro | **no** | 1.5 % [-1.2 %, 4.0 %] (n=80, indistinguible de 0) | 0/0 de 160 | 3479 / 3345 | 7647 / 7305 | 1 / 0 / 8 | 55.0 % [50.0 %, 65.0 %] | $0.0886 + $0.1243 |
| `gpt-5.4-mini` | 80/80 | $0.2555 | $0.2645 | -3.5 % [-8.4 %, 1.7 %] | indistinguible de 0 | **no** | -4.8 % [-12.7 %, 2.4 %] (n=80, indistinguible de 0) | 1/0 de 160 | 2056 / 2185 | 10465 / 9102 | 6 / 1 / 12 | 65.0 % [50.0 %, 80.0 %] | $0.5200 + $0.2725 |
| `claude-haiku-4-5` | — | — | — | — | — | — | — | — | — | — | — | — | 0 $ — no medible: clave inválida (GET /v1/models → 401; comprobación gratuita, 0 $ gastados) |
| `claude-sonnet-5` | — | — | — | — | — | — | — | — | — | — | — | — | 0 $ — no medible: clave inválida (GET /v1/models → 401; comprobación gratuita, 0 $ gastados) |

✂ = subconjunto por presupuesto. La tasa de victoria de B cuenta el empate como ½: 50 % = sin diferencia. «Clase del ahorro»: *ahorro* solo si el IC95 entero está por encima de 0, *sobrecoste* si está entero por debajo; si contiene el 0, *indistinguible de 0*. «¿Atribuible?»: *no* cuando el cable de B solo difiere del de A en campos sin efecto directo en coste (`prompt_cache_key`), B no leyó de caché más que A y la capa declara 0 $: la diferencia es muestreo de la salida. El control A/A mide ese ruido donde la capa no tocó nada.

## Qué es medido y qué es modelado

- **Medido:** tokens de ambos brazos (el `usage` de la respuesta del proveedor, leído por el mismo transporte), latencia de pared por turno (el brazo B incluye el preproceso de la capa), aciertos/escrituras de caché de prefijo (`cache_read_input_tokens` / `cached_tokens`), el cuerpo exacto que cada brazo mandó, y el informe que la capa devolvió.
- **Modelado:** el dinero = tokens medidos × precio de lista del catálogo del propio paquete (`CATALOGO`), con la escritura de caché de Anthropic a 1,25×. No es la factura.
- **Juicio:** la calidad es la opinión de un juez LLM (gpt-4o), no una verdad de referencia; en math/reasoning/coding el juez ve la respuesta de referencia de GPT-4 de FastChat.
- **Intervalos:** bootstrap percentil con semilla (10 000 remuestreos): el ahorro, estratificado por categoría (cada categoría pesa igual) y también agrupado; la tasa de victoria, sobre la media por pregunta.

## `gpt-4o-mini`

- Preguntas: 80 completas de 80 planificadas (writing 10, roleplay 10, reasoning 10, math 10, coding 10, extraction 10, stem 10, humanities 10).
- Tope de salida por llamada: 1024 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: FastChat por categoría (igual en A y B). Precio: 0.00015/0.0006 $ por 1k (cacheada 0.000075).
- Coste A $0.0450 · B $0.0435 · ahorro agrupado 3.3 % [0.8 %, 6.0 %] · estratificado 3.3 % [0.8 %, 5.9 %] (**ahorro**) · Δ medio por pregunta 18.8 µ$ [4.2, 35.2] · Wilcoxon p 0.026.
- Tokens A: entrada 43397, caché leída 0, escrita 0, salida 64203 (razonamiento 0). B: 42949 / 0 / 0 / 61804 (0).
- Atribución: el cable de B solo difiere de A en `prompt_cache_key`, B no leyó de caché más que A (0 frente a 0 llamadas) y la capa declara 0 $ de ahorro: la diferencia de coste es muestreo de la salida, no la capa. Control A/A (turno 1, cuerpo idéntico en 80 preguntas): «ahorro» 1.5 % [-1.2 %, 4.0 %] → indistinguible de 0.
- Truncadas por el tope: A 2, B 2. Respuestas byte-idénticas A=B: 30 turnos.
- Cable: 80/160 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `prompt_cache_key` ×80. Modelo servido A: gpt-4o-mini-2024-07-18; B: gpt-4o-mini-2024-07-18.
- Lo que dice la capa: basis {"measured":160}, ahorro declarado $0.0000 ({"measured":0}), coste declarado $0.0435 frente a $0.0435 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":160}; ruta {"NO_RETRIEVAL":50,"SINGLE_RETRIEVAL":82,"MULTI_HOP_RETRIEVAL":28}.
- Calidad: 9 turnos de 5 preguntas (16 llamadas al juez, cortado por el tope del juez); B gana 1, A gana 0, empate 8 (de ellos 5 por partidas discrepantes y 1 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 1; tasa de victoria B 55.0 % [50.0 %, 65.0 %]. Por categoría: writing 0/0/2, roleplay 0/0/2, reasoning 0/0/2, math 1/0/1, coding 0/0/1.
- Gasto real: A $0.0450 + B $0.0435 = $0.0886 de $0.8000; juez $0.1243 de $0.1814. Reservas superadas: 0.

## `gpt-5.4-mini`

- Preguntas: 80 completas de 80 planificadas (writing 10, roleplay 10, reasoning 10, math 10, coding 10, extraction 10, stem 10, humanities 10).
- Tope de salida por llamada: 4096 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: no se envía (modelo de razonamiento), en ningún brazo. Precio: 0.00075/0.0045 $ por 1k (cacheada 0.000075).
- Coste A $0.2555 · B $0.2645 · ahorro agrupado -3.5 % [-8.6 %, 1.6 %] · estratificado -3.5 % [-8.4 %, 1.7 %] (**indistinguible de 0**) · Δ medio por pregunta -111.8 µ$ [-276.1, 52.9] · Wilcoxon p 0.845.
- Tokens A: entrada 36155, caché leída 1280, escrita 0, salida 50733 (razonamiento 0). B: 38637 / 0 / 0 / 52329 (0).
- Atribución: el cable de B solo difiere de A en `prompt_cache_key`, B no leyó de caché más que A (0 frente a 1 llamadas) y la capa declara 0 $ de ahorro: la diferencia de coste es muestreo de la salida, no la capa. Control A/A (turno 1, cuerpo idéntico en 80 preguntas): «ahorro» -4.8 % [-12.7 %, 2.4 %] → indistinguible de 0.
- Truncadas por el tope: A 0, B 0. Respuestas byte-idénticas A=B: 6 turnos.
- Cable: 80/160 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `prompt_cache_key` ×80. Modelo servido A: gpt-5.4-mini-2026-03-17; B: gpt-5.4-mini-2026-03-17.
- Lo que dice la capa: basis {"measured":160}, ahorro declarado $0.0000 ({"measured":0}), coste declarado $0.2645 frente a $0.2645 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":160}; ruta {"NO_RETRIEVAL":52,"SINGLE_RETRIEVAL":84,"MULTI_HOP_RETRIEVAL":24}.
- Calidad: 19 turnos de 10 preguntas (39 llamadas al juez, cortado por el tope del juez); B gana 6, A gana 1, empate 12 (de ellos 6 por partidas discrepantes y 0 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 1; tasa de victoria B 65.0 % [50.0 %, 80.0 %]. Por categoría: writing 0/0/4, roleplay 1/0/2, reasoning 1/0/1, math 0/0/2, coding 0/0/2, extraction 0/1/1, stem 2/0/0, humanities 2/0/0.
- Gasto real: A $0.2555 + B $0.2645 = $0.5200 de $0.8000; juez $0.2725 de $0.3757. Reservas superadas: 0.

## Limitaciones

- MT-Bench es conversación de 2 turnos, prompts cortos (cientos de tokens) y sin herramientas ni contrato de salida: casi ninguna palanca de la capa tiene forma sobre la que actuar, y la caché de prefijo del proveedor no llega al mínimo de tramo (1024 tokens en OpenAI) en la mayoría de turnos. Este banco mide sobre todo que la capa NO empeore (coste, latencia, calidad) en tráfico de chat, no cuánto ahorra en tráfico agéntico.
- Una capa NUEVA por pregunta (caché y memoria frías): no hay repeticiones entre preguntas, así que la caché exacta/semántica de la capa no tiene ocasión de acertar. Es a propósito: el tráfico repetido va en otra batería.
- Subconjunto estratificado con semilla cuando las 80 preguntas no caben en el tope por modelo ($0.8000 OpenAI / $1.2500 Anthropic); la calidad, además, solo se juzga en las preguntas que caben en $0.5000 de juez EN TOTAL (repartidos entre los modelos medidos), así que su intervalo es ancho.
- El juez es gpt-4o por Vercel AI Gateway: sesgos conocidos de juez LLM (verbosidad, autopreferencia de familia OpenAI). Las posiciones intercambiadas controlan el sesgo de posición, no los demás.
- Temperatura de FastChat por categoría (0,7 en writing/roleplay): parte de las diferencias de calidad entre A y B en esas categorías es muestreo, no la capa. Los dos brazos muestrean igual; gpt-5.4-mini no acepta temperature y no se manda en ningún brazo.
- El dinero es modelado: tokens medidos × precio de lista del catálogo del paquete. Descuentos negociados, batch o niveles no entran.
- Tope de salida NATIVO de la 0.4.31 en el brazo B (`maxOutputTokens` → `max_completion_tokens` en OpenAI, `max_tokens` en Anthropic) y el mismo campo y valor en el brazo A. gpt-5.4-mini lleva 4096 (su razonamiento cuenta dentro); FastChat usa 1024.
- La latencia es de pared desde este portátil, con A y B lanzados a la vez para cada turno; incluye la red doméstica y la carga del proveedor en ese momento. Los reintentos por 429 se excluyen de p50/p95 por llamada. Otros tres bancos compartían las claves a la vez.

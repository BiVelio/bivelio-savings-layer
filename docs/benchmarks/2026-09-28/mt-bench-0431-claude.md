# MT-Bench A/B — capa @bivelio/savings-layer 0.4.31 (2026-09-28)

- **Modo:** LIVE. **Brazo A:** llamada directa al API del proveedor. **Brazo B:** v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical).
- **Paquete:** `@bivelio/savings-layer@0.4.31` — fuente de v0.4.31 (00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c), verificado idéntico al tarball de npm; integrity `sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ== (tarball de npm; dist/index.js sha256 b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731 = build del fuente)`.
- **Verificación del fuente:** etiqueta `v0.4.31` = commit `00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c` (fetch de etiquetas: ok). Árbol cargado: `benchmarks/out/mt-bench/.fuente-v0.4.31 (git archive v0.4.31)`; 173 ficheros de `src/` + `packages/` comparados blob a blob con la etiqueta → diferencias: **ninguna**. `pnpm build` de ese árbol → `dist/index.js` sha256 `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`; tarball de npm (`npm pack`, integrity comprobada) → `b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731`: **idénticos**. Versión cargada: 0.4.31. Nota: el árbol de trabajo del repo (main) ya difiere de la etiqueta en `M src/version.ts` (commits posteriores a la release); por eso se carga la etiqueta extraída y no `src/` del repo.
- **Dataset:** fastchat-fijado — `lm-sys/FastChat@587d5cfa1609a43d192cedb8441cac3c17db105d` (Apache-2.0); sha256 verificados: question.jsonl `119565adbab82227…`, reference_answer/gpt-4.jsonl `f957a5bc977badb6…`, judge_prompts.jsonl `fd283293406d024f…`. No se versiona: se descarga y se comprueba en cada tirada.
- **Subconjunto:** orden estratificado por categoría con semilla 20260928; cualquier prefijo queda equilibrado (±1 por categoría). Se corta cuando el peor coste de la siguiente pregunta ya no cabe en el tope.
- **Juez:** `openai/gpt-4o` por pasarela, prompts de pares de FastChat (`pair-v2`, `pair-v2-multi-turn`, y `pair-math-v1*` con referencia en math/reasoning/coding), posiciones intercambiadas; si las dos partidas discrepan, empate. Turnos con respuestas byte-idénticas en A y B = empate sin juez (declarado aparte).
- **Topes duros (en código):** $0.8000 por modelo de OpenAI y $1.2500 por modelo de Anthropic (A+B), $0.5000 de juez en total. Cada llamada reserva su peor caso antes de salir.
- **Gasto real total:** generación $1.8914 + juez $0.4002 = **$2.2916**.
- **Gasto acumulado de la batería** (libro de gasto LIVE de la 0.4.31: todas las tiradas, incluida la de humo de 1 pregunta y la recarga que completa el juicio): generación claude-haiku-4-5 $0.7688, claude-sonnet-5 $1.1225 = $1.8914; juez $0.4002 de $0.5000.
- **Hosts vistos** (guarda de `fetch`; solo se permiten `api.anthropic.com`, `api.openai.com`, `ai-gateway.vercel.sh`, `raw.githubusercontent.com`): `raw.githubusercontent.com` ×3, `api.anthropic.com` ×413, `ai-gateway.vercel.sh` ×54. Bloqueados: **ninguno**.

## Tabla por modelo

| modelo | preguntas | coste A | coste B | ahorro B vs A (IC95 estratificado) | clase del ahorro | ¿atribuible a la capa? | control A/A: turno 1 con cuerpo idéntico (IC95) | caché de prefijo leída A/B (llamadas) | p50 A / B (ms) | p95 A / B (ms) | B gana / A gana / empate (turnos) | tasa de victoria B (IC95) | gasto real (gen + juez) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `claude-haiku-4-5` | 80/80 | $0.3794 | $0.3894 | -2.6 % [-4.4 %, -1.0 %] | sobrecoste | **no** | -3.0 % [-5.9 %, -0.6 %] (n=80, sobrecoste) | 0/0 de 160 | 3915 / 4192 | 10623 / 10897 | 0 / 0 / 15 | 50.0 % [50.0 %, 50.0 %] | $0.7688 + $0.1578 |
| `claude-sonnet-5` | 23/80 ✂ | $0.5659 | $0.5566 | 2.5 % [-6.4 %, 10.7 %] | indistinguible de 0 | posible | -3.4 % [-15.1 %, 8.7 %] (n=23, indistinguible de 0) | 0/0 de 46 | 10621 / 9303 | 29615 / 24404 | 3 / 4 / 10 | 47.2 % [30.6 %, 66.7 %] | $1.1225 + $0.2424 |

✂ = subconjunto por presupuesto. La tasa de victoria de B cuenta el empate como ½: 50 % = sin diferencia. «Clase del ahorro»: *ahorro* solo si el IC95 entero está por encima de 0, *sobrecoste* si está entero por debajo; si contiene el 0, *indistinguible de 0*. «¿Atribuible?»: *no* cuando el cable de B solo difiere del de A en campos sin efecto directo en coste (`prompt_cache_key`, o marcas `cache_control` que el proveedor ignoró porque no escribieron ni leyeron un token), B no leyó de caché más que A y la capa declara 0 $: la diferencia es muestreo de la salida. El control A/A mide ese ruido donde la capa no tocó nada.

## Qué es medido y qué es modelado

- **Medido:** tokens de ambos brazos (el `usage` de la respuesta del proveedor, leído por el mismo transporte), latencia de pared por turno (el brazo B incluye el preproceso de la capa), aciertos/escrituras de caché de prefijo (`cache_read_input_tokens` / `cached_tokens`), el cuerpo exacto que cada brazo mandó, y el informe que la capa devolvió.
- **Modelado:** el dinero = tokens medidos × precio de lista del catálogo del propio paquete (`CATALOGO`), con la escritura de caché de Anthropic a 1,25×. No es la factura.
- **Juicio:** la calidad es la opinión de un juez LLM (gpt-4o), no una verdad de referencia; en math/reasoning/coding el juez ve la respuesta de referencia de GPT-4 de FastChat.
- **Intervalos:** bootstrap percentil con semilla (10 000 remuestreos): el ahorro, estratificado por categoría (cada categoría pesa igual) y también agrupado; la tasa de victoria, sobre la media por pregunta.

## `claude-haiku-4-5`

- Preguntas: 80 completas de 80 planificadas (writing 10, roleplay 10, reasoning 10, math 10, coding 10, extraction 10, stem 10, humanities 10).
- Tope de salida por llamada: 1024 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: FastChat por categoría (igual en A y B). Precio: 0.001/0.005 $ por 1k (cacheada 0.0001).
- Coste A $0.3794 · B $0.3894 · ahorro agrupado -2.6 % [-4.6 %, -0.9 %] · estratificado -2.6 % [-4.4 %, -1.0 %] (**sobrecoste**) · Δ medio por pregunta -125.3 µ$ [-216.9, -43.6] · Wilcoxon p 0.990.
- Tokens A: entrada 45605, caché leída 0, escrita 0, salida 66759 (razonamiento 0). B: 46556 / 0 / 0 / 68573 (0).
- Caché de prefijo: cuerpos con `cache_control` A 0 / B 80 de 160 llamadas por brazo; llamadas que ESCRIBIERON A 0 / B 0 (tokens 0 / 0); que LEYERON A 0 / B 0 (tokens 0 / 0). Prima de escritura pagada A $0.0000 / B $0.0000; ahorro por lecturas A $0.0000 / B $0.0000; neto de la caché en B $0.0000 (0.00 % del coste de B).
- Atribución: el cable de B solo difiere de A en `messages:cache_control`, las marcas `cache_control` de B no escribieron ni leyeron un token (tramo por debajo del mínimo del modelo: el proveedor las ignora), B no leyó de caché más que A (0 frente a 0 llamadas) y la capa declara 0 $ de ahorro: la diferencia de coste es muestreo de la salida, no la capa. Control A/A (turno 1, cuerpo idéntico en 80 preguntas): «ahorro» -3.0 % [-5.9 %, -0.6 %] → sobrecoste.
- Truncadas por el tope: A 27, B 29. Respuestas byte-idénticas A=B: 30 turnos.
- Cable: 80/160 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `messages:cache_control` ×80. Modelo servido A: claude-haiku-4-5-20251001; B: claude-haiku-4-5-20251001.
- Lo que dice la capa: basis {"measured":160}, ahorro declarado (Σ baseline − actual) $0.0000 en 0 turnos distintos de 0 ({"measured":0}), coste declarado $0.3894 frente a $0.3894 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":160}; ruta {"NO_RETRIEVAL":50,"SINGLE_RETRIEVAL":83,"MULTI_HOP_RETRIEVAL":27}.
- Calidad: 15 turnos de 8 preguntas (23 llamadas al juez, cortado por el tope del juez); B gana 0, A gana 0, empate 15 (de ellos 6 por partidas discrepantes y 4 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 1; tasa de victoria B 50.0 % [50.0 %, 50.0 %]. Por categoría: writing 0/0/2, roleplay 0/0/2, reasoning 0/0/2, math 0/0/2, coding 0/0/2, extraction 0/0/2, stem 0/0/2, humanities 0/0/1.
- Gasto real: A $0.3794 + B $0.3894 = $0.7688 de $1.2500; juez $0.1578 de $0.1578. Reservas superadas: 0.

## `claude-sonnet-5`

- Preguntas: 23 completas de 80 planificadas (writing 3, roleplay 3, reasoning 3, math 3, coding 3, extraction 3, stem 3, humanities 2). Corte: el peor coste de la pregunta siguiente ($0.2318) no cabía: gastado $1.0281 de $1.2500.
- Tope de salida por llamada: 4096 (igual en A y B; en B, el `maxOutputTokens` nativo de la capa). Temperatura: no se envía (modelo de razonamiento), en ningún brazo. Precio: 0.002/0.01 $ por 1k (cacheada 0.0002).
- Coste A $0.5659 · B $0.5566 · ahorro agrupado 1.7 % [-8.9 %, 12.7 %] · estratificado 2.5 % [-6.4 %, 10.7 %] (**indistinguible de 0**) · Δ medio por pregunta 406.2 µ$ [-2114.2, 3196.9] · Wilcoxon p 0.652.
- Tokens A: entrada 24133, caché leída 0, escrita 0, salida 51767 (razonamiento 0). B: 13437 / 0 / 10064 / 50456 (0).
- Caché de prefijo: cuerpos con `cache_control` A 0 / B 23 de 46 llamadas por brazo; llamadas que ESCRIBIERON A 0 / B 6 (tokens 0 / 10064); que LEYERON A 0 / B 0 (tokens 0 / 0). Prima de escritura pagada A $0.0000 / B $0.0050; ahorro por lecturas A $0.0000 / B $0.0000; neto de la caché en B $-0.0050 (-0.90 % del coste de B).
- Atribución: posible efecto de la capa: el cable difiere en `messages:cache_control`; la capa declara sobrecoste (-0.005032 $). Control A/A (turno 1, cuerpo idéntico en 23 preguntas): «ahorro» -3.4 % [-15.1 %, 8.7 %] → indistinguible de 0.
- Truncadas por el tope: A 1, B 0. Respuestas byte-idénticas A=B: 3 turnos.
- Cable: 23/46 turnos con cuerpo idéntico (normalizado; en el turno 2, con la respuesta de B al turno 1 puesta en la historia de A) en A y B; campos que difieren: `messages:cache_control` ×23. Modelo servido A: claude-sonnet-5; B: claude-sonnet-5.
- Lo que dice la capa: basis {"measured":46}, ahorro declarado (Σ baseline − actual) $-0.0050 en 6 turnos distintos de 0 ({"measured":-0.005032}), coste declarado $0.5566 frente a $0.5566 medido; turnos cuyo conteo de tokens no cuadra con el proveedor: 0; llamadas extra al proveedor: 0; caché {"miss":46}; ruta {"NO_RETRIEVAL":18,"SINGLE_RETRIEVAL":21,"MULTI_HOP_RETRIEVAL":7}.
- Calidad: 17 turnos de 9 preguntas (31 llamadas al juez, cortado por el tope del juez); B gana 3, A gana 4, empate 10 (de ellos 3 por partidas discrepantes y 2 por respuestas idénticas); errores de lectura 0; turnos sin juzgar por el tope 1; tasa de victoria B 47.2 % [30.6 %, 66.7 %]. Por categoría: writing 0/1/2, roleplay 1/0/1, reasoning 0/1/1, math 0/0/2, coding 0/0/2, extraction 0/0/2, stem 0/2/0, humanities 2/0/0.
- Gasto real: A $0.5659 + B $0.5566 = $1.1225 de $1.2500; juez $0.2424 de $0.2424. Reservas superadas: 0.

## Limitaciones

- MT-Bench es conversación de 2 turnos, prompts cortos (cientos de tokens) y sin herramientas ni contrato de salida: casi ninguna palanca de la capa tiene forma sobre la que actuar, y la caché de prefijo del proveedor no llega al mínimo de tramo (1024 tokens en OpenAI y en claude-sonnet-5, 4096 en claude-haiku-4-5) en la mayoría de turnos. Este banco mide sobre todo que la capa NO empeore (coste, latencia, calidad) en tráfico de chat, no cuánto ahorra en tráfico agéntico.
- Una capa NUEVA por pregunta (caché y memoria frías): no hay repeticiones entre preguntas, así que la caché exacta/semántica de la capa no tiene ocasión de acertar. Es a propósito: el tráfico repetido va en otra batería.
- Subconjunto estratificado con semilla cuando las 80 preguntas no caben en el tope por modelo ($0.8000 OpenAI / $1.2500 Anthropic); la calidad, además, solo se juzga en las preguntas que caben en $0.5000 de juez EN TOTAL (repartidos entre los modelos medidos), así que su intervalo es ancho.
- El juez es gpt-4o por Vercel AI Gateway: sesgos conocidos de juez LLM (verbosidad, autopreferencia de familia OpenAI). Las posiciones intercambiadas controlan el sesgo de posición, no los demás.
- Temperatura de FastChat por categoría (0,7 en writing/roleplay): parte de las diferencias de calidad entre A y B en esas categorías es muestreo, no la capa. Los dos brazos muestrean igual; gpt-5.4-mini y claude-sonnet-5 no aceptan temperature y no se manda en ningún brazo.
- El dinero es modelado: tokens medidos × precio de lista del catálogo del paquete. Descuentos negociados, batch o niveles no entran.
- Tope de salida NATIVO de la 0.4.31 en el brazo B (`maxOutputTokens` → `max_completion_tokens` en OpenAI, `max_tokens` en Anthropic) y el mismo campo y valor en el brazo A. gpt-5.4-mini y claude-sonnet-5 llevan 4096 (su razonamiento —en Sonnet 5, el pensamiento adaptativo que corre por defecto sin `thinking`— cuenta dentro); FastChat usa 1024.
- Anthropic: una capa nueva por pregunta y solo 2 turnos. La capa marca `cache_control` en el turno 2 (fin del prefijo estable = la respuesta del turno 1), pero no hay turno 3 que lea esa escritura: en este banco la marca solo puede costar (prima 1,25× sobre el tramo escrito) y nunca amortizarse. En una conversación larga, esa misma marca es la que haría que el turno siguiente leyera a 0,1×; este banco no mide ese caso.
- claude-sonnet-5 piensa (adaptativo) por defecto y el pensamiento se omite en la respuesta (`display: omitted`) pero se factura dentro de `output_tokens`; el juez solo ve el texto. Los dos brazos lo hacen igual (ninguno manda `thinking`).
- La latencia es de pared desde este portátil, con A y B lanzados a la vez para cada turno; incluye la red doméstica y la carga del proveedor en ese momento. Los reintentos por 429 se excluyen de p50/p95 por llamada. Otros tres bancos compartían las claves a la vez.

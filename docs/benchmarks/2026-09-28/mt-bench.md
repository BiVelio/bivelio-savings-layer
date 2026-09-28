# MT-Bench A/B — `@bivelio/savings-layer` 0.4.30 (2026-09-28)

> **NO EJECUTADO. Este fichero no contiene ninguna medida.** El arnés está listo y
> validado sin red, pero la tirada LIVE se paró en el prevuelo, antes de la primera
> llamada de pago. **Gasto real: 0 $ en los cuatro modelos y 0 $ de juez.**

## Por qué no hay resultados

El brazo B tiene que ser la capa **tal como se instala de npm**
(`npm view @bivelio/savings-layer version` → `0.4.30`, integrity
`sha512-73eFHgLe…8BxL+w==`). El paquete publicado es **fail-closed**: `generate()`
solo corre con un `licenseKey` verificado contra la clave pública embebida, y en el
build publicado un `licenseGate` inyectado se descarta. `.env.bench` no trae
`BIVELIO_LICENSE_KEY`, así que el script sale con código 2:

```
MT-Bench LIVE: faltan variables (solo nombres): BIVELIO_LICENSE_KEY (el paquete publicado es fail-closed: sin licencia el brazo B no existe). No se ha hecho ninguna llamada de pago.
```

No se ha tomado ningún atajo: ni recoger una licencia con la clave de servicio, ni
medir el fuente con la verja abierta y llamarlo «el paquete». Cualquiera de los dos
habría dado un brazo B que no es lo que se pidió medir.

**Para desbloquear:** añadir `BIVELIO_LICENSE_KEY` (la licencia de la org, de
`/dashboard/install`) al `.env.bench` y correr `pnpm bench:mt-bench`. La tirada
sobrescribe este fichero y `mt-bench.json` con los resultados.

## Qué mide el arnés (`benchmarks/publicados/mt-bench/`)

| | |
| --- | --- |
| Dataset | FastChat `lm-sys/FastChat@587d5cfa1609a43d192cedb8441cac3c17db105d`, Apache-2.0. `question.jsonl` (80 preguntas, 2 turnos, 8 categorías), `reference_answer/gpt-4.jsonl` y `judge_prompts.jsonl`. **No se versiona:** se descarga en cada tirada y se aborta si el sha256 no coincide (`119565ad…`, `f957a5bc…`, `fd283293…`). |
| Brazo A | La conversación directa contra el API (Anthropic Messages / OpenAI Chat Completions), sin la capa. |
| Brazo B | La misma conversación por `createSavingsLayer` del paquete de npm 0.4.30 (+ `gpt-tokenizer@3.4.0`, como pide el README), con `AnthropicProvider` / `OpenAICompatibleProvider` del propio paquete, `licenseKey` y **sin** `licenseServerUrl` (sin metering ni llamada a casa). Una capa nueva por pregunta (cachés frías). |
| Medida | Los dos brazos pasan por el **mismo** `fetch` envuelto: se lee el `usage` de la respuesta del proveedor con el mismo lector, se guarda el cuerpo de la petición (nunca cabeceras) y se compara el cable A vs B. El informe de la capa (`basis`, `netSavings`, tokens) se guarda aparte para cotejar lo que **ella** dice con lo medido. |
| Muestreo | Temperatura de FastChat por categoría, igual en los dos brazos (gpt-5.4-mini: sin `temperature` en ninguno). Tope de salida igual en los dos: 1024 (4096 en gpt-5.4-mini, que razona). |
| Calidad | Juez gpt-4o por Vercel AI Gateway con los prompts de pares de FastChat (`pair-v2`, `pair-v2-multi-turn`; `pair-math-v1*` con referencia en math/reasoning/coding), posiciones intercambiadas, discrepancia = empate. Turnos byte-idénticos A=B: empate sin juez, contado aparte. |
| Estadística | Ahorro `1 − ΣB/ΣA` con bootstrap estratificado por categoría y agrupado, Wilcoxon sobre el Δ por pregunta, p50/p95 de latencia por turno, tasa de victoria de B (empate = ½) con bootstrap sobre la media por pregunta. |
| Presupuesto | **En código:** 1,25 $ por modelo (A+B) y 0,25 $ de juez por modelo (1 $ en total). Cada llamada reserva su peor coste (entrada acotada, salida al tope, toda la entrada a precio de escritura de caché) y no sale si no cabe; el gasto real se persiste llamada a llamada en `benchmarks/out/mt-bench/gasto-live-acumulado.json`, así que repetir la tirada no reabre el tope. Si 80 preguntas no caben, se corre un prefijo del orden estratificado con semilla 20260928 (equilibrado ±1 por categoría) y se declara. |

## Qué cabe en el presupuesto (estimación, no medida)

Con respuestas medias de ~600 tokens: claude-haiku-4-5 y gpt-4o-mini caben enteros
(80 preguntas); claude-sonnet-5 unas 40 (5 por categoría); gpt-5.4-mini, según
cuánto razone, entre 50 y 80. El juez es el cuello de botella: a ~0,013 $ por turno
con las dos posiciones, 0,25 $ por modelo dan unas 8–10 preguntas juzgadas por modelo
(una por categoría), así que el intervalo de calidad saldrá **ancho**. Los turnos con
respuesta idéntica no gastan juez.

## Validación sin red

- `pnpm bench:mt-bench --mock`: los cuatro modelos, 80 preguntas con el dataset real en
  caché (sha256 verificado) y 16 con el sintético, pasando por transporte, tope, juez,
  estadística e informe. El brazo B del mock es un **stub declarado**, no la capa.
- `test/mt-bench-publicado.test.ts`: 14 tests del núcleo (fijación del dataset,
  equilibrio de cualquier prefijo del orden estratificado, lectura del `usage` de cada
  API, tope duro con reservas en vuelo, veredicto y combinación de partidas, prompts
  con referencia, diff del cable, redacción de credenciales).

## Limitaciones (del diseño, se mantienen cuando corra)

- MT-Bench es chat de 2 turnos con prompts cortos, sin herramientas ni contrato de
  salida: casi ninguna palanca de la capa tiene forma sobre la que actuar, y la caché
  de prefijo no llega al mínimo de tramo en la mayoría de turnos. Mide sobre todo que
  la capa **no empeore** coste, latencia y calidad en tráfico de chat.
- La capa 0.4.30 no admite tope de salida en texto libre con OpenAI (solo con contrato
  `response`): el transporte del banco añade `max_completion_tokens` idéntico en A y B
  como techo de gasto, y el diff del cable lo excluye.
- Juez LLM con sesgos conocidos (verbosidad, autopreferencia); las posiciones
  intercambiadas solo controlan el de posición. Con temperatura 0,7 en
  writing/roleplay, parte de las diferencias es muestreo.
- El dinero es modelado: tokens medidos × precio de lista del catálogo del paquete.

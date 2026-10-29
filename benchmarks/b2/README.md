# Protocolo B2 — Fase 1: evidencia de latencia separada

Este directorio contiene **utilidades del banco A/B y de los cuatro arneses semanales**, no un benchmark paralelo. Se conservan los escenarios, brazos, repeticiones, proveedores, costes y verjas de calidad existentes. Los cuatro arneses semanales (GSM8K, BFCL, XSTest y MT-Bench) emiten `B2-F1-v1`; los artefactos `B2-F0-v1` anteriores siguen siendo legibles.

## Dos presupuestos independientes

Toda request medida de cada brazo activo se cronometra de extremo a extremo con `performance.now()` (reloj monótono), en milisegundos. El resultado es visible por brazo y por celda/escenario:

- **SLO interactivo (`interactiveSlo`)**: p95 total ≤ **3000 ms** y máximo total ≤ **5000 ms**, con los mismos presupuestos absolutos de F0.
- **Trabajo local de capa (`layerWorkBudget`)**: p95 ≤ **250 ms** y máximo ≤ **500 ms**. Es un **presupuesto observado**, no un SLA futuro ni una promesa de disponibilidad.

Un proveedor lento puede hacer `interactiveSloOk=false` mientras `layerOk=true`: aprobar el trabajo de capa no aprueba el SLO interactivo. La verja de publicación recalcula ambos desde percentiles y estados; no confía en `latency.gate.approved` ni en los booleanos escritos en el artefacto. Un SLO no superado queda como advertencia visible; `deadline_exceeded`, una estructura inválida o el trabajo de capa fuera de presupuesto sí bloquean la release.

**B2-F1 no certifica respuestas completas ≤5 s en todos los modelos.** El máximo de 5000 ms evalúa las muestras conservadas de cada brazo y escenario; no demuestra que cualquier modelo, carga o respuesta futura termine dentro de ese tiempo.

## Muestras F1 y fallos conservados

Cada muestra de cada brazo contiene:

- `totalMs`: desde antes de invocar el brazo hasta su respuesta completa o su fallo.
- `providerWaitMs`: espera de los intentos al proveedor, incluida la lectura de la respuesta; no incluye los backoffs del banco.
- `layerWorkMs`: trabajo local de la capa entre esas esperas. No se calcula como un supuesto overhead puro `totalMs - providerMs`.
- `harnessMs`: esperas introducidas por el arnés, en particular sus backoffs. En los brazos directos también recoge su trabajo local fuera de la espera del proveedor.
- `estado`: `completed`, `deadline_exceeded` o `provider_error`.

Los totales incluyen muestras completas, errores y timeouts; ninguna se elimina antes de calcular percentiles. Los conteos `outcomes` por brazo tienen que cuadrar con `total.n`. Un `deadline_exceeded` conserva su duración y **siempre falla la petición y el SLO**, incluso si terminó por debajo de 5000 ms. Cuando se mida un deadline, ha de ser comparable en A y B; el presupuesto de 5000 ms no activa por sí solo un aborto a los 5 s.

La unidad principal sigue siendo la repetición pareada. Las llamadas auxiliares que ya entraban en los resúmenes no desaparecen. En MT-Bench también se conservan los turnos fallidos para latencia, aunque sigan fuera de los pares completos usados para coste y calidad. Los percentiles usan la interpolación lineal de tipo 7 de `benchmarks/latencia-gateways/nucleo.ts`.

## Lectura legacy B2-F0-v1

F0 conserva `total`, `provider` y `layerOverhead`, donde `layerOverhead = max(0, total - provider)` es solo su desglose histórico. No se transforma en evidencia F1: al evaluar un artefacto F0, `layerOk` es `null` porque no contiene una medida separada del trabajo de capa. El SLO total F0 se sigue recalculando con p95 ≤ 3000 ms y máximo ≤ 5000 ms.

El A/B existente puede conservar muestras F0 durante su migración. Su CSV mantiene `totalMs*` y `providerMs*` de cada repetición pareada; los artefactos nuevos de los cuatro arneses semanales guardan las muestras o los campos F1 necesarios para auditar los resúmenes.

## Coste, calidad, semillas y no inferioridad

La latencia no sustituye ninguna verja económica ni estadística:

- Se conservan `BVSALA_AB_SEED`, `config.resamples`, el muestreo pareado/adaptativo y los bootstrap estratificado/pooled existentes.
- El ahorro frente a B0/B1/B2 conserva sus IC y `floors.min`; cualquier afirmación sigue limitada por el menor suelo.
- La no inferioridad de respuesta sigue decidida por `veredictoDeCalidad`, `qualityFloor`, contratos y truncados. Una respuesta más rápida o barata no compensa una regresión de calidad.
- `sdk.asShipped` y las reglas de publicación anteriores permanecen intactos. Las verjas F1 son aditivas.

No se añade un IC nuevo para latencia: p50/p95/max describen las requests observadas; los IC existentes pertenecen al ahorro y no deben reinterpretarse como intervalos de latencia.

## `measured`, `estimated` y MOCK

En LIVE, `latency.status` es `measured` y `productionSla` es `assessed`: los presupuestos se evalúan sobre lo observado, sin prometer disponibilidad futura. En MOCK, `status` es `estimated`, `instrumental: true` y `productionSla: "not-applicable"`.

**Las duraciones MOCK solo prueban la instrumentación y la lógica de agregación/verja. Nunca son un SLA ni evidencia de latencia de producción.** El proveedor simulado no reproduce red, colas, generación ni variabilidad de un proveedor real.

La forma del artefacto es:

- `scenarios[].latency`: estado, presupuestos, resultados y resúmenes por brazo del escenario.
- `latency`: agregado con `interactiveSloOk`, `layerOk` y su verja con motivos.
- `latency.arms.*`: `total`, `providerWait`, `layerWork`, `harness`, `outcomes`, `interactiveSlo` y `layerWorkBudget` en F1; la forma histórica en F0.

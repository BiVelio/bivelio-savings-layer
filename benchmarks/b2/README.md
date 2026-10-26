# Protocolo B2 — Fase 0: valor demostrado y latencia

Este directorio contiene **utilidades del banco A/B existente**, no un benchmark paralelo. La ejecución sigue siendo `pnpm ab` (`benchmarks/ab-live.ts`), con los mismos escenarios, brazos A/A1/A2/B, repeticiones y proveedores.

## Presupuesto obligatorio

Toda request medida de cada brazo activo se cronometra de extremo a extremo con `performance.now()` (reloj monótono), en milisegundos:

- **p95 total ≤ 3000 ms**, tanto en el agregado como en cada escenario y brazo activo.
- **max total ≤ 5000 ms**, sin excepciones: cada request individual queda cubierta por el máximo de su brazo y escenario.

`p95 > 3000` o `max > 5000` bloquea la aprobación de publicación. El artefacto guarda todos los motivos en `latency.gate.reasons`; `publish-guard.ts` los recalcula desde los datos en vez de confiar en `latency.gate.approved`. Un percentil exactamente en el límite pasa.

La unidad principal es una repetición pareada. El sondeo de clasificación y las llamadas de amortización de caché de B también entran en sus resúmenes por escenario y agregado, para que una request auxiliar lenta no desaparezca. El CSV conserva las duraciones de las repeticiones pareadas; el JSON conserva los resúmenes que incluyen además esas llamadas auxiliares.

Los percentiles usan la interpolación lineal de tipo 7 ya empleada por `benchmarks/latencia-gateways/nucleo.ts`. `total` empieza antes de invocar el brazo y termina con su respuesta completa. `provider` suma las llamadas al proveedor anidadas en ese intervalo (incluidos reintentos, reparaciones y el contador del banco); no pretende aislar solo el tiempo de red. `layerOverhead = max(0, total - provider)`. En A/A1/A2 no hay capa BV-SALA que separar: total y proveedor usan la misma medida y el overhead es cero. En B, total incluye toda la capa.

## Coste, calidad, semillas y no inferioridad

La latencia no sustituye ninguna verja económica ni estadística:

- Se conservan `BVSALA_AB_SEED`, `config.resamples`, el muestreo pareado, el muestreo adaptativo y los bootstrap estratificado/pooled existentes.
- El ahorro frente a B0/B1/B2 conserva sus IC y `floors.min`; cualquier afirmación sigue limitada por el menor suelo.
- La no inferioridad de respuesta sigue decidida por `veredictoDeCalidad`, `qualityFloor`, contratos y truncados. Una respuesta más rápida o barata no compensa una regresión de calidad.
- `sdk.asShipped` y las reglas de publicación anteriores permanecen intactos. La verja de latencia es aditiva.

No se añade un IC nuevo para latencia en Fase 0: p50/p95/max son descriptivos de las requests observadas; los IC existentes pertenecen al ahorro y no deben reinterpretarse como intervalos de latencia.

## `measured`, `estimated` y MOCK

En LIVE, `latency.status` es `measured` y `productionSla` es `assessed`: el presupuesto se evalúa sobre lo observado, sin prometer disponibilidad futura. En MOCK, `status` es `estimated`, `instrumental: true` y `productionSla: "not-applicable"`.

**Las duraciones MOCK solo prueban la instrumentación y la lógica de agregación/verja. Nunca son un SLA ni evidencia de latencia de producción.** El proveedor simulado no reproduce red, colas, generación ni variabilidad de un proveedor real.

La forma del artefacto es:

- `scenarios[].latency`: estado, presupuestos y resúmenes por brazo del escenario.
- `latency`: el agregado del modelo y su veredicto con motivos.
- `ab-live-trials.csv`: `totalMs*` y `providerMs*` de cada brazo en cada repetición pareada.

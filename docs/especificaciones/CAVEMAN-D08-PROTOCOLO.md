# D08 · Corpus y cuatro brazos: protocolo PRE-REGISTRADO (plan Caveman 2026-10-14)

Estado: **corrida offline hecha; ensayo pagado NO hecho.** El presupuesto aprobado
para llamadas de pago en esta ronda es **0**. Este documento fija, ANTES de medir
con un modelo, cómo se medirá y qué se concluirá. Cambiarlo después de ver datos
pagados invalida el ensayo: cualquier cambio se fecha y se justifica aquí antes de
la corrida.

Depende de D06 (#479), que a su vez depende de D03 (#475) y D04 (#477).

## 1 · Brazos

| Brazo | Configuración fija | Código |
|---|---|---|
| **P-A** referencia | Savings actual; caché nativa del proveedor; mismo modelo y esfuerzo | cuerpo tal cual |
| **P-B** determinista | A + perfil `lossless-data` de D03 en cada `tool_result` (función pura, sin omisiones) | `src/compression/cola.ts` |
| **P-C** recuperable | A + proyección estable de D06 (`recoverable`, ejecutor real, almacén D04), con todo su sobrecoste: schema de `bvsala_retrieve` y rondas de recuperación | `src/compression/proyeccion-estable.ts` |
| **P-D** competidor | Caveman estándar aislado, release/commit fijados | **no ejecutado**: no hay release ni SHA fijado (D05 abierto) y la regla del dueño prohíbe descargar o ejecutar binarios de terceros |

El prefijo `P-` evita chocar con las letras de `benchmarks/brazos.ts` (A, A1, A2, B).
P-A/P-B/P-C aíslan la compresión. P-D es una comparación de producto: si cambia
la skill, el bucle o el setup, no es una prueba causal.

## 2 · Corpus

`benchmarks/ahorro-tool-results/corpus.ts`. Semilla, casos por familia y la
sha256 del corpus generado quedan en el manifiesto del artefacto.

Familias (plan p. 11):

- **`json-tablas`**: nulos, unicode (también escapado `é`), decimales con cero final, enteros > 2^53, un atípico en medio y orden significativo. 1 de cada 4 casos lleva una clave duplicada.
- **`logs-tests`**: fallos al principio, en medio o al final, varios fallos, warnings, stack traces, tests saltados y exit code.
- **`sesion-larga`**: 8 turnos que mezclan logs, JSON y `ls`.
- **`sesion-fork`**: el primer mensaje se edita a mitad. Se rompe el prefijo y D06 abre época.
- **`sesion-recuperacion-frecuente`**: 3 recuperaciones por caso.
- **`sesion-noop`**: solo salidas pequeñas; no hay nada que ganar.
- **`sesion-corta`**: un solo turno.

Las condiciones **frío** y **caliente** las pone el banco: en caliente, otra sesión acaba de escribir `tools + system`. Hay familias diseñadas para que comprimir **pierda**: no-op, corta, recuperación frecuente y fork.

Fuera de esta ronda:

- **código/herramientas y documentos**: necesitan un modelo que haga la tarea.
- **seguridad/protocolos**: está cubierta por los tests de contrato de D04/D06 (tenant ajeno, policy nueva, handle caducado, ámbito incompleto).

## 3 · Oráculos

- **Tarea.** La respuesta esperada sale de la verdad del generador (qué tests fallaron, qué literal se escribió), no de leer el texto con el código evaluado. Se compara la respuesta exacta (JSON canónico): conteos, literales, causas.
- **Integridad.** Cada original recuperado se compara por sha256 con la fuente.
- **Crítico** (cero fallos admitidos, cada excepción revisada a mano):
  - toda tarea de integridad numérica o literal: enteros grandes, decimales, claves duplicadas, conteo de fallos;
  - un original recuperado que no es el exacto;
  - un contenido con omisiones emitido sin recuperación disponible.
- **No crítico**: el resto (exit code, duración de un caso, conteo de `ls`).
- No hay juez LLM en esta ronda. Si se usa en el ensayo pagado, es evidencia auxiliar versionada y presupuestada, nunca árbitro de integridad.

## 4 · Métricas por brazo

- **Tokens por categoría**: entrada sin caché, escritura de caché y lectura de caché, con el simulador del carril sombra (offline) o el `usage` del proveedor (pagado).
- **Coste**:
  - offline: `usdEstimado`, catálogo versionado, USD, sin FX;
  - pagado: coste por intento (D02).
- **Coste por tarea correcta** (métrica principal) = coste de TODOS los intentos, recuperación incluida, ÷ tareas correctas. Si no hay ninguna correcta, el resultado es indefinido (`null`), nunca 0.
- **Tasa de éxito**, y en pagado también latencia p50/p95.
- **Sobrecoste**: tokens del schema de recuperación (todas las peticiones que lo llevan) y coste de las rondas de recuperación. Ya está dentro del coste total y se publica aparte.
- **Ahorro negativo**: casos en que el brazo sale más caro que P-A, por familia.
- **Motivos de bypass** (`transformId:reason`), contados al nacer cada segmento.

## 5 · Diseño estadístico (pre-registrado)

- **Unidad**: el caso (sesión). Todo se empareja por caso: los cuatro brazos ven la misma trayectoria y la misma semilla. Los intervalos son por caso o sesión, nunca por token.
- **Orden**: se alterna por caso (`directo` P-A→P-C en ids pares, `inverso` en impares).
  - Cada brazo tiene su propia caché y su propio almacén.
  - En pagado, cada brazo usa una sesión del proveedor separada, y frío/caliente se reportan por separado.
- **Distribución objetivo**:
  - hasta tener datos de tráfico real del segmento (modo `record` de D06), la mezcla es uniforme por familia y todo se publica por familia;
  - con datos `record`, se reponderan las familias a la mezcla observada, declarada en el manifiesto antes de correr.
- **Calidad, tareas no críticas**:
  - no inferioridad de P-B y P-C frente a P-A con margen δ = **1 punto porcentual** de tasa de éxito;
  - prueba pareada (diferencia de proporciones pareadas, IC 95 % bilateral de Newcombe para datos pareados);
  - se declara no inferior si el límite inferior del IC de (brazo − P-A) es > −1 pp;
  - un p-valor no significativo NUNCA se lee como equivalencia.
- **Calidad, tareas críticas**: cero fallos observados. Con n casos críticos y 0 fallos se publica la cota superior del 95 % (regla de tres: 3/n).
- **Coste**:
  - diferencia pareada por caso del coste por tarea, IC 95 % por bootstrap de casos (10 000 remuestreos, semilla fija en el manifiesto);
  - hay ahorro solo si el límite superior de (brazo − P-A) es < 0.
- **Tamaño de muestra** (fijado antes de correr):
  - n = (z₀.₉₇₅ + z₀.₈₀)² · π_d / δ², donde π_d es la proporción esperada de casos discordantes entre brazos;
  - π_d se estima en un piloto pagado de ≥ 200 casos pareados que NO cuenta para la conclusión. Con π_d = 0,02, n ≈ 1 568; con π_d = 0,04, n ≈ 3 136;
  - mínimo absoluto: 30 casos por familia;
  - 3 repeticiones por caso con la temperatura por defecto del producto; la unidad sigue siendo el caso (media de sus repeticiones).
- **Resultado**:
  - `superior`, `no inferior` o `inferior` en calidad, y `ahorra`, `no ahorra` o `encarece` en coste;
  - **`inconcluso`** si no se alcanza n, si el IC cruza el margen o si falta presupuesto. Un resultado inconcluso NO habilita rollout general (plan p. 12).
- **Excepciones**: todo fallo crítico, toda recuperación no exacta y todo caso descartado se listan con su id en el informe.

## 6 · Manifiesto

El artefacto (`benchmarks/evidencia/ahorro-tool-results-<fecha>.json`, campo `manifiesto`) fija:

- semilla, casos por familia, número de casos y sha256 del corpus generado;
- paquete y versión;
- tokenizador;
- versión del catálogo de precios (`PRECIOS_AL_DIA`);
- id y versión de cada transformación (`json-lossless`, `recoverable-preview`);
- revisión del adaptador de D06;
- regla de orden de los brazos.

El ensayo pagado añade:

- id exacto del modelo y región;
- versión del evaluador;
- `request_id` del proveedor por intento;
- presupuesto aprobado y gastado;
- fallos y artefactos saneados (sin contenido real ni claves).

## 7 · Resultado de la corrida offline (2026-10-15)

Reproducible bit a bit: `pnpm ahorro:banco` escribe el artefacto y `test/banco-ahorro-tool-results.test.ts` lo recalcula y exige igualdad. 84 casos (12 por familia). Coste de ENTRADA ESTIMADO con o200k (no es el tokenizador de Anthropic): los dólares son ilustrativos.

| Sonnet 5, frío | P-A | P-B | P-C |
|---|---|---|---|
| Ahorro frente a P-A (estimado) | 0 % | 9,47 % | 42,46 % |
| Casos con ahorro negativo | n/a | 0 / 84 | 28 / 84 |
| Tareas correctas (oráculo del generador) | 84 / 84 | 84 / 84 | 84 / 84 |
| P-C sin recuperar nada | n/a | n/a | 67 / 84 |
| Recuperaciones (todas exactas por sha256) | n/a | n/a | 43 / 43 |

Por familia, P-C pierde en todas las sesiones `sesion-noop` (−7,98 %: el schema de recuperación es sobrecoste puro), en 9/12 de `logs-tests` y en 4/12 de `sesion-corta`. P-B no encarece ninguna sesión. Opus 5.5 y la condición caliente dan cifras del mismo orden (ver el artefacto).

**Lo que esto NO dice.** El «modelo» del banco es un lector determinista que pide recuperar justo cuando la vista previa no basta. Un modelo real puede:

- no recuperar cuando debería: el peor caso es la columna «sin recuperar», 17 tareas perdidas;
- recuperar de más: más rondas, más coste;
- hacer más turnos.

Ninguna cifra offline mide calidad de modelo. El veredicto del artefacto es **`inconcluso`** hasta el ensayo pagado, que necesita presupuesto aprobado por el dueño.

Hallazgo de la corrida: la primera versión de D06 mandaba en vista previa un JSON con clave duplicada, porque el parser estricto lo rechazaba y lo tomaba por texto. Está corregido en #479 (commit 1c31fa1a), y el banco lo fija: `identity:duplicate_keys` = 3 en P-B y en P-C.

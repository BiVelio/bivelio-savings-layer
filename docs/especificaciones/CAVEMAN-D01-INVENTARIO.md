# D01 · Inventario real para el plan Caveman (2026-10-14)

**Base leída:** `origin/main` @ `5b616e8b`, paquete `@bivelio/savings-layer` 0.5.2. **Fuente del plan:** «BiVelio Savings — Plan de desarrollo Caveman 2026-10-14» (tickets D01–D12) y las líneas de adopción P0 de «Investigación y plan» del mismo día. Los dos son propuestas escritas sin ver este repositorio. Este documento es lo que el repositorio contiene de verdad.

**Cómo se hizo:** en solo lectura. Antes de escribir cada cita fichero:línea la he comprobado contra el código. Las que el mapeo previo daba mal están corregidas (ver §7). No he ejecutado inferencia, ni he hecho llamadas de pago, ni he aplicado migraciones.

**Leyenda de estados:** **implementado** = existe en `main` y tiene test. **parcial** = existe una pieza reutilizable, pero no cumple el contrato del plan. **no implementado** = no hay código.

---

## 1 · El camino real de una petición

### 1.1 SDK (`src/`)

```
adaptador (wire → ChatMessage[])
  anthropic-sdk.ts:156  tool_result → {role:"tool", toolCallId = tool_use_id}
  comun/prompt-ai-sdk.ts  (AI SDK; Mastra y LangChain usan los mismos helpers de comun/)
        │
SavingsPipeline.generate()            pipeline.ts:592
SavingsPipeline.generateStream()      pipeline.ts:645   ── motivoDeEntregaEntera :763
        └─► generateOptimized()       pipeline.ts:1955
              Etapa 1  resolvers                    :2050
              Etapa 2  caché exacta                 :2098
              Etapa 3  singleflight                 :2159
              Etapa 4  caché semántica              :2274
              Etapa 5  routing                      :2365
              Etapa 6  selección de herramientas    :2375
              Etapa 7  retrieval                    :2436
              Etapa 8  serialización                :2459
                ► COPIA SALIENTE  let messages = [...request.messages]   :2464
                ► finDelPrefijo = limiteDelPrefijoEstable(request.messages) :2493 (fn :6777)
              Etapa 9      compresión sidecar (long_context_compression)  :2602
              Etapa 9-bis  elisión por supersesión (tool_result_elision)  :2828
              Etapa 9-ter  compactación de la cola (toolOutputCompaction) :2914
                           resolverCompactacion :6754 → seleccionarCompactables (cola.ts:390)
              Etapa 10     llamada primaria                               :2993
                           llamarProveedor :775 | llamarProveedorEnStream :802
        │
proveedor (ChatMessage → wire)
  anthropic.ts:1626-1647  reagrupa role:"tool" en un user con tool_result; idDelCable :1660
  openai-compatible.ts:898  {role:"tool", tool_call_id}
  (no hay proveedor Responses: ningún function_call_output en src/)
```

**Lo que importa para el plan.** Todas las transformaciones posteriores a la etapa 8 trabajan sobre la copia de `:2464` y nunca tocan `request.messages`. La invariante «transformar una copia saliente, nunca el historial» **ya se cumple** en el SDK. Las etapas 1 a 9-ter las comparten stream y no-stream, así que lo que se enchufe ahí vale para los dos.

### 1.2 Gateway `bvsala` (`gateway/`)

```
bin.ts (env) ─► arrancarGateway()  servidor.ts:448  (OpcionesGateway :139)
  ruta local /_bvsala/v1/*  rutaLocal :1027 → atenderRutaLocal (informes-locales.ts:305, :348)
  requestId = randomUUID()  :980 · sesión x-claude-code-session-id :1130
  let cuerpoSaliente = cuerpo   :1285   (el original queda para medir y coalescer)
    1. diales de elisión   ajustarDiales      :1297  (canal.tiene("context_elision") :1294)
    2. modelo hermano      reescribirModelo   :1360
    3. esfuerzo            aplicarEsfuerzo    :1395
    4. rebaja de TTL       rebajarTtlDeCache  :1443
    5. TTL en sombra                          :1486
    6. include_usage (Chat) inyectarIncludeUsage :1521
    7. fetchImpl(url, {body: cuerpoSaliente}) :1540
  medición: medir :672 · noMedido / porQueSinUsoEnStream :641 · sin precio → no medido :928
```

Todas las palancas siguen el mismo patrón: flag local, después el feature de la org (fail-closed) y por último un try/catch que deja pasar el cuerpo intacto. Las palancas solo reescriben `/v1/messages`. `/chat/completions` y `/responses` solo se miden. Las respuestas SSE se observan, no se transforman. El parseo estricto que hace falta antes de reescribir ya existe: `parsearParaReescribir` (reserializacion.ts:148), sobre `textoUtf8Estricto` :42 y `reserializacionFiel` :66.

**Punto de extensión del gateway.** Una palanca nueva va entre la rebaja de TTL (`:1443-1500`) y la inyección de usage (`:1514`), con el mismo patrón.

---

## 2 · Matriz de capacidades del plan

| Capacidad del plan | Estado | Evidencia (comprobada) | Qué falta |
|---|---|---|---|
| **Compact JSON estricto** (tool results) | **parcial** | `minificarJson` cola.ts:172 quita espacios fuera de cadenas de forma textual, así que conserva enteros grandes y `1.0`. Verificación: `JSON.stringify(JSON.parse(…))` en :208. Lo activa `toolOutputCompaction` (config.ts:97, types.ts:244). Mínimo `DEFAULT_MIN_SAVED_CHARS = 256` (cola.ts:127) | **No rechaza claves duplicadas**: `JSON.parse` colapsa las dos copias y la comprobación pasa. El parser que sí las rechaza (`reserializacionFiel`, gateway/reserializacion.ts:66) no se usa en `src/`. No hay `reason` de bypass en el informe → **D03** |
| **Contenido protegido** | **parcial** | Solo se toca `role:"tool"`. Se saltan las vistas de fichero (`esVistaDeFichero` cola.ts:356). `ProtectedSpan` está en compression.ts:19. El último tool_result nunca se elide (`KEEP_TOOL_RESULTS` elision.ts:38). `redacted_thinking` pasa intacto (providers/types.ts:170, anthropic.ts:1323) | No hay una lista declarada (system, permisos, marcadores Privacy, bloques firmados, IDs, argumentos). No se reconoce ningún marcador Privacy. No hay ningún `assertProtectedBlocksIdentical` → D03 |
| **Handles recuperables** (scope/TTL/pin/cuota/revocación) | **no implementado** | Primitivas: `sha256` util/hash.ts:32. TTL y tope global en `InMemoryExactCache` (cache/exact.ts:44). El filtro de aislamiento por tenant/principal/época está en semantic.ts:539-547, e `invalidateEpoch` en :852. La revocación firmada con `seq` monótono existe solo para licencias (license/revocation.ts:51) | Store, handle ≥192 bits (`randomId` util/id.ts:27 da un UUIDv4 de 122 bits), pin, cuota por scope y revocación de handles. El `⟦ref:ext-…⟧` de 757a6134 tira el original y usa un hash de 32 bits, así que **no sirve de base** → **D04** |
| **Elección persistida** por sesión/rama/época | **no implementado** | Lo más parecido: `CacheBreakpointStore` (cache/breakpoint-store.ts:26), `MemoriaDePrefijos` (gateway/tarifa.ts:419, en proceso) y `cargarEspejo` (pipeline.ts:1435). 9-ter lo sustituye por **pureza**: la decisión es función solo del contenido | Clave `(tenant, project, session, branch, epoch, segment, source_hash, adapter_revision)`. No existen rama ni proyecto como scope → D06 |
| **Puerta de beneficio neto** | **parcial** | `minSavedChars` cuenta caracteres, no tokens. Existen `tokensFor` pipeline.ts:6071, `estimatorEsExacto` :6084, `VerjaDeCacheDePrefijo` prefix-cache-gate.ts:123, `tramoDeCache` politica-compresion.ts:81 y `FormatSelector` format-selector.ts:54 | No hay verja por tokenizador dentro de 9-ter. Tampoco existe un tokenizador local de Anthropic, así que fuera de los encodings OpenAI la verja será **estimada** y tendrá que llevar esa etiqueta |
| **Normalización de usage por intento** | **parcial** | `ProviderUsage` providers/types.ts:139 (`reasoningTokens?` :176, `complete?: false`). `UsoSse` gateway/medidor.ts:35. `mapearUsoResponses` :428 y `mapearUsoChat` :461 | `inputTokens` no significa lo mismo en cada proveedor: en Anthropic excluye lo cacheado y en OpenAI es `prompt_tokens`. No hay `input_uncached`. El gateway descarta reasoning. No hay registro por intento: reparación y descubrimiento se suman al ledger (accounting.ts:290, :308) → **D02** |
| **usage_basis / completeness** | **parcial** | `CostBasis` accounting.ts:41 describe cómo se valoró el dinero, no de dónde salió el contador. `callsWithoutUsage` :297 → `basis="unmeasured"` y baseline 0 (:519-521) | Falta `provider_reported \| client_observed \| estimated` y `completo/parcial/ausente` por campo → D02 |
| **Unpriced ≠ coste cero** | **parcial** | Gateway: sin precio de catálogo, la petición sale «no medida» (servidor.ts:928) y no se escribe un registro a $0. El único $0 es intencional, `sinCobro` (servidor.ts:703, `negativaNoCobrada` medidor.ts:157) | SDK: un modelo desconocido cae en `DEFAULT_COST_MODEL` (pipeline/config.ts:465), un precio ilustrativo distinto de cero, no `unpriced`. Con `complete:false`, `cost.actual` sale de contadores rellenados con 0 y puede quedar bajo o en 0 → D02 |
| **Recibos idempotentes** | **parcial** | En servidor: PK `bvsala.usage_ingest_seen (org_id, request_id)` (db/migrations/0009_ingest_idempotency.sql:20-25). Sufijo `:shadow` (metering/emitter.ts:170, :448). `gateway/recibo.ts` (`DatosDelRecibo` :44, `renderizarRecibo` :94) es un **resumen para la CLI**, no un recibo por intento | No existen `eventId`, `logicalCallId` ni `attemptId` distintos de `requestId` → D02 (en local) y D07 |
| **Presupuesto reserve/settle** | **no implementado** | No hay ningún concepto de tope de gasto. «presupuesto» en pipeline.ts:2539 es el presupuesto de **salida** | Máquina `planned→reserved→dispatched→settled/released/uncertain` → **D07**. Necesita migración |
| **Outbox** | **no implementado** (solo en memoria) | `UsageEmitter` emitter.ts:124: buffer en memoria con tope 1000 que tira lo más viejo (:174-176) y `stopAndDrain` :205 | Nada se persiste. Outbox transaccional con dedup por `event_id` → D07 |
| **Rutas /v1/savings/** | **no implementado** | Las rutas locales `/_bvsala/v1/status` y `/_bvsala/v1/reports…` (informes-locales.ts:342-344, `atenderRutaLocal` :348) solo se sirven en loopback y nunca se reenvían. Un `/v1/savings/*` público chocaría con los paths que van upstream | Recomendación: `/_bvsala/v1/savings/{optimize,retrieve,revoke}` en el plano de datos, y solo `receipts` (metadatos) en apps/web. La regla del protocolo es que el contenido nunca cruza al plano de control (packages/protocol/src/index.ts:432 `USAGE_ALLOWED_FIELDS`) |
| **Eval offline de 4 brazos** | **parcial** | `benchmarks/compactacion-de-cola/banco.ts`: `BRAZOS` :61 (`base`, `cola`, `vieja`, `mitad`), `medirCompactacionDeCola` :195, sin red. `MockProvider` providers/mock.ts:48. SSE falso `apiDeMensajes` test/helpers/api-de-mensajes-falsa.ts:193 | Faltan el brazo C (recuperable) y el D (competidor). La trayectoria es fija, así que no mide turnos extra. Las letras A/B de benchmarks/brazos.ts:178 chocan con las del plan → D08 |
| **Vectores de paridad TS/Python** | **no implementado** | `packages/python` (`bvsala`) es cliente del gateway (`_gateway.py`: `status` :148, `wrap` :171, `report` :205, `totals` :263). Su paridad se prueba con esquemas y e2e (test/python-cliente.test.ts) | No hay vectores JSON compartidos ni compactación en Python → D10 |
| **init / skill** | **implementado** (base) | `bvsala init`: `leerArgumentosDeInit` gateway/init.ts:122, `detectar` :258, `planear` :358, `escribirConPermiso` :669. Skill: skills/savings-mode/SKILL.md, instalado por `instalarSkill` gateway/skill.ts:128 | Un único perfil de skill (A11 pide breve/normal/exhaustivo). init no verifica una llamada ni enseña el recibo (A16, D11) |
| **MCP** | **no implementado** | En el repo no hay servidor MCP. «MCP» solo aparece como catálogo de herramientas del cliente (router/schema-on-demand.ts:157) | Todo → D12, fase dos |
| Modo sombra | **implementado** | `CadenaDeSimulacion` gateway/sombra.ts:569, `basis:"shadow"` | Se reutiliza tal cual para el modo `record`/`shadow` del plan |

---

## 3 · Tickets y líneas P0 → puntos de extensión

| ID | Qué pide | Dónde se engancha |
|---|---|---|
| **D01** | Este inventario | Este documento |
| **D02** Usage por intento | Normalizar sin perder el dialecto. Recibo idempotente. unpriced/parcial | Un módulo nuevo en `src/metering/`, alimentado por `ProviderUsage` y `UsoSse`. Clave `requestId:attemptN`. Antes de tocar el cable: allow-list del protocolo y migración (regla «servidor primero», protocol/index.ts:432) |
| **D03** JSON sin omisiones | Perfil lossless opt-in solo sobre tool results | Etapa 9-ter (pipeline.ts:2914-2991) y `minificarJson` (cola.ts:172). Llevar a `src/` la lógica de `reserializacionFiel`. El `reason` de bypass va en la traza |
| **D04** Recovery autorizado | Store, grants, scope, TTL/pin/cuota y revocación | Una interfaz nueva `AlmacenRecuperable`, con un default en memoria modelado sobre `InMemoryExactCache` (exact.ts:44). Handle de 24 bytes o más con `getRandomValues`. Rutas locales en `atenderRutaLocal` |
| **D05** Engine opcional | Release ≥3.0, SHA, SBOM, sidecar sin Cloud | Fuera del paquete núcleo, como `Compressor` inyectable (compression.ts) |
| **D06** Proyección estable | Tool runner y elecciones persistidas por época | Una interfaz hermana de `CacheBreakpointStore` (breakpoint-store.ts:26). Gateway: `atribucion.sessionId` + huella del system, como hace `MemoriaDePrefijos` |
| **D07** Reserve/settle | Reserva concurrente, exposición incierta | Nuevo. Gancho en `UsageEmitter.record`/`stopAndDrain`. Tablas nuevas (0036+), solo metadatos |
| **D08** Corpus y 4 brazos | Manifest, mocks, oráculos, sin gasto | `benchmarks/compactacion-de-cola/banco.ts` + `MockProvider` + `apiDeMensajes`. El artefacto sale con fecha nueva y lleva su test bit a bit |
| **D09** Operación/rollback | Límites, SLO, runbooks | docs/RUNBOOK-*.md, `RecuentoDeMedicion` (gateway/recuento.ts:34) |
| **D10** Paridad Python | Vectores comunes | `test/fixtures/…`, consumidos por vitest y por pytest (packages/python/tests) |
| **D11** init con evidencia | Verificar una llamada y enseñar el recibo | gateway/init.ts (`planear`/`escribirConPermiso`) + `GET /_bvsala/v1/reports/<id>` |
| **D12** MCP gobernado | Lectura de costes y oportunidades | Nuevo. Reutiliza la auth `bvk_…` de apps/web/app/api |
| **A01** P0 | Compactar JSON de tool results en el SDK | = D03 (9-ter) |
| **A02** P0 | Normalizar logs y tests sin pérdida | Transformaciones `ansi`, `carriage-return` y `repeated-lines` de cola.ts. Ya existen; las omisiones esperan a D04 |
| **A06** P0 | Lista de contenido protegido | D03: una lista declarada y un aserto de bloques idénticos sobre la copia saliente |
| **A11** P0 | savings-mode con perfiles breve/normal/exhaustivo | skills/savings-mode/SKILL.md + gateway/skill.ts:128 |
| **A16** P0 | init asistido con verificación | D11 |
| **A21** P0 | SavingsReport por tarea/sesión | `SavingsReport` contracts/types.ts:1209 + `attribution` :1231. Agregar por sesión **después** de D02 |
| **A22** P0 | Atribución org/proyecto/workflow | `org_id` solo existe en la licencia (license/verify.ts:44). Proyecto y workflow no existen todavía |
| **A23** P0 | Grado de evidencia | `CostBasis` (accounting.ts:41) + `usage_basis` de D02 |
| **A25** P0 | Pruebas pareadas por tarea | D08. Hoy hay `pnpm ab` en MOCK (benchmarks/transporte.ts) |
| **A31** P0 | Free con una mejora real | `toolOutputCompaction` es local y no necesita tarjeta, pero pide `long_context_compression` (pipeline.ts:2942). Es una decisión comercial |
| **A32** P0 | Demo sintética + verificador | `benchmarks/run.ts` (`pnpm demo`, MOCK) + corpus/verja-de-extraccion.ts:795 |
| **A33** P0 | Guías para agentes (llms.txt) | No existe ningún llms.txt en el repo ni en apps/web |

---

## 4 · Resultados medidos que condicionan el plan

1. **La capa intermedia de 757a6134 engordaba la petición.** Rama `origin/feat/caveman-toon-capa-intermedia`, no es ancestro de `main`. Medida con 3 peticiones reales: el turno pierde 17 caracteres y el prefijo gana 690, **neto +673 caracteres por petición**. TOON no llegó a dispararse. El handle `⟦ref:ext-…⟧` descarta el original. Conclusión: no se rescata como base. Solo se aprovecha la idea de tocar únicamente el tool_result del turno.
2. **Lo que decide el signo es cuándo se compacta** ([compresion-segura.md](../investigacion/2026-09-27/compresion-segura.md), l.19 y 193-195). Compactar al nacer da de +11 % a +37 % de entrada [simulado]. Compactar el mismo bloque un turno después, de +1,9 % a −148 %. Encender a mitad de sesión, de −5 % a −13 %. Esto obliga a que D03 decida con una función pura del bloque cuando nace y nunca reescriba historia. La elección persistida de D06 solo hace falta para lo que no es puro (recuperable, selección por consulta).
3. **TOON: −9 pp de precisión en tool-calling multiturno** ([COMPETENCIA-2026-09-26.md](../COMPETENCIA-2026-09-26.md):75, :126), con un ahorro medido de −15 % a −26 % frente a JSON. TOON es candidato y nunca va por defecto ([PLAN-CAMINO-AL-50.md](../PLAN-CAMINO-AL-50.md):387). D03 no incluye TOON.
4. **Preferir el `context_management` del proveedor** ([PLAN-S4-PALANCA.md](../PLAN-S4-PALANCA.md) §0, l.14-48). `clear_tool_uses` actúa después de la caché y lo declara `applied_edits`. El 75,2 % de las peticiones ya lo traen, y se observaron 0 `applied_edits` en 1.952. En Anthropic, cualquier reescritura en el cliente compite con esta vía, que no invalida el prefijo.
5. Caveman como estilo de salida: −16,4 % de salida y −12,0 % de coste con IC [−7,2; 21,8], que incluye 0 ([SKILL-MODO-AHORRO.md](../SKILL-MODO-AHORRO.md):72-95). La elisión de tool_result dio −16,7 % y la poda de herramientas, 35,7:1 en contra ([BITACORA-2026-09-10.md](../BITACORA-2026-09-10.md):28-40).

---

## 5 · Baseline y endpoint piloto

**El endpoint piloto NO está elegido.** La única base reproducible sin gasto es el banco en seco `benchmarks/compactacion-de-cola` (artefacto `benchmarks/evidencia/compactacion-de-cola-2026-09-27.json`, con su test bit a bit), que hace de brazo A/B **simulado**. No hay baseline de tráfico real del segmento.

Antes del piloto el dueño tiene que cerrar estas decisiones (plan, p. 15). Ninguna bloquea preparar código, contratos ni pruebas deterministas:

1. Proveedor, endpoint y framework prioritarios.
2. Límites de tamaño y SLO. El plan propone 100 ms, 1 MiB por segmento y 8 MiB por petición como hipótesis, no como capacidad.
3. Storage local o privado del cliente.
4. Retención y pins por modalidad. El plan propone 24 h, lease de 2 h y 256 MiB por sesión.
5. Política Privacy al recuperar. Hoy no hay integración con `bivelio-privacy-gateway`.
6. Criterio de tarea crítica y margen de no inferioridad.
7. Catálogo de precios y FX. Hoy: `PRECIOS_AL_DIA = "2026-09-29"` (src/pricing/catalogo.ts:56), solo en USD.
8. Autorizaciones y responsables de guardia.
9. Commit de Caveman y subconjunto elegido.
10. Exposición máxima con usage desconocido.

---

## 6 · Estado de los tickets

- **D02, D03 y D04 se están implementando en PRs paralelos**, sin producción, sin migraciones aplicadas y sin llamadas de pago:
  - `feat/uso-por-intento-d02`
  - `feat/json-estricto-d03`
  - `feat/almacen-recuperable-d04`
- **D05–D12 no están empezados.** Motivos:
  - **D05:** necesita elegir un commit de Caveman y revisión legal/OSS (decisión 9).
  - **D06:** depende de D04 y D05.
  - **D07:** necesita migraciones nuevas en `bvsala` y la decisión 10.
  - **D08:** necesita D02–D06 para tener los brazos B y C, y el plan estadístico (decisión 6). Los ensayos reales requieren gasto.
  - **D09:** necesita SLO y responsables (decisiones 2 y 8).
  - **D10–D12:** el plan los pone en fase dos.

---

## 7 · Citas del mapeo previo corregidas aquí

| Citada | Correcta |
|---|---|
| `cache/exact.ts:28` / `:47` | `ExactCache` :25, `InMemoryExactCache` :44 |
| `cache/breakpoint-store.ts:31` / `:47` | `CacheBreakpointStore` :26, `InMemoryCacheBreakpointStore` :43 |
| `elision.ts:90` (KEEP_TOOL_RESULTS) | :38 (`:90` es donde se aplica) |
| `util/id.ts:32` | `randomId` :27 |
| `informes-locales.ts:43-104` (rutas) | `rutaLocal` :305, `atenderRutaLocal` :348 |
| `emitter.ts:167-173` (`:shadow`) | :170 y :448 |

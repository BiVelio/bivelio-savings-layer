# Camino a la 0.5

> Documento interno. Estado a **2026-10-02**, con la 0.4.36 publicada (#444) y
> la candidata **0.5.0-rc.1** en el dist-tag `next` de npm (PR #434), y la
> 0.5.0 adelantada a hoy por decisión del dueño (criterio 5). La guía
> para clientes es [`MIGRAR-A-0.5.md`](MIGRAR-A-0.5.md) (en inglés; publicada
> en la web en `/migrate-to-0.5`) y el inventario de la API, con el veredicto
> de cada nombre, es [`INVENTARIO-API-0.5.json`](INVENTARIO-API-0.5.json).

## La decisión

«La 0.5 congela la API y publica una guía de migración 0.4 → 0.5; se permiten
cambios rompientes, documentados en un sitio» (dueño, 2026-09-29, decisión
`api-05`). Ninguna 0.4.x rompe nada: lo rompiente se anuncia en la 0.4.x con
`@deprecated` y se ejecuta en la 0.5.

La 0.5 sale cuando se cumplen los seis criterios acordados:

| # | Criterio | Estado hoy | Veredicto |
|---|---|---|---|
| 1 | Funciona con Anthropic, OpenAI y Gemini (nativo) sin errores causados por la capa en el banco | Anthropic, OpenAI y Gemini 3.8 Flash nativo: `capa-falla 0` en todas las celdas de las cuatro baterías del banco en vivo completo ([run 36795672930](https://github.com/BiVelio/bivelio-savings-layer/actions/runs/36795672930), main `5bec174`, 0.4.35; #442–#445). Gemini 3.1 Pro nativo, con 250 peticiones al día, en dos bancos parciales en vivo, uno por jornada de su cuota ([run 36925298365](https://github.com/BiVelio/bivelio-savings-layer/actions/runs/36925298365) y [run 36977332185](https://github.com/BiVelio/bivelio-savings-layer/actions/runs/36977332185), main `b349d7a`, 0.4.36; #448, #449): `capa-falla 0` en las cuatro baterías | 🟢 |
| 2 | Nunca empeora la respuesta | En el run 36795672930 y en los dos parciales de Gemini 3.1 Pro, todos los B−A dentro del ruido, 0 respuestas de otra pregunta y 0 llamadas cambiadas, en los tres proveedores. El recorte a 8 del catálogo tipado ya no existe: sin `maxTools` no se poda (#419) | 🟢 |
| 3 | Nunca cobra lo que no debe | XSTest en el run 36795672930 y en los parciales de Gemini 3.1 Pro: 0 negativas cacheadas y 0 acreditadas en todos los modelos medidos, Gemini incluido. La negativa dentro de una salida estructurada de OpenAI, vista por una sonda en vivo, ya no se cachea ni acredita (#431, 0.4.35). Licencia Medir sin comisión (#417) | 🟢 |
| 4 | El informe cuadra con la factura ±2 %, con el ahorro nativo aparte | `informe/factura` 0,00 % en todas las celdas medidas, y el ahorro nativo sale aparte (#412). Esa «factura» es uso × precio de lista: la comparación con la factura real (`benchmarks/banco-semanal/factura.ts`) espera las claves de administrador del dueño | 🟢 contra el precio de lista (§4, punto 4); la factura real, pendiente de las claves del dueño |
| 5 | Banco semanal en CI como puerta de release | #413 y #421; `publish.yml` no publica si el último banco en vivo **completo** en main falló o tiene más de 8 días (los «vivo parcial» no cuentan). **Decisión del dueño (2026-10-02): «adelántalo a hoy».** La 0.5.0 sale **hoy, 2-oct**, en cuanto un banco en vivo completo en main salga en verde con la candidata; sustituye al plan de viernes y sábado («Salimos a producción este fin de semana», del mismo día). La puerta de `publish.yml` no cambia ni se relaja. El banco del 2-oct sobre la 0.5.0-rc.1 ([run 36998187601](https://github.com/BiVelio/bivelio-savings-layer/actions/runs/36998187601), main `e779dc3`) salió en rojo por un solo motivo: un 529 «Overloaded» de Anthropic contado como `capa-falla`; #450 lo trata como el 429. Banco en verde: [run 37004817524](https://github.com/BiVelio/bivelio-savings-layer/actions/runs/37004817524) (main `b03bb5b`, el mismo código del SDK que la 0.5.0-rc.1), «sin regresiones»: 0 infracciones y 0 `capa-falla`. A mitad de la tirada se agotó el saldo de la API de Anthropic: GSM8K de los 4 modelos de Claude y XSTest de Sonnet 5, Sonnet 5.5 y Opus 5.5 salieron «no medible» en los dos brazos. Esas celdas están medidas en verde, con el mismo SDK, en el run 36998187601 (salvo la petición de Opus con el 529 de sobrecarga). **Decisión del dueño (2-oct): publicar con este banco** en vez de recargar el saldo y repetirlo | 🟢 decisión del dueño: banco en vivo completo en verde (run 37004817524) |
| 6 | API pública congelada con guía | Inventario, test y guía (#418); nombres nuevos y alias con aviso (#419, 0.4.33); `@deprecated` y avisos en la 0.4.34 (#424, #429). **PR #434**: raíz cerrada nombre a nombre, 73 exports y 7 campos fuera, `finishReason` cerrado, CLI solo en inglés, inventario 0.5.0 todo `estable` sin `pendientes`, guía final publicada en la web (`/migrate-to-0.5`) y la 0.5.0-rc.1 en `next` | 🟢 en la 0.5.0-rc.1; la 0.5.0 la congela |

La tabla y [«Lo que falta, en orden»](#lo-que-falta-en-orden) son el estado
vigente. Las secciones 1 a 5 conservan el detalle con el que se escribieron
(#418, mañana del 29, contra la 0.4.31/0.4.32): lo que allí figura como
«abierto» está fusionado.

## 1 · Tres proveedores sin errores de la capa

**Lo verificable hoy** (artefactos en `docs/benchmarks/2026-09-28/`, todos contra la 0.4.31):

- **Anthropic** (Haiku 4.5, Sonnet 5, Opus 5.5, Sonnet 5.5): 0 errores de la
  capa. `bfcl-0431-claude.md` registra 396 llamadas, todas 200 (#391);
  también `gsm8k-0431-claude.md` (#392), `xstest-0431-claude.md` (#395),
  `mt-bench-0431-claude.md` (#394) y `gsm8k-0431-gama-alta.md` (#397).
- **OpenAI** (gpt-4o-mini, gpt-5.4-mini, gpt-5.5, gpt-5.6-sol): 0 errores de la
  capa. Ver `bfcl-0431.md` (#387), `gsm8k-0431.md` (#388), `mt-bench-0431.md`
  (#390) y `xstest-0431.md` (#389). Los tres 400 de `xstest-0431-gama-alta.md`
  (#396) salen también en el brazo A, así que no son de la capa.
- **Gemini** (3.8 Flash, 3.1 Pro), por el endpoint compatible: **100 % de
  fallos** en la 0.4.31 (`gsm8k-0431-gama-alta.md`, #397), por un 400 `Unknown
  name "prompt_cache_key"`. Solo pasó con un parche del banco. BFCL de gama alta
  (#398) perdía además la `thought_signature` de Gemini 3. **#402 (0.4.32)**
  arregla las dos cosas, pero ninguna batería se ha repetido contra la 0.4.32.

**Lo que falta**

1. Fusionar **#410**, el adaptador nativo `GoogleProvider`. Solo tiene una
   sonda en vivo sobre gemini-3.8-flash (< 0,01 $), no banco.
2. Medir Gemini **nativo** en las cuatro baterías. #413 lo mide por el endpoint
   compatible, y en GSM8K ni eso: «la verja de hosts no deja pasar a Google».
   Hay que añadir el adaptador nativo al banco semanal.
3. Repetir Anthropic y OpenAI contra la 0.4.32 o una versión posterior. #403
   cambió `tool_choice`, `temperature` y la caché del turno 2.

## 2 · Nunca empeora la respuesta

**Lo verificable hoy** (0.4.31)

- BFCL: B−A de 0,0 pp y −1,0 pp [−2,8, 0,8] en OpenAI y de 0,0 pp en Claude.
  48/48 llamadas `fiel` y 35 de 35 herramientas en el cable. El recorte a 8 de
  la 0.4.30 (el turno 1 de multi-turn cayó de 8/10 a 1/10) lo arregla **#382**.
- GSM8K: Δ entre −1,9 y +1,1 pp, dentro del ruido, y **0** respuestas de otra
  pregunta. En la 0.4.30 la caché semántica sin calibrar servía otra respuesta
  en 8/20; lo arregla **#383**, y sin red la cifra pasa de 477 a 0.
- XSTest: ninguna diferencia A/B en la tasa de negativa (p ≥ 0,34).
- MT-Bench: tasa de victoria de B del 47–65 %, con juez parcial y muestras
  reducidas en Sonnet 5.

**Lo que falta**

1. **Catálogo tipado.** Con `intents`/`risk`, el selector sigue recortando a
   `maxTools` = 8 y ningún banco lo mide. En el inventario figura como
   `cambiar-default` (propuesta): sin tope por defecto en la 0.5, salvo que un
   BFCL con catálogo tipado demuestre que el recorte no empeora nada.
2. Gemini a través de la capa (criterio 1).
3. `BVSALA_GATEWAY_ESFUERZO`, en la pasarela, sigue sin medir contra la verja
   de calidad (lo dice la ayuda del CLI). Queda fuera de la 0.5 mientras siga
   apagado por defecto.

## 3 · Nunca cobra lo que no debe

**Lo verificable hoy**

- Negativas no cobradas de Anthropic (#374): en `xstest-0431-claude.md`, 16 de
  Opus con informe a 0 $, sin ahorro y con la traza «unbilled refusal»; las que
  sí se cobran no se ponen a 0. Sonnet 5.5: 13 correctas (#396).
- **Fallos de la 0.4.31**:
  - Negativas en texto que el detector no veía se cachearon y se acreditaron
    como `reference`: ids 429, 440, 445 y 449 en `xstest-0431.md`, e id 322
    («argue») en `xstest-0431-claude.md`.
  - Gemini `content_filter: OTHER`: 29 referencias y 5 servidas con ahorro
    (#396).
  - **La 0.4.32 corrige los dos**: generaliza el detector y reconoce
    `content_filter:` (notas de la 0.4.32, #402). No se ha re-medido.
- La comisión por `reference` exige una versión mínima: **#404** (abierto) la
  sube a 0.4.32.
- Licencia Medir, que nunca comisiona: **#417** (abierto).

**Lo que falta**

1. Fusionar #404.
2. Una tirada de XSTest contra la 0.4.32 con Gemini y Claude. Los umbrales
   `negativa-cacheada` y `negativa-acreditada` de #413 son justo esta puerta.
3. Observar en vivo una negativa del API de OpenAI (`message.refusal`). El
   camino existe (#356/#367/#374) pero ningún banco lo ha ejercitado.

## 4 · El informe cuadra con la factura (±2 %)

**Lo verificable hoy**

- El informe coincide con **uso × precio de lista** en:
  - OpenAI: `mt-bench-0431.md` da coste declarado = medido y 0 turnos
    descuadrados; `xstest-0431.md` da coste ≠ uso = 0.
  - Anthropic con fila en el catálogo.
- **Descuadres de la 0.4.31**, todos corregidos en la 0.4.32 pero sin re-medir:
  - Sonnet 5.5 sin fila en el catálogo: informe/uso = 0,15 en 458 llamadas
    (#396). Lo arregla la fila de #403.
  - Gemini no contaba el pensamiento: informe entre 0,18× y 0,28× lo facturado.
    Lo arregla #402.
- El ahorro de la caché de prefijo del proveedor no aparece en el informe. En
  Sonnet 5 GSM8K se declaran −0,0009 $ frente a ~0,13 $ medidos
  (`gsm8k-0431-claude.md`). Lo resuelve **#412** (`report.nativeSavings`,
  aparte y sin comisión), que está abierto.

**El hueco de verdad.** Ningún artefacto compara con una **factura**. Lo que
todos llaman «factura», incluida la regla `informe-vs-factura` de #413, es
`usage` × precio del catálogo, o sea, el mismo catálogo que usa la capa. Un
error de precio en el catálogo no lo detectaría. Para cumplir el criterio:

1. Aislar el gasto del banco en claves o proyectos dedicados por proveedor.
2. Tras cada banco semanal, leer el coste real con la API de costes de cada
   proveedor: la Usage & Cost API de Anthropic, la Costs API de OpenAI y la
   exportación de facturación de Google Cloud. Las credenciales de administrador
   se comprueban por existencia, nunca por valor.
3. Compararlo con `Σ report.cost.actual`, poniendo aparte el
   `nativeSavings.netUsd` de #412. Tolerancia: ±2 %.
4. Hasta que esto exista, el criterio 4 se da por cumplido **solo contra el
   precio de lista**, y así lo dice la guía de lanzamiento.

**Hecho en código:** `benchmarks/banco-semanal/factura.ts` hace los puntos 2 y 3
para Anthropic y OpenAI, con la regla `factura-no-cuadra`. Falta que el dueño
aísle el gasto y dé de alta las claves de administrador y los ids
(`docs/BANCO-SEMANAL.md`, «La factura real»). Mientras no estén, el banco avisa
y no falla, y rige el punto 4. Google sigue sin comprobar.

## 5 · Banco semanal en CI como puerta

**Hoy.** **#413** está abierto: cron los lunes, 50 $ con tope global, cuatro
baterías y diez modelos, y `publish.yml` bloqueado por `banco-semanal`. Sus
umbrales cubren los criterios 1 a 4 (`capa-falla`, `exactitud-peor`,
`otra-pregunta`, `negativa-*`, `informe-vs-factura`, banco incompleto).

**Lo que falta**, en orden:

1. Revisar y fusionar #413.
2. Dar de alta los secretos que lista `docs/BANCO-SEMANAL.md` de #413 (se
   comprueban con `gh secret list`, por nombre).
3. Un `workflow_dispatch` en modo `seco` y después uno en `vivo`.
4. Añadir el adaptador nativo de Gemini (#410) y la comparación con factura real
   (criterio 4).
5. Una **semana en verde** con la versión candidata a 0.5 es la condición de
   release.

## 6 · API congelada con guía

**La 0.5 (PR #434, en borrador hasta los criterios de salida)**

- **Raíz cerrada.** `src/index.ts` exporta una lista explícita, nombre a nombre,
  sin un solo `export *`; `src/deprecaciones-0.5.ts` borrado. Salen 73 exports
  de la raíz: los 68 «quitar» y los 5 españoles renombrados (sin alias). Quedan
  230 en las cinco entradas, todos estables. Lo que los arneses, los tests, los
  ejemplos y los adaptadores importaban de la raíz y ya no está lo importan de
  su módulo interno (los adaptadores, de `src/util/hash.ts` y
  `src/providers/motivo-de-parada.ts`, puros y en la lista blanca).
- **Miembros.** Fuera `licenseGate`, `devUnlicensed`, `licensePublicKey`,
  `semanticCache` (constructor), `cost.netSavings`,
  `deferred.estimatedTierSaving` y `RevocationPollerOptions.silenciarAvisos`.
  Las tres de licencia siguen vivas SOLO desde el fuente
  (`ConfiguracionDesdeElFuente` en `src/pipeline/config.ts`, que no llega al
  `.d.ts`; los tests y el banco las ven por
  `test/helpers/opciones-desde-el-fuente.d.ts`). Desde JavaScript, en el paquete
  publicado, `licenseGate`/`licensePublicKey`/`semanticCache` se ignoran con un
  aviso único; `devUnlicensed`, en silencio (la verja de sala limpia).
  `BVSALA_SILENCE_DEPRECATIONS` desaparece: no queda nada obsoleto que callar.
- **`finishReason` cerrado** (`stop | length | tool_calls | content_filter |
  other`) en `SavingsResult` y en `qualityLedger.truncation`, con el literal del
  proveedor en `finishReasonDetail`. Un solo ayudante
  (`src/providers/motivo-de-parada.ts`) para Anthropic, OpenAI-compatible,
  Google nativo, el adaptador del SDK oficial y el pipeline (también con
  proveedores de terceros). Tests por proveedor y por modo (JSON y stream) en
  `test/finish-reason-cerrado.test.ts`.
- **CLI solo en inglés.** `--puerto`/`--proyecto`/`--forzar` y
  `BVSALA_GATEWAY_ESFUERZO`/`BVSALA_GATEWAY_MODELO_HERMANO` dan un error que
  nombra el nuevo y `bvsala` sale con 1.
- **Inventario** `version: "0.5.0"`, todo `estable`, sin `pendientes`, y una
  sección `retirados` con lo que se fue. `test/api-publica-congelada.test.ts`
  falla con cualquier export o miembro fuera del inventario, con un veredicto
  no estable, si algo retirado reaparece o la guía deja de nombrarlo, si vuelve
  un `export *` a la raíz o si el `.d.ts` publica un `@deprecated`.
- **Guía** `MIGRAR-A-0.5.md` final, con el antes y el después de cada cambio.
- Bundle: `dist/index.js` 419.561 B (0.4.34: 422.372 B); el techo de 450.000
  no se toca. `dist/index.d.ts` baja de 315.928 B a 249.432 B.

**La 0.4.34 (PR «la 0.4.34 avisa de todo lo que la 0.5 quita»)**

- `@deprecated` en los 63 exports «quitar» que no lo llevaban, reexportados con
  nombre desde `src/deprecaciones-0.5.ts` (el `@deprecated` es del export, no de
  la función interna). El test del inventario exige ahora `@deprecated` en el
  `.d.ts` publicado para todo export y campo «quitar» o «renombrar».
- Aviso único por proceso, silenciable con `silenceWarnings` o con
  `BVSALA_SILENCE_DEPRECATIONS=1`, para `licensePublicKey` en el paquete
  publicado (donde no hace nada); el de `licenseGate` dice ya que la opción sale
  en la 0.5 y el alias `semanticCache` obedece la misma variable.
- **`devUnlicensed` NO avisa en ejecución**: la verja de
  `test/sala-limpia-del-tarball.test.ts` exige que ese nombre no esté en el
  bundle publicado (prueba de que la puerta de desarrollo se plegó), y un aviso
  lo metería. Queda con su `@deprecated`. **Decide el dueño** si se relaja la
  verja (por ejemplo, a comprobar solo `BVSALA_DEV_OPEN` y la forma de
  `devOpen()`) para poder avisar.
- `QualityTruncationCheck.finishReason` entra en el inventario con el veredicto
  de `SavingsResult.finishReason`, y `QualityTruncationCheck.finishReasonDetail`
  llega para que la migración sea simétrica.
- Inventario a la 0.4.33, sin `pendientes` (los de #410, #412, #416, #417 y
  #419, movidos); guía sin «(proposed)» y con «Upgrade to 0.4.34 first».

**Lo que hizo #418**

- **Inventario** (`docs/INVENTARIO-API-0.5.json`):
  - Los 298 nombres de las cinco entradas del paquete (`.`, `./ai-sdk`,
    `./mastra`, `./langchain` y `./anthropic-sdk`).
  - Los campos, con un nivel de anidación, de las interfaces que el cliente
    escribe o lee: `SavingsLayerConfig`, `SavingsRequest`, `SavingsToggles`,
    `SavingsResult`, `SavingsReport`, `SavingsLayer`, `OpenAICompatibleOptions`,
    `AnthropicOptions`, `ToolSelectorOptions`, `RequestContext`,
    `OutputContract`, `ToolDescriptor`, `ChatMessage`, `ToolCallRequest`,
    `DeferredExecutionReport` y `SemanticCacheOptions`.
  - Cada entrada lleva su veredicto: 225 estables, 5 que se renombran y 68 que
    se quitan. En los campos: 2 renombres, 4 que se quitan y 2 cambios de valor
    o de default.
- **`test/api-publica-congelada.test.ts`** falla en estos casos:
  - Aparece un export o un campo nuevo que no está en el inventario.
  - Desaparece uno del inventario.
  - Un nombre pasa de tipo a valor, o al revés.
  - Un veredicto no dice por qué.
  - La guía no menciona un nombre que no es estable.

  Lo que traen #410, #412, #416 y #417 figura como `pendientes`: esos PR pasan
  sin tocar el inventario, excepto por lo que se indica abajo.
- **Deprecaciones triviales en la 0.4.x**, que no cambian comportamiento (solo
  JSDoc y alias con el mismo objeto):
  - Nombres ingleses `PRICE_CATALOG`, `listPrice`, `PRICES_AS_OF`,
    `localEmbedding` y `LOCAL_EMBEDDING_THRESHOLD`, con los españoles como
    `@deprecated`.
  - `@deprecated` en `compresionFiel`, `quitarPrefijoDeProveedor` y
    `vectorLocal`.
  - `@deprecated` en `licenseGate`, `devUnlicensed` y `licensePublicKey`.
  - Aviso en el JSDoc de `semanticCache` (constructor) y de `cost.netSavings`
    («es una razón, no dólares»).
- **Guía** `docs/MIGRAR-A-0.5.md` (en inglés, para el cliente).

### Cambios rompientes propuestos para la 0.5

| Cambio | Tipo | Estado |
|---|---|---|
| `CATALOGO`/`precioDeLista`/`PRECIOS_AL_DIA`/`embebedorLocal`/`UMBRAL_LOCAL` → nombres ingleses | renombrar | alias `@deprecated` desde #418 |
| `SavingsLayerConfig.semanticCache` → `semanticCacheStore` (#380) | renombrar | alias con aviso desde la 0.4.33 (#419); el aviso obedece `BVSALA_SILENCE_DEPRECATIONS` desde la 0.4.34 |
| `cost.netSavings` → `netSavingsRatio`, más `netSavingsUsd` nuevo | renombrar | los dos campos nuevos desde la 0.4.33 (#419) |
| `finishReason` a unión cerrada, con el literal en `finishReasonDetail` (#416) — también `qualityLedger.truncation` | cambiar valor | `finishReasonDetail` desde la 0.4.33 (#416); en `truncation` desde la 0.4.34. La normalización, en la 0.5 |
| `ToolSelectorOptions.maxTools`: sin tope por defecto (#382) | cambiar default | **decidido y hecho** en la 0.4.33 (#419) |
| `licenseGate`, `devUnlicensed`, `licensePublicKey` fuera de `SavingsLayerConfig` | quitar | `@deprecated` desde #418; aviso en ejecución de `licenseGate` y (desde la 0.4.34) `licensePublicKey`; `devUnlicensed`, solo el tipo (decide el dueño) |
| 68 exports fuera de la raíz: pipeline, licencia/medición, constantes de la referencia y alias españoles | quitar | todos `@deprecated` desde la 0.4.34; lista en la guía, §7 |
| Alias ya deprecados: `MODELOS_POR_CODIFICACION`, `registrarTokenizadorExacto`, `estimatedTierSaving`, `silenciarAvisos` | quitar | ya `@deprecated` |
| CLI: `--puerto`/`--proyecto`/`--forzar`, `BVSALA_GATEWAY_ESFUERZO` → `_EFFORT`, `BVSALA_GATEWAY_MODELO_HERMANO` → `_SIBLING_MODEL` | renombrar | **decidido**: alias con aviso desde la 0.4.33 (#419) |

Lo que **no** cambia, aunque se tocó hace poco: `maxOutputTokens` por petición
(gana el menor de petición y contrato, #381), `reasoningEffort` (#402),
`temperature` quitada con aviso en modelos que la rechazan (#403, decisión
«quitar»), la caché del turno 2 solo con evidencia (#403, decisión
«evidencia»), `sendPromptCacheKey`/`maxTokensParam` (#402/#381), `toolSearch`
y `toolDiscovery`, `nativeSavings` (#412), el plan `measure` y `report.measure`
(#417), y el adaptador compatible para Gemini, que sigue soportado aunque se
recomiende el nativo (#410).

### El CLI `bvsala`

No es código TypeScript, así que el test no lo vigila. Su inventario:

| Superficie | Veredicto |
|---|---|
| `gateway`, `claude`, `codex`, `goose`, `qwen`, `opencode`, `kilo`, `copilot`, `aider`, `doctor`, `skill`, `init`, `--version`/`-v`, `--help`/`-h` | estable |
| `--port`, `--upstream`, `--project`, `--force`, `--codex`, `--write`, `--yes`, `--stack`, `--provider`, `--cwd`, `--json` | estable |
| `--puerto`, `--proyecto`, `--forzar` | quitar (alias con aviso desde la 0.4.33) |
| `BIVELIO_SERVICE_KEY`, `BIVELIO_LICENSE_KEY`, `BVSALA_SEAT_ID`, `BVSALA_GATEWAY_UPSTREAM`, `BVSALA_GATEWAY_USAGE_INJECT`, `BVSALA_GATEWAY_ELISION`, `BVSALA_CODEX_AUTH`, `BVSALA_GATEWAY_LOG` | estable |
| `BVSALA_GATEWAY_COALESCE`, `BVSALA_GATEWAY_SHADOW` | estable (la ayuda los marca como experimentales) |
| `BVSALA_GATEWAY_ESFUERZO` → `BVSALA_GATEWAY_EFFORT`; `BVSALA_GATEWAY_MODELO_HERMANO` → `BVSALA_GATEWAY_SIBLING_MODEL` | renombrar (alias con aviso desde la 0.4.33) |

### Hallazgos en los PR que entonces estaban abiertos (todos fusionados ya)

- **#417 saca `vigenciaEfectiva` a la raíz del paquete.** Es un `export` en
  `src/license/verify.ts`, que el barril reexporta con `export *`: un nombre en
  español y una pieza interna. El test nuevo lo caza. Hay que quitar el
  `export` (o moverla a un módulo que el barril no reexporte) antes de fusionar
  #417 sobre este PR.
- **#412 y #417 escriben la misma migración 0032**
  (`0032_ahorro_nativo_del_proveedor.sql` y `0032_licencia_medir.sql`) y el
  mismo `test/migracion-0032.test.ts`. El segundo en fusionarse tiene que
  renumerar. En el caso de #412, eso incluye rebasar el cuerpo de la RPC, como
  avisa su descripción.
- **El techo del bundle** (`test/dx-empaquetado.test.ts`) lo suben por separado
  #410 (450 KB), #412 (420 KB) y #417 (425 KB). Juntos suman más que cualquiera
  de los tres techos: hay que recalcularlo después del último.

## Lo que falta, en orden

Hecho: la 0.4.34 (#429), Gemini nativo medido en el banco (3.8 Flash en el run
36795672930; 3.1 Pro en dos jornadas, runs 36925298365 y 36977332185), la
negativa de OpenAI dentro de la salida estructurada (#431), y la 0.5 entera en
el PR #434: guía aplicada, `src/deprecaciones-0.5.ts` borrado, raíz sin
`export *`, inventario 0.5.0 todo `estable`, test sin `pendientes`, guía en la
web y versión **0.5.0-rc.1**, publicada en el dist-tag `next` (una prerelease
nunca mueve `latest`: `publish.yml` desde el PR #434).

**Decisión del dueño, 2026-10-02: «adelántalo a hoy».** La 0.5.0 sale hoy, en
cuanto haya **un** banco en vivo completo en verde en main. Sustituye al plan
anterior del mismo día (bancos el viernes 2-oct y el sábado 3-oct, y la 0.5.0
el domingo 4-oct). Lo que no cambia es la puerta de `publish.yml`: el último
banco en vivo completo en main, en verde y con 8 días o menos.

1. **Un banco en vivo completo en verde en main, hoy 2-oct** (criterio 5):
   `gh workflow run banco-semanal.yml --ref main`, sin `modelos` ni
   `baterias`. El del 2-oct sobre la 0.5.0-rc.1 (run 36998187601) salió en
   rojo solo por un 529 «Overloaded» de Anthropic contado como `capa-falla`,
   que arregla #450. Si sale en rojo por otra cosa, se leen las infracciones
   enteras y se arregla primero (una 0.5.0-rc.2 si el arreglo toca `src/`) y
   otro banco. Banco en verde: [run 37004817524](https://github.com/BiVelio/bivelio-savings-layer/actions/runs/37004817524) (main `b03bb5b`, el mismo código del SDK que la 0.5.0-rc.1), «sin regresiones»: 0 infracciones y 0 `capa-falla`. A mitad de la tirada se agotó el saldo de la API de Anthropic: GSM8K de los 4 modelos de Claude y XSTest de Sonnet 5, Sonnet 5.5 y Opus 5.5 salieron «no medible» en los dos brazos. Esas celdas están medidas en verde, con el mismo SDK, en el run 36998187601 (salvo la petición de Opus con el 529 de sobrecarga). **Decisión del dueño (2-oct): publicar con este banco** en vez de recargar el saldo y repetirlo.
2. **0.5.0, hoy, justo después:** fusionar el PR de release
   («chore(release): 0.5.0 — …», preparado en borrador), que sube la versión a
   `0.5.0`, y cortar la Release `v0.5.0` **sin** `--prerelease`, con lo que npm
   la pone en `latest`.
3. **Cliente de Python 0.1.1:** contra un gateway 0.5, la 0.1.0 de PyPI da
   ahorro 0 (lee `cost.netSavings`, que la 0.5 renombra). El arreglo está en
   main; publicarlo es cortar la Release `py-v0.1.1` (`publish-pypi.yml`).
4. **Factura real** contra el informe (criterio 4, no bloquea la 0.5): las
   claves de administrador y los ids dedicados al banco, del dueño
   (`docs/BANCO-SEMANAL.md`, «La factura real»).

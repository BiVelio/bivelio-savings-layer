# Camino a la 0.5

> Documento interno. Estado a **2026-09-29**, con la 0.4.32 publicada y main en
> `04e0aa7` (#407 incluido). La guía para clientes es [`MIGRAR-A-0.5.md`](MIGRAR-A-0.5.md) (en
> inglés) y el inventario de la API, con el veredicto de cada nombre, es
> [`INVENTARIO-API-0.5.json`](INVENTARIO-API-0.5.json).

## La decisión

«La 0.5 congela la API y publica una guía de migración 0.4 → 0.5; se permiten
cambios rompientes, documentados en un sitio» (dueño, 2026-09-29, decisión
`api-05`). Ninguna 0.4.x rompe nada: lo rompiente se anuncia en la 0.4.x con
`@deprecated` y se ejecuta en la 0.5.

La 0.5 sale cuando se cumplen los seis criterios acordados:

| # | Criterio | Estado hoy | Veredicto |
|---|---|---|---|
| 1 | Funciona con Anthropic, OpenAI y Gemini (nativo) sin errores causados por la capa en el banco | Anthropic y OpenAI, sí (0.4.31). Gemini falló el 100 % en la 0.4.31; el arreglo (0.4.32) y el adaptador nativo (#410, abierto) no se han medido en el banco | 🔴 |
| 2 | Nunca empeora la respuesta | Sin diferencia significativa en cuatro baterías (0.4.31, Anthropic y OpenAI). Sin medir: catálogo tipado recortado a 8 y Gemini | 🟡 |
| 3 | Nunca cobra lo que no debe | Negativas no cobradas de Anthropic, verificadas. En la 0.4.31 se acreditaron negativas en texto y filtros de Gemini; la 0.4.32 lo corrige sin re-medir | 🟡 |
| 4 | El informe cuadra con la factura ±2 %, con el ahorro nativo aparte | Cuadra con uso × precio de lista en OpenAI y Anthropic con fila. **Nunca se ha comparado con una factura real.** El ahorro nativo (#412) está abierto | 🔴 |
| 5 | Banco semanal en CI como puerta de release | #413 abierto, sin fusionar ni ejecutar | 🔴 |
| 6 | API pública congelada con guía | Este PR: inventario, test que congela la superficie, guía en borrador y deprecaciones triviales. Faltan decisiones y la implementación | 🟡 |

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

**Lo que hace este PR**

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
| `CATALOGO`/`precioDeLista`/`PRECIOS_AL_DIA`/`embebedorLocal`/`UMBRAL_LOCAL` → nombres ingleses | renombrar | alias ya en este PR |
| `SavingsLayerConfig.semanticCache` → `semanticCacheStore` (#380) | renombrar | falta el alias y el aviso (toca `create.ts`, que #417 edita) |
| `cost.netSavings` → `netSavingsRatio`, más `netSavingsUsd` nuevo | renombrar | faltan los campos aditivos (toca `accounting.ts`, que #412 edita) |
| `finishReason` a unión cerrada, con el literal en `finishReasonDetail` (#416) | cambiar valor | depende de #416 |
| `ToolSelectorOptions.maxTools`: sin tope por defecto (#382) | cambiar default | **decide el dueño**; falta el banco con catálogo tipado |
| `licenseGate`, `devUnlicensed`, `licensePublicKey` fuera de `SavingsLayerConfig` | quitar | `@deprecated` ya en este PR |
| 66 exports internos fuera de la raíz: pipeline, licencia/medición, constantes de la referencia | quitar | lista en la guía, §7 |
| Alias ya deprecados: `MODELOS_POR_CODIFICACION`, `registrarTokenizadorExacto`, `estimatedTierSaving`, `silenciarAvisos` | quitar | ya `@deprecated` |
| CLI: `--puerto`/`--proyecto`/`--forzar`, `BVSALA_GATEWAY_ESFUERZO` → `_EFFORT`, `BVSALA_GATEWAY_MODELO_HERMANO` → `_SIBLING_MODEL` | renombrar | **decide el dueño** |

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
| `--puerto`, `--proyecto`, `--forzar` | quitar (propuesta) |
| `BIVELIO_SERVICE_KEY`, `BIVELIO_LICENSE_KEY`, `BVSALA_SEAT_ID`, `BVSALA_GATEWAY_UPSTREAM`, `BVSALA_GATEWAY_USAGE_INJECT`, `BVSALA_GATEWAY_ELISION`, `BVSALA_CODEX_AUTH`, `BVSALA_GATEWAY_LOG` | estable |
| `BVSALA_GATEWAY_COALESCE`, `BVSALA_GATEWAY_SHADOW` | estable (la ayuda los marca como experimentales) |
| `BVSALA_GATEWAY_ESFUERZO` → `BVSALA_GATEWAY_EFFORT`; `BVSALA_GATEWAY_MODELO_HERMANO` → `BVSALA_GATEWAY_SIBLING_MODEL` | renombrar (propuesta) |

### Hallazgos en los PR abiertos (para quien los fusione)

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

1. **Fusionar lo que está en vuelo**: #404, #416, #410 (quitando
   `vigenciaEfectiva` en #417), #412 y #417. Resolver 0032 y el techo del
   bundle. Al fusionar cada uno, mover sus `pendientes` del inventario a
   `exports`/`miembros`.
2. **Fusionar #413** y ejecutarlo contra la 0.4.32, primero en seco y luego en
   vivo, con Gemini nativo (criterios 1, 2, 3 y 5).
3. **Decisiones del dueño**: `maxTools` sin tope por defecto, los nombres del
   CLI, el conjunto cerrado de `finishReason` y el nombre `semanticCacheStore`.
4. **0.4.33 (deprecaciones con código, sin cambiar comportamiento)**, cuando lo
   del punto 1 esté fusionado, para no pisar esos ficheros:
   - Aceptar `semanticCacheStore` y avisar una vez, silenciable, al recibir
     `semanticCache` en el constructor.
   - Añadir `netSavingsRatio` y `netSavingsUsd` y marcar `netSavings`
     `@deprecated`.
   - Avisar una vez, silenciable, de `devUnlicensed` y `licensePublicKey` en el
     paquete publicado.
   - Aceptar `BVSALA_GATEWAY_EFFORT` y `BVSALA_GATEWAY_SIBLING_MODEL` y avisar
     de los nombres españoles y de `--puerto`/`--proyecto`/`--forzar`.
   - `@deprecated` en los 63 exports internos que este PR no marca. Muchos viven en ficheros que
     editan #412 y #417: por eso no van en este PR.
5. **Factura real** contra el informe: la API de costes de cada proveedor, con
   claves dedicadas al banco (criterio 4).
6. **Una semana del banco en verde** con la candidata.
7. **0.5.0**:
   - Aplicar la guía: quitar, renombrar y normalizar `finishReason`.
   - Regenerar el inventario con `version: "0.5.0"` y todo `estable`.
   - Endurecer el test: en la 0.5 ya no se aceptan `pendientes`.
   - Publicar la guía en la web.

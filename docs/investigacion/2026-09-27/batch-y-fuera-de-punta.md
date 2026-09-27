# Batch y fuera de punta: las palancas de precio que #332 dejó sin construir

**Línea:** `batch-y-fuera-de-punta` · **Rama:** `feat/batch-y-fuera-de-punta` · **Fecha:** 2026-09-27
**Parte de:** las diez líneas en paralelo del 2026-09-27. Diseño de partida: `docs/especificaciones/2026-09-27-recomendaciones/palancas-precio.md` (D6 y D7).

## 1. La pregunta

#332 construyó Flex (OpenAI y Gemini) medido con el contador del proveedor y dejó dos palancas diseñadas y sin construir:

- las **Batch API** (Message Batches de Anthropic, Batch de OpenAI, Batch Mode de Gemini);
- el **fuera de punta de DeepSeek**.

La pregunta es doble. ¿Se pueden ofrecer ya, opcionales y medidas con el mismo `usage` a las dos tarifas de catálogo, sin acreditar nunca más que la diferencia real? ¿Y cuál de ellas vale la pena para que la herramienta sea la mejor del mercado para quien programa con LLM?

## 2. Hallazgos

Todas las fuentes se leyeron el 2026-09-27. Los precios se leyeron en la versión Markdown o HTML oficial **descargada tal cual**, sin pasar por un resumidor; las frases entre comillas son literales.

### 2.1 Anthropic · Message Batches

- **H1. Precio.** «All usage is charged at 50% of the standard API prices» [1]. La página de precios lo repite así: «a 50% discount on both input and output tokens», con una tabla de entrada y salida de lote por modelo [2]. La tabla coincide exactamente con la mitad de las filas de `CATALOGO` en todos los modelos con fila propia: Opus 5.5 $2/$10, Opus 4.5–5 $2.50/$12.50, Sonnet 5 $1/$5, Sonnet 4–4.6 $1.50/$7.50, Haiku 4.5 $0.50/$2.50, Haiku 3.5 $0.40/$2, Fable y Mythos $5/$25.
- **H2. Caché dentro del lote.** No tiene columna propia. Hay una frase en la página de precios: «These multipliers stack with other pricing modifiers, including the Batch API discount and data residency» [2]. La guía dice lo mismo con otras palabras: «The pricing discounts from prompt caching and Message Batches can stack» [1]. Por tanto:
  - lectura de caché en lote = multiplicador del modelo (0,1×; 0,05× en Opus 5.5; 0,025× en Fable y Mythos 5.1) × la entrada de lote;
  - escritura en lote = 1,25× la entrada de lote.
  - Sobre los aciertos, Anthropic dice que son «best-effort» y que «Users typically experience cache hit rates ranging from 30% to 98%» [1]. Es una afirmación del proveedor, no una medición independiente.
- **H3. El tier llega en cada resultado.** `usage.service_tier: "standard" | "priority" | "batch" | null` en `MessageBatchIndividualResponse` [3]. Es la condición M1 de `measured` leída del cuerpo, igual que en Flex.
- **H4. Límites y desenlaces.**
  - 100.000 peticiones o 256 MB por lote. La mayoría termina en menos de una hora y caducan a las 24 h. Los resultados se pueden descargar durante 29 días.
  - `custom_id` sigue el patrón `^[a-zA-Z0-9_-]{1,64}$`. `stream: true`, `speed` y `max_tokens: 0` dan error de validación.
  - Resultados `errored`, `canceled` y `expired`: «You will not be billed for these requests» [1].
- **H5. `results_url`.** El lote devuelve una URL absoluta para descargar los resultados. La ruta equivalente relativa a la base es `GET /v1/messages/batches/{id}/results` [3].

### 2.2 OpenAI · Batch API

- **H6. Precio y forma.**
  - «50% cost discount compared to synchronous APIs» [4].
  - Funcionamiento: un JSONL con líneas `{custom_id, method, url, body}` se sube a `/v1/files` con `purpose=batch` y se crea el lote en `/v1/batches` con `completion_window: "24h"`. Admite Chat Completions, Responses y Embeddings, entre otros.
  - Límites: 50.000 peticiones y 200 MB por lote; «each input file can only include requests to a single model»; 2.000 lotes por hora.
  - Caducidad: «You will be charged for tokens consumed from any completed requests»; lo caducado va al fichero de errores con `code: "batch_expired"` [4].
- **H7. El tier NO viene en el cuerpo.** El ejemplo de salida de la guía no trae `service_tier` [4]. Además, el `service_tier` de Chat Completions no tiene el valor `batch` (lo dejó escrito #332). Así que en OpenAI el tier de un resultado es el del **canal**: la línea sale del fichero de salida de un lote que su API de lotes informa.
- **H8. Tabla Batch frente a Flex** [5]:
  - En **todos** los modelos con fila Flex, la entrada, la salida y la escritura de caché de Batch son idénticas a las de Flex.
  - Batch solo añade precio en modelos **sin** Flex: gpt-4o, gpt-4o-mini, gpt-4.1*, o3-mini, o3-pro, o1 y los *-pro.
  - En gpt-4.1*, gpt-4o*, o3, o3-mini, o4-mini y o3-pro la tabla Batch **no publica lectura cacheada** («-»).
  - `gpt-4o-2024-05-13` tiene precio propio en las dos tablas: $5/$15 estándar y $2.50/$7.50 en lote.
- **H9. gpt-6 en Flex.** La tabla Flex ya publica gpt-6-astra, gpt-6-sol y gpt-6-luna. `CATALOGO` tiene su fila estándar desde `feat/catalogo-2026`. #332 dejó escrito que las añadiría «la que se fusione segunda», y no se añadieron.

### 2.3 Gemini · Batch Mode

- **H10. Precio y forma.**
  - «50% of the standard cost» y objetivo de 24 h [6].
  - Un trabajo en `JOB_STATE_EXPIRED` (más de 48 h) no devuelve resultados [6].
  - Peticiones inline de hasta 20 MB o un fichero de hasta 2 GB.
- **H11. Contradicción entre fuentes oficiales.**
  - La guía dice: «If a request in your batch results in a cache hit, the cached tokens are priced the same as for non-batch mode traffic» [6].
  - La tabla de precios pone la caché de lote de 3.5 Flash a la mitad: $0.075 frente a $0.15 [7].
- **H12. El endpoint compatible con OpenAI crea lotes, pero** «Compatibility for upload and download is currently not supported» [8]. Subir el JSONL y bajar los resultados exige la API de ficheros nativa, y esta capa no tiene adaptador nativo de Gemini.
- **H13. Flex de Gemini.** Ya se publica para 3.8 Flash, 3.6 Flash, 3.1 Flash-Lite y 3 Flash Preview [7], que ahora tienen fila propia en `CATALOGO`.
  - 3 Flash Preview cobra la caché Flex «Same as Standard».
  - 3.8 y 3.6 cuestan $0.375/$1.875/$0.0375 «through December 31, 2026».

### 2.4 DeepSeek · fuera de punta

- **H14. Modelos y franjas** [9]:
  - Dos modelos: `deepseek-flash` (V4.1-Flash) y `deepseek-v4-pro`.
  - «Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other hours are off-peak, including weekends and Chinese public holidays in full.»
  - No hay Batch API.
- **H15. La respuesta no dice qué tarifa se aplicó.** El `usage` de Chat Completions trae `prompt_cache_hit_tokens` y `prompt_cache_miss_tokens`, pero ningún tier ni franja; solo `created` («The Unix timestamp (in seconds) of when the chat completion was created») [10]. La página tampoco dice qué calendario de festivos aplica ni si manda la hora de inicio o la de fin.

### 2.5 Competencia (marketing frente a medición)

- **H16. En las fuentes consultadas no hay ninguna medición independiente de ese «50 %».**
  - El informe del 2026-09-26 [11] recoge «Batch −50 %» en OpenAI, Anthropic, Google, Mistral y OpenRouter, y «DeepSeek fuera de punta −50 %».
  - Es **aritmética de tarifa de lista**, no medición: la mitad del precio por token es un hecho del catálogo.
  - Lo que el cliente no tiene es cuánto le supuso **en su factura**, resultado a resultado y con la caché dentro del lote, que no siempre se descuenta igual (H8, H11).
  - Ese hueco es el que puede ocupar BV‑SALA sin inventar nada.
  - El presupuesto de búsquedas web de la sesión se agotó antes de poder releer las páginas de gateways (LiteLLM, Portkey). No se afirma aquí qué hacen con los lotes.

## 3. Opciones

| | Opción | Veredicto |
|---|---|---|
| A | Solo el informe | No: la investigación sí justifica construir |
| B | Solo las tablas de lote y la valoración pura, sin superficie | No: dato muerto, ningún camino lo usaría |
| C | **Superficie de lotes con las peticiones tal cual** (Anthropic y OpenAI) y cada resultado valorado a las dos tarifas publicadas, **sin metering** | **Sí** |
| D | Superficie completa: caché exacta antes de construir el lote, compresión y metering durable | Después: el metering durable es decisión del dueño |
| E | DeepSeek fuera de punta por reloj (`created`) | No (§4) |
| F | Gemini Batch Mode | Después: necesita adaptador nativo de ficheros (H12) |

## 4. Decisión y por qué

**Se construye C**, más dos rellenos de la tabla Flex que la investigación dejó a la vista (H9 y H13). **No se construyen E ni F.**

- **Por qué C.**
  - En Anthropic, el lote es el **único** sitio donde existe el descuento por diferir (#332).
  - La valoración cumple M1–M6 tal cual: el tier se lee del resultado (H3) y el precio es de catálogo (H1 y H2).
  - En OpenAI añade los modelos sin Flex (H8).
  - Traducir con el **mismo adaptador** que `generate()` evita que las dos vías deriven.
  - No emitir uso hace imposible cobrar de más: la comisión no ve este carril.
- **Por qué OpenAI por el canal y no por el cuerpo (H7).** El cuerpo no tiene el valor `batch`. Lo que sí lee la capa del proveedor es su registro de lote: la línea viene del fichero de salida de un lote que su API informa, y la guía fija que esos tokens se cobran a tarifa de lote.
  - Se añade `tierLeidoDe: "lote"` a la valoración. Cuenta para M1 como el cuerpo, y `basisReason` lo dice.
  - Queda como **paso del dueño** confirmarlo contra una factura real (§8).
- **Por qué NO DeepSeek (E).** Cinco motivos, escritos en `economics/tier-diferido.ts`:
  1. `CATALOGO` no tiene filas de DeepSeek, a propósito: el precio depende de la hora.
  2. La respuesta no dice la tarifa (H15).
  3. No se sabe si manda la hora de inicio o la de fin.
  4. No se sabe el calendario de festivos; suponer un festivo que no lo era acredita la mitad de una llamada cobrada entera.
  5. Retener peticiones hasta la franja de valle exige una cola durable propia, porque DeepSeek no tiene lotes.

  Lo único defendible sin inventar: fuera de 01–04 y 06–10 UTC, de lunes a viernes, la tarifa es la de valle seguro. Aun así sería `estimated` y necesita franjas en el catálogo.
- **Por qué NO Gemini todavía (F).** Por H12. Además, H11 obliga a elegir entre dos fuentes oficiales; cuando se construya, gana la que da la diferencia menor.

## 5. Qué se construye hoy

1. **`layer.batches`** (`src/batch/lotes.ts` y los tipos públicos en `src/contracts/batch.ts`), con cuatro operaciones:
   - `submit(requests, options?)`: `BatchJob` en JSON plano (ids de lote, ids del cliente, modelos y esquemas; nunca prompts). No devuelve ninguna cifra.
   - `status(job)`
   - `results(job)`: un `BatchItemResult` por petición, con `tierSaving` si se acredita y `reason` siempre, más un `BatchSummary`.
   - `cancel(job)`

   Cómo se comporta:
   - Trocea por los límites del proveedor (100k/256 MB; 50k/200 MB) y, en OpenAI, por modelo.
   - Si un trozo falla con otros ya creados, lanza `BatchSubmitError` con el **trabajo parcial**, para que no se pierda lo que se factura.
   - Rechaza `retrieval` y `structuredData`: son trabajo del pipeline.
   - `cacheSharedPrefix`, opcional y solo para Anthropic, marca la cabecera de `system` con `cache_control`.
   - Nunca sigue el `results_url` absoluto: toda llamada va a la base del adaptador (`rutaRelativa`), para no mandar la clave a otro host.
   - Todo pasa por la **misma licencia** que `generate()` (`exigirLicencia`).
   - No emite uso: el ahorro de lote se reporta con `creditedLedger: "none"` y nunca se cobra.
2. **Adaptadores.** `AnthropicProvider` y `OpenAICompatibleProvider` declaran su capacidad de lotes en un WeakMap interno (`providers/lotes-del-proveedor.ts`, el patrón del atestado). La clase no gana API pública.
   - OpenAI separa `construirCuerpo` de `enviar` y `leerJson` de `leer`; Anthropic separa `leerMensaje` de `leer`. Así el lote y `generate()` comparten traducción; el cuerpo de `generate()` no cambia.
   - Un host Gemini se rechaza antes de enviar nada.
3. **Tablas** (`pricing/tarifas-de-tier.ts`), cada fila con fuente y fecha:
   - `anthropic.batch` (17 modelos);
   - `openai.batch` (23 modelos);
   - Flex de gpt-6-astra, gpt-6-sol y gpt-6-luna (H9);
   - Flex de Gemini 3.8 Flash, 3.6 Flash, 3.1 Flash-Lite y 3 Flash Preview (H13).
4. **Valoración.** `tierLeidoDe: "lote"`, y `familiaDeTarifa` reconoce `claude-*` y `anthropic/`.
5. **Encaje con `deferrable`.**
   - En Anthropic, el aviso y `SIN_TIER_DIFERIBLE` indican `layer.batches.submit()`.
   - En OpenAI, un modelo sin Flex pero con tarifa de lote (gpt-4o-mini, gpt-4.1…) recibe en `deferred.reason` dónde vive su descuento. Solo cuando el adaptador atestigua el API oficial de OpenAI: detrás de un proxy no se sabe si hay Batch API.
6. **README.** Bloque «Provider price levers» ampliado con `layer.batches`, en inglés, sin porcentajes y con un fragmento que compila.

**Tests:**

- **`test/lotes.test.ts`** (21), contra un servidor de mentira con cada dialecto:
  - paridad byte a byte del cuerpo con `generate()`;
  - troceo y trabajo parcial;
  - rechazos antes de enviar;
  - desenlaces de resultado;
  - `measured` y `estimated` (proxy, `costModels`, host compatible, caché sin precio de lote);
  - contrato `met`/`missed`;
  - no seguir `results_url`;
  - licencia en las cuatro operaciones;
  - proveedor de terceros;
  - que nada llega al medidor.
- **`test/lotes-propiedad.test.ts`** (P6, 50 casos × 40 resultados). De punta a punta, el importe de cada resultado está entre la diferencia real de catálogo menos 1e-10 y la diferencia real, calculada en enteros y directamente de las tablas. El resumen es la suma exacta y nunca pasa de la real.
- **`palancas-precio-propiedad`** (P1–P5) recorre ya todas las filas nuevas.
- **`tier-diferible`** prueba la pista hacia los lotes y su ausencia cuando no hay tarifa de lote.

## 6. Qué queda

1. **Comisión sobre el ahorro de lote.** Es decisión del dueño, y va servidor primero: lista blanca, LICENSE §5, textos en 12 idiomas y un emisor **durable**, porque entre el envío y la recogida puede haber un reinicio. Sin esto tampoco hay telemetría de adopción.
2. **Las palancas de la capa dentro del lote**:
   - filtrar por caché exacta antes de construir el lote y servir el acierto en la misma forma;
   - compresión;
   - elisión.

   Exige partir `generate()` en pre- y post-proveedor (tamaño L).
3. **Gemini Batch Mode.** Adaptador nativo de ficheros o peticiones inline, y resolver H11.
4. **DeepSeek.** Franjas horarias en `CATALOGO` y, con ellas, solo el valle seguro y `estimated`.
5. **Responses API en lote de OpenAI.** Hoy va solo Chat Completions, porque es el dialecto del adaptador.
6. **Lectura en streaming de resultados enormes.** Ya se hace línea a línea si el cuerpo es un stream. Lo que no hay es paginación ni reanudación.

## 7. Riesgos

- **El tier de OpenAI por el canal (H7).** Si OpenAI cobrara algún resultado de lote a otra tarifa, se sobre-acreditaría con `measured`. Mitigación: la guía lo documenta, `basisReason` lo dice, y hay un paso del dueño contra factura.
- **Multiplicadores de caché de Anthropic en lote (H2).** Salen de una regla publicada, no de una celda. Si la regla se leyera distinta, la escritura y la lectura se valorarían mal. Hoy la escritura de 1 h (2×) se valora a 1,25× en los dos lados, y eso queda corto, nunca largo.
- **`gpt-4o-2024-05-13`.** Se valora con las filas de gpt-4o: queda corto (1,25/5 frente a 2,50/7,50 por 1M). Su `standardCost` publicado no es su factura.
- **Cambio de tipo público.** `SavingsLayer` gana el miembro `batches`, obligatorio. Quien **implemente** `SavingsLayer` a mano (un envoltorio propio) tiene que añadirlo; `instrumentSavingsLayer` ya lo reenvía. Quien solo lo consume no nota nada.
- **Expectativa de producto.** El valor de hoy es la palanca del proveedor, medida. Las palancas propias de la capa **no** corren en lotes, y README, JSDoc y `summary.reason` lo dicen.
- **Carga de CI.** `verificacion-nulo-simetrico` roza los 5 s de timeout cuando la máquina está muy cargada. No tiene relación con este cambio: pasa en 5,2 s aislado, con una carga media de 183.

## 8. Cómo se medirá el efecto

- **Cuadre con factura** (paso del dueño, con credenciales del banco y sin tocar producción):
  1. Enviar un lote pequeño a Anthropic (Haiku 4.5) y otro a OpenAI (gpt-4o-mini) con `layer.batches`.
  2. Comparar `summary.appliedCost` con la línea de lote de la factura o del panel de uso del proveedor, y `summary.standardCost` con esos tokens a tarifa estándar.
  3. Criterio: `appliedCost` es igual a la línea, con redondeo de céntimo. Si no cuadra, se retira el `measured` de ese proveedor.
- **Cobertura `measured`**: la fracción de resultados acreditados con `basis: "measured"`. Es la señal de que los contadores traen el desglose de caché (M6).
- **Adopción**: no se puede medir sin emisor. Queda atada a la decisión 6.1.

## 9. Fuentes

1. Anthropic, Batch processing: https://platform.claude.com/docs/en/build-with-claude/batch-processing (2026-09-27)
2. Anthropic, Pricing: https://platform.claude.com/docs/en/about-claude/pricing (2026-09-27)
3. Anthropic, Retrieve Message Batch results: https://platform.claude.com/docs/en/api/messages/batches/results (2026-09-27)
4. OpenAI, Batch API guide: https://developers.openai.com/api/docs/guides/batch (versión `.md`, 2026-09-27)
5. OpenAI, Pricing: https://developers.openai.com/api/docs/pricing (versión `.md`: «Standard», «Batch» y «Flex pricing data», 2026-09-27)
6. Google, Gemini Batch Mode: https://ai.google.dev/gemini-api/docs/batch-mode (2026-09-27)
7. Google, Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing (2026-09-27)
8. Google, OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai (sección «Batch API», 2026-09-27)
9. DeepSeek, Models & Pricing: https://api-docs.deepseek.com/quick_start/pricing (2026-09-27)
10. DeepSeek, Create Chat Completion: https://api-docs.deepseek.com/api/create-chat-completion (2026-09-27)
11. BiVelio, Informe de competencia: `docs/COMPETENCIA-2026-09-26.md` (§3, filas «Descuento por diferir», OpenRouter y DeepSeek; §8, n.º 9)
12. BiVelio, Especificación de palancas de precio: `docs/especificaciones/2026-09-27-recomendaciones/palancas-precio.md` (D6 y D7)

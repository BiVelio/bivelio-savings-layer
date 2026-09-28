# Inteligencia competitiva: los gateways OSS, instalados y medidos en local (2026-09-27)

**Fecha de corte:** 27‑sep‑2026 · **Producto:** `@bivelio/savings-layer` 0.4.25 (en npm desde el 27‑sep, 15:59 UTC) · **Línea:** «inteligencia-competitiva», una de diez en paralelo · **Base:** el informe del 26‑sep [1], la bitácora [2], el README [3], el código del gateway [5] y lo que esta línea instaló y midió en local [4]. Las citas [n] remiten a §11.

Etiquetas: **[medido aquí]** = medido hoy en esta máquina con el arnés de este PR; **[código]** = leído en el código o el paquete del producto; **[doc]** = documentación oficial del producto; **[marketing]** = cifra del propio vendedor; **[inferido]** = conclusión de este análisis.

---

## 1. La pregunta

El informe del 26‑sep comparó a BV‑SALA con el mercado leyendo fuentes. Esta línea baja un nivel: **instalar en local, sin cuentas de pago, los gateways OSS que un desarrollador probaría hoy** (LiteLLM proxy, Bifrost, el gateway OSS de Portkey y el de Helicone) y compararlos con el gateway de BV‑SALA en cuatro ejes:

1. **Tiempo hasta el primer ahorro medido**: cuánto cuesta pasar de cero a ver un ahorro respaldado por el contador del proveedor.
2. **Qué miden y cómo**: de dónde sale el coste, qué pasa en un acierto de caché, si separan lo medido de lo estimado.
3. **Privacidad**: dónde escuchan, qué guardan, a quién llaman por su cuenta.
4. **Sobrecoste de latencia**, medido desde fuera contra un upstream falso.

Y dos entregas más: las **señales de mercado de septiembre de 2026** que no estaban en el informe del 26‑sep y una **lista de experimentos priorizados** para las dos próximas semanas.

## 2. La respuesta corta

1. **Latencia: BV‑SALA está en el grupo de cabeza y la latencia no es argumento.** A concurrencia 1, su gateway añade **0,33–0,72 ms** de mediana según el escenario, en dos tiradas; Helicone, 0,25–0,66 ms; Bifrost, 0,31–1,40 ms; Portkey, 0,49–2,12 ms (y no sirve stream); LiteLLM, **2,9–5,7 ms** [medido aquí, §4.1]. A esa concurrencia, medir cada petición no añade nada medible (`bvsala-medido` ≈ `bvsala`). Frente a los cientos de milisegundos que tarda un proveedor real en dar el primer token, todo lo que no es LiteLLM es ruido.
2. **Carga: BV‑SALA queda en mitad de tabla.** A concurrencia 32, ~7.700–8.000 peticiones/s frente a 34–37 mil de Helicone y 16–17 mil de Bifrost; muy por delante de Portkey (~4.700) y del proxy en Python de LiteLLM (360–434, con p50 de 71–84 ms) [medido aquí, §4.2]. Para un medidor local de terminales sobra; importaría si alguien lo usa como gateway de servidor (E5).
3. **Fidelidad: BV‑SALA es el único que entrega los bytes intactos en los dos sentidos.** Helicone **pierde `prompt_cache_key`**, la clave con la que OpenAI enruta su caché de prefijo; Bifrost quita `service_tier: "flex"` cuando su ficha dice que el modelo no admite Flex (en `gpt-5-mini` lo conserva) y añade `extra_fields` a la respuesta; LiteLLM cambia el `model` de la respuesta por su alias; Portkey conserva el JSON [medido aquí, §4.3].
4. **Ninguno de los cuatro OSS mide un ahorro.** LiteLLM y Bifrost miden gasto con tablas de precios que **se descargan al arrancar** (de la rama `main` de GitHub y de `getbifrost.ai`); Portkey y Helicone no calculan coste en local. En un acierto de la caché local de LiteLLM, la llamada no llega al proveedor y **la cabecera de coste repite lo que costó la original**. El único «ahorro» que se enseña, el del Auto Router de LiteLLM, es estimado contra «usar siempre el modelo más caro» [medido aquí + doc, §4.4].
5. **La brecha más grande es comercial.** Los cuatro OSS arrancan en segundos y sin cuenta, y LiteLLM y Bifrost ya dan el coste de cada petición; BV‑SALA se instala en 6 s y se para: sin licencia de pago no arranca el gateway ni responde el SDK [medido aquí, §4.5]. Es el único que puede enseñar un ahorro con base, y el único que no deja verlo sin pagar.
6. **Privacidad: grupo bueno, con matices.** BV‑SALA escucha en loopback y no guarda nada; LiteLLM y Portkey escuchan en todas las interfaces por defecto y Bifrost guarda prompts y respuestas en disco, legibles por una API local sin autenticación. Tres de los cinco llaman a casa al arrancar, BV‑SALA incluido (licencia e ingesta, enumeradas en la LICENSE §5) [medido aquí + código, §4.6].
7. **Mercado (septiembre): el «ahorro verificable» se llena.** Caveman retira sus cifras no medidas y promete recibos firmados (15‑sep); Headroom etiqueta bases y prepara un precio sobre la factura (21 y 25‑sep); LiteLLM lanza un calculador de ROI modelado (26‑sep). Portkey OSS y el gateway de Helicone están parados; Opus 5.5 baja a 4/20 $ (22‑sep) y Anthropic vuelve a cobrar ciertas negativas (24‑sep) [§5].

**Recomendación:** no competir en latencia; convertir la fidelidad y la base declarada en argumento verificable (el arnés de este PR lo permite a cualquiera) y llevar al dueño la decisión de «Medir» gratis, que es la brecha medida más cara (§7, §10).

---

## 3. Método

**Máquina.** Apple M4 Pro, 14 núcleos, 48 GB, macOS 15.7.4; Node 25.9.0 para el arnés, BV‑SALA y Portkey; Python 3.13.7 para LiteLLM. **La máquina estaba compartida con las otras nueve líneas de trabajo**: durante la sesión su carga media llegó a pasar de 150, y dos tiradas previas se descartaron por eso. En las dos que se publican, la carga media de 1 minuto al empezar y al terminar estuvo entre 6 y 29, y la de 5 minutos entre 31 y 60; queda escrita en cada fichero de evidencia. Las rondas compartidas protegen la mediana y la comparación entre gateways; la cola (p99) y la prueba de carga lo acusan más.

**Instalación.** Cada producto en su propio directorio temporal, nunca global, con `HOME` redirigido y la versión fijada (tabla y sumas en `benchmarks/latencia-gateways/README.md`): LiteLLM 1.102.1 con `uv`, Bifrost `transports/v2.2.3` (binario de `downloads.getmaxim.ai`), Portkey 1.15.2 con npm y Helicone AI Gateway 0.2.0‑beta.30 (binario de GitHub con su sha256 comprobado). Configuración mínima de su guía de inicio, apuntando a un upstream falso en 127.0.0.1 y con claves de relleno. Sin Docker (el demonio estaba apagado): no se probaron las piezas que exigen Redis u otro almacén (cachés de Bifrost y Portkey, la plataforma completa de Helicone), ni el gateway de LiteLLM en Rust, que es una beta cerrada por formulario [9].

**BV‑SALA.** El gateway se compila desde el fuente a un `.js` y corre en Node pelado con una licencia de prueba (la clave efímera de los tests; el paquete publicado solo acepta la embebida, así que su binario no arranca sin una licencia real). El camino de cada petición es el mismo código. Dos modos: `bvsala` (sin clave de servicio, solo reenvía) y `bvsala-medido` (mide cada petición contra una ingesta falsa, como el CLI en producción).

**Latencia** (`pnpm latencia:gateways`). Cada ronda manda la misma petición directa al upstream y a través de **cada** gateway, en una permutación aleatoria con semilla; el sobrecoste de un gateway es la **mediana de sus diferencias con el directo de la misma ronda**, con IC 95 % por bootstrap. Como todos comparten rondas, todos viven la misma carga de la máquina. 600 rondas por escenario tras 60 de calentamiento; cuatro escenarios: Chat Completions de 1 KB y de 200 KB (el tamaño de un turno de agente de código), con y sin stream (8 trozos a ~1 ms). El primer byte se mide aparte. Nadie se mide a sí mismo: LiteLLM publica su sobrecoste con una cabecera que calcula él mismo [7] y Bifrost con peticiones simuladas dentro de su banco [15]; aquí el reloj es el del cliente y el upstream es el mismo para todos. **Carga:** 4.000 peticiones por brazo a concurrencia 32, en dos pasadas por todos los brazos (la segunda en orden inverso). Dos tiradas completas, A y B.

**Fidelidad.** Una petición con los campos que cambian la factura (`prompt_cache_key`, `service_tier: "flex"`, `store`, herramientas, `parallel_tool_calls`) y los bytes que el upstream dice haber recibido; y la respuesta del gateway frente a la directa. Con `gpt-4o-mini` (OpenAI no le ofrece Flex) y `gpt-5-mini` (sí).

**Privacidad** (`pnpm vigia:conexiones`). Cada gateway arranca bajo un vigía que muestrea sus conexiones con `lsof` cada 100 ms y le pone delante, por `HTTP(S)_PROXY`, un proxy local que apunta cada destino. El muestreo solo no basta: LiteLLM baja su tabla de precios en menos de lo que dura una muestra y solo el proxy lo vio. Ve **a quién** se llama, no **qué** viaja, y no ve a quien ignora las variables de proxy.

**Tiempo hasta el primer ahorro.** Cronometrado a mano: instalación en limpio, primera petición medida y qué enseña cada producto en un acierto de caché (repitiendo una petición A después de otra B y comprobando en el upstream que la segunda A no llegó).

## 4. Hallazgos

### 4.1 Sobrecoste de latencia a concurrencia 1

Mediana del sobrecoste **total** por petición, en ms, con su IC 95 %: tirada A · tirada B (600 rondas cada una; todos los gateways en las mismas rondas) [4].

| Gateway | 1 KB | 1 KB, stream | 200 KB | 200 KB, stream |
|---|---|---|---|---|
| **BV‑SALA** | 0,46 [0,45–0,47] · 0,33 [0,33–0,34] | 0,54 [0,52–0,58] · 0,55 [0,53–0,57] | 0,72 [0,68–0,74] · 0,58 [0,57–0,60] | 0,68 [0,65–0,71] · 0,68 [0,66–0,71] |
| **BV‑SALA medido** | 0,47 [0,46–0,48] · 0,34 [0,33–0,35] | 0,54 [0,51–0,58] · 0,54 [0,52–0,56] | 0,73 [0,69–0,75] · 0,60 [0,59–0,62] | 0,69 [0,65–0,74] · 0,69 [0,66–0,72] |
| LiteLLM 1.102.1 | 3,48 [3,45–3,52] · 2,86 [2,85–2,87] | 4,95 [4,84–5,08] · 5,21 [5,12–5,32] | 4,75 [4,65–4,94] · 4,16 [4,13–4,19] | 5,69 [5,53–5,82] · 5,19 [5,15–5,24] |
| Bifrost v2.2.3 | 0,40 [0,39–0,41] · 0,31 [0,31–0,32] | 0,50 [0,48–0,53] · 0,51 [0,48–0,53] | 1,25 [1,22–1,29] · 1,12 [1,10–1,15] | 1,40 [1,35–1,45] · 1,27 [1,24–1,29] |
| Portkey 1.15.2 | 0,76 [0,75–0,78] · 0,49 [0,48–0,49] | HTTP 500 | 2,12 [2,05–2,18] · 1,75 [1,73–1,78] | HTTP 500 |
| Helicone 0.2.0‑b30 | 0,31 [0,31–0,32] · 0,25 [0,25–0,26] | 0,38 [0,35–0,40] · 0,37 [0,34–0,39] | 0,66 [0,63–0,68] · 0,58 [0,57–0,59] | 0,64 [0,60–0,68] · 0,64 [0,62–0,67] |

Sobrecoste hasta el **primer byte** del stream (lo que nota un usuario en el primer token), ms, A · B:

| Gateway | 1 KB, stream | 200 KB, stream |
|---|---|---|
| **BV‑SALA** | 0,60 [0,59–0,62] · 0,62 [0,61–0,64] | 0,79 [0,77–0,80] · 0,73 [0,72–0,74] |
| **BV‑SALA medido** | 0,61 [0,60–0,62] · 0,62 [0,61–0,63] | 0,78 [0,76–0,79] · 0,76 [0,75–0,77] |
| LiteLLM 1.102.1 | 4,68 [4,55–4,79] · 4,98 [4,84–5,12] | 5,70 [5,53–5,79] · 4,97 [4,94–5,00] |
| Bifrost v2.2.3 | 1,64 [1,63–1,64] · 1,65 [1,64–1,66] | 2,55 [2,51–2,58] · 2,39 [2,37–2,41] |
| Portkey 1.15.2 | HTTP 500 | HTTP 500 |
| Helicone 0.2.0‑b30 | 0,43 [0,42–0,44] · 0,43 [0,42–0,44] | 0,73 [0,71–0,75] · 0,68 [0,67–0,69] |

Lectura:

- **BV‑SALA, Helicone y Bifrost quedan por debajo del milisegundo** en casi todo; Bifrost sube a 1,1–1,4 ms con cuerpos de 200 KB y a **1,6–2,6 ms hasta el primer byte** del stream, el doble o el triple que BV‑SALA y Helicone. LiteLLM añade 3–6 ms en todo; su propia documentación dice 2 ms de mediana y 8 de P95 medidos con su cabecera interna [7], y su blog, ~7,5 ms para el proxy en Python [9]: lo medido desde fuera cae entre las dos.
- **Las afirmaciones de los fabricantes no son comparables con esto.** Los «11 µs» de Bifrost [15] y el «sub‑1ms» de Portkey [20] se miden dentro del proceso; aquí se mide desde el cliente, con el salto de red local incluido, que ningún proxy se ahorra. El «P95 <10ms» de Helicone [23] se cumple con holgura (p99 a concurrencia 1: 0,64–0,70 ms con 1 KB).
- **Medir no cuesta latencia**: `bvsala-medido` (cada petición al libro, contra una ingesta falsa) y `bvsala` (solo reenvío) se solapan dentro del IC en los ocho casos. La ingesta va por lotes y fuera del camino de la respuesta [5]. Bajo carga sí se nota algo: un 5–10 % menos de peticiones por segundo (§4.2).
- **Los IC son de una tirada; entre tiradas hay más dispersión.** A y B no siempre se solapan (BV‑SALA con 1 KB: 0,46 frente a 0,33 ms): el IC recoge el ruido del muestreo, no el de una máquina compartida (carga media entre 6 y 60, §3). El orden entre gateways sí se repite. Una tirada preliminar con dos brazos por ronda (cada gateway medido a solas, procesos siempre «calientes»; no se guardó como evidencia porque el arnés cambió después) dio cifras más bajas en todos (BV‑SALA 0,19 ms con 1 KB; Helicone 0,10; Bifrost 0,18; LiteLLM 2,71): con varios brazos por ronda cada gateway espera a los demás entre petición y petición, que se parece más al uso real de un medidor local.
- **Portkey no sirve stream** en su instalación por defecto: HTTP 500 `TypeError: immutable`, también contra LiteLLM y Bifrost como upstream y también con Node 20.20 y con `@hono/node-server` 1.14.2 fijado (issues #1389 y #1550, abiertos desde oct‑2025 y mar‑2026) [21]. Además, su código (`src/handlers/streamHandler.ts`, líneas 182–186) espera **25 ms antes del primer trozo** de todo stream que no sea de Bedrock, y 1 ms entre trozos con Azure OpenAI [36] [código; no medido, porque el stream no funcionó].

### 4.2 Carga (concurrencia 32) y memoria

| Brazo | Peticiones/s (A · B) | p50 ms (A · B) | p99 ms (A · B) | Memoria residente al terminar (MB, A · B) |
|---|---|---|---|---|
| Directo (techo del cliente) | 41950 · 39908 | 0,70 · 0,71 | 2,62 · 2,17 | — |
| **BV‑SALA** | 7979 · 7696 | 3,63 · 3,72 | 7,27 · 7,78 | 299 · 348 |
| **BV‑SALA medido** | 7455 · 6928 | 3,94 · 4,18 | 7,20 · 8,92 | 292 · 293 |
| LiteLLM 1.102.1 | 434 · 359 | 70,93 · 84,11 | 160,25 · 210,80 | 386 · 393 |
| Bifrost v2.2.3 | 16692 · 16380 | 1,56 · 1,62 | 8,86 · 8,33 | 2116 · 2197 |
| Portkey 1.15.2 | 4663 · 4809 | 6,51 · 6,47 | 10,20 · 10,21 | 409 · 433 |
| Helicone 0.2.0‑b30 | 37327 · 34439 | 0,78 · 0,87 | 2,33 · 2,37 | 60 · 62 |

- El directo marca el techo del cliente (un solo proceso Node): la cifra de Helicone está cerca de ese techo, así que su RPS real es un suelo.
- **BV‑SALA atiende ~7.700–8.000 peticiones/s con un p50 de 3,6–3,7 ms**: suficiente para cualquier terminal y para un servicio pequeño, lejos de Bifrost y Helicone. Es un proceso Node de un hilo; cuándo merece la pena perfilarlo lo dice E5.
- Memoria: BV‑SALA usa **70 MB en reposo** (el lanzador compilado recién arrancado) y ~300–350 MB tras la tirada (cuerpos de 200 KB y carga); Helicone, ~60 MB; Bifrost pasa de **2 GB** con su almacén de logs por defecto encendido. Medida con `ps` al final, no es un pico.

### 4.3 Fidelidad: ¿llega lo que el cliente mandó?

| Gateway | Petición al proveedor | Respuesta al cliente |
|---|---|---|
| **BV‑SALA** (los dos modos, los dos modelos) | **Bytes idénticos** | **Bytes idénticos** |
| **LiteLLM** | Mismo JSON, reserializado con las claves en orden alfabético | `model` pasa a ser el alias del proxy (`bench-gpt-4o-mini`); añade `provider_specific_fields` y quita `logprobs: null` |
| **Bifrost** | Con `gpt-4o-mini` **quita `service_tier: "flex"`** (su ficha dice que ese modelo no admite Flex, que es lo que dice OpenAI); con `gpt-5-mini` lo conserva | Añade `extra_fields` (proveedor, modelo resuelto y **el nombre de la clave usada**) y `usage.prompt_tokens_details.cache_write_tokens` |
| **Portkey** | Mismo JSON, claves reordenadas | Bytes idénticos |
| **Helicone** | **Pierde `prompt_cache_key`** | Añade siete campos `null` (`refusal`, `tool_calls`, `function_call`, `audio`, `service_tier`, `audio_tokens`, `completion_tokens_details`); con `gpt-5-mini`, HTTP 500 «No model mapping found»: su catálogo acaba en modelos de 2025 |

[medido aquí, `benchmarks/evidencia/latencia-gateways-2026-09-27-{a,b}.json`, campo `fidelidades`]

Qué importa para la factura [inferido]: perder `prompt_cache_key` no rompe nada visible, pero OpenAI la usa para enrutar peticiones con el mismo prefijo a la misma caché; sin ella baja la tasa de acierto y sube la factura, en una cantidad que aquí no se midió. Quitar `service_tier` a un modelo sin Flex evita un 400 y es defendible; a uno con Flex (`gpt-5-mini`) sería cobrar el doble, y Bifrost no lo hace. Que el cuerpo llegue reserializado con el mismo JSON no cambia la factura en OpenAI (la caché trabaja sobre los tokens, no sobre los bytes del JSON). La garantía de BV‑SALA —«with no lever armed, your provider receives the request body byte for byte» [3]— es la única de las cinco que se cumple **en bytes**, y ahora la ata también `test/latencia-gateways.test.ts` con los campos de factura de OpenAI.

### 4.4 Qué miden y cómo

| | De dónde sale el coste | En un acierto de caché | Ahorro que enseña | Base declarada |
|---|---|---|---|---|
| **LiteLLM 1.102.1** | `usage` del proveedor × su tabla de precios, que **al importarse baja de `raw.githubusercontent.com/BerriAI/litellm/main`** sin fijar versión (visto con el proxy de registro y con `get_model_cost_map_source_info()`: `source: remote`) [medido aquí]. Cabecera `x-litellm-response-cost` por respuesta, desglosada en entrada y salida | Con la caché local encendida, la repetición no llega al upstream (comprobado) y **la cabecera repite el coste de la llamada original** (`1.02e-05` en los dos casos), con el `usage` original [medido aquí, sin base de datos] | Del Auto Router, «**total estimated savings**» frente a «usar siempre el modelo más caro» [11]; el ROI Calculator modela horas de ingeniería [10] | No: gasto medido y ahorro estimado sin etiqueta por cifra |
| **Bifrost v2.2.3** | `usage` × precios que **sincroniza de `getbifrost.ai` al arrancar y cada 24 h** [medido aquí: log «background startup pricing sync completed»]. Coste por petición en `logs.db` y en su interfaz, con desglose [medido aquí] | La caché exige Redis/Valkey, Weaviate, Qdrant o Pinecone, también en modo exacto [16]; no probada (sin Docker) | Ninguno | No |
| **Portkey OSS 1.15.2** | No calcula coste en local | Con `cache: simple` responde `x-portkey-cache-status: DISABLED`: la caché necesita `REDIS_CONNECTION_STRING` [medido aquí + código] | Ninguno | No |
| **Helicone AI Gateway 0.2.0‑beta.30** | No calcula coste en local; el coste vive en la nube de Helicone | Caché en memoria: `helicone-cache: HIT` y el `usage` original, sin cifra de coste ni de ahorro [medido aquí] | Ninguno en local | No |
| **BV‑SALA 0.4.25 (gateway)** | `usage` del proveedor × catálogo con fechas de vigencia **dentro del paquete** (sin descarga en tiempo de ejecución); solo mide si el proveedor emitió `usage` y el modelo tiene precio [5] | El gateway no guarda respuestas (con `BVSALA_GATEWAY_COALESCE=1` sirve un duplicado **en vuelo** con la respuesta de la primaria); el SDK sirve la repetición idéntica con base `reference`, valorada con el contador de la llamada que sí corrió [3] | Cuatro libros que nunca se suman en una cifra (llamadas evitadas, tokens eliminados, comprimidos y cacheados por el proveedor), cada cifra con su base: `measured`, `reference` o `estimated` [3] | **Sí, por cifra**; detrás de un upstream no oficial (un mock, LiteLLM, vLLM) el precio de lista no cuenta como factura y no hay comisión (`esUpstreamOficial`) [5] |

Lo que sale de la tabla [inferido]: **ninguno de los cuatro OSS mide un ahorro**. Miden gasto (LiteLLM, Bifrost) o nada en local (Portkey, Helicone), y el único ahorro que se enseña, el del Auto Router de LiteLLM, es una estimación contra el contrafactual más halagüeño posible. El caso de la caché de LiteLLM es el más útil para BV‑SALA: justo donde hay un ahorro real y comprobable (la llamada no se hizo), la cifra que ve el cliente dice que se pagó. Es exactamente el hueco que cubre la base `reference`.

### 4.5 Tiempo hasta el primer ahorro medido

| | Instalar (cronometrado aquí, en limpio) | Configurar y arrancar (hasta escuchar) | Primera petición con coste | Hasta el primer **ahorro medido** | ¿Hace falta pagar? |
|---|---|---|---|---|---|
| **LiteLLM** | 2,5 s con `uv` (entorno de 475 MB) | Un YAML de 6 líneas; 2,8 s | Sí: cabecera `x-litellm-response-cost` | No llega: la caché no enseña ahorro, y el del Auto Router es estimado y vive en una tabla de la base de datos del proxy [11] | No |
| **Bifrost** | 41 s de descarga (binario de 123 MB) | Un JSON; 5,1 s la primera vez (crea sus bases SQLite) | Sí: en `logs.db` y su interfaz | No llega sin un almacén externo, y tampoco enseñaría ahorro | No |
| **Portkey OSS** | 4,6 s con npm (21 MB) | Sin fichero, por cabeceras; 0,3 s | **No**: no calcula coste | No llega (caché con Redis; sin coste) | No |
| **Helicone** | 1,2 s (5,4 MB, suma comprobada) | Un YAML; 0,4 s | **No** en local | No llega en local | No en local; la nube es de pago |
| **BV‑SALA** | 6,2 s con npm (55 MB con `gpt-tokenizer`) | **Bloqueado**: `bvsala gateway` no arranca sin `BIVELIO_SERVICE_KEY` y el SDK lanza «BiVelio license required… This published package has no unlicensed mode» [medido aquí]. Con licencia, el gateway compilado escucha en 0,18 s | Con licencia, sí: cada petición al panel | Con licencia, la primera repetición idéntica en el SDK sale con base `reference` (segundos) [código y doc; no medido: no hay licencia de prueba] | **Sí: 4 €/asiento/mes antes de ver nada** |

Tiempos de arranque medidos desde el lanzamiento hasta que el puerto escucha, con la caché de disco ya caliente [medido aquí].

**La brecha medida más grande no es técnica.** Los cuatro OSS arrancan en segundos y sin cuenta, y dos de ellos dan el coste de cada petición desde la primera; BV‑SALA es el único que puede enseñar un ahorro con base, y el único que no deja verlo sin pagar [inferido]. Refuerza la recomendación 5 del 26‑sep (licencia gratuita «Medir»), que sigue siendo decisión del dueño (E3).

### 4.6 Privacidad y cadena de suministro

| | Dónde escucha por defecto | Qué guarda | A quién llama por su cuenta al arrancar (vigía, 20–40 s) | Instalación verificable |
|---|---|---|---|---|
| **LiteLLM** | **`*:4000`, todas las interfaces**, y sin master key en la configuración mínima [medido aquí, `lsof`] | Sin base de datos, nada en disco | `raw.githubusercontent.com:443` (tabla de precios) [medido aquí, proxy] | Ruedas de PyPI con sha256; dos versiones maliciosas publicadas el 24‑mar‑2026 [6] |
| **Bifrost** | `localhost` (bandera `-host`) | **Prompts y respuestas en `logs.db`** (`input_history`, `content_summary`), legibles por `GET /api/logs` sin autenticación en la configuración por defecto [medido aquí] | `getbifrost.ai:443` ×2: precios y catálogo MCP [medido aquí, proxy + log] | El lanzador de npm descarga el binario **sin suma ni firma**; el servidor no publica suma; binario con firma ad hoc [código + medido aquí] |
| **Portkey OSS** | **`*:8787`, todas las interfaces**, sin opción de host [medido aquí + código] | Nada en disco | Ninguna [medido aquí] | npm con rangos `^` en sus dependencias: se resuelven al instalar; la versión que resuelve hoy de `@hono/node-server` rompe el stream (#1389) y las anteriores tienen un aviso alto (GHSA‑wc8c‑qw6v‑h7f6) [21][22] |
| **Helicone** | `0.0.0.0` según su código; la configuración del banco lo fija a loopback | Nada con `features: none` | Ninguna [medido aquí] | Publica sha256 por binario, pero **su instalador de npm no la comprueba** [código] |
| **BV‑SALA** | **`127.0.0.1`**, fijo en el código [5] | Nada: «nothing persisted» [3] | En el banco, ninguna (ingesta falsa local) [medido aquí]. El CLI real habla con `savings.bivelio.com` para recoger la licencia, las revocaciones, la renovación, los entitlements y la ingesta de cuentas (qué campos viajan: LICENSE §5) [código; E8 lo medirá] | npm con integridad sha512 y firmas del registro, pero **0.4.25 sin attestation de procedencia**: se publicó a mano porque la CI falló (bitácora, §6); el trusted publishing de #331 la añadirá cuando publique la CI [2][medido aquí, `npm view`] |

Lo que sale de la tabla [inferido]: en privacidad local BV‑SALA está en el grupo bueno (loopback, nada en disco), junto a Helicone y Portkey, y por delante de Bifrost (guarda el contenido) y LiteLLM (escucha en todas las interfaces). Su «llamada a casa» es mayor que la de Portkey o Helicone —cinco usos contra `savings.bivelio.com`—, pero es la única cuyos campos están enumerados uno a uno en una licencia. Decir «ningún gateway local llama a casa» sería falso para tres de los cinco.

## 5. Señales de mercado de septiembre de 2026

Solo lo que **no** estaba en el informe del 26‑sep, o lo que cambió desde entonces. Todo verificado en la fuente primaria el 27‑sep.

### 5.1 El «ahorro verificable» deja de ser territorio libre

| Fecha | Señal | Etiqueta | Qué significa para BV‑SALA |
|---|---|---|---|
| 15‑sep | **Caveman 2.7.0** retira de su documentación las cifras de ahorro no medidas: `/caveman-stats` «reports only what the transcript shows». Su web describe una escalera *inferred → replayed → verified* con recibos Ed25519 encadenados, y «verified_savings = $0.00 until a change is active on real traffic»; la plataforma sigue «en desarrollo» [32] | [doc] | El competidor con más estrellas (108.036★) adopta el lenguaje de BV‑SALA: base declarada y cero hasta que el proveedor lo demuestre. El diferencial «basis por cifra» se estrecha [inferido] |
| 21 y 25‑sep | **Headroom 0.38 y 0.39**: tarjeta «Cost Saved», ahorro por enrutado, «show the new‑input savings basis beside the whole‑wire figure», coste exacto de lectura de caché y gasto de salida acumulado «so a bill‑share rate has a denominator» [31] | [doc] | Headroom (73.941★) prepara un precio en % de la factura y etiqueta bases. Es la señal más directa de que alguien va a cobrar como BV‑SALA [inferido] |
| 21‑sep | Headroom 0.38: telemetría anónima «beacon schema v2 — routing/compression training signal» [31] | [doc] | Contraste de privacidad a favor de BV‑SALA, que no manda contenido ni señales de entrenamiento (LICENSE §5) |
| 26‑sep | **LiteLLM ROI Calculator**: dólares de gasto por «hora de ingeniería estimada», con esfuerzo estimado por un modelo sobre los PR [10] | [doc] | Ahorro **modelado**, no medido. Junto con el «total estimated savings» del Auto Router frente a «usar siempre el modelo más caro» [11], confirma que el gateway más usado mide gasto y **estima** ahorro |

### 5.2 Gateways: consolidación, abandono y Rust

| Fecha | Señal | Etiqueta |
|---|---|---|
| 22‑jun (vigente) | LiteLLM migra el gateway a Rust: «15x throughput, 11x less memory, and sub‑1ms per‑request overhead» en su AIGatewayBench (Python ~7,5 ms y 453 req/s; Rust ~0,05 ms y 6.782 req/s). Es una **beta opt‑in por formulario**; el paquete de PyPI sigue sirviendo el proxy en Python [9] | [marketing con método] |
| 6, 14, 19 y 24‑sep | LiteLLM 1.100–1.102: presupuestos por grupo de acceso, auto router heurístico, búsqueda semántica de herramientas MCP, «time‑based off‑peak pricing»; townhall de septiembre con 583 correcciones [8][12] | [doc] |
| 24‑sep | Bifrost `transports/v2.2.3`: breakpoints de caché de prompts para GPT‑6 en OpenAI, Azure y Bedrock [17] | [doc] |
| 25‑may (sin cambios) | **Portkey OSS**: último commit el 25‑may; última versión 1.15.2 del 12‑ene; 1.838 descargas npm/mes. La instalación por defecto rompe el stream (issues #1389 y #1550 abiertos) [20][21][35] | [medido aquí] + [doc] |
| 21‑nov‑2025 (sin cambios) | **Helicone AI Gateway** (Rust): sin commits desde el 21‑nov‑2025, su página de configuración da 404 y el catálogo embebido acaba en modelos de 2025; 91 descargas npm/mes. La plataforma sigue en «maintenance mode» y en septiembre recibió parches de seguridad («close platform‑admin takeover and HQL cross‑tenant bypass», 16‑sep) [23][24][25][26][35] | [medido aquí] + [doc] |
| 23‑jun y 21‑ago | Envoy AI Gateway llega a 1.0 (GA) y 1.1; el repositorio vive ahora en la organización `theagentrouter` [33] | [doc] |
| 27‑sep | TensorZero, archivado en GitHub [34] | [doc] |
| 9 y 22‑sep | OpenRouter: enrutado en región (EE. UU./UE) y Batch a mitad de precio. La compra por Stripe sigue **anunciada, no cerrada** [30] | [doc] |

### 5.3 Proveedores: precios y facturación

| Fecha | Señal | Etiqueta | Efecto |
|---|---|---|---|
| 22‑sep | **Claude Opus 5.5** a **4/20 $** por M tokens (Opus 5: 5/25 $), 1M de contexto, pensamiento adaptativo siempre activo [27] | [doc] | Deflación: la misma factura encoge un 20 % sin que nadie optimice nada. Un ahorro medido contra el mes anterior la confundiría con mérito propio |
| 22‑sep | GPT‑6 Sol (2 / 0,20 / 10 $) y Luna (0,10 / 0,01 / 0,50 $); 25‑sep: corrección de un fallo de codificación de imágenes en ambos [28] | [doc] | Ya en el informe del 26‑sep; el 25‑sep pide repetir evaluaciones con imágenes |
| 24‑sep | Anthropic **vuelve a cobrar** las negativas que llegan antes de cualquier salida en tres categorías, «at the rates of the model that ran it» [27] | [doc] | Una respuesta sin texto también es factura: el gateway y el SDK deben medirla (experimento E7) |
| 22‑sep | Anthropic, herramientas en línea (beta `inline-tools-2026-09-15`): definirlas en un mensaje de sistema a mitad de conversación [27] | [doc] | Otra palanca de caché que el proveedor regala |
| 2 y 18‑sep | Gemini 3.8 Flash en GA; Gemini 2.5 restringido a quien ya lo usaba [29] | [doc] | Catálogo: fila nueva y migración forzada |
| 10 y 15‑sep | OpenAI: Agents API en beta pública con Codex gestionado; gobierno de claves de API por organización [28] | [doc] | El proveedor entra en la orquestación de agentes |

## 6. Opciones

| Opción | Qué sería | A favor | En contra |
|---|---|---|---|
| **A. Competir en rendimiento del gateway** | Perfilar y optimizar el gateway para acercarse a Bifrost o Helicone en carga | La tabla de carga es la única donde BV‑SALA queda en mitad de tabla | Nadie compra un medidor local por RPS: un desarrollador manda decenas de peticiones por minuto y a concurrencia 1 BV‑SALA ya está en el grupo de cabeza. Es esfuerzo sin comprador [inferido] |
| **B. Vender lo que la tabla demuestra: fidelidad y medición con base** | Publicar, con método y fecha, que el gateway entrega los bytes intactos y que cada cifra lleva su base, frente a gateways que reescriben campos de factura o repiten el coste en un acierto de caché | Es verificable por un tercero con `pnpm latencia:gateways`; coincide con lo que premia la evidencia (informe del 26‑sep, §4) | Comparar con nombre a terceros exige cuidado: versiones que cambian, una sola máquina. Solo con la tabla completa, la fecha y el enlace al arnés |
| **C. Abrir la puerta: la licencia gratuita «Medir»** | Recomendación 5 del 26‑sep | Hoy es la mayor brecha medida: los cuatro OSS arrancan sin cuenta y dos dan coste por petición desde el primer minuto; BV‑SALA exige pagar antes de enseñar nada | Revierte en parte #314; decisión de negocio **del dueño** |
| **D. Complementar a LiteLLM en vez de competir** | Documentar y probar el SDK delante de un LiteLLM (o un callback de LiteLLM que lleve libros con base) | 89 M de descargas al mes en PyPI según el informe del 26‑sep [1]; el hueco medido (el acierto de caché repite el coste) es exactamente lo que BV‑SALA resuelve con la base `reference` | Detrás de LiteLLM el precio de lista no es lo que se pagó: BV‑SALA ya lo trata como no oficial y no cobra comisión (`esUpstreamOficial`) [5]. Sería medición, no ingreso |
| **E. No hacer nada nuevo** | Quedarse con el informe del 26‑sep | Coste cero | Deja sin respuesta la pregunta de un comprador técnico: «¿cuánto añade tu proxy y qué me cambia?» |

## 7. Decisión y por qué

**Decisión de esta línea: construir el instrumento que hace posible B y proponer B al dueño; C (la licencia «Medir») queda propuesta al dueño con el dato de hoy; A y D pasan a experimentos condicionados (E5, E6).** Publicar comparaciones con nombre de terceros es decisión del dueño.

Por qué:

1. **La latencia no es el problema ni el argumento.** A concurrencia 1 el gateway de BV‑SALA está en el grupo de cabeza (§4.1) y todo el grupo queda por debajo del milisegundo, ruido frente a los 300–2.000 ms que tarda un proveedor real en dar el primer token. Optimizar para la tabla de carga (A) sería esfuerzo sin comprador mientras nadie use el gateway en servidor.
2. **Lo que sí distingue a BV‑SALA se puede demostrar y reproducir.** Es el único de los cinco que entrega los bytes intactos en los dos sentidos (§4.3) y el único que etiqueta la base de cada cifra (§4.4). Las dos cosas las comprueba ahora un arnés que cualquiera puede volver a pasar, y la fidelidad del gateway propio queda atada en la CI.
3. **La brecha más grande es comercial, no técnica** (§4.5): pagar antes de ver nada. Eso no se arregla con código en esta línea; se arregla con la decisión del dueño sobre «Medir» (E3).
4. **No se construye ninguna palanca ni se toca el comportamiento del producto.** El PR añade instrumentos de medida, sus tests y la evidencia; nada que pueda cobrar ni cambiar una petición de un cliente.

## 8. Qué se construye hoy y qué queda

**Entra hoy (este PR):**

- `benchmarks/latencia-gateways/`: el núcleo puro (`nucleo.ts`: percentiles, IC de la mediana por bootstrap, órdenes multibrazo, cuerpos de prueba, comparación de fidelidad, lectura de `lsof`), el upstream falso (`upstream-falso.ts`, OpenAI y Anthropic, con y sin stream, más una ingesta falsa y un espejo de la última petición), el lanzador del gateway de BV‑SALA compilado (`lanzar-bvsala.ts`), el arnés (`arnes.ts`), el vigía de conexiones con proxy de registro (`vigia-conexiones.ts`), las configuraciones mínimas de LiteLLM, Bifrost y Helicone, y un README con versiones fijadas, sumas y avisos.
- `pnpm latencia:gateways` y `pnpm vigia:conexiones` en `package.json`. Ninguna dependencia nueva.
- `test/latencia-gateways.test.ts`: 16 tests (estadística, cuerpos, fidelidad, `lsof`, upstream falso y el arnés de extremo a extremo contra el gateway de BV‑SALA en proceso, incluida la garantía de bytes intactos con los campos de factura de OpenAI). Ninguna petición sale de 127.0.0.1.
- `test/modelos-que-servimos.test.ts` declara `gpt-5-mini`, que el banco nombra para la prueba de Flex (ya tenía fila en el catálogo y fila Flex oficial): la verja sigue exigiendo fila a todo modelo nombrado.
- La evidencia: `benchmarks/evidencia/latencia-gateways-2026-09-27-a.json` y `-b.json`.
- Este informe.

**Queda:** los experimentos E1–E9 de §10; una tirada en máquina ociosa y en Linux antes de citar ninguna cifra de latencia fuera de este informe (E2); y las decisiones del dueño: «Medir» (E3), la licencia de staging para vigilar el gateway real (E8) y cualquier texto público que nombre a competidores.

## 9. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Las cifras de latencia se leen como promesa de producto | Media | Medio | El README del arnés y este informe dicen que es una máquina, una fecha y unas versiones; la cifra no entra en la web sin la tabla completa y el enlace al método |
| Ruido de la máquina compartida (carga media > 100 en algunos tramos) | Alta hoy | Bajo en la mediana, alto en la cola y la carga | Dos tiradas separadas y comparadas (§4.1); experimento E2 repite en máquina ociosa y en un runner Linux |
| Un tercero replica y le sale otra cosa | Media | Medio | El arnés y las configuraciones están en el repo; los desacuerdos se investigan, no se discuten |
| Comparar con nombre a competidores en material público | Media | Medio (reputación, reclamaciones) | Solo hechos reproducibles con versión y fecha; nada de marcas en la portada; el texto público lo aprueba el dueño |
| La foto caduca rápido (LiteLLM saca versión cada semana; su gateway en Rust cambiaría la tabla de carga) | Alta | Bajo | Fecha en cada cifra; el arnés se vuelve a pasar antes de citar nada (E2) |
| Sesgo del upstream falso: responde al instante y en loopback | Cierta | Bajo | Se dice: mide lo que añade el proceso, no la red; con un proveedor real medio milisegundo es ruido |
| Instalar software de terceros en la máquina del dueño | Baja | Medio | Todo en directorios temporales, con `HOME` redirigido, versiones fijadas y sumas comprobadas donde existen; nada global; los procesos escuchan en loopback salvo donde el producto no lo permite (LiteLLM y Portkey), y solo con claves de relleno |

## 10. Experimentos priorizados (28‑sep a 11‑oct‑2026) y cómo se medirá el efecto

Ordenados por impacto sobre esfuerzo. «Dueño» marca lo que exige una decisión suya; lo demás lo puede hacer una sesión.

| # | Experimento | Hipótesis | Métrica y umbral de decisión | Esfuerzo | Quién decide |
|---|---|---|---|---|---|
| **E1** | **Fidelidad en el dialecto de Anthropic.** Extender la prueba de fidelidad a `/v1/messages` (`cache_control` con TTL de 1 h, `anthropic-beta`, `tool_reference`, herramientas en línea) contra el paso directo de LiteLLM (`/v1/messages`), Bifrost (`/anthropic/v1/messages`) y Portkey | Al menos un gateway OSS popular pierde o reescribe un campo que cambia la factura de Claude Code, el tráfico principal del gateway de BV‑SALA | Tabla de campos conservados por gateway. Si alguno pierde un campo de caché: entra en la sección «no empeora» de la web con método y fecha | S | Sesión; el texto público, el dueño |
| **E2** | **Repetir la latencia en limpio**: máquina ociosa y un runner Linux de GitHub Actions, dos tiradas cada uno, con `--guardar` | La mediana de BV‑SALA a concurrencia 1 se mantiene por debajo de 1 ms (límite superior del IC) en todos los escenarios y entornos | Si se cumple en los cuatro entornos, la cifra se puede citar con su tabla; si no, se investiga antes de citar | S | Sesión |
| **E3** | **«Medir» gratis 14 días** (recomendación 5 del 26‑sep, con el dato de hoy) | El cuello de la adopción es pagar antes de ver un ahorro: los cuatro OSS arrancan sin cuenta y LiteLLM y Bifrost enseñan coste en el primer minuto | Activaciones por semana; mediana del tiempo entre `npm install` y el primer registro con base `reference` (el servidor tiene la marca de tiempo del primer registro de cada org); conversión a pago a 30 días ≥ 10 % | M | **Dueño** (revierte en parte #314) |
| **E4** | **Contraste semanal del catálogo de precios** con la tabla de LiteLLM (MIT) y los precios de Bifrost para los modelos que servimos, como **alarma**, nunca como fuente | Salen discrepancias al mes; algunas son errores nuestros y otras suyos. Hoy LiteLLM baja su tabla de `main` sin fijar versión, y Bifrost la sincroniza cada 24 h | Discrepancias por semana y cuántas confirma la página oficial del proveedor; objetivo: cero errores nuestros confirmados que lleguen a un cliente | S | Sesión |
| **E5** | **Perfil de carga del gateway**: `node --cpu-prof` a concurrencia 32 con cuerpos de 200 KB | El tiempo se va en trabajo por petición (lectura y huella del cuerpo, observador SSE, línea de log) que se puede recortar | Solo si un cliente usa el gateway en servidor (Python por el gateway): objetivo, p50 de sobrecoste a c=32 ≤ 1 ms. Sin ese cliente, se aparca | M | Sesión, tras E2 |
| **E6** | **BV‑SALA delante de LiteLLM**: una receta documentada y una prueba de extremo a extremo con el SDK apuntando a un LiteLLM local | El comprador que ya tiene LiteLLM quiere libros con base sin cambiar de gateway | Receta publicada; un test que demuestre que la repetición idéntica sale `reference` y que detrás de un upstream no oficial no hay comisión | S–M | Sesión; publicarla, el dueño |
| **E7** | **Negativas facturadas** (Anthropic, 24‑sep): un test del gateway y del SDK con una negativa que trae `usage` y sin texto | Se miden como cualquier petición; el test lo ata para que no se pierdan en un futuro filtro de «respuesta vacía» | Test verde en CI; si falla, arreglo antes de la próxima versión | S | Sesión |
| **E8** | **Vigía sobre el gateway real**: `bvsala gateway` con una licencia de pruebas del entorno de staging bajo `pnpm vigia:conexiones --proxy-registro` | Solo contacta `savings.bivelio.com` y solo en los cinco usos de la LICENSE §5 (licencia, revocaciones, renovación, entitlements, ingesta) | Lista de destinos y rutas, publicable junto a la de LiteLLM (GitHub) y Bifrost (`getbifrost.ai`) | S | **Dueño** (la licencia de staging) |
| **E9** | **Radar quincenal** de Headroom, Caveman y LiteLLM (versiones, bases de ahorro, precios) | Uno de los tres publica un precio sobre el ahorro medido antes de noviembre | Una nota en la bitácora cada 15 días; si alguno cobra sobre lo medido, se revisa el mensaje de la web | S | Sesión |

**Cómo se medirá el efecto de lo que entra hoy.** El arnés no cambia el producto: su efecto es poder contestar con datos. Se da por bueno si (1) una segunda persona reproduce las tablas de §4 con `pnpm latencia:gateways` y los comandos del README del arnés, con medianas dentro del mismo orden de magnitud; (2) la prueba de fidelidad del gateway de BV‑SALA sigue en verde en la CI (`test/latencia-gateways.test.ts`), de modo que un cambio que reescriba bytes sin declararlo se ve antes de publicar; y (3) E1 y E2 se ejecutan con este mismo arnés sin tocar su núcleo.

## 11. Fuentes

Consultadas el 27‑sep‑2026 salvo que se indique otra fecha. El cupo de búsqueda web estaba agotado: todo se leyó en la fuente primaria (webs, documentación, GitHub con `gh api`, npm y PyPI).

**Internas**
1. `docs/COMPETENCIA-2026-09-26.md`, origin/main `bd108ff`. [interno]
2. `docs/BITACORA-2026-09-26.md`, origin/main `bd108ff`. [interno]
3. `README.md` de `@bivelio/savings-layer` 0.4.25. [interno]
4. `benchmarks/latencia-gateways/` y `benchmarks/evidencia/latencia-gateways-2026-09-27-*.json` (este PR). [medido aquí]
5. `gateway/servidor.ts` (escucha en 127.0.0.1), `gateway/upstream.ts` (`esUpstreamOficial`), `gateway/license.ts` (`LICENSE_SERVER_URL`). [código]

**LiteLLM**
6. Incidente de cadena de suministro (1.82.7 y 1.82.8, 24‑mar‑2026): https://docs.litellm.ai/blog/security-update-march-2026
7. Benchmarks del proxy (mediana 2 ms, P95 8 ms, P99 13 ms de sobrecoste por la cabecera `x-litellm-overhead-duration-ms`; Locust, 1.000 usuarios): https://docs.litellm.ai/docs/benchmarks [marketing con método]
8. Notas de versión 1.100–1.102 (6, 14 y 19‑sep‑2026): https://docs.litellm.ai/release_notes ; https://docs.litellm.ai/release_notes/v1.101.0/v1-101-0
9. «Migrating LiteLLM to Rust» (22‑jun‑2026): https://docs.litellm.ai/blog/litellm-rust-launch [marketing con método]
10. «Introducing the LiteLLM ROI Calculator» (26‑sep‑2026): https://docs.litellm.ai/blog/litellm-roi-calculator
11. «AutoRouter: Easy Visibility to Your Savings» (6‑ago‑2026): https://docs.litellm.ai/blog/auto-router-spend-visibility
12. Índice del blog (townhall de septiembre, 24‑sep; LiteAgents, 25‑sep): https://docs.litellm.ai/blog
13. PyPI, `litellm` (1.102.1; rueda arm64 sha256 `da73fe3f…b280c7`): https://pypi.org/pypi/litellm/json
14. GitHub `BerriAI/litellm` («Rust core with Python SDK», 59.714★): https://github.com/BerriAI/litellm

**Bifrost**
15. Benchmarks («11 µs» en t3.xlarge y «59 µs» en t3.medium a 5.000 RPS, con «mocked OpenAI calls»): https://docs.getbifrost.ai/benchmarking/getting-started [marketing]
16. Caché semántica (exige Redis/Valkey, Weaviate, Qdrant o Pinecone, también en modo directo): https://docs.getbifrost.ai/features/semantic-caching
17. `transports/v2.2.3` (24‑sep‑2026): https://github.com/maximhq/bifrost/releases/tag/transports/v2.2.3
18. Lanzador `@maximhq/bifrost` 1.6.3 (`bin.js`, descarga sin suma ni firma) y https://getbifrost.ai/latest-release [código]
19. Esquema de configuración: https://www.getbifrost.ai/schema

**Portkey**
20. GitHub `Portkey-AI/gateway` (último commit 25‑may‑2026; 1.15.2 del 12‑ene‑2026; «<1ms latency», «122kb»): https://github.com/Portkey-AI/gateway [marketing en las cifras]
21. Issues #1389 (23‑oct‑2025) y #1550 (4‑mar‑2026), `TypeError: immutable`: https://github.com/Portkey-AI/gateway/issues/1389 ; https://github.com/Portkey-AI/gateway/issues/1550
22. GHSA‑wc8c‑qw6v‑h7f6, `@hono/node-server` < 1.19.10 (4‑mar‑2026): https://github.com/advisories/GHSA-wc8c-qw6v-h7f6

**Helicone**
23. GitHub `Helicone/ai-gateway` (último push 21‑nov‑2025; 0.2.0‑beta.30 del 21‑jul‑2025; «P95 <10ms» en el README del binario): https://github.com/Helicone/ai-gateway [marketing en las cifras]
24. «Helicone is joining Mintlify» (3‑mar‑2026): https://www.helicone.ai/blog/joining-mintlify
25. Commits de seguridad en `Helicone/helicone` (#5801, 31‑ago; #5816, 16‑sep‑2026): https://github.com/Helicone/helicone/commits/main
26. https://docs.helicone.ai/ai-gateway/config → HTTP 404 (27‑sep‑2026)

**Proveedores y mercado**
27. Anthropic, notas de versión de la API (22, 23 y 24‑sep‑2026): https://platform.claude.com/docs/en/release-notes/api
28. OpenAI, changelog (3, 8, 10, 15, 22 y 25‑sep‑2026): https://developers.openai.com/api/docs/changelog
29. Google, changelog de la Gemini API (2 y 18‑sep‑2026): https://ai.google.dev/gemini-api/docs/changelog
30. OpenRouter, anuncios (9 y 22‑sep‑2026; compra por Stripe anunciada el 19‑ago, sin cierre): https://openrouter.ai/announcements
31. Headroom v0.38.0 (21‑sep) y v0.39.0 (25‑sep‑2026): https://github.com/headroomlabs-ai/headroom/releases
32. Caveman v2.7.0 (15‑sep‑2026) y su web: https://github.com/JuliusBrussee/caveman/releases/tag/v2.7.0 ; https://caveman.so
33. Envoy AI Gateway v1.0.0 (23‑jun) y v1.1.0 (21‑ago‑2026): https://github.com/theagentrouter/agent-router/releases
34. `tensorzero/tensorzero`, archivado: https://github.com/tensorzero/tensorzero
35. API de descargas de npm, 28‑ago a 26‑sep‑2026: https://api.npmjs.org/downloads/point/last-month/@portkey-ai/gateway (y el análogo para `@maximhq/bifrost` y `@helicone/ai-gateway`)
36. Portkey, `src/handlers/streamHandler.ts` (espera de 25 ms antes del primer trozo, líneas 182–186): https://github.com/Portkey-AI/gateway/blob/main/src/handlers/streamHandler.ts [código]

---

## 12. Anexo del 27‑sep‑2026 (noche): E7 y E1, ejecutados

Línea «negativas y fidelidad de Anthropic». Mismo arnés y misma máquina que §3 (Apple M4 Pro, Node 25.9.0, compartida con otras cuatro líneas). Etiqueta nueva: **[laboratorio]** = cifra o resultado obtenido hoy en esta máquina contra el upstream falso, con las versiones fijadas de §3; no es una medida contra ningún proveedor real (esta línea no llamó a ninguna API con gasto). Nada de este anexo es texto público: comparar con nombre fuera del repo lo aprueba el dueño.

### 12.1 E7 · Negativas facturadas

**Qué dice Anthropic** [doc, consultado el 27‑sep‑2026, 37–39]. Una negativa es un HTTP 200 normal con `content: []`, `stop_reason: "refusal"` y `stop_details: { type: "refusal", category, explanation }`; «either way, `content` is empty and token counts appear in `usage`». En stream: `message_start` con su `usage`, ningún bloque y un `message_delta` con `delta.stop_reason: "refusal"` y `delta.stop_details`. Desde el 24‑sep se cobran las que llegan **antes de cualquier salida** en `bio`, `frontier_llm` y `reasoning_extraction`, «like any other request, at the rates of the model that ran it»; en `cyber`, `general_harms` o categoría nula **no** se cobran; las de mitad de stream se cobraban ya. La lista «may change». Afecta a Fable 5.1, Fable 5, Opus 5.5 y Opus 5.

**Hipótesis: confirmada.** Con una negativa cobrada (`frontier_llm`, Opus 5.5, 412 tokens de entrada, 0 de salida) el gateway (JSON y SSE), el SDK (`generate` y `generateStream` con el proveedor de Anthropic), el adaptador del SDK oficial (`messages.create` y `messages.stream`) y, donde aplica, Chat Completions (`finish_reason: "content_filter"`) la miden `measured`, con su coste (0,001648 $ [laboratorio]), baseline igual al coste y `netSavings` 0. Lo atan 14 tests en `test/negativas-facturadas.test.ts`: un filtro futuro de «respuesta vacía» que la perdiera se pone rojo.

**Lo que no estaba bien, y se arregló en este PR** (lo encontraron esos mismos tests):

| # | Dónde | Qué pasaba [laboratorio] | Arreglo |
|---|---|---|---|
| 1 | SDK, caché exacta y semántica | La negativa se guardaba 24 h y la repetición salía `cache: exact` con base **`reference`** (comisionable); un seguidor de singleflight, también `reference` | Sexta puerta de la caché: `finishReason === "content_filter"` no se cachea; sin registro de referencia (E7 de `referencia.ts`), el seguidor sale `estimated` |
| 2 | Gateway, coalescencia | La gemela de una negativa se valoraba por referencia, y la verja real del ingest la aceptaba como `reference` | Motivo nuevo `primary-refused`: la gemela sigue siendo llamada evitada, pero `estimated` |
| 3 | SDK con contrato de salida | La negativa (sin texto) no cumplía el contrato y la capa **pagaba una reparación** al mismo modelo con la salida vacía: dos llamadas y `netSavings: -1` | `repair-skipped` con `skipReason: "provider_refusal"` (tipo público ampliado) |

**Decisión: una negativa no se guarda en caché ni se repite por referencia.** (a) No es una respuesta: la documentación manda reintentar en otro modelo o con `fallbacks`, y los clasificadores tienen falsos positivos; congelarla 24 h serviría el falso positivo sin preguntar. (b) Repetida por referencia acreditaría una llamada evitada que en `cyber`, `general_harms` o categoría nula habría costado 0 $: ahorro inventado y comisionable. (c) La lista de categorías cobradas puede cambiar, así que al leer la caché no se sabe si la repetición se habría facturado. Es la regla que ya aplicaban los adaptadores de frameworks (solo se reutiliza `stop`/`end_turn`) y la misma familia que «media respuesta no se cachea». El coste de equivocarse al revés es una llamada más, y queda en la traza.

**Lo que queda, y es del dueño** [inferido]:

- **Las negativas NO cobradas se miden como si lo fueran.** En `cyber`, `general_harms` o categoría nula el gateway y el SDK apuntan `measured` con coste = `usage` × precio, cuando Anthropic factura 0 $. Sin palancas el ahorro sigue a 0 (solo se infla el gasto del panel), pero con la palanca C (modelo hermano) o la rebaja de TTL el gateway podría acreditar ahorro `measured` sobre una petición que no se cobró. Opciones: coste 0 si la categoría no está en la lista publicada (frágil: la lista cambia), marcarla sin crédito, o dejarlo. Toca cifras de gasto y comisión: no se cambió.
- **La negativa de salidas estructuradas de OpenAI** (`content: null` + `refusal`, con `finish_reason: "stop"`) se mide bien, pero el adaptador no la propaga como negativa y la capa aún paga una reparación. Arreglarlo cambiaría el `finishReason` que ve el cliente; no se hizo.
  **Cerrado el 28‑sep‑2026** (#367) [doc 43–44 + laboratorio]: el `finishReason` no se toca (sigue `stop`, como lo dijo el proveedor); el adaptador de Chat Completions propaga `message.refusal` (JSON) y `delta.refusal` (stream) en un campo nuevo, `refusal`, y el pipeline la trata como negativa: medida, sin reparación (`skipReason: "provider_refusal"`), sin caché, sin registro por referencia y con el seguidor de singleflight `estimated`. El cliente la ve en `SavingsResult.refusal`. Una respuesta vacía normal (`content: ""`, `refusal: null`) sigue siendo una respuesta.
- La negativa de la Responses API (una parte `refusal` dentro de una respuesta `completed`) no la ve la guarda de coalescencia del gateway.
  **Cerrado el 28‑sep‑2026** (#367) [doc 43, 45 + laboratorio]: `negativaEnJson` y `ObservadorResponses` la ven en JSON y en SSE (`response.refusal.delta`/`.done`, la parte `refusal` en `content_part`/`output_item` y en el `response.output` del evento final), y la gemela sale `estimated` con `primary-refused`. De paso, el gateway ve también el `message.refusal`/`delta.refusal` de Chat Completions, que tenía el mismo hueco. Lo atan 10 tests en `test/negativas-facturadas.test.ts`: 8 fallan con el código anterior (reparación pagada, caché, seguidor y gemelas `reference`) y 2 son controles.

### 12.2 E1 · Fidelidad en el dialecto de Anthropic

**Método.** `pnpm latencia:gateways --solo-fidelidad` con el cuerpo nuevo `cuerpoDeFidelidadAnthropic`: `cache_control` con `ttl: "1h"` en `system`, en una herramienta y en el último turno; la búsqueda de herramientas (herramienta de búsqueda, una diferida con `defer_loading: true` y, en el historial, su `tool_search_tool_result` con un `tool_reference`); y las herramientas en línea: un mensaje `system` a mitad de conversación con un `tool_addition` por definición y otro por referencia [doc, 40]. Cabeceras `anthropic-version: 2023-06-01` y `anthropic-beta: extended-cache-ttl-2025-04-11,inline-tools-2026-09-15,mid-conversation-tool-changes-2026-07-01`. El upstream falso contesta con una `tool_use` y un `usage` con escritura de caché de 1 h desglosada (100 de entrada, 2.048 escritos a 1 h, 12 de salida). Con `claude-haiku-4-5` y `claude-opus-5-5`, en JSON y en SSE; dos pasadas, idénticas. Versiones de §3, instaladas de nuevo en un directorio temporal (Bifrost con la misma sha256 `dd596a79…33b4a`), en loopback salvo Portkey, que no lo permite; todo parado al acabar. Evidencia: `benchmarks/evidencia/fidelidad-anthropic-2026-09-27.json` [41].

| Gateway (ruta) | Cuerpo que llega al proveedor | `anthropic-beta` | Respuesta JSON | Respuesta SSE |
|---|---|---|---|---|
| **BV‑SALA** (`/v1/messages`, los dos modos) | **Bytes idénticos** | **Intacta** | **Bytes idénticos** | **Bytes idénticos** |
| LiteLLM 1.102.1 (`/v1/messages`) | Mismo JSON reserializado; añade `stream: false`. Conserva los `ttl`, el `tool_reference` y las herramientas en línea | Le **antepone** `advanced-tool-use-2025-11-20` | `model` pasa a ser el alias (`bench-claude-haiku-4-5`); `usage` intacto | Igual: el alias en `message_start`; `usage` intacto |
| Bifrost v2.2.3 (`/anthropic/v1/messages`) | **Quita el mensaje `system` a mitad de conversación** (los dos `tool_addition`: las herramientas en línea no llegan); parte el turno del asistente en dos; aplana `tool_search_tool_result.content` en `tool_references`. Conserva los `ttl` de `system`, herramientas y turno | **La sustituye entera** por `tool-search-tool-2025-10-19` (se pierden `extended-cache-ttl`, `inline-tools` y `mid-conversation-tool-changes`) | Mismo JSON, claves reordenadas; `usage` intacto | Quita `service_tier` y **reescribe el `message_delta` final con `input_tokens: 0`, `cache_creation_input_tokens: 0` y la escritura de 1 h a 0** |
| Portkey 1.15.2 (`/v1/messages`) | Mismo JSON, claves reordenadas | Intacta | **Bytes idénticos** | **HTTP 500** `TypeError: immutable` (el fallo de stream de §4.1) |

[laboratorio; el `model` reescrito por diseño no cuenta como cambio en el cuerpo]

Lo que sale de la tabla:

- **La hipótesis de E1 se cumple con Bifrost** [laboratorio + inferido]: en el dialecto que más tráfico lleva al gateway de BV‑SALA (Claude Code), pierde la cabecera de betas que Claude Code negocia para el TTL de 1 h y las herramientas en línea, cuya razón de ser es cambiar herramientas **sin** invalidar la caché de prefijo. Si la API real sigue exigiendo esa beta para el TTL de 1 h, o si el cliente recurre a reescribir `tools` al no llegarle las herramientas en línea, la factura sube; esta línea **no lo verificó** contra la API real.
- **El `usage` del stream de Bifrost es el hallazgo con más dinero** [laboratorio + código]. Quien fusiona `message_start` ∪ `message_delta` para leer el contador —el `MessageStream` del SDK oficial de TypeScript (0.128.0) pisa los campos no nulos del delta, y el medidor del gateway y el proveedor de Anthropic de BV‑SALA hacen lo mismo [42]— lee 0 de entrada y 0 de escritura de caché. En el caso de laboratorio, con precios de Opus 5.5, la petición cuesta 0,017024 $ y el contador fusionado dice 0,00024 $: un 98,6 % de gasto que desaparece. Consecuencia para BV‑SALA [inferido]: el SDK detrás de Bifrost mediría de menos (y E6, «BV‑SALA delante de LiteLLM», habría que repetirlo con Bifrost antes de recomendarlo).
- **LiteLLM** conserva todo lo que cambia la factura; reescribe el `model` de la respuesta (como en Chat Completions, §4.3) y añade una beta por su cuenta.
- **Portkey** conserva el JSON en los dos sentidos, pero sin stream no sirve a Claude Code.
- **BV‑SALA** es el único de los cuatro que entrega los bytes intactos en los dos sentidos también en este dialecto, y ahora lo ata la CI: `test/latencia-gateways.test.ts` pasa la prueba contra el gateway en proceso (dos modelos, JSON y SSE, cuerpo, `anthropic-beta`, respuesta y `usage`) y un control negativo demuestra que la prueba ve un `ttl` y una beta perdidos.

**Umbral de §10:** «si alguno pierde un campo de caché: entra en la sección "no empeora" de la web con método y fecha». Bifrost pierde la beta del TTL y las herramientas en línea, y reescribe el contador del stream. El texto público con nombre queda **para el dueño**.

### 12.3 Qué entra con este anexo

- E7: `src/pipeline/pipeline.ts` (la sexta puerta de la caché y la reparación que no se hace), `src/contracts/types.ts` (`skipReason: "provider_refusal"`), `gateway/medidor.ts`, `gateway/coalescencia.ts` y `gateway/servidor.ts` (`primary-refused`), `test/negativas-facturadas.test.ts`.
- E1: `benchmarks/latencia-gateways/` (cuerpo, comparación de cabeceras, diferencias por ruta, SSE y `usage`; el upstream falso con la respuesta de fidelidad de Mensajes y el espejo de cabeceras; `--solo-fidelidad`, `--prefijo` y `--modelos-fidelidad-anthropic`; las rutas de Mensajes de LiteLLM, Bifrost y Portkey en sus configuraciones), 7 tests nuevos en `test/latencia-gateways.test.ts` y la evidencia.

**Fuentes del anexo** (consultadas el 27‑sep‑2026):

37. Anthropic, «Refusals and fallback» («What a refusal looks like», «How refusals are billed»): https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback
38. Anthropic, «Handling stop reasons» (`refusal`, en JSON y en stream): https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
39. Anthropic, notas de versión de la API, 24‑sep‑2026 («Refusals Billing Change»): https://platform.claude.com/docs/en/release-notes/api
40. Anthropic, «Mid-conversation system messages» (`tool_addition`, `tool_reference`, betas `inline-tools-2026-09-15` y `mid-conversation-tool-changes-2026-07-01`): https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
41. `benchmarks/evidencia/fidelidad-anthropic-2026-09-27.json` (este PR). [laboratorio]
42. `@anthropic-ai/sdk` 0.128.0, `lib/MessageStream.js` (el `message_delta` pisa `input_tokens` y los contadores de caché si no son nulos); `gateway/medidor.ts` (`ObservadorSse`) y `src/providers/anthropic-uso.ts` (`fusionarUso`). [código]

Consultadas el 28‑sep‑2026, para el cierre de las dos negativas de OpenAI:

43. OpenAI, «Structured model outputs», sección «Refusals with Structured Outputs» (ejemplo de Chat Completions: `message.refusal` sin `content` y `finish_reason: "stop"`; ejemplo de Responses: parte `{ "type": "refusal", "refusal": … }` en una respuesta `status: "completed"`): https://developers.openai.com/api/docs/guides/structured-outputs
44. OpenAI, referencia de Chat Completions (`message.refusal: string or null`, «The refusal message generated by the model»; `delta.refusal` en el stream): https://developers.openai.com/api/reference/resources/chat y https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
45. OpenAI, eventos de stream de la Responses API (`response.refusal.delta`, `response.refusal.done`, `ResponseOutputRefusal` en `response.content_part.added`): https://developers.openai.com/api/reference/resources/responses/streaming-events

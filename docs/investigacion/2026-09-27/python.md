# Python: el mejor camino para que un desarrollador de Python obtenga lo mismo que en TypeScript

**Fecha:** 2026-09-27 · **Línea:** «python» (rama `feat/python`) · **Base:** `origin/main` @ `bd108ff` (paquete 0.4.25)

Etiquetas, como en el informe de competencia: **[medido]** = lo he comprobado yo, con código o ejecutándolo; **[fuente]** = lo dice la fuente primaria citada; **[marketing]** = cifra del propio vendedor; **[inferido]** = conclusión de este análisis.

---

## 1 · La pregunta

Python es el mercado mayor y BV‑SALA solo tiene SDK en TypeScript (informe de competencia, §5: «Solo TypeScript/Node. Python llega solo a través del gateway» [21]). Hoy un script de Python puede apuntar el SDK oficial al gateway y su gasto aparece en el panel, pero **el script no recibe nada**: ni el `SavingsReport` por petición que devuelve el SDK de TypeScript, ni una señal de que la licencia no sirve, ni el motivo cuando una petición no se mide. ¿Cuál es el mejor camino para que un desarrollador de Python tenga lo mismo, sin romper los principios (ahorro medido con el contador del proveedor, cero cifras sin fuente, fail-closed sin licencia)?

Opciones evaluadas: (a) cliente Python fino sobre el gateway local; (b) callback de LiteLLM; (c) envoltorios de los SDK oficiales `openai` y `anthropic`; (d) port del núcleo.

## 2 · Hallazgos

### 2.1 El tamaño del mercado

- `openai` 284.217.868 descargas/mes, `anthropic` 139.420.518, `litellm` 89.385.344 (pypistats, ventana de 30 días, consultado el 27‑sep‑2026) [1] [fuente]. El SDK oficial de OpenAI en Python mueve 3,2 veces lo que LiteLLM.
- Headroom, el competidor más parecido en forma, ya se distribuye en Python como biblioteca, como proxy (`headroom proxy`), con envoltorios de los SDK y con un callback de LiteLLM (`litellm.callbacks = [HeadroomCallback()]`) [13] [fuente; sus cifras de ahorro son marketing]. Langfuse ofrece un reemplazo directo (`from langfuse.openai import openai`) y pide `include_usage` para medir streams [14] [fuente].

### 2.2 Los SDK oficiales de Python, hoy

- `openai` 3.19.2 y `anthropic` 1.8.0 exigen Python ≥ 3.10 y **dependen de `httpx2`, no de `httpx`** [2][3] [fuente]. Una integración que se enganche a la capa HTTP (event hooks, transportes, un `http_client` propio) habría tenido que cambiar con esa migración, porque el tipo que esperan los SDK ya no es el de `httpx` [inferido].
- Los dos exponen `with_options(base_url=…, default_headers=…)` (alias de `copy`), que devuelve una copia del cliente [4][5] [fuente]. Lo he comprobado con las dos versiones: `default_headers` se **fusiona** con las cabeceras del cliente y el original queda intacto [medido].
- Los objetos de respuesta llevan el `id` del proveedor como campo público (`chatcmpl-…`, `msg_…`, `resp_…`), también en cada chunk y en `message_start`; los streams (`Stream`, `MessageStream`) guardan la respuesta HTTP en `.response`, con sus cabeceras [7] [fuente, y medido con 3.19.2 y 1.8.0].
- `anthropic` añadió un parámetro `middleware` (clase `Middleware` con `handle`/`handle_async`, sobre `APIRequest`/`APIResponse`, dentro del bucle de reintentos) [6] [fuente]. `openai` no tiene equivalente [4] [fuente]: un diseño basado en middleware sería asimétrico.
- `AzureOpenAI` acepta `with_options(base_url=…)` y conserva su ruta `/openai/` [medido].

### 2.3 LiteLLM

- Un callback es una subclase de `CustomLogger` con `log_success_event(kwargs, response_obj, start_time, end_time)` y su versión async; `kwargs["response_cost"]` es el coste **calculado por LiteLLM** con su propia tabla de precios; se registra con `litellm.callbacks = [...]` [8] [fuente].
- Con el proveedor Anthropic, LiteLLM **no conserva el `id` del mensaje** en su `ModelResponse` (se genera uno), pero guarda todas las cabeceras crudas del proveedor en `_hidden_params["additional_headers"]` con el prefijo `llm_provider-` (transformación de Anthropic, línea 2597 de `main` el 27‑sep; y `process_response_headers` en `core_helpers.py`, genérico para todos los proveedores) [9][10] [fuente: código].
- `api_base` (o `ANTHROPIC_API_BASE`) apunta el proveedor a otro origen y LiteLLM añade `/v1/messages`; `extra_headers` viaja con la petición [11] [fuente].
- **Cadena de suministro:** las versiones 1.82.7 y 1.82.8 de LiteLLM en PyPI llevaron un ladrón de credenciales el 24‑mar‑2026 desde las 10:39 UTC durante unos 40 minutos; el origen fue una dependencia de su CI (Trivy) [12] [fuente].

### 2.4 Empaquetado y publicación

- Python 3.10 llega a fin de vida en octubre de 2026; 3.14 está en bugfix y 3.15 sale el 1‑oct‑2026 [15] [fuente]. Los SDK siguen exigiendo ≥ 3.10 [2][3].
- `pyproject.toml` admite una expresión SPDX con `LicenseRef-…` para licencias propias y `license-files` [16] [fuente]. Lo he construido con hatchling: `License-Expression: LicenseRef-BiVelio-Commercial` y la LICENSE dentro del wheel [medido].
- PyPI admite *trusted publishing* con un *pending publisher* que crea el proyecto en la primera subida, **pero no reserva el nombre hasta entonces** [17] [fuente]; la acción oficial genera las atestaciones PEP 740 por defecto [18] [fuente]. Los nombres `bivelio-savings-layer`, `bvsala` y `bivelio` estaban libres el 27‑sep‑2026 (HTTP 404 en la API JSON de PyPI) [20] [medido].
- `actions/setup-python` va por la v7.0.0 (20‑jul‑2026) [19] [fuente].

### 2.5 El gateway, leído en el código

- Escucha solo en `127.0.0.1` (`server.listen(…, "127.0.0.1")`), verja **todas** las rutas con la licencia (402 con `x-bvsala-license-status` a las peticiones nuevas) y registra cada petición medida con `emisor.record(informe)`, donde `informe` **es un `SavingsReport`**, el mismo tipo que devuelve el SDK de TypeScript (`gateway/servidor.ts`, `gateway/medidor.ts`) [medido].
- Todo lo que no se mide ya tiene su motivo en una línea de log (`noMedido`) [medido]. Lo que faltaba era devolvérselo al cliente.

## 3 · Opciones

| | Qué es | A favor | En contra |
|---|---|---|---|
| **(a) Cliente fino sobre el gateway** | Python habla con el gateway local; el gateway mide y devuelve el informe | La licencia (LICENSE §2) y la medición ya viven en el gateway; **un solo catálogo de precios**; cero dependencias; sirve también para cualquier lenguaje | Necesita Node para el gateway; exige un cambio en el gateway para devolver el informe |
| **(b) Callback de LiteLLM** | `CustomLogger` que lee el uso | Audiencia de 89 M/mes | El coste que ve el callback es el de **la tabla de LiteLLM**, no nuestro catálogo; el callback no cambia la ruta, así que para medir con nuestro contador el tráfico **tiene que pasar igualmente por el gateway**; importar `litellm` arrastra una cadena de suministro que ya fue comprometida [12] |
| **(c) Envoltorios de los SDK oficiales** | `wrap(OpenAI())` | 424 M descargas/mes entre los dos SDK [1]; `with_options` es API pública y simétrica en ambos | Sin (a) debajo no hay ni licencia ni medición |
| **(d) Port del núcleo** | Reescribir el pipeline, el catálogo, la licencia y las palancas en Python | Palancas del SDK en proceso, sin Node | Dos catálogos de precios que cobran = dos fuentes de verdad del dinero; reimplementar la verificación Ed25519 offline, la revocación y el fail-closed; meses de trabajo; cada verja (tarifa, referencia-es-suelo, licencia) por duplicado |

## 4 · Decisión, y por qué

**(a) + (c) hoy; (b) como adaptador fino después; (d) no.**

1. **El dinero sale de un solo sitio.** El gateway ya mide con el contador del proveedor y tarifa con el catálogo del paquete de npm. El cliente de Python no calcula nada: lo que enseña es **el mismo objeto** que el gateway encola para el panel. No hay segundo catálogo que pueda divergir, y la prueba de extremo a extremo lo compara campo a campo con lo que recibe la ingesta.
2. **Fail-closed sin reimplementar la licencia.** Sin gateway vivo y con licencia, `wrap()` lanza. Nunca cae al proveedor directo: eso sería tráfico sin licencia y sin medir.
3. **API pública, no tripas.** Los envoltorios usan `with_options(base_url, default_headers)`, pública y simétrica en los dos SDK. Nada de enganches a `httpx2`, que ya cambió una vez [2][3]. La correlación va por dos claves públicas: la cabecera `x-bvsala-request-id` (streams, `with_raw_response`, LiteLLM) y el `id` de la respuesta (cualquier objeto o chunk).
4. **LiteLLM después, y encima de esto.** Un callback no mide con nuestro contador si el tráfico no pasa por el gateway [8][11]. Con `api_base` apuntando al gateway y `extra_headers=bvsala.REPORT_HEADERS`, `gw.report(respuesta)` ya lee la cabecera que LiteLLM conserva [9][10]. Sin dependencia de `litellm`.
5. **El port no compensa hoy.** El informe de competencia ya pedía el SDK nativo «solo si las n.º 5 y 8 dan señal» [21]; el camino fino entrega el informe por petición sin esa inversión.

## 5 · Qué se construye hoy

**En el gateway** (`gateway/informes-locales.ts`, cableado en `gateway/servidor.ts`):

- **Opt-in por petición.** Solo una petición con `x-bvsala-report: 1` abre informe. Sin esa cabecera no cambia nada: ni una cabecera de respuesta, ni un byte guardado. Claude Code, Codex y el resto siguen igual.
- La cabecera **no viaja al proveedor**: es la única excepción documentada a «se reenvía toda cabecera» (README y `docs/terminales/README.md`). La respuesta lleva `x-bvsala-request-id`.
- **Rutas locales**, que jamás van al upstream, quedan detrás de la verja de licencia y solo responden a un `Host` de loopback: `GET /_bvsala/v1/status` (versión, origen del upstream sin credenciales, estado de la licencia, si mide), `GET /_bvsala/v1/reports/<id>` y `GET /_bvsala/v1/reports?response_id=<id>`, con `wait_ms` (30 s como mucho) para una petición en curso.
- El informe es `metered` con el `SavingsReport` encolado para el panel, `not_metered` con el mismo motivo de la línea de log, o `pending`. En memoria, como mucho 1.000 informes y una hora cada uno; nada a disco y **nada más hacia BiVelio** (LICENSE §5 intacta).
- La gemela coalescida recibe **su** id, no el de su primaria (la réplica reutiliza las cabeceras de la primaria, y eso se cuida a propósito).

**En Python** (`packages/python`, distribución `bivelio-savings-layer`, import `bvsala`, versión 0.1.0, independiente de la de npm):

- `Gateway(url)`: `status()`, `require_ready()` (fail-closed), `wrap(client)` para `OpenAI`, `AsyncOpenAI`, `AzureOpenAI`, `Anthropic` y `AsyncAnthropic`, `report(obj, wait=5)` y `areport`, `reports()` y `totals()`, que suma **por base** (`measured`, `reference`, `estimated`) y nunca las mezcla.
- `wrap()` injerta la ruta del `base_url` del cliente (`/v1`, `/openai/`) en el origen del gateway, y lanza `GatewayMismatch` si el cliente apunta a otro proveedor que el que reenvía el gateway, en vez de mandar el tráfico a donde no toca.
- Solo biblioteca estándar; ignora `HTTP_PROXY` (el gateway es local). `python -m bvsala status|report`.
- LICENSE idéntica byte a byte a la del paquete de npm (hay una verja que lo comprueba).

**Pruebas:**

- `test/gateway-informes-locales.test.ts` (25): sin cabecera no cambia nada; con ella, el informe es el registro de la ingesta; JSON y SSE en los tres dialectos (Messages, Chat Completions y Responses); motivos de no medido; 429; espera larga; gemela coalescida; rutas locales (405, 404, 400, 403 a un `Host` ajeno, 402 sin licencia, nada secreto en `status`); el buzón en unidad.
- `packages/python/tests` (46, pytest): estado y licencia, lectura del informe desde cualquier objeto, envoltorios con clientes falsos y **con los SDK de verdad** (openai 3.19.2 y anthropic 1.8.0), CLI. Un fixture autouse hace fallar cualquier conexión que no sea a `127.0.0.1`: «sin red» es una verja, no una promesa.
- `test/python-cliente.test.ts` (10): verjas (LICENSE idéntica, cabeceras y esquemas iguales en los dos lados, cero dependencias, el cliente solo conoce URL del gateway local, la CI corre pytest con hashes) y un **extremo a extremo**: vitest arranca dos gateways reales y lanza Python contra ellos; cada informe que recibe Python es el registro que recibe la ingesta (id, coste, base, tokens), la cabecera nunca llega al upstream, un stream sin `include_usage` sale `not_metered` con su motivo y sin registro, y un cliente de OpenAI contra el gateway de Anthropic lanza `GatewayMismatch`.
- CI: `setup-python@v7` y dependencias de prueba **fijadas por versión y por hash** (`requirements-ci.txt`, 330 hashes) antes de `pnpm test`; y un trabajo `python` con pytest en 3.10 y 3.14. En CI el extremo a extremo es obligatorio y con los dos SDK; en local se salta si no hay Python ≥ 3.10.

## 6 · Qué queda para la paridad con el SDK de TypeScript

| Del SDK de TypeScript | En Python, hoy | Qué haría falta |
|---|---|---|
| `SavingsReport` por petición | **Sí**, el que registra el gateway (mismos números que el panel) | — |
| Fail-closed sin licencia | **Sí**, vía gateway | — |
| Streaming medido | **Sí** (Anthropic siempre; Chat Completions con `include_usage` o `BVSALA_GATEWAY_USAGE_INJECT=1`) | — |
| Palancas del pipeline (caché exacta y semántica, compresión, router, cascada, codebook, rescate, serialización) | **No** | Llevarlas al gateway (solo las que no cambian contenido sin contrato) o el port (d) |
| Palancas del gateway (TTL de caché, hermano, esfuerzo) | Sí para `/v1/messages` de Anthropic con PRO (el TTL, por defecto; hermano y esfuerzo, opt-in) | Palancas equivalentes para OpenAI |
| Basis `reference` (repetición evitada) | Solo con la coalescencia del gateway (opt-in, `BVSALA_GATEWAY_COALESCE=1`) | Caché exacta en el gateway |
| `generate()`/`generateStream()` con contratos de salida | No | Port o API propia |
| Verificación A/B («tu propio banco») | No | Exponerla en el gateway |
| Exportadores (OTel, Langfuse, Datadog, FOCUS) | No | Leer `reports()` y reutilizar los formatos |
| Adaptadores de frameworks (LangChain, LlamaIndex, Pydantic AI…) | No | Envoltorios finos sobre `wrap()` |
| LiteLLM | Lectura del informe desde su respuesta (probado con la forma de su código, **no de extremo a extremo**) | Adaptador `CustomLogger` y prueba con LiteLLM instalado en un entorno aislado |
| Paquete publicado | **No está en PyPI** | Pasos del dueño, abajo |

## 7 · Riesgos

- **La excepción a «se reenvía toda cabecera».** `x-bvsala-report` no llega al proveedor. Está documentada en el README y en la guía de terminales, y probada en los dos sentidos (sin ella no cambia nada; con ella, no se reenvía).
- **Datos de coste en un puerto local.** Otro proceso del mismo equipo que conozca un id puede leer su informe (recuentos y coste, nunca contenido), igual que hoy puede leer el log. No hay ruta que liste informes, y los ids son UUID o ids del proveedor. Para un navegador: sin CORS, y un `Host` que no sea de loopback recibe 403, que es lo que corta el *DNS rebinding* (una página cuyo nombre resuelve a 127.0.0.1 sería «mismo origen»). Memoria acotada.
- **Desfase de versiones.** Un gateway ≤ 0.4.25 no tiene las rutas: el cliente lo dice («needs a version newer than 0.4.25») en vez de fallar raro. Hasta la próxima publicación en npm, el cliente de Python solo funciona con un gateway construido desde `main`.
- **Cambios en los SDK.** Se usa solo API pública (`with_options`, `base_url`, `id`, `.response.headers`) y la CI lo prueba con versiones fijadas. Subir esas versiones es un cambio deliberado de `requirements-ci.in`.
- **Nombre en PyPI.** Un *pending publisher* no reserva el nombre [17]: hasta la primera subida, alguien podría ocuparlo.
- **Python 3.10 caduca en octubre.** Se mantiene mientras los SDK oficiales lo exijan como mínimo [2][3].
- **Metadata 2.5.** El hatchling actual emite `Metadata-Version: 2.5`. Conviene subir primero a TestPyPI para confirmar que PyPI lo acepta.

## 8 · Cómo se medirá el efecto

- **Paridad de números, en cada PR:** el extremo a extremo exige que cada informe de Python sea el registro que recibe la ingesta. Si divergen, la CI se pone en rojo.
- **Adopción, cuando esté publicado:** descargas mensuales de `bivelio-savings-layer` en pypistats, frente a las del paquete de npm.
- **Tráfico de Python en el panel:** peticiones del gateway a `/v1/chat/completions` y `/v1/responses` por organización (el panel ya desglosa por modelo). El registro de uso no dice qué cliente las hizo, y no se añade ningún campo: eso exigiría servidor primero y cambiar la LICENSE §5.
- **Lo que no se mide, en local:** el motivo de cada `not_metered` (por ejemplo, streams de OpenAI sin `include_usage`) queda en el informe que ve el desarrollador. No viaja a BiVelio.

## 9 · Fuentes (consultadas el 2026-09-27 salvo que se indique)

1. pypistats, descargas recientes: https://pypistats.org/api/packages/openai/recent · https://pypistats.org/api/packages/anthropic/recent · https://pypistats.org/api/packages/litellm/recent
2. PyPI, `openai` 3.19.2 (requires_python y requires_dist): https://pypi.org/pypi/openai/json
3. PyPI, `anthropic` 1.8.0: https://pypi.org/pypi/anthropic/json
4. openai-python, `OpenAI.__init__` y `copy`/`with_options`: https://github.com/openai/openai-python/blob/main/src/openai/_client.py
5. anthropic-sdk-python, `Anthropic.__init__` y `copy`/`with_options`: https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_client.py
6. anthropic-sdk-python, middleware: https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_middleware.py
7. openai-python, README (Request IDs, `with_raw_response`, streaming): https://github.com/openai/openai-python/blob/main/README.md
8. LiteLLM, callbacks personalizados: https://docs.litellm.ai/docs/observability/custom_callback
9. LiteLLM, transformación de Anthropic (`_hidden_params["additional_headers"]`): https://github.com/BerriAI/litellm/blob/main/litellm/llms/anthropic/chat/transformation.py
10. LiteLLM, `process_response_headers` (prefijo `llm_provider-`): https://github.com/BerriAI/litellm/blob/main/litellm/litellm_core_utils/core_helpers.py
11. LiteLLM, proveedor Anthropic (`api_base`, `extra_headers`): https://docs.litellm.ai/docs/providers/anthropic
12. LiteLLM, incidente de seguridad de marzo de 2026: https://docs.litellm.ai/blog/security-update-march-2026
13. Headroom (v0.39.0, 25‑sep‑2026) [marketing en las cifras]: https://github.com/headroomlabs-ai/headroom
14. Langfuse, integración con el SDK de OpenAI para Python: https://langfuse.com/integrations/model-providers/openai-py
15. Python, estado de las versiones: https://devguide.python.org/versions/
16. Python Packaging User Guide, `pyproject.toml`: https://packaging.python.org/en/latest/guides/writing-pyproject-toml/
17. PyPI, crear un proyecto con un pending publisher: https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/
18. PyPI, producir atestaciones: https://docs.pypi.org/attestations/producing-attestations/
19. actions/setup-python v7.0.0: https://github.com/actions/setup-python/releases/tag/v7.0.0
20. PyPI JSON API, nombres libres (404): https://pypi.org/pypi/bivelio-savings-layer/json · https://pypi.org/pypi/bvsala/json · https://pypi.org/pypi/bivelio/json
21. Informe de competencia interno: `docs/COMPETENCIA-2026-09-26.md`, §5 y §8 n.º 12

Nota de método: el cupo de búsqueda web de la sesión estaba agotado, así que cada fuente se abrió directamente por URL (documentación, código en GitHub, API de PyPI y pypistats). No se ha ejecutado ninguna tirada contra proveedores reales: todo el extremo a extremo corre contra upstreams falsos en 127.0.0.1.

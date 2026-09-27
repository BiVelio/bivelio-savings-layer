# Guías por terminal — medir el gasto de IA con el gateway local

**Fecha:** 2026-08-30 · **Fuente de verdad:** `docs/PASARELA-S3-TERMINALES.md`
§3 (formas de URL y mecanismos de enrutado verificados contra el código de cada
terminal). Cada afirmación va marcada **[V]** (verificada en fuente) o **[I]**
(inferida). Si una guía contradice a ese documento, manda el documento.

## Qué es esto

`bvsala gateway` es un proxy local medidor: escucha en `127.0.0.1`, reenvía
cada petición al proveedor (`https://api.anthropic.com` por defecto) —**byte a
byte**, salvo las palancas que se explican abajo (con licencia PRO, la de tarifa
va encendida por defecto)— y, una vez servida la respuesta, lee el `usage` del
stream y lo convierte en coste. Ni tus prompts, ni las respuestas, ni la clave de
tu proveedor salen de tu máquina hacia BiVelio: solo viaja el uso de cada
petición —cuentas de tokens, coste, el id del modelo, un id de petición y los ids
opacos de asiento y de sesión—, y la lista exacta de campos está en la
LICENSE §5. Es fail-closed como el SDK: arranca solo con tu clave de servicio
(`BIVELIO_SERVICE_KEY`) y una licencia BiVelio activa, que recoge con esa clave y
cuya firma verifica en tu máquina. Una vez arrancado, jamás corta una petición en
curso: si la licencia caduca o se revoca, solo las peticiones NUEVAS reciben un
HTTP 402 hasta renovarla. La medición es best-effort: con la ingesta caída,
reenvía y avisa.

Mide cada petición. Con licencia PRO aplica por defecto **una sola palanca**:
rebaja el TTL de escritura de caché mientras la sesión sigue caliente — cambia la
tarifa, nunca el contenido que lee el modelo. Las demás (modelo hermano, esfuerzo
por turno) van apagadas hasta que las enciendes. Y mide **todo el tráfico de inferencia**
que el terminal enruta por el base URL — no «todo el tráfico»: cada guía dice
lo que su terminal manda por fuera.

En suscripción (login de claude.ai en Claude Code, cuenta ChatGPT en Codex) no
hay factura por tokens: ese tráfico se mide a precio de lista equivalente y
nunca se le acredita ahorro ni comisión; la licencia por asiento hace falta
igual.

## Índice

| Guía | Base URL exacto | `/v1` | Enrutado [V] | Envoltorio | Estado |
|---|---|---|---|---|---|
| [Claude Code](claude-code.md) | `http://127.0.0.1:8402` | **sin** | env `ANTHROPIC_BASE_URL` | `bvsala claude` ✅ | [V] en producción |
| [Codex CLI](codex.md) | `http://127.0.0.1:8402/v1` (API key) · `…/backend-api/codex` (ChatGPT) | **con** | `codex -c openai_base_url=…` | `bvsala codex` ✅ | [V] validado en mano el 30-08 (426 → fallback HTTP, stream íntegro) |
| [Goose](goose.md) | `http://127.0.0.1:8402` | **sin** | env `ANTHROPIC_HOST` | `bvsala goose` ✅ | [V] |
| [Qwen Code](qwen-code.md) | `http://127.0.0.1:8402` | **sin** | env `ANTHROPIC_BASE_URL` + `~/.qwen/settings.json` | `bvsala qwen` ✅ | [V] |
| [opencode](opencode.md) | `http://127.0.0.1:8402/v1` | **con** | env `OPENCODE_CONFIG_CONTENT` o `~/.config/opencode/opencode.json` | `bvsala opencode` ✅ (sin escribir en disco) | [V] en código (v1.18.32) |
| [Kilo Code](kilo.md) (CLI y extensiones) | `http://127.0.0.1:8402/v1` | **con** | env `KILO_CONFIG_CONTENT` o `~/.config/kilo/kilo.json` | `bvsala kilo` ✅ (CLI) | [V] en código (v7.8.1, fork de opencode) |
| [Copilot CLI](copilot.md) (solo BYOK) | anthropic: `http://127.0.0.1:8402` · openai: `…/v1` | anthropic **sin**, openai **con** | env `COPILOT_PROVIDER_BASE_URL` | `bvsala copilot` ✅ (tipo anthropic) | [V] en la doc oficial; sin validar en mano. Tipo openai: a mano, sin validar (WebSocket → 426) |
| [Copilot en VS Code](copilot.md#copilot-en-vs-code-byok-custom-endpoint) (solo BYOK) | `http://127.0.0.1:8402/v1/messages` (ruta completa) | ruta completa | UI → Custom Endpoint (`chatLanguageModels.json`) | — | [V] en la doc oficial; sin validar en mano |
| [Aider](aider.md) | Anthropic: `http://127.0.0.1:8402` · OpenAI: `…/v1` | Anthropic **sin**, OpenAI **con** | env `ANTHROPIC_API_BASE` / `OPENAI_API_BASE` (litellm) | `bvsala aider` ✅ | [V] en código (litellm 1.82.3); OpenAI en stream solo con `BVSALA_GATEWAY_USAGE_INJECT=1` |
| [Continue](continue.md) (CLI `cn` y extensiones) | `http://127.0.0.1:8402/v1` | **con** | `~/.continue/config.yaml` (`apiBase`) | — (config de usuario) | [V] en código |
| [Crush](crush.md) | `http://127.0.0.1:8402/v1` | **con**, sin barra final | `~/.config/crush/crushrc` | — (config de usuario) | [V] |
| [Droid](droid.md) | `http://127.0.0.1:8402` | sin **[I]** | `~/.factory/settings.json` | — (config de usuario) | validar en mano |
| [Cline](cline.md) | `http://127.0.0.1:8402/v1` | **con** | UI | — | [V] |
| [Gemini CLI](no-soportados.md#gemini-cli--no-se-mide-todavía) | — | — | env `GOOGLE_GEMINI_BASE_URL` | — | **no se mide**: el gateway no lee el dialecto de Gemini |
| [Cursor](no-soportados.md#cursor--no-se-puede) | — | — | sus servidores, no tu máquina | — | **no se puede**: Cursor no alcanza `127.0.0.1` |
| [Python y cualquier SDK](../../README.md#python-and-any-other-language-the-local-gateway) (OpenAI · Anthropic) | OpenAI: `http://127.0.0.1:8403/v1` · Anthropic: `http://127.0.0.1:8402` | OpenAI **con**, Anthropic **sin** | `base_url` del SDK | `bvsala gateway --upstream openai` | [V] en test (upstream falso) |

Reglas de la columna «Base URL»: **nunca barra final**, **nunca redirecciones**
(un 3xx en el base URL es fallo por diseño del cliente, y el gateway lo reenvía
en vez de seguirlo). Y nunca copies el URL de un terminal a otro: cada SDK añade
su propio tramo de ruta y el error es silencioso (§ «Comprobar que mide»).

Claude Code, Codex, Goose, Qwen Code, opencode, Kilo, Copilot CLI (BYOK) y Aider
tienen **envoltorio propio** (`bvsala
claude|codex|goose|qwen|opencode|kilo|copilot|aider`): arrancan un gateway en
puerto efímero, lanzan el terminal apuntándole y lo apagan al salir. Cero
configuración persistente: opencode y Kilo reciben la suya por variable
(`OPENCODE_CONFIG_CONTENT`, `KILO_CONFIG_CONTENT`), fusionada con la tuya. La
receta manual de cada guía hace exactamente lo mismo. Para el resto,
`bvsala doctor` imprime el bloque exacto de cada terminal instalado.

**Al salir, cada envoltorio dice lo que midió.** Dentro de un envoltorio el log
por petición va callado para no pisar el TUI, así que al terminar imprime por
stderr una línea como esta:

```
[bvsala copilot] metering in this run: 41 request(s) metered with the provider's usage · 3 forwarded but NOT metered (nothing is estimated in their place): 3 × the request did not ask for usage (stream_options.include_usage). What each reason means and what to do: docs/terminales/README.md.
```

Los motivos son los de la tabla `· not metered: …` de abajo. Si ninguna petición
pasó por el gateway, lo dice también: el terminal no estaba apuntado. `bvsala
gateway` imprime la misma línea al pararlo con Ctrl-C. Es local, como el aviso de
tráfico degradado: no viaja a BiVelio.

## Lo común a todas las guías

### 1 · Instalar y arrancar el gateway

```bash
npm i -g @bivelio/savings-layer      # trae el binario `bvsala`
export BIVELIO_SERVICE_KEY=bvk_…     # clave de servicio, desde tu panel. Obligatoria: sin ella el gateway no arranca
bvsala gateway                        # escucha en http://127.0.0.1:8402
bvsala gateway --port 8500            # otro puerto si el 8402 está ocupado
```

Al arrancar imprime, entre otras, estas líneas:

```
[bvsala gateway] v0.4.x listening on http://127.0.0.1:8402 → https://api.anthropic.com
[bvsala gateway] license: PRO, active until 2026-10-24 (+14 days grace), collected with your service key and verified on this machine
[bvsala gateway] metering: ON (service key present)
```

Si no arranca (sale con código 1), el mensaje dice exactamente qué falta:

| Mensaje | Qué pasa | Arreglo |
|---|---|---|
| `BIVELIO_SERVICE_KEY is not set` | falta la clave de servicio | créala en el panel (Instalar, paso 2), expórtala y relanza |
| `BIVELIO_SERVICE_KEY is not recognised` | clave borrada, rotada o copiada a medias | crea otra |
| `your organization has no active BiVelio license` | no hay suscripción | suscríbete en Cuenta y relanza |
| `your BiVelio license expired on …` | licencia caducada y sin gracia | renueva en Cuenta |
| `could not collect your license from savings.bivelio.com` | sin acceso a savings.bivelio.com | revisa la conexión; como respaldo, `BIVELIO_LICENSE_KEY` (se verifica sin red y se sustituye a mano cada período) |
| un HTTP 402 en el terminal a mitad de sesión | la licencia caducó o se revocó con la sesión abierta | renueva; las peticiones que ya estaban en curso no se cortaron |

Si lanzas `bvsala gateway` como servicio (launchd/systemd), un fallo de licencia
queda en el log del servicio con código 1 y el terminal solo verá «connection
refused»: mira ese log.

Un gateway habla con **un** upstream (`BVSALA_GATEWAY_UPSTREAM`, por defecto
`https://api.anthropic.com`). Los terminales del dialecto Anthropic comparten
instancia; Codex necesita la suya contra OpenAI — `bvsala codex` la arranca
sola con el upstream correcto según tu modo de auth (ver su guía). Desde la
próxima versión, `bvsala gateway --upstream openai|anthropic|<origen>` lo elige
sin variable de entorno (el flag manda sobre `BVSALA_GATEWAY_UPSTREAM`). Para un
SDK de OpenAI (Python, Node…) arranca uno con `--upstream openai` en otro puerto;
en streaming, la petición tiene que llevar `stream_options.include_usage` o el
gateway la reenvía sin medirla y lo dice en el log.

### 2 · Comprobar que mide: el log del gateway

Por cada llamada de inferencia servida y medida, el gateway escribe una línea
con el coste:

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓46792, out 8)
```

Si ves esa línea con `$`, el terminal está enrutado y medido. Lo que significan
las otras líneas:

| Línea en el log | Qué pasa | Arreglo |
|---|---|---|
| `[gateway] POST /v1/v1/messages → 404` | el base URL lleva `/v1` **de más** para ese terminal | quita el `/v1` |
| `[gateway] POST /messages → 404` | al base URL le **falta** `/v1` (el SDK solo añade `/messages`) | añade el `/v1` |
| `[gateway] POST /v1/messages → 402 (license expired)` | la licencia caducó, se revocó o la org está bloqueada: las peticiones NUEVAS se rechazan (las que estaban en curso terminaron) | renueva en Cuenta; el terminal enseña el motivo |
| nada de nada | el terminal no está apuntando al gateway (config no leída, env pisado por config, otro puerto) | revisa la trampa de su guía |

Cada petición que el gateway reenvía **sin medir** deja su propia línea con
`· not metered: <motivo>`, y en su lugar no se estima nada. Los motivos, tal y
como salen hoy:

| `· not metered: …` | Qué pasa | Arreglo |
|---|---|---|
| `no BIVELIO_SERVICE_KEY` | un gateway arrancado desde código sin clave de servicio: reenvía, no mide (el CLI `bvsala` ni arranca sin ella) | exporta `BIVELIO_SERVICE_KEY` |
| `model "…" has no list price in the catalog` | modelo fuera del catálogo de precios, a propósito: un precio presente y equivocado es peor que ninguno (la consola lo avisa una vez por modelo) | nada; se reenvía sin medir |
| `could not read the model from the request body (content-encoding: …)` | el cuerpo no se pudo leer: JSON ilegible o una compresión que este Node no abre (zstd, el de Codex, necesita Node ≥ 22.15) | actualiza Node |
| `the request did not ask for usage (stream_options.include_usage)` | Chat Completions en stream sin `include_usage`: el proveedor no manda contador | añade `stream_options={"include_usage": True}` a la llamada, o arranca con `BVSALA_GATEWAY_USAGE_INJECT=1` |
| `…; usage injection skips compressed request bodies` | la inyección está puesta, pero solo añade la opción a cuerpos sin comprimir | pídelo en la llamada |
| `…, and the upstream rejects that option` | el upstream rechazó `stream_options` y la inyección quedó apagada para el resto del proceso | en stream no hay arreglo desde el gateway; con `stream: false` sí se mide |
| `the stream ended without the provider's final usage event` | el stream se cortó antes de su evento final (`message_delta`, `response.completed`/`incomplete`/`failed`, el chunk de uso o `[DONE]`): sin él no hay contador | nada |
| `the response ended as response.failed without usage` | la Responses API cerró con `response.failed` sin `usage`. Si lo trae, sí se mide | nada |
| `the response ended as response.incomplete without usage` | la Responses API cerró con `response.incomplete` sin `usage`. Si lo trae, sí se mide: un `response.incomplete` por `max_output_tokens` o por el filtro de contenido lo factura el proveedor | nada |
| `the response carried no usage` | respuesta JSON (`stream: false`) sin `usage` | nada |
| `the response was too large to read its usage` | respuesta JSON de más de 5 MB: el gateway no la guarda entera para leerla | nada |
| `the response is neither JSON nor an event stream (content-type: …)` | el upstream contestó con otro tipo de contenido en una ruta que sí sabe medir | revisa el upstream |
| `no usage dialect for this route` | ruta sin contador que el gateway sepa leer (embeddings, imágenes, audio…): solo mide `/v1/messages`, `…/chat/completions` y `…/responses` | nada |

Con `BVSALA_GATEWAY_COALESCE=1` (apagada por defecto), una petición idéntica a
otra que sigue en vuelo no viaja: recibe la réplica y su línea lleva
`· COALESCED (call avoided)`. Detrás va `· by reference: floor $… (cache read
price, …)` cuando se valora con el contador de la petición que sí viajó —a
precio de lectura de caché, sin primas y con la salida solo si el cuerpo trae
`temperature: 0` y el modelo no razona (la misma guarda de modelo que el SDK)—,
o `· estimated, not by reference: <motivo>` cuando no. Esa línea es la
valoración local: el panel todavía recibe estas peticiones como `estimated`, y
no entran en la base de la comisión, porque el gateway aún no lee los tokens de
razonamiento que declara el proveedor y la regla `reference-v2` los exige.

| `· estimated, not by reference: …` | Por qué no |
|---|---|
| `no-primary-record` | la petición que viajó no dejó su contador final (ni evento final del stream ni `usage` en el JSON) |
| `subscription` | tráfico de suscripción (Claude o ChatGPT): no hay factura por token |
| `unofficial-upstream` | el gateway no habla con `api.anthropic.com` ni `api.openai.com` (un mock, un proxy, Azure, un revendedor): el precio de lista no está en ninguna factura |
| `layer-changed-request` | una palanca cambió lo que viajó (modelo, cuerpo, cabeceras; también la rebaja de TTL de la caché): ya no es la petición del cliente byte a byte |
| `primary-failed` | la petición que viajó cerró con `response.failed` |
| `client-disconnected` | el cliente de esta petición se fue antes de recibir la réplica entera |
| `service-tier` | el `service_tier` pedido o el servido no tiene precio por token publicado (`scale`, uno nuevo) |
| `no-cached-price` | el modelo no tiene precio de lectura de caché en su propia fila del catálogo |
| `no-credit` | el contador no deja nada que acreditar |

Claude Code manda además un `HEAD /api/hello` antes de la primera llamada: es
la sonda de vida, no una inferencia.

`bvsala doctor [--port N]`: sondea el PATH y la existencia de las configs de
usuario (nunca lee su contenido) e imprime el bloque exacto por terminal con el
puerto indicado. Solo imprime: no escribe ninguna configuración.

### 3 · Windows

`npm i -g @bivelio/savings-layer` y `bvsala claude` son idénticos en los tres
sistemas. Lo que cambia es cómo se fija la clave en la sesión — el `export` de
estas guías es POSIX; en PowerShell:

```powershell
$env:BIVELIO_SERVICE_KEY = "bvk_…"
bvsala claude
```

(En `cmd`: `set BIVELIO_SERVICE_KEY=bvk_…`.) El prefijo `VAR=valor comando` de
las recetas manuales también es POSIX: en Windows, fija la variable primero y
lanza después.

Y una condición dura: el terminal debe estar instalado con su **instalador
nativo** (un `claude.exe` / `codex.exe` en el PATH — Claude Code, Codex, Goose
y Qwen Code lo tienen [V]). El shim `.cmd` que deja `npm i -g <terminal>` no
puede lanzarse de forma segura con argumentos (CVE-2024-27980) y `bvsala` se
niega con una guía en vez de fallar con un ENOENT mudo. opencode, Kilo y Copilot
CLI también se instalan por npm: en Windows, usa su binario nativo (releases de
GitHub, winget o scoop) **[I: no validado en Windows]**. Aider se instala con pip,
que deja un `aider.exe`.

### 4 · Regla BYOK, sin excepción

Todas las recetas del anillo 2 (Goose, Qwen Code, opencode, Kilo, Copilot, Aider,
Crush, Droid, Cline, Continue) son **API key exclusivamente**. Anthropic prohíbe usar el OAuth de Claude
Pro/Max en harnesses de terceros (opencode lo documenta; Crush retiró su OAuth en
ene-2026). El gateway reenviaría un Bearer de suscripción sin inmutarse — y eso
no se promociona ni se documenta como receta.

### 5 · Wording honesto

«Anthropic doesn't endorse, maintain, or audit third-party gateway products»
[V]. El modo BV-SALA es **configuración soportada del binario sin modificar**:
di eso, nunca «aprobado por Anthropic». El contrato del gateway es una lista
abierta de cabeceras y campos que crece con cada release del terminal; el
passthrough byte a byte es lo que lo mantiene vivo sin tocar nada.

## What the gateway guarantees: it forwards what your client sends

A proxy in front of your provider can raise your bill without breaking anything
you can see: a lost cache marker, a dropped beta header, a block it does not
recognise. This gateway is built not to do that, and a test suite checks it
against a fake upstream on 127.0.0.1: `test/gateway-no-empeora.test.ts`, which
runs in our CI on every pull request and every push to `main`. The source
repository is not public, so this section lists exactly what the suite checks.

**With no lever armed, your provider receives what your client sent, byte for
byte:**

- **The request body**, including `tool_reference` blocks (from the provider's
  tool search and from a client-side search tool such as Claude Code's), tools
  with `defer_loading`, `cache_control` in every place the API reads it (top
  level, `system`, `tools`, and text, image, document, `tool_use` and
  `tool_result` blocks, including blocks nested inside a `tool_result` or inside
  a document's `source.content`), each with its `ttl: "1h"`, the advisor tool
  with its `advisor_tool_result` blocks, thinking signatures, and fields the
  gateway does not know. Not a JSON equivalent: the same bytes.
- **The path and query string** (`/v1/messages?beta=true`).
- **Every request header**, including every `anthropic-beta` value (the 1-hour
  cache TTL, the advisor, context management, OAuth, and betas that do not exist
  yet). Three kinds stay on the hop from your client to the gateway, as HTTP
  requires: hop-by-hop headers (RFC 7230 §6.1, plus `expect` and any header named
  in `Connection`), `host` and `content-length`.
- **The response**: the same bytes and headers, except the transport ones
  (`content-encoding`, `content-length`, `transfer-encoding`), because the
  gateway receives the body already decompressed.

"No lever armed" means any of: a license without that lever's feature,
`BVSALA_GATEWAY_ELISION=0`, or a lever you have not turned on (the sibling
model, per-turn effort, the context-editing dials and usage injection are off by
default). The suite checks each of these with the request exactly as Claude
Code sends it (compact JSON, which every armed lever would rewrite) and with a
hand-formatted one, and next to each it runs the same setup with the lever armed
and checks that the request does change, so a lever that stopped switching off
would fail it.

**With a lever armed, the only change is the one it declares:**

| Lever | Applies to | What changes | What does not |
|---|---|---|---|
| Cache TTL (`cache_ttl_tuning`, on by default with PRO) | `/v1/messages` requests where a large part of the prompt is new (session start, compaction); a chained turn travels untouched | every `cache_control` with `ttl: "1h"` becomes `"5m"`, the top-level one included (a 1-hour top-level marker behind 5-minute block markers would be a 400) | a key named `cache_control` inside a tool call's `input` or a tool's `input_schema` is content and stays as it is; so does the advisor's `caching`; headers are untouched |
| Per-turn effort (`BVSALA_GATEWAY_ESFUERZO=low` or `medium`) | `/v1/messages` for `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5-5` and `claude-opus-5`, when the level is below the model's default effort (`high`; `medium` on `claude-opus-5-5`) and the request carries no `output_config` of its own (top level or in a message); a level at or above the default leaves the request untouched | one message appended at the end of `messages`, `{"role":"system","content":[],"output_config":{"effort":…}}`, and `mid-conversation-output-config-2026-07-01` appended after your `anthropic-beta` value | your `anthropic-beta` value is kept verbatim in front; nothing earlier in `messages` moves |
| Sibling model (`BVSALA_GATEWAY_MODELO_HERMANO=1`) | `/v1/messages` and `/v1/messages/count_tokens` for `claude-fable-5`, except with a forced `tool_choice` or the 1M-context beta | `model` becomes `claude-fable-5-1` | headers are untouched |
| Context-editing dials (`BVSALA_GATEWAY_DIALES_ELISION=1`; measured as a net loss, off) | `/v1/messages` | your `clear_tool_uses_20250919` edit in `context_management` is replaced by ours | your other edits are kept, `clear_thinking_20251015` first; your `anthropic-beta` value is kept verbatim, with `context-management-2025-06-27` appended if it was not there |
| Usage in Chat Completions streams (`BVSALA_GATEWAY_USAGE_INJECT=1`, off) | streaming `…/chat/completions` requests without `stream_options` of their own | `"stream_options":{"include_usage":true},` inserted as text right after the opening `{` | the rest of the body, byte for byte (nothing is re-serialized); headers are untouched; a 400 or 422 gets your original request once more |

A lever that changes the body parses it and writes it back: your provider reads
the same JSON values, although whitespace and the way strings are escaped may
differ. When writing it back would change anything else (a number JavaScript
prints differently, such as `1.0`, `1e5`, `-0` or an integer beyond 2^53; an
object key that looks like an array index, which JavaScript moves to the front;
a key repeated in the same object; invalid UTF-8; a compressed body), no lever
is applied and the request travels byte for byte. If the provider answers 400 to
a request a lever changed, the gateway sends your original request once more,
unchanged, and meters that one.

**Degraded traffic.** The gateway also watches, with the provider's own usage
counters, for requests that come out worse than your client asked for:

| Log line: `[gateway] degraded traffic (session …) · …` | What it means |
|---|---|
| `prompt caching: … no cache read and no cache write` | the request marked `cache_control` at its end (top level or in the last message), the provider counted at least 4,096 input tokens (the largest minimum cacheable prompt in [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), checked on 2026-09-27) and reported neither a cache read nor a cache write |
| `cache TTL: … wrote the cache at the 5-minute TTL only` | every `cache_control` asked for `ttl: "1h"`, the TTL lever did not touch the request, and the provider wrote only 5-minute entries |
| `tool search: … tool search is off` | Claude Code traffic (a `x-claude-code-session-id` header or a `claude-cli/` user agent) sent at least 40 full tool definitions, none with `defer_loading` and no `tool_reference`. Claude Code turns tool search off by default behind any proxy, this gateway included: `bvsala claude` turns it back on in a new window, or export `ENABLE_TOOL_SEARCH=true` |

Each kind is logged once per session (Claude Code's session id; once per gateway
process for clients that send none) and every case is counted. `bvsala` prints
the totals when it exits, because the per-request log is silent inside `bvsala
claude|codex|goose|qwen` (unless `BVSALA_GATEWAY_LOG=1`). None of this is sent to BiVelio: the usage record has
no field for it (LICENSE §5), so it stays on your machine.

**Limits.**

- The guarantee covers what the gateway sends. It cannot make the provider
  cache: the watcher reports, it does not fix.
- The cache TTL lever changes the price of a cache write, never the content the
  model reads, and it is a trade: if a 5-minute entry expires before the next
  turn starts, that turn pays for a cache write that a 1-hour entry would have
  saved. The lever only acts where a large part of the prompt is being written
  anyway (session start, compaction), and `BVSALA_GATEWAY_ELISION=0` turns it
  off.
- On a request that declares server tools (web search, web fetch, code
  execution, tool search, the advisor, MCP servers; the gateway counts any typed
  tool other than a client tool such as bash or the text editor), the cache TTL
  lever still applies but its saving is recorded as zero. When Claude uses a
  server tool, the provider caches its result at the 5-minute TTL on its own,
  whatever TTL your markers ask for, and reports that write in the same
  `ephemeral_5m_input_tokens` counter
  ([Anthropic's documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#server-tool-results-are-cached-automatically),
  checked on 2026-09-27), so the invoice cannot tell which part the lever wrote.
- The two cache checks need the provider's usage: a request that is not metered
  is not checked. The prompt-caching check uses the largest documented minimum
  for every model, so a future model with a larger minimum would raise false
  alarms until the threshold moves.
- For the same reason, the TTL check skips requests that declare server tools.
- The tool-search check only looks at Claude Code traffic: another client with
  many tools may never have used tool search, and that is not degraded traffic.
- Header names arrive in lower case (HTTP header names are case-insensitive),
  and a header your client sends twice arrives once, with both values joined by
  a comma, in order.

# S3 · Conformidad con Claude Code y más terminales API-key — cómo aplicarlo

**Fecha:** 2026-08-30 · **Fase:** S3 de `docs/PLAN-PASARELA-API-KEY.md` ·
**Método:** 3 investigadores + 3 refutadores contra **fuente primaria** (doc
oficial de Claude Code, repos de `openai/codex`, `openai-node`, `vercel/ai`,
`cline/cline`, `opencode`, `goose`, `crush`, docs de Qwen Code / Droid / Kilo)
y contra `main` del repo. Cada afirmación va marcada **[V]** (verificada en
fuente) o **[I]** (inferida). Las citas de línea externas caducan; los nombres
de símbolos y los mecanismos están verificados hoy.

---

## 1. Conformidad con el protocolo oficial de gateway de Claude Code

Fuente: https://code.claude.com/docs/en/llm-gateway-protocol y
https://code.claude.com/docs/en/llm-gateway (leídas íntegras el 2026-08-30).

**Veredicto: el passthrough byte a byte nos da GRATIS 10 de 12 requisitos.**
La doc recomienda literalmente el patrón que ya usamos — «pass `anthropic-*`
request headers and request body fields through unchanged rather than
allowlisting» — y sanciona el modo suscripción-por-gateway: con solo
`ANTHROPIC_BASE_URL` y sin credencial de gateway, el login de claude.ai sigue
siendo la credencial activa [V] («its usage limits and billing apply»).

| Requisito [V] | Estado | Evidencia en `main` |
|---|---|---|
| `POST /v1/messages` — casar por **path**, no por URL entera (`?beta=true`) | ✅ | servidor.ts verjas por `url.pathname` |
| `POST /v1/messages/count_tokens` opcional, sin consumir inferencia | ✅ + test | test/gateway-servidor.test.ts (cero registros) |
| `HEAD /api/hello` (sonda, best-effort) | ✅ + test | — |
| Reenviar `anthropic-version` / `anthropic-beta` **sin cambios**, listas abiertas | ✅ + test | copia total salvo `host`/`content-length` (undici descarta además las hop-by-hop, que es lo correcto) |
| Capability OAuth dentro de `anthropic-beta` (quitarla = 401) | ✅ | reenvío íntegro; `bvsala claude` no toca credenciales |
| Streaming sin bufferizar, pings como bytes; **watchdog 300 s** por defecto | ✅ camino normal · ⚠️ coalescencia | ver §1.1 |
| Array `system` **exactamente** como llega (el strip de atribución es posicional) | ✅ | nunca se parsea-y-reconstruye |
| Pares beta-header + campo-de-cuerpo viajan **juntos** (`context_management`, `output_config`, thinking…) | ✅ | idem — y es la lista de lo que S4 **no** puede separar |
| Errores del upstream **sin modificar** (el cliente casa el texto para desactivar capabilities) | ✅ | `writeHead(upstream.status)` + cuerpo tal cual; los 502 propios solo cuando no hay error del upstream [I] |
| Sin redirects en el base URL (cualquier 3xx = fallo de discovery, por diseño) | ✅ | `redirect: "manual"` — verificado empíricamente que reenvía el 3xx en vez de seguirlo con la credencial |
| `GET /v1/models` — model discovery, opt-in `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` [V nombre] | 🟡 sin test | §1.2 |
| `x-claude-code-session-id` / `agent-id` / `parent-agent-id` | ✅ reenviadas · 🟡 no consumidas | §1.3 |

**Corrección al repo (aplicada en este PR):** la cifra «180 s directo» de
TERMINALES-DE-CODIFICACION.md:54 ya no figura en la doc oficial — hoy solo
documenta 300 s por defecto en conexiones `ANTHROPIC_BASE_URL`.

### 1.1 · El único hueco de protocolo: la gemela coalescida y el watchdog

Bajo `BVSALA_GATEWAY_COALESCE=1` (apagada por defecto), la gemela **no recibe
ni cabeceras ni un byte** hasta que la primaria termina (`Coalescedor.esperar`
resuelve una promesa única en `terminar()`). Una primaria de más de 300 s
mataría a la gemela por watchdog. **Arreglo correcto:** canal incremental en
`Coalescedor` — la gemela recibe chunk a chunk según la primaria los captura
(cabeceras al llegar las de la primaria). Alternativa mínima: acotar la espera
(~250 s) y degradar la gemela a viaje propio. Condición: el arnés F2 debe
seguir dando PASA. *Esfuerzo: días. Prioridad: antes de encender la
coalescencia por defecto, no antes.*

### 1.2 · Model discovery: test + validación en mano

Con la bandera, Claude Code pide `GET /v1/models?limit=1000` con timeout de
3 s, credencial en `Authorization` **y** `x-api-key`, y filtra ids que
contengan «claude»/«anthropic» [V]. El passthrough lo sirve por construcción
(api.anthropic.com responde `{data:[{id,display_name}]}`), pero **no hay test**.
Refinamiento del refutador [V]: las únicas fuentes de credencial del discovery
son `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` y `ANTHROPIC_API_KEY` — **un login
claude.ai NO es fuente**, así que en suscripción pura el cliente escribe
`[gatewayDiscovery] skipped` y ni pregunta. Discovery solo funciona para
clientes API key: exactamente nuestro segmento.

- Test nuevo en `test/gateway-servidor.test.ts`: upstream falso que sirva
  `GET /v1/models`, passthrough íntegro + cero registros. *Horas.*
- Validación en mano con API key: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  bvsala claude` → «From gateway» en `/model`. *Horas.*

### 1.3 · Atribución por sesión y subagente — oportunidad de producto

Las tres cabeceras llegan en el tráfico real (verificado en la captura de humo
de S1: `x-claude-code-session-id` presente en cada `POST /v1/messages`). Hoy se
reenvían y se ignoran. Consumirlas da **coste por sesión y por subagente
paralelo sin abrir un solo cuerpo** — la doc lo ofrece expresamente, y prohíbe
tratarlas como identificador de usuario.

Aplicación: capturar las tres en `servidor.ts` junto al resto de cabeceras y
pasarlas a `medir()`; campos opcionales `sessionId`/`agentId`/`parentAgentId`
en `informeMedido`/`informeCoalescido` (medidor.ts) y en el wire de
`UsageEmitter`; extender la verja del ingest (las dos copias de
`USAGE_BASIS`-style: `apps/web/lib/metering/usage.ts` y
`packages/protocol`) y el panel. **Orden de despliegue: servidor primero** (un
campo desconocido no debe dar 400 — comprobar que la verja ignora campos
extra antes de emitirlos). *Días. Encaja con S2: el registro `shadow`
también querrá la sesión.*

### 1.4 · Wording comercial (fuente [V])

«Anthropic doesn't endorse, maintain, or audit third-party gateway products».
El modo BV-SALA es **configuración soportada del binario sin modificar** —
decir eso, y nunca «aprobado por Anthropic». Y la promesa de medición es «todo
el tráfico de **inferencia**», no «todo el tráfico»: fast-mode y el
safety-check de WebFetch van directos a api.anthropic.com por diseño del
cliente. El contrato es una lista abierta que crece con cada release: smoke
test de `bvsala claude` contra cada versión nueva de Claude Code.

---

## 2. Codex CLI — 4 piezas de código y 3 validaciones en mano

Fuente: `openai/codex` (`codex-rs/*`), `openai/openai-node`, docs de OpenAI.

**El cable es único y estable [V]:** solo Responses API (`WireApi` solo tiene
`Responses`; `"chat"` deserializa con error «no longer supported»). `POST
{base_url}/responses`, siempre `stream: true`, SSE con `event:
response.completed` → `data.response.usage = { input_tokens,
input_tokens_details: { cached_tokens, cache_write_tokens }, output_tokens,
output_tokens_details: { reasoning_tokens }, total_tokens }` — verificado en el
parser de codex (`sse/responses.rs`) y en `openai-node` (`ResponseUsage`).

**La fórmula de coste es OFICIAL [V]** (guía de prompt caching de OpenAI, código
literal): `ordinaryInputTokens = inputTokens − cachedTokens − cacheWriteTokens`.
No hay incógnita de subset; queda solo un chequeo de plausibilidad.

| Pieza | Qué | Dónde | Esfuerzo |
|---|---|---|---|
| **P1 · `ObservadorResponses`** | Clase hermana de `ObservadorSse` (no parametrizar: ni eventos ni forma de usage coinciden), misma interfaz `observar(chunk)`/`usage()`, filtra `response.completed` y devuelve un `UsoSse` **ya mapeado**: `input_tokens = max(0, input − cached − writes)`, `cache_read_input_tokens = cached_tokens` (tarifa `cachedInputPer1k`, ya al 10 % en el catálogo), `cache_creation_input_tokens = cache_write_tokens` (cae en la rama 5m a 1,25× — **es exactamente la prima oficial de OpenAI para gpt-5.6+**; jamás al bucket 1h, que es exclusivo de Anthropic). `reasoning_tokens` ya va dentro de `output_tokens`: no sumar. Ignorar `compute_units`. Plausibilidad `cached + writes ≤ input` antes de emitir (OpenAI reconoció contadores mal en el arranque de 5.6) | gateway/medidor.ts | días |
| **P2 · Dialecto por ruta** | `url.pathname.endsWith("/responses")` → `ObservadorResponses`; `/v1/messages` → `ObservadorSse`; otras rutas SSE → sin observador. Cubre `/v1/responses` y `/backend-api/codex/responses` | gateway/servidor.ts | horas |
| **P3 · Handshake WebSocket → 426** | **Requisito duro, no mejora.** `supports_websockets: true` está hardcodeado en el provider integrado y no se puede apagar por config ([model_providers.openai] se ignora para built-ins; los feature flags están `Removed`); todos los modelos bundled llevan `prefer_websockets`. Refutación útil: hoy Node **no** destruye el socket — el GET con `Upgrade` entra en el handler normal, undici falla con «invalid connection header» y el gateway responde **502**, que Codex trata como error genérico: quema `stream_max_retries` intentos con «Reconnecting…» visibles antes del fallback. Con un **426** el fallback a HTTP es inmediato, silencioso y pegajoso por sesión [V test `websocket_fallback.rs`]. Aplicación: `server.on("upgrade", (req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"))` | gateway/servidor.ts | horas |
| **P4 · `bvsala codex`** | Espejo de `bvsala claude`: gateway efímero + `spawn("codex", ["-c", "openai_base_url=http://127.0.0.1:<puerto><prefijo>", ...resto])`. `-c` es flag global de máxima precedencia [V]; **no** existe env `OPENAI_BASE_URL` (cero referencias en el código de config) [V]; sin escribir config, muere con el proceso. **El prefijo depende del modo de auth** [V `AuthDotJson`, `to_api_provider`]: `ApiKey` → upstream `https://api.openai.com`, prefijo `/v1`; toda la familia ChatGPT (`Chatgpt`, `ChatgptAuthTokens`, `Headers`, `AgentIdentity`, `PersonalAccessToken`) → upstream `https://chatgpt.com`, prefijo `/backend-api/codex` — y **el base_url tiene que terminar exactamente en `/backend-api/codex`** o `supports_codex_backend_routes()` se apaga. Leer `auth_mode` de `~/.codex/auth.json` **por existencia/valor del enum, jamás imprimir tokens**. Una instancia de gateway por envoltorio (patrón actual de bin.ts) | gateway/bin.ts | días |

Ya cumplido: catálogo gpt-5.x (las que Codex ofrece hoy — 5.6-sol/terra/luna,
5.5, 5.2, 5.4, 5.4-mini — coinciden **exactamente** con la página oficial de
precios [V]; cuatro slugs viejos del catálogo —`gpt-5-codex`, `5.1-codex`,
`5.1-codex-max`, `5.2-codex`— ya no figuran en la página oficial: revisar),
verja del ingest acepta `gpt-*`, extracción del modelo del cuerpo funciona
(`model` en la raíz de `ResponsesApiRequest` [V]).

**Validaciones en mano:** ✅ (b) **modo suscripción ChatGPT** validado el
30-08 (Codex v0.134: 426 → fallback HTTP inmediato, 200, stream íntegro,
`usage` presente en `response.completed`, registro `measured` en la ingesta —
y tres hallazgos que el código ya contempla: Codex cierra la conexión nada más
recibir `response.completed`, el backend de ChatGPT sirve el SSE **sin
`content-type`**, y el cuerpo de la petición viaja **comprimido con zstd**);
⏳ (a) sesión con API key (`/v1/responses`); ⏳ (c) plausibilidad
`cached + writes ≤ input` en un prompt repetido > 1.024 tokens. **Postura de cumplimiento idéntica a
Claude Code:** OpenAI ni bendice ni prohíbe el proxy de suscripción (silencio
del staff, a diferencia de Anthropic que lo documenta): cero persistencia de
`Authorization`/`ChatGPT-Account-ID`, binario sin modificar, y no promocionar
el modo suscripción hasta validarlo.

---

## 3. Anillo 2 — dialecto Anthropic, medidor actual, cero observador nuevo

Los cinco CLI hablan dialecto Anthropic puro y autentican con `x-api-key` +
`anthropic-version`, que el reenvío actual pasa intactos: **nada que cambiar en
servidor.ts/medidor.ts** [V]. **La trampa central es la forma del `baseURL`**,
que depende del SDK de cada terminal, y una URL copiada entre terminales rompe
en silencio (`/v1/v1/messages` → 404 sin medir):

| Terminal | Enrutado [V] | Forma exacta del base URL | Envoltorio | Trabajo |
|---|---|---|---|---|
| **Goose** | env `ANTHROPIC_HOST` (pisa `config.yaml`) + `ANTHROPIC_API_KEY` | `http://127.0.0.1:8402` (**sin** `/v1`) | ✅ `bvsala goose` — espejo exacto de `bvsala claude` | horas |
| **Qwen Code** | env `ANTHROPIC_BASE_URL` + `~/.qwen/settings.json` con `selectedType: anthropic` | **sin** `/v1` (SDK TS oficial añade `/v1/messages`) | ✅ `bvsala qwen` (el doctor comprueba `selectedType`) | horas |
| **opencode** | `~/.config/opencode/opencode.json` → `provider.anthropic.options.baseURL` (el de proyecto pisa al global) | **con** `/v1` (su capa `packages/llm` añade `/messages`) | ✗ config → instalador con merge JSON de config de USUARIO; alternativa [V]: `"baseURL": "{env:BVSALA_BASE_URL}"` escrito una vez habilita envoltorio puro-env (trampa: sin la variable, baseURL vacío) | horas |
| **Crush** | `~/.config/crush/crushrc` (Bash): `provider add bvsala --type anthropic --base-url http://127.0.0.1:8402/v1 --api-key "$ANTHROPIC_API_KEY"`; `crush.json` **deprecado** | **con** `/v1`, **sin barra final** (el SDK Go resuelve relativo: `/v1/` → `/v1/v1/messages`) | ✗ config | horas |
| **Droid** (Factory, cerrado) | `~/.factory/settings.json` → `customModels[]{provider:"anthropic", baseUrl, apiKey}` | sin `/v1` [I] | ✗ config → merge JSON | validar en mano contra el log del gateway |
| **Cline** | UI: proveedor Anthropic + «Use custom base URL» | **con** `/v1` — **refutación**: Cline main ya usa `@ai-sdk/anthropic` (no el SDK TS oficial); `normalizeBaseURL` solo añade `/v1` a `https://api.anthropic.com` exacto; `builtins.ts` fija `https://api.anthropic.com/v1` [V] | ✗ UI → solo docs | horas |
| **Kilo Code** | proveedor custom, Provider API «Anthropic Messages»; config en `kilo.json` (detectable) | probar **con** `/v1` primero (linaje Cline) [I] | ✗ UI → docs | validar en mano |

**Pieza común: `bvsala doctor`** (gateway/bin.ts): sondea PATH (`claude`,
`codex`, `opencode`, `goose`, `crush`, `qwen`, `droid`) y la existencia de las
configs de usuario, e **imprime el bloque exacto por terminal** con el puerto
vivo y la forma correcta del URL; `--write <terminal>` escribe **solo config de
usuario** (merge JSON conservador; append comentado en `crushrc`; copia `.bak`),
nunca archivos del repo del cliente. Detecta en el log del gateway el síntoma
`POST /v1/v1/messages` (URL mal formada). Más `docs/terminales/<terminal>.md`
por cada uno. *Días.* Los envoltorios `bvsala goose|qwen` salen de generalizar
el `switch` de bin.ts a una tabla `{comando → variable de entorno}`.

**Regla BYOK sin excepción:** Anthropic prohíbe usar el OAuth de Claude
Pro/Max en harnesses de terceros (opencode lo documenta; Crush retiró su OAuth
en ene-2026). Las recetas del anillo 2 son **API key exclusivamente** — el
gateway reenviaría un Bearer de suscripción sin inmutarse, y eso no se
promociona.

**Familia qwen — fuera del catálogo a propósito:** `costeMedido → null`,
passthrough con aviso una vez, coherente con la política de catalogo.ts:10-15
(presente-y-mal es peor que ausente). Para medirla: precios **verificados** de
ModelStudio/DashScope en la fecha, y antes comprobar que DashScope emite SSE
con `\n\n` — el `ObservadorSse` parte bloques solo por `\n\n`; un upstream que
emita `\r\n\r\n` jamás cerraría un bloque y no mediría nada aunque el precio
esté [I].

---

## 4. Orden de aplicación propuesto

| # | Pieza | Esfuerzo | Por qué en este orden |
|---|---|---|---|
| 1 | Test `GET /v1/models` + validación en mano con API key (§1.2) | horas | cierra el único requisito de conformidad sin test; cero riesgo |
| 2 | `bvsala goose` + `bvsala qwen` + generalizar bin.ts (§3) | horas | más tráfico API-key medible **hoy**, con el medidor actual |
| 3 | P3 (426) + P2 (dialecto por ruta) + P1 (`ObservadorResponses`) + P4 (`bvsala codex` con prefijo por auth) + validaciones (§2) | ~1 semana | Codex es la prioridad #1 del catálogo de terminales: la mayor expansión con el menor riesgo técnico |
| 4 | `bvsala doctor` + `docs/terminales/*.md` + validaciones en mano de Droid/Kilo (§3) | días | onboarding del anillo entero a coste marginal ~0 |
| 5 | Atribución por sesión/subagente (§1.3) | días | producto; **coordinar con S2** (el registro `shadow` querrá la sesión) y desplegar servidor primero |
| 6 | Canal incremental de la coalescencia (§1.1) | días | solo antes de encender la coalescencia por defecto |

Nada de esto toca el cuerpo de las peticiones: **la defensa del passthrough
queda intacta** en todas las piezas.

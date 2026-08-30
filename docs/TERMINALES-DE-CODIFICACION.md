# BV-SALA y los terminales de codificación con IA — investigación

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
>
> **Fecha:** 2026-08-24 · **Método:** 4 pasadas de investigación web en paralelo
> contra documentación oficial viva, repositorios en `main`, API de GitHub y
> páginas de precios, todas consultadas el 2026-08-24, más lectura del código
> propio (`gateway/`, `docs/PASARELA-F0.md`). Cada afirmación va etiquetada
> **[V]** = VERIFICADA (URL primaria consultada en esa sesión) o **[I]** =
> INFERIDA (fuente secundaria, o razonamiento por ausencia en la documentación).
>
> Complementa a `PASARELA-F0.md` (la evidencia técnica local de que la puerta de
> Claude Code funciona); este documento aporta el mapa del mercado y de las
> puertas de los demás terminales.

---

## 1. OpenAI Codex CLI — interceptable de primera clase, incluso con suscripción ChatGPT

### Base URL y proveedores personalizados
- **[V]** La referencia oficial de configuración (https://learn.chatgpt.com/docs/config-file/config-reference, destino de la redirección de https://developers.openai.com/codex/config-reference) documenta en `~/.codex/config.toml`:
  - `model_provider` (por defecto `"openai"`) y tablas `[model_providers.<id>]` con claves exactas: `name`, `base_url`, `env_key`, `wire_api`, `query_params`, `http_headers`, `env_http_headers`, `request_max_retries` (4), `stream_max_retries` (5), `stream_idle_timeout_ms` (300000), `auth` (token bearer por comando), `requires_openai_auth`, `supports_websockets`.
  - **`openai_base_url`** (clave TOML de nivel superior): «Base URL override for the built-in `openai` model provider». La doc dice literalmente que sirve para «point the built-in OpenAI provider at an LLM proxy, router…». **Es LA clave para BV-SALA.**
  - `chatgpt_base_url` (por defecto `https://chatgpt.com/backend-api/`) gobierna el backend de ChatGPT (login, cloud tasks), no el tráfico de modelo.
- **[V]** **`OPENAI_BASE_URL` como variable de entorno YA NO es un override en runtime** (verificado por grep del `main` actual de `openai/codex`): la ruta soportada es la clave TOML o `-c openai_base_url=...` en línea de comandos (el SDK TS hace exactamente eso en `sdk/typescript/src/exec.ts`).
- **[V]** Restricción de seguridad: `openai_base_url` y `chatgpt_base_url` están en `PROJECT_LOCAL_CONFIG_DENYLIST` (`codex-rs/config/src/loader/mod.rs`) — no se pueden fijar desde el `.codex/config.toml` de un repositorio; solo desde el nivel usuario/sistema/managed/CLI. Implicación de producto: el instalador de BV-SALA debe escribir en `~/.codex/config.toml`.

### Protocolo de cable
- **[V]** **Solo Responses API.** El enum `WireApi` en `codex-rs/model-provider-info/src/lib.rs` solo contiene `Responses`; deserializar `"chat"` devuelve un error explícito de eliminación. Deprecación anunciada en https://github.com/openai/codex/discussions/7782, retirada completada en febrero de 2026. El proveedor integrado apunta a `{base_url}/responses` vía SSE. **BV-SALA necesita un adaptador de Responses API (eventos SSE `response.output_item.done`, semántica `previous_response_id`/store), no chat completions.**
- **[V]** Existe transporte **WebSocket** para Responses (`supports_websockets: true` en el proveedor integrado). Los tests del propio repo lo desactivan al usar mocks SSE. Riesgo a probar en mano antes de GA: manejar el upgrade WS o desactivarlo.

### Proxy local
- **[V]** Es exactamente como corren los tests del propio repo: `-c openai_base_url="{mock_server}"` (`codex-rs/core/tests/suite/cli_stream.rs`). Streaming SSE con reintentos configurables. Existe `respect_system_proxy`; problema conocido con SOCKS5 en Windows (https://github.com/openai/codex/issues/20844) — irrelevante para la vía base_url.

### Suscripción ChatGPT a través del proxy — la respuesta que vale dinero
- **[V, a nivel de código fuente]** En `to_api_provider()` (`codex-rs/model-provider-info/src/lib.rs`): con auth ChatGPT el destino por defecto es `CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`, **pero `self.base_url` tiene precedencia con independencia del modo de autenticación**. El test `remote_models.rs` usa auth ChatGPT ficticia con `base_url: Some(mock)`. Es decir: **`openai_base_url` a nivel usuario redirige también el tráfico de suscripción**, reenviando aguas arriba a `chatgpt.com/backend-api/codex` con `Authorization: Bearer` + cabecera `ChatGPT-Account-ID` intactas. Confirmación externa del endpoint: https://docs.litellm.ai/docs/providers/chatgpt.
  - *Discrepancia entre agentes de investigación*: un segundo repaso solo desde la doc pública concluía «ChatGPT-plan solo llega a OpenAI» (cierto para `model_providers` personalizados, que exigen `env_key`). La verificación en fuente del proveedor **integrado** es más fuerte; aun así, **validar en mano** antes de anunciarlo (la doc no bendice explícitamente este uso — ver §7).
- **[V]** `requires_openai_auth = true` permite que un proveedor personalizado use el token de ChatGPT (mutuamente excluyente con `env_key`). Claves de administración: `forced_login_method = "chatgpt" | "api"`, `forced_chatgpt_workspace_id`. `experimental_use_responses_url` **ya no existe** en `main`.
- **[V]** Adopción: 116.142 estrellas / 17.708 forks (API de GitHub, 2026-08-24). **[I]** ~2M usuarios semanales (mar-2026) → 5M+ (jun-2026); ~41,8M descargas en mayo de 2026 (https://thenewstack.io/gpt-5-6-codex-user-surge/, https://tech-insider.org/ie/openai-codex-5-million-users-2026/).

---

## 2. Claude Code — el canal de BV-SALA, ahora especificado oficialmente

La documentación se reestructuró en 2026 en un conjunto completo sobre gateways: https://code.claude.com/docs/en/llm-gateway (visión), /llm-gateway-connect (desarrollador), /llm-gateway-rollout (admin) y — lo más importante — **una referencia de protocolo para operadores de gateway**: https://code.claude.com/docs/en/llm-gateway-protocol. Es decir, Anthropic documenta ahora la categoría en la que opera BV-SALA.

### Variables (todas [V] de las páginas anteriores)
`ANTHROPIC_BASE_URL` (apunta al gateway), `ANTHROPIC_AUTH_TOKEN` (→ `Authorization: Bearer`), `ANTHROPIC_API_KEY` (→ `x-api-key`), `apiKeyHelper` (+ `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`), `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_BEDROCK_BASE_URL`/`ANTHROPIC_VERTEX_BASE_URL` (+ `CLAUDE_CODE_USE_*`, `CLAUDE_CODE_SKIP_*_AUTH`), nuevas 2026: `ANTHROPIC_FOUNDRY_BASE_URL` (Microsoft Foundry, v2.1.203+) y `ANTHROPIC_AWS_BASE_URL` («Claude Platform on AWS», exige reenviar `anthropic-workspace-id`), `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (SOCKS no soportado), `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CERT_STORE`, mTLS (`CLAUDE_CODE_CLIENT_CERT/_KEY`), `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, **`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`** (Claude Code consulta `GET /v1/models` del gateway y lista sus modelos como «From gateway»), `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.

### Hechos de protocolo directamente útiles para BV-SALA (todos [V] de /llm-gateway-protocol)
- Endpoint a igualar: `POST /v1/messages?beta=true`; opcional `/v1/messages/count_tokens`; sonda `HEAD /api/hello`.
- «Forward `anthropic-version` and `anthropic-beta` unchanged… don't allowlist individual values» — cabeceras y campos como listas abiertas.
- **Cabeceras de atribución para contabilidad sin abrir cuerpos**: `x-claude-code-session-id`, `x-claude-code-agent-id`, `x-claude-code-parent-agent-id` — ofrecidas explícitamente para atribución de coste por sesión/agente.
- Las respuestas **deben fluir** (watchdog de bytes: 300 s por defecto en conexiones `ANTHROPIC_BASE_URL`; la cifra «180 s directo» ya no figura en la doc oficial — verificado 2026-08-30); un proxy que bufferice aborta al cliente. Reenviar cuerpos de error **sin modificar**.
- Bloque de atribución del system prompt estable por conversación desde **v2.1.181** (antes rompía cachés por cuerpo).
- **Suscripciones por gateway, sancionadas** ([V], sección «Subscriptions and gateways» de /llm-gateway): fijar solo `ANTHROPIC_BASE_URL` sin credencial de gateway mantiene el login de claude.ai como credencial activa («its usage limits and billing apply»), y «Gateways that pass this traffic on to Anthropic **must forward the OAuth capability in `anthropic-beta`**» (si se elimina → 401). **Es exactamente el modo de operación de BV-SALA, ahora documentado como configuración soportada del binario sin modificar.**
- Fugas: el chequeo de fast-mode y el safety-check de WebFetch van directos a `api.anthropic.com` saltándose `ANTHROPIC_BASE_URL` — un proxy local no ve el 100 % del tráfico ([V]).

### Telemetría y APIs de uso nuevas en 2026
- **[V]** (https://code.claude.com/docs/en/monitoring-usage): `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER`, nueva beta `OTEL_TRACES_EXPORTER` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`; métricas `claude_code.cost.usage` (coste **estimado en cliente**, «may not reflect actual billing» — literal que valida la tesis de BV-SALA de medir contra contadores reales) y `claude_code.token.usage` (input/output/cacheRead/cacheCreation); nuevo `OTEL_LOG_RAW_API_BODIES=1`.
- **[V]** **Claude Code Analytics API** (https://platform.claude.com/docs/en/manage-claude/claude-code-analytics-api): informe diario por usuario con tokens por modelo y `estimated_cost`, y campo `customer_type` que distingue **`api` vs `subscription`**. Gratuita, solo organizaciones. Anthropic se mueve hacia la analítica organizativa — pero sigue siendo *estimación/telemetría*, no ahorro verificado ni palancas.
- **[V]** Anthropic lanza su propio gateway autoalojado, «**Claude apps gateway**» (`claude gateway --config gateway.yaml`, v2.1.195+; https://code.claude.com/docs/en/claude-apps-gateway): SSO, RBAC, límites de gasto, failover multi-nube. Dirigido al enrutado corporativo de credenciales (sin suscripción ni API key del usuario), **no** a la medición local de ahorro por asiento. Competencia por arriba, no en el nicho de BV-SALA.
- **[V]** La doc ya no nombra a LiteLLM: «Any gateway that exposes a supported API format works. Anthropic doesn't endorse… third-party gateway products, and doesn't support routing Claude Code to non-Claude models through any gateway.»

---

## 3. Google Gemini CLI — interceptable (con modo `gateway` nativo), pero en repliegue

- **[V]** ⚠️ **Puesta de sol para consumo**: Google anunció (2026-05-19) la transición a **Antigravity CLI**; desde el **2026-06-18** Gemini CLI dejó de servir a suscriptores AI Pro/Ultra y usuarios individuales gratuitos (https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/). Siguen funcionando: licencias enterprise de Code Assist y **modo API key**. El repo sigue vivo (106.645 estrellas, push 2026-08-24).
- **[V]** Overrides (docs/reference/configuration.md + `packages/core/src/core/contentGenerator.ts`):
  - **`GOOGLE_GEMINI_BASE_URL`** — override para auth `gemini-api-key`; exige HTTPS **salvo `localhost`/`127.0.0.1`/`[::1]`**, donde permite HTTP plano. Hecho a medida para un proxy local.
  - `GOOGLE_VERTEX_BASE_URL` (auth `vertex-ai`), `CODE_ASSIST_ENDPOINT` (ruta OAuth `cloudcode-pa.googleapis.com/v1internal:*` — la vía que Google mató para consumo).
  - **Nuevo `AuthType.GATEWAY = 'gateway'`** ([V] en código, aún no en doc pública): la mera presencia de `GOOGLE_GEMINI_BASE_URL` auto-selecciona el modo gateway, API key opcional. Un modo «apúntame a tu gateway» de primera clase.
- **[V]** Protocolo: Gemini API `generateContent`/`streamGenerateContent` (SSE `?alt=sse`) en los modos API-key/gateway/Vertex; Code Assist API en OAuth. Sin soporte OpenAI-compatible (peticiones abiertas: https://github.com/google-gemini/gemini-cli/issues/23385).
- **[I]** Antigravity CLI mantendría `GEMINI_API_KEY` + `GOOGLE_GEMINI_BASE_URL` (guías de terceros + https://antigravity.google/docs/cli/install/) — **validar en mano antes de construir**.

---

## 4. Los demás CLIs de codificación (agosto 2026): quién respeta un base URL

| Herramienta | ¿Base URL propio? | Mecanismo exacto | ¿Protocolo Anthropic? | Tracción |
|---|---|---|---|---|
| **opencode** (Anomaly) | Sí | `opencode.json` → `provider.<id>.options.baseURL` (también en el proveedor `anthropic`); solo config, no env (https://opencode.ai/docs/providers/) | Sí | 200.780 ★; ~9,86M npm/30d — el mayor OSS |
| **Codex CLI** | Sí | `openai_base_url` / `model_providers` (§1) | No (solo Responses) | 116.142 ★ |
| **Gemini CLI** | Sí | `GOOGLE_GEMINI_BASE_URL` + auth `gateway` (§3) | No (protocolo Gemini) | 106.645 ★, consumo en repliegue |
| **Cline** | Sí | UI: proveedor «OpenAI Compatible» con Base URL; Anthropic con «Use custom base URL» (https://docs.cline.bot/provider-config/anthropic) | Sí | 66.738 ★; 5,08M instalaciones |
| **Goose** (Block/LF) | Sí — el más limpio por env | **`ANTHROPIC_HOST`**, **`OPENAI_HOST`**+`OPENAI_BASE_PATH` (https://goose-docs.ai/docs/getting-started/providers) | Sí | 53.343 ★; solo BYOK |
| **Aider** | Sí | `OPENAI_API_BASE` / `--openai-api-base`; `ANTHROPIC_API_BASE` vía `--set-env` [I] | Sí [I] | 48.441 ★ pero **estancado** (último release ago-2025) |
| **Qwen Code** | Sí | env **`OPENAI_BASE_URL`** y **`ANTHROPIC_BASE_URL`** + `modelProviders[].baseUrl` | Sí | 27.325 ★; BYOK desde abr-2026 |
| **Crush** (Charm) | Sí | `crushrc` (Bash, en `~/.config/crush/`) → `provider add <id> --type anthropic --base-url …/v1` — `crush.json` está DEPRECADO (verificado 2026-08-30) | Sí | 27.626 ★; OAuth Claude retirado ene-2026 |
| **Kilo Code** | Sí | UI «OpenAI Compatible»: Base URL + Headers (https://kilo.ai/docs/providers/openai-compatible) | [I] probable | 26.994 ★; 1,45M instalaciones |
| **Droid** (Factory) | Sí (BYOK) | `~/.factory/settings.json` → `customModels[].baseUrl` + `provider: "anthropic"` (https://docs.factory.ai/cli/byok/overview) | Sí | Cerrado; Series B $50M |
| **Cursor CLI** | **No** | El tráfico termina en el backend de Cursor | No | Adquirido por SpaceX ~$60B (cierre 2026-08-14) |
| **Amp**, **Copilot CLI**, **Devin/Windsurf**, **Kiro**, **Antigravity** | **No** | Plataformas cautivas | No | — |
| **Roo Code** | (era Sí) | **Cerrado 2026-05-15** | — | 1,95M instalaciones al cierre |

**Lecturas [V]/[I]**: (1) el base URL personalizado es estándar en todo CLI open-source y ausente en toda plataforma cautiva — su negocio *es* la capa de enrutado; (2) tras la ofensiva de Anthropic (ene–abr 2026, §7), en los CLIs de terceros **todo el tráfico redirigible es BYOK medido por API** — justo el que un proxy de ahorro monetiza; (3) el churn es real (Roo Code cerrado, Aider parado, Qwen sin free tier): la lista de integraciones requiere refresco trimestral.

---

## 5. Contexto de mercado: los agentes de codificación dominan el gasto en tokens

- **[V]** OpenRouter/a16z «State of AI» (estudio de 100T tokens, dic-2025; https://openrouter.ai/state-of-ai): programación pasó de ~11 % de los tokens (inicio 2025) a **>50 %** (final 2025); prompts de programación habitualmente >20K tokens de entrada; **Anthropic >60 %** de los tokens de la categoría.
- **[V]** Leaderboard de apps de OpenRouter (2026-08-24, https://openrouter.ai/apps): el top-10 por tokens son casi todos agentes de codificación (Hermes Agent 2,31T; Claude Code 685B; Kilo Code 401B; Cline 297B; Codex 123B…).
- **[V]** Menlo Ventures (dic-2025, vía https://finance.yahoo.com/news/menlo-ventures-2025-state-generative-123000623.html): gasto enterprise en genAI $37B (×3,2 interanual); coding & dev tools **$7,3B, la mayor categoría**; coding = **55 % del gasto departamental** (~$4,0B, ×7 desde 2024); Anthropic 40 % del gasto enterprise en LLM.
- **[V]** Crecimiento de producto: Claude Code $500M run-rate (sep-2025) → ~$1B (oct-2025, Reuters) → **>$2,5B, doblado desde el 1-ene-2026** (feb-2026, https://www.constellationr.com/insights/news/anthropics-claude-code-revenue-doubled-jan-1); Anthropic $65B anualizado en jul-2026 (https://techcrunch.com/2026/08/17/anthropics-annualized-revenue-surges-to-65b/). Codex: mensajes diarios ×10 desde ago-2025; >40T tokens de GPT-5-Codex en ~3 semanas (DevDay oct-2025); [I] >4M usuarios semanales (abr–may 2026).
- **Patrón de consumo — la superficie de BV-SALA**:
  - **[V]** Cache-heavy: Claude Code reenvía el contexto completo cada turno con prefijo estable, de modo que la mayor parte de la entrada se factura como lecturas de caché a ~10 % de tarifa (https://code.claude.com/docs/en/prompt-caching); Anthropic declara SEVs cuando cae el hit-rate de caché — «Prompt caching is everything» (https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything, abr-2026).
  - **[V]** Dominado por entrada: sesión agéntica de 50 turnos ≈ 1M tokens de entrada vs 40K de salida (20–25:1); la entrada ≈ 85 % del coste (https://www.vantage.sh/blog/agentic-coding-costs).
  - **[V]** Multiplicación agéntica: tareas agénticas ≈ ×1000 tokens frente a chat de código; **hasta ×30 de varianza entre ejecuciones idénticas** (arXiv https://arxiv.org/abs/2604.22750) — la varianza es precisamente lo que hace valioso medir de verdad.

---

## 6. Panorama competitivo: gateways delante de CLIs de codificación

Contexto [V]: el passthrough Anthropic `/v1/messages` ya es *table stakes* (en 2025 solo LiteLLM; hoy lo documentan OpenRouter, Vercel, Cloudflare, Helicone, Portkey, Bifrost, Requesty, LLM Gateway…), y **el markup de tokens ha colapsado a cero** en todos los grandes (https://llmgateway.io/blog/ai-gateway-fees-compared, act. 2026-08-05): se monetiza con fees de plataforma (5–5,5 % sobre créditos), suscripciones ($49–$799/mes) o licencias enterprise.

| Vendor | (a) `/v1/messages` para Claude Code | (b) ¿Preserva prompt caching Anthropic? | (c) ¿Ahorro u observabilidad? | (d) ¿Local-first? | (e) Precio (ago-2026) |
|---|---|---|---|---|---|
| **LiteLLM** | Sí [V] (unificado o passthrough `/anthropic`; https://docs.litellm.ai/docs/pass_through/anthropic_completion) | Sí en ruta traducida [V], con bugs graves (§7); passthrough por diseño [I] | Observabilidad + presupuestos + caché de respuestas; sin ahorro verificado | Autoalojable OSS | OSS gratis; enterprise ~$250/mes [I] |
| **Helicone** | Parcial [V]: passthrough legado «no longer actively developed»; el gateway Rust nuevo es solo formato OpenAI (https://docs.helicone.ai/integrations/anthropic/claude-code) | [I] passthrough preserva | Caché de respuestas en edge; principalmente observabilidad | Ambos (OSS Rust + cloud) | Free 10K req/mes; Pro $79/mes; Team $799/mes (https://www.helicone.ai/pricing) |
| **Portkey** | Sí [V] (https://portkey.ai/docs/integrations/libraries/claude-code) | Mayormente [V], **bug: `cache_control` eliminado al enrutar a Vertex** (https://github.com/Portkey-AI/gateway/issues/1579) | Caché simple/semántica «hasta ×20»; paneles estimados | Cloud-first (OSS reducido) | Free 10K logs; $49/mes; enterprise |
| **OpenRouter** | Sí [V] — «Anthropic Skin» nativa 2026 (https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration) | Sí en general [V] (`cache_control`, campo `cache_discount`); vía Skin [I] | Conveniencia/failover; **único que expone `cache_discount` por petición** (lo más parecido a un recibo de ahorro) | Cloud | 0 % markup; 5,5 % en compras de crédito; BYOK 5 % >1M req/mes |
| **Vercel AI Gateway** | Sí [V] — endpoint dedicado `https://ai-gateway.vercel.sh/claude-code`, **incl. passthrough de suscripción Claude Max** (https://vercel.com/docs/ai-gateway/coding-agents/claude-code) | Sí [V] (passa `cache_control`; devuelve tokens de caché) | Observabilidad/failover; sin promesa de ahorro | Cloud | 0 % markup; add-ons por informes (https://vercel.com/docs/ai-gateway/pricing) |
| **Cloudflare AI Gateway** | Sí [V] (https://developers.cloudflare.com/ai-gateway/integrations/coding-agents/claude-code/) | [I] passthrough | Caché de respuestas gratis en edge; paneles | Cloud (edge) | Núcleo gratis; logs de pago; 5 % en Unified Billing |
| **TensorZero** | **Muerto**: repo archivado 2026-06-12 [V] (https://github.com/tensorzero/tensorzero) | — | — | Era 100 % self-hosted | — |
| **Kong AI Gateway** | Parcial [V] (`llm_format: anthropic` en traducción) | No documentado; en riesgo por traducción [I] | Caché semántica enterprise | Autogestionable con licencia | ~$105/mes/servicio + enterprise [I] |
| **Bifrost** (Maxim) | Sí [V] — `http://localhost:8080/anthropic`, autodetecta suscripción Max vs API key (https://docs.getbifrost.ai/cli-agents/claude-code) | [I] probable | Presupuestos, balanceo; sin ahorro verificado | **Sí — OSS Go autoalojado; el más parecido arquitectónicamente a BV-SALA** | OSS gratis; enterprise sales-led |
| **Requesty** | Sí [V] | [I] | Enrutado a modelos baratos | Cloud | **5 % de markup** (https://www.requesty.ai/pricing) |
| **LLM Gateway** (llmgateway.io) | Sí [V], nativo (https://docs.llmgateway.io/features/anthropic-endpoint) | Sí [V] («forward cache_control markers») | Caché + «DevPass» de precio fijo para Claude Code/Cursor/Codex | Ambos | 0 % markup; 5 % créditos; BYOK 0 % |
| **claude-code-router** (OSS) | Sí — proxy local que enruta Claude Code a modelos baratos (36,8k ★; https://github.com/musistudio/claude-code-router) | N/A (su fin es salir de Anthropic) | Sustitución por modelo barato, sin medición | **Sí, local** | Gratis (MIT) |
| **ccusage** (OSS) | No es proxy — lee logs JSONL de Claude Code/Codex/16+ agentes (18,1k ★; https://github.com/ryoppippi/ccusage) | Solo reporting | Pura medición estimada, sin palancas | Sí, offline | Gratis |
| **ccflare** (OSS) | Sí — proxy local sin tocar payloads, rotación de cuentas (gris en ToS) (https://github.com/snipeship/ccflare) | Sí por diseño [V] | Analítica; «ahorro» por rotación de suscripciones | Sí, local | Gratis |

**Hallazgo central [V/I]**: **ningún gateway del mercado promete «ahorro medido/verificado contra los contadores del proveedor»**. Todos (a) miden y muestran paneles con costes estimados (tokens × tarifas), o (b) afirman palancas («hasta ×20») sin bucle de verificación. El único lenguaje de «verified savings» viene de dos consultorías FinOps cloud — LLM CFO (https://llmcfo.com/: «15–25 % of verified savings… reconciled to raw provider invoices») y FinOps LLM — con mínimos de $20K/mes de gasto, sin producto local ni foco en CLIs. **El espacio «local-first + ahorro verificado + por asiento + nativo de Claude Code/Codex» está desocupado.** Nadie documenta coalescencia de peticiones como palanca [I, por ausencia]. Además, Anthropic mismo se mueve al nicho enterprise con su «Claude apps gateway» (§2) — presión desde arriba, no sobre el nicho de BV-SALA.

---

## 7. Riesgos técnicos y legales

### TLS / pinning — vía libre
- **[V]** Ninguno de los tres grandes CLIs hace certificate pinning; los tres documentan CAs personalizadas: Claude Code (`NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_CERT_STORE`, «Zscaler/CrowdStrike work without additional configuration»), Codex (`CODEX_CA_CERTIFICATE`, https://github.com/openai/codex/issues/6849), Gemini CLI (`NODE_USE_SYSTEM_CA`, `--proxy`). Un proxy por base_url ni siquiera necesita interceptar TLS.

### La ofensiva de Anthropic contra el OAuth de terceros (ene–abr 2026) — y por qué BV-SALA queda al otro lado de la línea
- **[V]** Cronología: 2026-01-09 bloqueo server-side de tokens OAuth de suscripción usados desde harnesses de terceros (OpenCode, Cline, RooCode…; https://paddo.dev/blog/anthropic-walled-garden-crackdown/); feb-2026 formalización en ToS (https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/); 2026-04-04 aplicación total. Crush y opencode retiraron sus plugins OAuth.
- **[V]** Texto oficial vigente (https://code.claude.com/docs/en/legal-and-compliance): prohibido a terceros «offer Claude.ai login into their own applications, or route requests through Free, Pro, or Max plan credentials **on behalf of their users**… developers may not **collect, store, or intermediate** Claude.ai credentials or session tokens». Pero, explícitamente: «Nor does it prevent an end user from signing in to the **unmodified Claude Code binary** with their own Claude subscription».
- **Análisis [I sobre bases V]**: lo prohibido es el *harness* de terceros que reutiliza tokens, el login intermediado y la reventa. Lo **documentado como soportado** es exactamente BV-SALA: binario Claude Code sin modificar + `ANTHROPIC_BASE_URL` + OAuth del propio usuario intacto (la doc de gateway incluso obliga a reenviar la capacidad OAuth en `anthropic-beta`). Zona gris residual: el verbo «intermediate… session tokens» — un proxy ve el token en tránsito. Postura de cumplimiento máxima: **no registrar ni persistir jamás el header Authorization, no inyectarlo ni sustituirlo, reenviar `anthropic-beta` literal, no falsificar cabeceras identificativas, no intermediar facturación**. Anthropic se reserva enforcement «without prior notice».
- **[V/I]** OpenAI: sin equivalente al veto de Anthropic. El CLI es Apache-2.0 y forkeable (mantenedor oficial en https://github.com/openai/codex/discussions/8338), pero preguntas sobre proxificar la suscripción quedaron **sin respuesta del staff**. Los ToS generales prohíben «circumventing any rate limits… or bypassing protective measures» (https://openai.com/policies/row-terms-of-use/); un proxy de medición transparente no elude nada — pero eso es inferencia nuestra, no postura declarada de OpenAI. Existen proyectos que *revenden* cuota de Codex vía proxy (patrón que Anthropic sí prohibió); distanciarse de ellos.

### Rotura de prompt caching a través de proxies — el argumento de venta involuntario de la competencia
- **[V]** LiteLLM: `cache_control` aplicado a todos los bloques en vez del último (https://github.com/BerriAI/litellm/issues/15696, /14317); header beta inválido en ruta Vertex → fallos duros (/14293); **contadores de caché rotos en passthrough** — `cache_read_input_tokens` sin normalizar, métricas a cero (/27763); balanceo de carga que destruye la localidad de caché (/6784, /17139, /12584).
- **[V]** Portkey: `cache_control` silenciosamente eliminado hacia Vertex (issue #1579) — el panel del gateway ni lo muestra.
- **[V]** Anthropic codifica ya las reglas anti-rotura en /llm-gateway-protocol (reenviar `anthropic-beta` y el array `system` sin tocar; bloque de atribución estable desde v2.1.181). **Un proxy transparente byte a byte como BV-SALA evita todos estos modos de fallo por construcción; todos los fallos documentados están en gateways que reescriben.**

---

## Oportunidades para BV-SALA (ranking)

**1. Adaptador Codex CLI (Responses API) — la mayor expansión de mercado con el menor riesgo técnico.**
Evidencia: `openai_base_url` redirige incluso el tráfico de suscripción ChatGPT (verificado en fuente, §1); 116K ★ y ~5M usuarios semanales; wire único y estable (`responses`, chat eliminado en feb-2026); precedente de mercado (headroom añadiendo justo esto: https://github.com/chopratejas/headroom/issues/773). Trabajo: adaptador SSE de `/responses` con passthrough de `Authorization` + `ChatGPT-Account-ID`, instalador que escriba en `~/.codex/config.toml` (denylist de config local), y prueba en mano del transporte WebSocket y del modo suscripción antes de anunciarlo (la doc no lo bendice explícitamente, a diferencia de Anthropic). Del lado del repo: el gateway F1 ya es genérico en el passthrough; la pieza nueva es un `ObservadorSse` del protocolo Responses en `gateway/medidor.ts` (el actual habla el SSE de Anthropic) + un envoltorio `bvsala codex`. El catálogo de precios ya cubre la familia gpt-5/codex desde el 2026-08-24.

**2. «Recibo de ahorro verificado» como categoría de producto — nadie lo tiene.**
Evidencia: los 15+ gateways auditados solo ofrecen paneles con costes estimados o palancas sin verificación (§6); el propio `claude_code.cost.usage` de Anthropic se declara estimación que «may not reflect actual billing» [V]; los bugs de caché de LiteLLM/Portkey demuestran que un gateway puede destruir el ahorro de caché sin que su panel lo detecte; las únicas «verified savings» del mercado son consultorías a $20K+/mes. Concreción: informe por sesión/mes reconciliado contra contadores del proveedor (cache_read/cache_creation reales, `cache_discount` estilo OpenRouter), con base de comparación bloqueada — la mecánica que LLM CFO vende a enterprise, empaquetada local y por asiento. El extracto en sombra (S6) y el cierre mensual (migración 0016) ya son esta mecánica; falta contarla como categoría.

**3. Conformidad nativa con el protocolo de gateway de Anthropic + atribución por sesión/agente.**
Evidencia: la referencia /llm-gateway-protocol es nueva y va dirigida a productos como BV-SALA; ofrece cabeceras `x-claude-code-session-id`/`agent-id` para atribución de coste sin abrir cuerpos [V]; `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` permite aparecer en `/model` como «From gateway» [V]. Implementar la especificación completa (streaming byte a byte, errores intactos, `anthropic-beta` literal, OAuth capability reenviada) convierte «cumplimos el protocolo oficial de Anthropic» en argumento de venta y en la defensa legal (§7). Añadir un test continuo de «no-rotura de caché» que verifique con contadores reales que el proxy es invisible. Declarar honestamente la fuga parcial (fast-mode/WebFetch van directos a `api.anthropic.com`).

**4. Segundo anillo de CLIs vía el mismo endpoint Anthropic-compatible (coste marginal ~0).**
Evidencia: Goose (`ANTHROPIC_HOST`, 53K ★, Linux Foundation), opencode (200K ★, `provider.anthropic.options.baseURL`), Cline (5M instalaciones, checkbox de base URL Anthropic), Qwen Code (`ANTHROPIC_BASE_URL`), Crush, Droid — todos BYOK tras la ofensiva de enero, es decir, tráfico API medido, el que mejor monetiza un proxy de ahorro (§4). Son docs de onboarding, no ingeniería nueva.

**5. (Opcional, vigilar) Gemini/Antigravity como tercera pata.**
Evidencia: modo `gateway` de primera clase y HTTP-en-localhost permitido [V], pero la base de consumo migró a Antigravity el 2026-06-18 y el soporte de base URL en Antigravity es solo [I]. No construir hasta validar Antigravity en mano; mantener como opción barata para clientes enterprise de Code Assist con API key. El catálogo de precios ya cubre la familia gemini-2.5/3.x desde el 2026-08-24.

**Riesgo transversal a gestionar**: la zona gris del verbo «intermediate» en los ToS de Anthropic (§7) — mitigación: passthrough estricto de credenciales sin persistencia, binarios sin modificar, y ninguna intermediación de facturación; y la fuga parcial de tráfico (fast-mode/WebFetch van directos a `api.anthropic.com`), que conviene declarar honestamente en la medición.

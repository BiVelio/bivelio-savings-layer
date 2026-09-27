# Agentes de código en 2026: quién acepta un base URL propio, qué miden ya ellos mismos y qué añade el gateway

**Fecha:** 2026-09-27 · **Línea:** agentes-de-codigo · **Producto:** `@bivelio/savings-layer` 0.4.25 (gateway local `bvsala`)
**Método:** fuentes primarias. Documentación oficial leída con WebFetch y **código fuente** leído con la API de GitHub
(`gh api repos/<org>/<repo>/contents/…`), cada cosa con su fecha. El buscador web se agotó en esta sesión: no hay
afirmaciones sacadas de resultados de búsqueda, solo de páginas y ficheros abiertos. Etiquetas: **[V]** verificado en
fuente, **[I]** inferido, **[marketing]** cifra del propio vendedor. Las citas [n] remiten a §10.

---

## 1. La pregunta

Doce agentes de código ocupan el mercado en 2026: Claude Code, Codex CLI, Cursor, Cline, Kilo Code, Aider, Continue,
opencode, Goose, Qwen Code, Gemini CLI y GitHub Copilot (con clave propia). Para cada uno:

1. ¿Acepta un base URL propio? ¿Cómo (variable, flag, archivo, UI) y con qué forma exacta (`/v1` o no)?
2. ¿Qué mide ya él mismo (`/usage`, `/stats`, coste por mensaje) y qué mide gratis un tercero (ccusage)?
3. ¿Qué añade el gateway que no den ya ellos, sin prometer un ahorro que no hemos medido?

Y la consecuencia práctica: qué recetas de `bvsala doctor` y qué envoltorios `bvsala <agente>` faltan.

## 2. Resumen

- **Diez de los doce se pueden medir con el gateway.** Siete ya estaban cubiertos (Claude Code, Codex, Goose y Qwen
  Code con envoltorio; opencode, Cline y Kilo por receta, la de Kilo con la forma del URL inferida). Hoy entran
  **Copilot CLI con clave propia de Anthropic, Aider y Continue**, y **opencode y Kilo pasan de receta a envoltorio**
  sin escribir nada en disco. El tipo `openai` de Copilot queda como receta manual sin validar (§3.3).
- **Dos no se pueden medir y ahora se dice:** Cursor manda todas las peticiones, también las de clave propia, desde sus
  servidores, que no alcanzan `127.0.0.1` [9]; Gemini CLI sí acepta base URL [10], pero habla la API de Gemini y el
  gateway no lee ese contador. Copilot con los modelos de GitHub tampoco pasa por un base URL [7].
- **Lo más importante del hallazgo no es un agente, es una trampa:** detrás de un proxy, un cliente de OpenAI puede
  **dejar de pedir el contador en stream**. litellm (Aider) lo hace: solo añade `include_usage` cuando habla con
  `api.openai.com` directamente [5]. De la CLI de Copilot no lo sabemos (no es de código abierto). Dentro de un envoltorio el log va
  callado: una sesión entera podía quedarse sin medir sin que nada lo dijera. **Cada envoltorio imprime ahora, al
  salir, cuántas peticiones midió y cuáles reenvió sin medir, y por qué.**
- **Medir no es ahorrar, y medir ya es gratis.** Claude Code calcula el coste de la sesión en local a precio de lista y
  lo llama estimación [1]; ccusage lee los registros locales de 18 agentes y los tarifica con los precios de LiteLLM,
  gratis [11]. El valor del gateway no está en «ver el gasto»: está en el contador del proveedor petición a petición en
  todos los agentes, en decir lo que no pudo medir, en el aviso de tráfico degradado y en el panel del equipo. Nada de
  esto es una cifra de ahorro, y este PR no publica ninguna.

## 3. Hallazgos por agente

| Agente | Base URL propio [V] | Forma | Dialecto | Qué mide él mismo | En BV‑SALA antes → hoy |
|---|---|---|---|---|---|
| Claude Code | env `ANTHROPIC_BASE_URL` [2] | sin `/v1` | Messages | `/usage`: coste local a precio de lista, «an estimate»; línea de caché del hilo principal con causa del fallo (v2.1.260) [1] | `bvsala claude` → igual |
| Codex CLI (0.159) | solo `-c openai_base_url=…`; sigue sin variable de entorno [4] | `/v1` (API key) · `/backend-api/codex` (ChatGPT) | Responses | ccusage lo cubre [11] | `bvsala codex` → igual; el doctor ahora comprueba `/responses`, no `/messages` |
| opencode (1.18.32, 210k★) | `OPENCODE_CONFIG_CONTENT` o `opencode.json` → `provider.anthropic.options.baseURL` [3] | con `/v1` | Messages | ccusage [11] | receta → **`bvsala opencode`** |
| Kilo Code (7.8.1, fork de opencode) | `KILO_CONFIG_CONTENT` o `~/.config/kilo/kilo.json` [6] | con `/v1` | Messages | ccusage [11] | receta por UI con forma **[I]** → **`bvsala kilo`**, forma [V] |
| Copilot CLI (1.0.89) | solo BYOK: `COPILOT_PROVIDER_BASE_URL` + `COPILOT_PROVIDER_TYPE` [7] | anthropic sin `/v1`, openai con `/v1` | Messages; con `openai`, Chat Completions y Responses por WebSocket [17] | `/usage`: créditos de GitHub y tokens por modelo [7] | nada → **`bvsala copilot`** (tipo anthropic); openai a mano, sin validar |
| Copilot en VS Code | solo BYOK: Custom Endpoint, `url` por modelo [8] | ruta completa `…/v1/messages` | Messages, Chat Completions o Responses | — | nada → **receta del doctor** |
| Aider (main a 2026‑05‑22; release v0.86, ago‑2025) | env de litellm: `ANTHROPIC_API_BASE`, `OPENAI_BASE_URL`/`OPENAI_API_BASE` [5] | Anthropic sin `/v1`, OpenAI con `/v1` | Messages o Chat Completions | tokens y coste por mensaje; sin `usage`, cuenta con su tokenizador local [5] | nada → **`bvsala aider`** |
| Continue (2.1.0) | `~/.continue/config.yaml` → `apiBase` [12] | con `/v1` (él pone la barra) | Messages | — | nada → **receta del doctor** |
| Cline (4.1.21) | UI → «Use custom base URL» [13] | con `/v1` | Messages | — (no verificado hoy) | receta → igual |
| Goose, Qwen Code | env `ANTHROPIC_HOST` / `ANTHROPIC_BASE_URL` | sin `/v1` | Messages | ccusage [11] | envoltorio → igual |
| Gemini CLI (0.63 nightly, 107k★) | env `GOOGLE_GEMINI_BASE_URL` (http solo en localhost) [10] | — | **API de Gemini** | `/stats model`: tokens y cuota [10] | nada → **«no se mide todavía», dicho en el doctor** |
| Cursor | no: «all requests are routed through Cursor's servers» [9] | — | — | su panel de uso | nada → **«no se puede», dicho en el doctor** |

Hallazgos que cambian recetas:

1. **opencode y Kilo aceptan la configuración entera por variable**, fusionada por encima de la global y de la de
   proyecto. En opencode, `OPENCODE_CONFIG_CONTENT` se carga después de `opencode.json` global, del de proyecto y de
   `.opencode/`; solo la configuración de cuenta remota y la gestionada por la empresa van detrás (`config.ts`) [3].
   Kilo lo documenta con su precedencia: global, `KILO_CONFIG`, proyecto, `KILO_CONFIG_CONTENT`, gestionada [6]. Eso
   convierte a los dos en envoltorios de cero configuración persistente, como `bvsala claude`.
2. **La forma del URL de Kilo deja de ser inferida.** La guía anterior decía «probar con `/v1` primero (linaje Cline)
   [I]». Kilo 7 es un fork de opencode (`.opencode-version` = v1.18.26) y su protocolo Anthropic fija
   `DEFAULT_BASE_URL = "https://api.anthropic.com/v1"` y `PATH = "/messages"` [6]: **con `/v1`** [V].
3. **Copilot CLI tiene BYOK por variables y no exige cuenta de GitHub** [7]. Tres tipos: `openai` (por defecto, «any
   other OpenAI Chat Completions API‑compatible endpoint»), `azure` y `anthropic`. Ejemplos oficiales: Anthropic
   `https://api.anthropic.com` (sin `/v1`), OpenAI `https://api.openai.com/v1` [7]. **Pero** su changelog dice que
   desde la 1.0.64 el BYOK de OpenAI también habla la Responses API **por WebSocket** [17]. El gateway responde 426 a
   todo WebSocket (así cae Codex a HTTP); si la CLI de Copilot cae igual no se puede saber sin probarlo, porque su
   repositorio no publica el código. Por eso el envoltorio solo acepta el tipo `anthropic`, y el `openai` queda como
   receta manual marcada «sin validar».
4. **Aider habla por litellm, y litellm manda.** Para Anthropic, `ANTHROPIC_API_BASE` antes que `ANTHROPIC_BASE_URL`,
   y añade `/v1/messages` si la URL no termina así; para OpenAI, `OPENAI_BASE_URL` antes que `OPENAI_API_BASE`. Leído
   en litellm 1.82.3, la versión que fija `main` de aider [5]. Aider elige Sonnet por defecto si hay
   `ANTHROPIC_API_KEY` [5].
5. **La trampa del usage en stream (medida en código, no supuesta).** `get_stream_options` de litellm:
   «by default litellm will include usage for openai endpoints», **solo** si `api_base` es `None` o su host es
   `api.openai.com` [5]. Detrás del gateway el host es `127.0.0.1`: los streams de OpenAI de Aider llegan sin
   `include_usage`, el proveedor no manda contador y el gateway los reenvía sin medir. Solución sin tocar el cliente:
   `BVSALA_GATEWAY_USAGE_INJECT=1` (opt‑in, ya existía) o `--no-stream`.
6. **Continue normaliza la barra final** (`if (!apiBase.endsWith("/")) apiBase += "/"`) y resuelve
   `new URL("messages", apiBase)` sobre un valor por defecto `https://api.anthropic.com/v1/` [12]: **con `/v1`**.
7. **VS Code usa tal cual una `url` que ya lleva `/messages`**, `/chat/completions` o `/responses`; si no, añade la
   ruta y, si falta, `/v1` [8]. La receta da la ruta completa para no depender de esa regla. Su BYOK cubre el chat y
   las tareas auxiliares; las sugerencias en línea y los embeddings siguen en GitHub [8].
8. **Gemini CLI sí acepta proxy** (`GOOGLE_GEMINI_BASE_URL`; con esa variable el tipo de auth pasa a `GATEWAY`) [10],
   pero el gateway solo lee el contador de Anthropic Messages y de OpenAI Chat Completions y Responses.
9. **Codex sigue sin variable de entorno** para el base URL: `openai_base_url` solo llega por configuración
   (`built_in_model_providers(openai_base_url)`) [4]. El envoltorio con `-c` sigue siendo el camino.
10. **Un error del doctor, encontrado de paso:** la sección de Codex terminaba con la comprobación de
    `POST /v1/messages`, una ruta que Codex nunca pide (habla Responses). Corregido.

## 4. Qué miden ellos, qué mide un tercero gratis y qué añade el gateway

| Quién | Qué da | De dónde sale el número | Límites |
|---|---|---|---|
| Claude Code `/usage` [1] | coste de la sesión, caché del hilo principal con causa del fallo, atribución a skills/MCP en planes | tokens de la API × precio de lista, en local; `modelPricing` para tarifas pactadas | «The figure is an estimate»; la línea de caché «covers the main conversation only, not subagents» |
| Copilot CLI `/usage` [7] | créditos de GitHub y tokens por modelo | su propio contador | solo esta máquina y sesión |
| Gemini CLI `/stats` [10] | tokens por modelo y cuota | su propio contador | sin dinero |
| Aider [5] | tokens y coste por mensaje | `usage` de litellm; sin él, tokenizador local | la parte sin `usage` es estimación |
| ccusage [11] (MIT, 18.763★) | informes diarios/mensuales de 18 agentes | registros locales de cada agente × precios de LiteLLM | depende del formato de registro de cada agente; no ve lo que el agente no guarda |
| **Gateway `bvsala`** | contador del proveedor en cada petición que pasa, de cualquier agente y proceso (subagentes y tareas de fondo incluidos); aviso de tráfico degradado; panel del equipo por asiento y sesión; palanca de TTL con PRO | el `usage` de la respuesta, leído en el cable, × catálogo con fechas de vigencia | solo tres dialectos; solo lo que el agente manda por el base URL; nada de Cursor ni de los modelos alojados por GitHub o Kilo |

**Lectura honesta [I].** Para un desarrollador solo, `/usage` y ccusage ya responden «¿cuánto gasto?» sin coste. El
gateway compite ahí con herramientas gratuitas, como ya concluía el informe de competencia (§6.3: «la medición debe ser
gratuita») [14]. Lo que añade y ellos no: (a) **el mismo contador en todos los agentes**, sin depender del formato de
registro de cada uno; (b) **lo que no se midió, dicho** (hoy, también al salir de cada envoltorio); (c) el aviso de
tráfico degradado (caché ignorada, TTL recortado, búsqueda de herramientas apagada), que en Claude Code cubre también a
los subagentes, donde su propia línea de caché no llega [1]; (d) el panel del equipo. Ninguna de esas cuatro cosas baja
la factura por sí sola. La única palanca con dinero medido sigue siendo la de TTL, y solo en Anthropic.

## 5. Opciones

| Opción | Qué es | Coste | Veredicto |
|---|---|---|---|
| A. Solo recetas nuevas en el doctor | Aider, Copilot, Continue, Gemini, Cursor | horas | Insuficiente: opencode (210k★) seguiría pidiendo editar un fichero, y la trampa de §3.5 seguiría muda |
| **B. Envoltorios por variable + recetas + recuento de lo medido** | `bvsala opencode|kilo|copilot|aider`, recetas nuevas, y una línea al salir con lo medido y lo no medido | un día | **Elegida** |
| C. Dialecto de Gemini en el gateway | observador de `usageMetadata`, modelo sacado de la ruta, precio por tramos | días | Aplazada (§7): el catálogo solo guarda el tramo ≤200k, y en los Pro el tramo >200k cuesta el doble de entrada (3.1 Pro Preview: $4/$18/$0,40 frente a $2/$12/$0,20 por millón) [15]. Medir con el tramo bajo prompts de agente de 1M sería tarifar de menos: un precio presente y equivocado es peor que ninguno |
| D. `bvsala doctor --write` | escribir la config de usuario con copia `.bak` | días | Aplazada: con la vía por variable, los dos agentes que más la necesitaban (opencode, Kilo) ya no la necesitan |
| E. Gateway expuesto para Cursor | escuchar fuera de loopback | — | Descartada: expone el proxy y la clave del proveedor a Internet, y los prompts pasarían por un tercero (Cursor) igualmente |
| F. Encender la inyección de `include_usage` por defecto en Aider/Copilot | medir sus streams de OpenAI sin pedírselo al usuario | minutos | Descartada hoy: cambia la forma del último chunk (`choices: []`). Opt‑in, como ya era; el resumen de salida dice cuándo hace falta |

## 6. Decisión y porqué

**B.** Es lo que la evidencia sostiene sin prometer nada:

- **Más agentes medibles sin configuración persistente.** opencode es el agente de código abierto con más tracción
  (210.377★ a hoy), y ahora se mide con un comando, igual que Claude Code.
- **Negarse bien vale tanto como aceptar.** Copilot sin BYOK, Azure, un Ollama local, Gemini CLI y Cursor no se pueden
  medir a precio de lista, y el tipo `openai` de Copilot puede no sobrevivir al 426: el envoltorio se niega antes de pedir la licencia y el doctor lo dice, en vez de arrancar un
  proxy que no mide nada.
- **El recuento cierra la trampa de §3.5 para cualquier agente**, presente o futuro: si un cliente deja de pedir el
  contador, la sesión termina diciendo cuántas peticiones se quedaron fuera y por qué. No estima nada en su lugar.
- **Nada puede cobrar de más.** Los envoltorios solo cambian a dónde apunta el cliente; el recuento es local (no viaja:
  LICENSE §5 no tiene campo para él); la inyección sigue siendo opt‑in.

## 7. Qué se construye hoy y qué queda

**Hoy (este PR):**

- `gateway/envoltorios.ts`: envoltorios `opencode`, `kilo`, `copilot` y `aider`, más `impedimentoDeEnvoltorio`, que
  se niega antes de la licencia y de la red (Copilot sin BYOK, con un tipo que no sea `anthropic` o contra un origen
  no oficial; una config inline ilegible de opencode o Kilo, sin repetir su valor). La config inline del usuario se **fusiona**: solo cambia
  `provider.anthropic.options.baseURL`.
- `gateway/recuento.ts` y `gateway/servidor.ts`: el recuento de lo medido y de lo reenviado sin medir, por motivo.
  Solo cuenta rutas de la API (con dialecto o bajo `/v1/`): la telemetría y las sondas de un agente no son «no
  medido», y un error del proveedor tampoco. Un stream que el cliente corta antes del usage final sí cuenta: el
  proveedor puede facturar lo generado y aquí no queda contador.
- `gateway/bin.ts`: los cuatro comandos en la ayuda; la negativa previa; la línea de recuento al salir de cada
  envoltorio y al parar `bvsala gateway`, por stderr y una sola vez.
- `gateway/doctor.ts`: recetas de Kilo (ahora detectable y [V]), Copilot CLI, Aider, Continue y Copilot en VS Code;
  Gemini CLI y Cursor como «no medido» / «no soportado», sin línea de comprobación; Codex comprobado contra
  `/responses`.
- Docs: `docs/terminales/` (índice, `opencode.md`, `kilo.md`, y nuevas `copilot.md`, `aider.md`, `continue.md`,
  `no-soportados.md`) y el párrafo del README.
- Tests: `test/gateway-envoltorios.test.ts`, `test/gateway-doctor.test.ts` y el nuevo `test/gateway-recuento.test.ts`
  (contra un upstream falso en 127.0.0.1).

**Queda:**

1. **Validación en mano** de los cuatro envoltorios con una clave real (pasos del dueño, §8). Hasta entonces, las
   formas están [V] en código o documentación oficial, no en una sesión real.
2. **Dialecto de Gemini** (opción C), después de dar al catálogo los tramos de contexto largo.
3. **Copilot CLI tipo `openai`:** probar en una sesión real si cae a HTTP tras el 426 y si pide `include_usage`.
   Si cae y se mide, abrir el envoltorio a ese tipo (con la inyección armada si no pide el contador).
4. **La web** (10 idiomas) sigue nombrando los cuatro envoltorios de antes. Correcto hasta que salga una versión en npm
   con los nuevos; entonces hay que actualizarla.
5. **Saber qué agente usa cada cliente** exigiría un campo nuevo en el registro de uso (LICENSE §5): decisión del dueño.

## 8. Riesgos

| Riesgo | Señal | Mitigación |
|---|---|---|
| opencode o Kilo cambian la precedencia o el nombre de su variable | el resumen de salida dice «no inference request went through the gateway» | el resumen lo hace visible en la primera sesión; la receta por fichero sigue en el doctor |
| La config inline del usuario lleva un `baseURL` a un proxy corporativo y el envoltorio lo sustituye | el tráfico sale por el gateway hacia `api.anthropic.com` | documentado en la guía; como `bvsala claude` con `ANTHROPIC_BASE_URL`, el envoltorio manda |
| Copilot CLI cambia su transporte también con el tipo `anthropic` | el resumen de salida con peticiones no medidas, o la sesión que falla | el resumen lo hace visible; la guía da la vuelta a la URL directa |
| Aider sin releases desde agosto de 2025 | versiones instaladas con otro litellm | la lógica de `ANTHROPIC_API_BASE` + sufijo `/v1/messages` está igual en litellm 1.82.3 y en `main` [5] |
| Windows: opencode, Kilo y Copilot por npm dejan un shim `.cmd` | `bvsala` se niega con la guía de siempre | binario nativo; **[I: no validado en Windows]** |

## 9. Cómo se medirá el efecto

- **En cada sesión, para el usuario:** la línea de salida. Éxito = `N request(s) metered` con N > 0 y ninguna línea
  «NOT metered». Es un contador, no una estimación.
- **Validación del dueño:** una sesión corta con cada envoltorio (§ pasos) y su registro en el panel (`surface:
  gateway`, `basis: measured`).
- **Para el negocio:** hoy no se puede atribuir un registro a un agente (§7, punto 5). Hasta que exista ese campo, la
  medida es cualitativa: probadores que usan opencode, Kilo, Copilot o Aider y ven su gasto en el panel.
- **Lo que no se medirá aquí:** ahorro. Estos envoltorios miden; no añaden ninguna palanca.

## 10. Fuentes (consultadas el 2026-09-27 salvo que se indique)

1. Claude Code, «Manage costs effectively»: https://code.claude.com/docs/en/costs — `/usage` a precio de lista, «The figure is an estimate», línea «Prompt cache (main)» solo del hilo principal.
2. Claude Code, «Other LLM gateways» y «Gateway compatibility guide»: https://code.claude.com/docs/en/llm-gateway · https://code.claude.com/docs/en/llm-gateway-protocol
3. opencode (`anomalyco/opencode`, v1.18.32 del 2026-09-21): `packages/opencode/src/config/config.ts` (carga de `OPENCODE_CONFIG_CONTENT`), `packages/llm/src/protocols/anthropic-messages.ts` (`DEFAULT_BASE_URL`, `PATH`), `packages/web/src/content/docs/cli.mdx` y `providers.mdx`.
4. Codex (`openai/codex`, rust-v0.159.0-alpha.9 del 2026-09-27): `codex-rs/core/src/config/mod.rs`, `codex-rs/model-provider-info/src/lib.rs`.
5. Aider (`Aider-AI/aider`, `main` a 2026-05-22; releases en https://github.com/Aider-AI/aider/releases, última v0.86.0 del 2025-08-09): `requirements.txt` (litellm==1.82.3), `aider/main.py`, `aider/onboarding.py`, `aider/models.py`, `aider/coders/base_coder.py`; https://aider.chat/docs/config/options.html. litellm (`BerriAI/litellm` v1.82.3 y `main`): `litellm/main.py`, `litellm/llms/anthropic/common_utils.py`, `litellm/llms/openai/openai.py` (`get_stream_options`).
6. Kilo Code (`Kilo-Org/kilocode`, v7.8.1 del 2026-09-25): `packages/opencode/src/kilocode/skills/kilo-config.md`, `packages/core/src/flag/flag.ts`, `packages/llm/src/protocols/anthropic-messages.ts`, `packages/opencode/package.json`, `.opencode-version`, `packages/kilo-docs/pages/ai-providers/anthropic.md`.
7. GitHub Docs, «Using your own LLM models in GitHub Copilot CLI» y «Authenticating GitHub Copilot CLI» (fuente en `github/docs`: `content/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models.md`, `…/set-up-copilot-cli/authenticate-copilot-cli.md`); https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli (`/usage`). Copilot CLI v1.0.89 (`github/copilot-cli`, 2026-09-27).
8. VS Code, «AI language models in VS Code» (fechada el 16-09-2026): https://code.visualstudio.com/docs/copilot/customization/language-models
9. Cursor, «API Keys»: https://cursor.com/docs/settings/api-keys — «all requests are routed through Cursor's servers for final prompt building»; «Custom API keys only work with chat models».
10. Gemini CLI (`google-gemini/gemini-cli`, v0.63.0-nightly del 2026-09-26): `docs/reference/configuration.md` (`GOOGLE_GEMINI_BASE_URL`), `packages/core/src/core/contentGenerator.ts` (`AuthType.GATEWAY`), `docs/reference/commands.md` (`/stats`).
11. ccusage (`ccusage/ccusage`, 18.763★): README — 18 fuentes (Claude Code, Codex, OpenCode, Amp, Droid, Goose, Kilo, Qwen, GitHub Copilot CLI, Gemini CLI…), precios de LiteLLM, modo `--offline`.
12. Continue (`continuedev/continue`, v2.1.0-vscode del 2026-06-19): `core/llm/llms/Anthropic.ts`, `core/llm/index.ts` (barra final), `core/llm/llms/OpenAI.ts`, `docs/cli/configuration.mdx`, `docs/guides/cli.mdx`.
13. Cline (`cline/cline`, v4.1.21 del 2026-09-24): `sdk/packages/llms/src/providers/builtins.ts`.
14. `docs/COMPETENCIA-2026-09-26.md` (este repositorio): §6.3 (medición gratuita), §4.1, §2.7 (ccusage y CodeBurn).
15. Google, «Gemini Developer API pricing»: https://ai.google.dev/gemini-api/docs/pricing — tramos ≤200k y >200k de Gemini 3.1 Pro Preview.
16. Tracción en GitHub (API, 2026-09-27): opencode 210.377★ · Codex 126.741★ · Gemini CLI 107.166★ · Cline 69.441★ · Goose 54.706★ · Aider 49.217★ · Continue 36.044★ · Crush 28.325★ · Qwen Code 28.156★ · Kilo 27.425★ · Copilot CLI 11.215★.
17. Copilot CLI, `changelog.md` de `github/copilot-cli` (1.0.64, 2026-06-23: «Add websocket responses support for BYOK OpenAI-compatible providers»; el repositorio publica binarios, instalador y changelog, no el código).

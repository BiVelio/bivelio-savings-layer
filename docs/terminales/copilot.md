# GitHub Copilot (CLI y VS Code) a través del gateway — solo con tu propia clave

**Fuente:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`: la doc oficial
de GitHub «Using your own LLM models in GitHub Copilot CLI» (fuente en
`github/docs`, consultada el 2026-09-27) y la de VS Code «AI language models in
VS Code» (fechada el 16-09-2026).

**Lo primero:** Copilot solo pasa por un base URL cuando usas **tu propia clave
de proveedor (BYOK)**. Los modelos alojados por GitHub van a GitHub y no se
pueden medir aquí; su gasto lo enseña `/usage` (créditos de IA de GitHub y
tokens por modelo). Con BYOK, la CLI funciona **sin cuenta de GitHub** [V].

## Copilot CLI

### Qué necesitas

- `copilot` en el PATH (en Windows, el instalador nativo: el shim `.cmd` de npm no
  se puede lanzar con argumentos de forma segura y `bvsala` se niega con una guía).
- BYOK configurado y funcionando **directo** [V]:

  ```bash
  export COPILOT_PROVIDER_TYPE=anthropic
  export COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com
  export COPILOT_PROVIDER_API_KEY=…          # tu clave de Anthropic
  export COPILOT_MODEL=<modelo de Claude>
  ```

  (Con OpenAI, el tipo por defecto, el base URL es `https://api.openai.com/v1`: ver «El tipo `openai`» abajo.)
- `bvsala` instalado, `BIVELIO_SERVICE_KEY` exportada y una licencia BiVelio activa (ver [README](README.md)).

### Envoltorio: `bvsala copilot [args…]`

```bash
bvsala copilot
```

Con `COPILOT_PROVIDER_TYPE=anthropic`, arranca el gateway contra
`api.anthropic.com` y lanza `copilot` con `COPILOT_PROVIDER_BASE_URL` apuntando
al gateway, **con la misma ruta que ya tenías**. Tu modelo y tu clave no se
tocan. Al salir imprime cuántas peticiones midió y cuáles reenvió sin medir, y
por qué.

Se niega, antes de arrancar nada y con el motivo, cuando:

- no hay `COPILOT_PROVIDER_BASE_URL` (estás en los modelos de GitHub: nada que medir);
- el tipo es `openai` (el de por defecto): todavía no, ver abajo;
- el tipo es `azure` u otro, o el base URL no es `https://api.anthropic.com`: el
  gateway solo tarifa la API del propio proveedor a su precio de lista, y Azure,
  un modelo local o un revendedor facturan distinto (o nada).

### Manual (tipo `anthropic`)

```bash
bvsala gateway                                                   # Anthropic, 8402
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:8402 copilot          # SIN /v1
```

Cada `POST /v1/messages` se mide con su contador (Messages siempre lo trae).

### El tipo `openai`: sin envoltorio hasta validarlo en mano

La doc oficial lo describe como «any other OpenAI Chat Completions API‑compatible
endpoint» [V], pero el changelog de la CLI dice que desde la 1.0.64 también
habla la **Responses API por WebSocket** con BYOK («Add websocket responses
support for BYOK OpenAI-compatible providers») [V]. El gateway responde **426**
a todo intento de WebSocket (así cae Codex a HTTP), y **no sabemos** si la CLI
de Copilot hace lo mismo: la CLI no es de código abierto. Un envoltorio que
puede romper la sesión no se publica sin probarlo. A mano, y mirando el log:

```bash
bvsala gateway --upstream openai --port 8403
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:8403/v1 copilot       # CON /v1
```

- `… → 426 (WebSocket not supported …)` seguido de líneas `POST /v1/responses`
  o `POST /v1/chat/completions` con `$` → la CLI cayó a HTTP y se mide.
- Solo el 426 y la sesión falla → no funciona detrás del gateway; vuelve a la
  URL directa.
- `not metered: the request did not ask for usage` → relanza el gateway con
  `BVSALA_GATEWAY_USAGE_INJECT=1`.

### Lo que no pasa por aquí

Lo que va a GitHub con BYOK igualmente (`/delegate`, búsqueda de código,
telemetría sin `COPILOT_OFFLINE=true`) no es inferencia de tu proveedor [V].

## Copilot en VS Code (BYOK, «Custom Endpoint»)

No se detecta ni se envuelve (es una extensión): la receta la imprime `bvsala doctor`.

1. **Manage Language Models** → **Add Models** → **Custom Endpoint**.
2. Tipo de API: **Messages** (Anthropic). VS Code abre `chatLanguageModels.json`.
3. En el modelo, la **ruta completa** en `url`:

   ```json
   "url": "http://127.0.0.1:8402/v1/messages"
   ```

   VS Code usa tal cual una URL que ya lleva `/messages`, `/chat/completions` o
   `/responses`; si no, añade la ruta y, si falta, `/v1` [V]. Con la ruta
   completa no hay nada que adivinar.
4. `bvsala gateway` corriendo aparte.

El BYOK de VS Code cubre el chat y las tareas auxiliares (títulos, mensajes de
commit) [V]; las sugerencias en línea y los embeddings siguen en GitHub y no se
miden aquí. Las tareas auxiliares usan `chat.utilityModel` y
`chat.utilitySmallModel`, no el modelo del chat: si quieres medirlas, apúntalas
también a un modelo del Custom Endpoint.

## Nota BYOK

Tu clave, tu factura: es exactamente el caso que el gateway mide. Nunca enrutes
por aquí el OAuth de una suscripción Claude Pro/Max: Anthropic lo prohíbe en
harnesses de terceros.

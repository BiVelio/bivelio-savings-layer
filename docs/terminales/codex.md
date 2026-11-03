# Codex CLI a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §2 (código de `openai/codex`,
`openai-node` y docs de OpenAI, 2026-08-30). **Estado: envoltorio en el
paquete y validado en mano el 30-08** (sesión real de Codex v0.134 con auth
ChatGPT: 426 → fallback HTTP, stream íntegro, registro `measured` en la
ingesta). Lee «Qué mide» y las validaciones pendientes antes de anunciar
cifras.

## Qué necesitas

- `codex` en el PATH.
- Login en Codex: **API key de OpenAI** (el caso que se monetiza) o
  suscripción ChatGPT (se enruta y se mide a precio de lista equivalente, **sin
  comisión**: no hay factura por tokens; la licencia por asiento hace falta
  igual; ver más abajo).
- `bvsala` instalado. Open core: sin claves el gateway arranca en modo Community (todo el ahorro local, cero telemetría); `BIVELIO_SERVICE_KEY` añade el panel y los entitlements de la org (ver [README](README.md)).

## Envoltorio: `bvsala codex [args…]`

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPCIONAL: panel + entitlements de org (sin ella: modo Community)
bvsala codex                       # cualquier argumento pasa tal cual a codex
```

Espejo de `bvsala claude`: gateway efímero con el upstream que toque +
`spawn("codex", ["-c", 'openai_base_url="http://127.0.0.1:<puerto><prefijo>"', ...resto])`
(cadena TOML entrecomillada: «values are parsed as TOML», doc oficial). Por qué
así y no por variable de entorno:

- `-c` es flag global de **máxima precedencia** [V]; **no existe** una env
  `OPENAI_BASE_URL` en Codex (cero referencias en su código de config) [V].
- Sin escribir config, el ajuste muere con el proceso: nada queda apuntando a un
  gateway que ya no corre.
- **El prefijo depende del modo de auth** [V `AuthDotJson`, `to_api_provider`]:
  `ApiKey` → upstream `https://api.openai.com`, prefijo `/v1`; toda la familia
  ChatGPT → upstream `https://chatgpt.com`, prefijo `/backend-api/codex`. El
  envoltorio lee `auth_mode` de `~/.codex/auth.json` **por existencia/valor del
  enum, jamás imprime tokens**; `BVSALA_CODEX_AUTH=api-key|chatgpt` lo fuerza.

## Manual (API key): `-c openai_base_url=…`

```bash
BVSALA_GATEWAY_UPSTREAM=https://api.openai.com bvsala gateway     # ventana 1: http://127.0.0.1:8402
codex -c openai_base_url=http://127.0.0.1:8402/v1                 # ventana 2 — CON /v1, sin barra final
```

Codex añade `/responses` (`POST {base_url}/responses`, siempre `stream: true`)
[V]. Si en el 8402 ya tienes el gateway de Anthropic para otros terminales,
arranca este en otro puerto (`--port 8403`) y apunta ahí: un gateway habla con
un solo upstream.

No lo escribas en `~/.codex/config.toml`: ahí se quedaría fijo y Codex fallaría
cada vez que el gateway no esté corriendo. El `-c` por sesión es la forma.

## Comprobar que funciona

En el log del gateway verás, en este orden, la sesión real (30-08):

```
[gateway] GET /backend-api/codex/models → 200
[gateway] GET /backend-api/codex/responses → 426 (WebSocket no soportado; el cliente cae a HTTP)
[gateway] POST /backend-api/codex/responses → el cliente cerró tras el usage; se mide igual
[gateway] POST /backend-api/codex/responses  · gpt-5.5 · $0.210766 (in 41880, cache↑0 cache↓2432, out 5)
```

(Con API key la ruta es `/v1/responses`.) La línea con `$` es la medición.

**Qué mide:** el `usage` de `event: response.completed` con la fórmula oficial
de OpenAI (`entrada = input − cached − writes`; `cached` a la tarifa cacheada
del catálogo; `writes` a 1,25×, la prima oficial de gpt-5.6+) [V]. Tres cosas
que el tráfico real enseñó y el gateway ya contempla:

- Codex **cierra la conexión nada más recibir `response.completed`**; el
  gateway mide igual con el usage ya observado («se mide igual» en el log).
- El backend de ChatGPT sirve el SSE **sin cabecera `content-type`**; en las
  rutas `…/responses` el gateway asume SSE si falta.
- Codex manda el cuerpo de la petición **comprimido con zstd**; el gateway lo
  reenvía intacto y lee el `model` a través del `content-encoding` (Node ≥ 22.15
  para zstd; en un Node sin zstd la petición pasa y no se mide).

## La trampa típica

1. **El prefijo.** Con API key es `/v1` **exacto**. Con la familia ChatGPT el
   base_url tiene que terminar **exactamente** en `/backend-api/codex` o
   `supports_codex_backend_routes()` se apaga [V]. Mezclarlos = 404 silencioso.
2. **Una línea `failed to connect to websocket: HTTP error: 426`** al arrancar
   es normal: Codex intenta WebSocket primero (`supports_websockets: true` está
   hardcodeado y no se apaga por config [V]); el gateway responde `426 Upgrade
   Required` y el fallback a HTTP es inmediato y pegajoso por sesión [V test
   `websocket_fallback.rs`]. Sin «Reconnecting…».
3. **`failed to refresh available models: unknown variant …`** es de tu versión
   de Codex frente a su backend: aparece igual **sin** gateway (comprobado).
4. **Barra final.** `…/v1/` no.

## Modo suscripción ChatGPT — validado, medido, sin comisión

Validado en mano el 30-08 (prefijo `/backend-api/codex`, upstream
`https://chatgpt.com`): 200, stream íntegro, `usage` presente en
`response.completed` y registro `measured` en la ingesta. **Pero un suscriptor
no paga por tokens**: la cifra que ve es el equivalente a precio de lista por
API key, no una factura; y como la comisión de BV-SALA solo toca ahorro medido
sobre gasto real, este tráfico **no genera comisión** — igual que el OAuth de
suscripción en Claude Code (`docs/PASARELA-F0.md`: «el caso que NO
facturamos»). OpenAI ni bendice ni prohíbe el proxy de suscripción (silencio
del staff, a diferencia de Anthropic, que lo documenta). Postura idéntica a
Claude Code: cero persistencia de `Authorization` / `ChatGPT-Account-ID`,
binario sin modificar, y no se promociona como modo de ahorro.

**Comisión 0 por diseño:**
el gateway clasifica como suscripción el tráfico de `/backend-api/…` o con
upstream chatgpt.com (y el de Claude Code con `anthropic-beta: oauth-*`) y no le
acredita ahorro: `baseline == actual`. Laguna que queda: el registro no lleva
etiqueta propia en el wire, así que el panel no distingue suscripción de API key
(exige migración; fuera de este frente).

## Validaciones en mano

- ✅ (b) Suscripción ChatGPT: 426 → fallback, 200, stream íntegro, `usage`
  presente, registro `measured` (30-08).
- ⏳ (a) Sesión con **API key** (ruta `/v1/responses` contra api.openai.com):
  misma mecánica, pendiente de una cuenta con API key.
- ⏳ (c) Plausibilidad `cached + writes ≤ input` en un prompt repetido > 1.024
  tokens (OpenAI reconoció contadores mal en el arranque de 5.6). El gateway
  ya recorta al lado que infra-mide si no cuadra.
- ⏳ Contrastar la cifra del gateway con la consola del proveedor en una sesión
  larga (Codex imprime su propio «tokens used»; la fuente de BV-SALA es el
  `usage` del proveedor, no ese contador).

## Nota BYOK

La receta documentada es **API key exclusivamente**. El gateway no persiste
ninguna credencial; lo que factura BV-SALA es el uso por API key.

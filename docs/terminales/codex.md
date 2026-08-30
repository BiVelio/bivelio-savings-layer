# Codex CLI a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §2 (código de `openai/codex`,
`openai-node` y docs de OpenAI, 2026-08-30). **Estado: en construcción hoy.**
Esta guía describe el uso previsto del envoltorio y la receta manual que ya
enruta; lee «Qué mide hoy» antes de esperar cifras.

## Qué necesitas

- `codex` en el PATH.
- **Login por API key de OpenAI** en Codex. El modo suscripción ChatGPT está
  **pendiente de validar en mano y no anunciado** (más abajo).
- `bvsala` instalado y `BIVELIO_SERVICE_KEY` exportada (ver [README](README.md)).

## Envoltorio: `bvsala codex [args…]` (uso previsto — pieza P4 de S3)

```bash
export BIVELIO_SERVICE_KEY=bvk_…
bvsala codex                       # cualquier argumento pasa tal cual a codex
```

Lo que hará, espejo de `bvsala claude`: gateway efímero contra
`https://api.openai.com` + `spawn("codex", ["-c", "openai_base_url=http://127.0.0.1:<puerto>/v1", ...resto])`.
Por qué así y no por variable de entorno:

- `-c` es flag global de **máxima precedencia** [V]; **no existe** una env
  `OPENAI_BASE_URL` en Codex (cero referencias en su código de config) [V].
- Sin escribir config, el ajuste muere con el proceso: nada queda apuntando a un
  gateway que ya no corre.
- **El prefijo depende del modo de auth** [V `AuthDotJson`, `to_api_provider`]:
  `ApiKey` → upstream `https://api.openai.com`, prefijo `/v1`; toda la familia
  ChatGPT → upstream `https://chatgpt.com`, prefijo `/backend-api/codex`. El
  envoltorio lee `auth_mode` de `~/.codex/auth.json` **por existencia/valor del
  enum, jamás imprime tokens**.

## Manual (API key): `-c openai_base_url=…`

```bash
BVSALA_GATEWAY_UPSTREAM=https://api.openai.com bvsala gateway     # ventana 1: http://127.0.0.1:8402
codex -c openai_base_url=http://127.0.0.1:8402/v1                 # ventana 2 — CON /v1, sin barra final
```

Codex añade `/responses` (`POST {base_url}/responses`, siempre `stream: true`)
[V]. Si en el 8402 ya tienes el gateway de Anthropic para otros terminales,
arranca este en otro puerto (`--puerto 8403`) y apunta ahí: un gateway habla con
un solo upstream.

No lo escribas en `~/.codex/config.toml`: ahí se quedaría fijo y Codex fallaría
cada vez que el gateway no esté corriendo. El `-c` por sesión es la forma.

## Comprobar que funciona

En el log del gateway, la ruta que verás es la de Responses:

```
[gateway] POST /v1/responses → 200
```

**Qué mide hoy:** el medidor actual solo entiende el stream de `/v1/messages`
(dialecto Anthropic). Para Codex faltan tres piezas de S3 §2 — el
`ObservadorResponses` (P1: lee `usage` en `event: response.completed`), el
dialecto por ruta (P2: `…/responses` → ese observador) y la respuesta `426` al
handshake WebSocket (P3). Hasta que entren, verás la línea `→ 200` **sin `$`**:
el tráfico pasa, no se mide. El catálogo gpt-5.x y la verja del ingest (`gpt-*`)
ya están listos [V], y la fórmula de coste es la oficial de OpenAI:
`ordinaryInputTokens = inputTokens − cachedTokens − cacheWriteTokens` [V].

## La trampa típica

1. **El prefijo.** Con API key es `/v1` **exacto**. Con la familia ChatGPT el
   base_url tiene que terminar **exactamente** en `/backend-api/codex` o
   `supports_codex_backend_routes()` se apaga [V]. Mezclarlos = 404 silencioso.
2. **«Reconnecting…» al arrancar.** Codex intenta WebSocket primero
   (`supports_websockets: true` está hardcodeado en el provider integrado y no
   se apaga por config [V]). Hoy el gateway responde a ese GET con `Upgrade` un
   **502**, que Codex trata como error genérico: quema `stream_max_retries`
   intentos visibles antes de caer a HTTP. Con el `426 Upgrade Required` de P3
   el fallback será inmediato, silencioso y pegajoso por sesión [V test
   `websocket_fallback.rs`]. Mientras tanto: es ruido, no fallo; espera al
   fallback.
3. **Barra final.** `…/v1/` no.

## Modo suscripción ChatGPT — pendiente de validar en mano, no anunciado

El enrutado técnico existe (prefijo `/backend-api/codex`, upstream
`https://chatgpt.com`), pero **no está validado**: hace falta comprobar 200,
stream íntegro y `usage` presente en `response.completed` (existe el error
`usage_not_included` → registro no producido, tolerado por doctrina). OpenAI ni
bendice ni prohíbe el proxy de suscripción (silencio del staff, a diferencia de
Anthropic, que lo documenta). Postura idéntica a Claude Code: cero persistencia
de `Authorization` / `ChatGPT-Account-ID`, binario sin modificar, y **no se
promociona hasta validarlo**.

## Validaciones en mano pendientes (antes de anunciar)

- (a) Sesión `bvsala codex` real con API key: 1 GET de prewarm con 426 y después
  solo POSTs SSE, sin «Reconnecting…».
- (b) Modo suscripción ChatGPT con prefijo `/backend-api/codex`: 200, stream
  íntegro, `usage` presente.
- (c) Plausibilidad `cached + writes ≤ input` en un prompt repetido > 1.024
  tokens (OpenAI reconoció contadores mal en el arranque de 5.6).

## Nota BYOK

La receta documentada es **API key exclusivamente**. El gateway no persiste
ninguna credencial; lo que factura BV-SALA es el uso por API key.

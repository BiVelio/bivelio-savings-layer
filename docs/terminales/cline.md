# Cline a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Cline configura el
proveedor por **UI** (extensión de VS Code), así que aquí no hay archivo ni
envoltorio: solo pasos y la forma exacta del URL, que es **con `/v1`**.

Por qué con `/v1` (refutación verificada): Cline `main` ya usa
`@ai-sdk/anthropic`, no el SDK TS oficial; su `normalizeBaseURL` solo añade
`/v1` cuando el URL es exactamente `https://api.anthropic.com`, y `builtins.ts`
fija `https://api.anthropic.com/v1` [V]. Con un URL custom, lo que pongas es lo
que se usa.

## Qué necesitas

- Cline instalado en VS Code.
- Tu **API key** de Anthropic.
- `bvsala gateway` corriendo en `http://127.0.0.1:8402` (ver [README](README.md)).

## Pasos en la UI

1. Abre los ajustes de Cline → **API Provider**: elige **Anthropic**.
2. Pega tu **Anthropic API Key**.
3. Marca **«Use custom base URL»** y escribe exactamente:

   ```
   http://127.0.0.1:8402/v1
   ```

   **Con `/v1`, sin barra final.**
4. Elige el modelo y guarda.

## Comprobar que funciona

Manda un mensaje trivial desde Cline y mira la ventana del gateway:

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## La trampa típica

- **Sin `/v1`** → Cline pide `…/messages` → `[gateway] POST /messages → 404` y
  la UI muestra un error genérico de API. Añade el `/v1`.
- **Barra final** → no.
- **Gateway apagado**: la UI recuerda el base URL custom; cuando no tengas
  `bvsala gateway` corriendo, Cline fallará hasta que lo arranques o desmarques
  la casilla.

## Nota BYOK

**API key exclusivamente.** Anthropic prohíbe usar el OAuth de Claude Pro/Max en
harnesses de terceros (Cline estuvo en la primera oleada del bloqueo de
ene-2026). Esta receta es la del proveedor Anthropic con API key; nada más.

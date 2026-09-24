# Droid (Factory) a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3. Droid es **cerrado**; el
mecanismo de enrutado está verificado [V] (`~/.factory/settings.json` →
`customModels[]` con `provider: "anthropic"`), pero **la forma del base URL es
inferida [I]: hay que validarla en mano contra el log del gateway.** Esta guía
lo dice tal cual; no hay validación hecha.

## Qué necesitas

- `droid` instalado, en modo BYOK con tu **API key** de Anthropic.
- `bvsala` instalado, `BIVELIO_SERVICE_KEY` exportada y una licencia BiVelio activa (la recoge el gateway con la clave; ver [README](README.md)).

## Config de usuario: `~/.factory/settings.json`

```json
{
  "customModels": [
    {
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:8402",
      "apiKey": "<tu ANTHROPIC_API_KEY>"
    }
  ]
}
```

Las claves verificadas [V] son `customModels[]{provider:"anthropic", baseUrl,
apiKey}`. La forma **sin `/v1`** es inferida [I]. Conserva el resto de tu
`settings.json` (el `doctor --write droid` previsto en S3 hará el merge JSON
conservador con copia `.bak`).

## Validar en mano (obligatorio antes de fiarte)

1. `bvsala gateway` en una ventana.
2. Lanza `droid` con ese modelo custom y haz una pregunta trivial.
3. Mira el log del gateway:
   - `[gateway] POST /v1/messages  · <modelo> · $…` → la forma sin `/v1` es la
     buena. Confírmalo en S3 (pasar el [I] a [V]).
   - `[gateway] POST /messages → 404` → Droid solo añade `/messages`: cambia el
     `baseUrl` a `http://127.0.0.1:8402/v1` y repite.
   - nada en el log → Droid no está leyendo el modelo custom; revisa que sea el
     modelo seleccionado.

## La trampa típica

- **Adivinar el `/v1`**: por eso el paso de validación. Un URL mal formado
  falla en silencio (404 del upstream sin medir).
- **La API key va en el JSON**: es config de usuario en tu máquina; no la
  copies a ningún repo ni la pegues en un ticket.

## Nota BYOK

**API key exclusivamente.** Droid es BYOK; Anthropic prohíbe el OAuth de Claude
Pro/Max en harnesses de terceros, y esta receta no lo contempla.

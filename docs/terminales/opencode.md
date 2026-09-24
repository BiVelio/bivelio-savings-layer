# opencode a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. opencode enruta por
**archivo de configuración**, no por variable de entorno, y su capa
`packages/llm` añade `/messages` al `baseURL`: por eso aquí el URL lleva `/v1`.

## Qué necesitas

- `opencode` instalado, proveedor `anthropic` con tu **API key** de Anthropic.
- `bvsala` instalado, `BIVELIO_SERVICE_KEY` exportada y una licencia BiVelio activa (la recoge el gateway con la clave; ver [README](README.md)).

## Config de usuario: `~/.config/opencode/opencode.json`

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:8402/v1"
      }
    }
  }
}
```

**Con `/v1`, sin barra final.** Es la clave `provider.anthropic.options.baseURL`
[V]. El `opencode.json` de proyecto pisa al global: si tienes uno en el repo,
ahí es donde manda.

No hay envoltorio `bvsala opencode`: el enrutado es config de usuario. El
`bvsala doctor --write opencode` previsto en S3 hará un merge JSON conservador
de este bloque (con copia `.bak`) en tu config de usuario, nunca en archivos
del repo.

### Alternativa [V]: `baseURL` desde variable de entorno

```json
{ "provider": { "anthropic": { "options": { "baseURL": "{env:BVSALA_BASE_URL}" } } } }
```

Escrito una vez, habilita un uso puro-env (`BVSALA_BASE_URL=http://127.0.0.1:8402/v1 opencode`).
**Trampa:** sin la variable, el `baseURL` queda vacío y opencode no funciona.

## Arrancar y comprobar

```bash
bvsala gateway        # http://127.0.0.1:8402
opencode
```

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## La trampa típica

- **Sin `/v1`** → opencode pide `http://127.0.0.1:8402/messages` → `[gateway] POST /messages → 404`.
- **Barra final** (`…/v1/`) → no.
- **Config de proyecto** con otro `baseURL` pisando al global sin que lo sepas.
- **Gateway apagado con la config escrita**: opencode falla hasta que arranques
  `bvsala gateway` de nuevo. La config es persistente; el gateway, no. (La
  variante `{env:…}` sin exportar la variable también falla, por vacío.)

## Nota BYOK

**API key exclusivamente.** opencode documenta expresamente que el OAuth de
Claude Pro/Max no puede usarse en harnesses de terceros; esta receta lo respeta.

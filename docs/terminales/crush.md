# Crush a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Crush (Charm) configura
proveedores por **`~/.config/crush/crushrc`** (un script Bash); `crush.json`
está **deprecado** (verificado 2026-08-30). Su SDK Go resuelve rutas de forma
relativa, y eso dicta la forma del URL: **con `/v1`, sin barra final**.

## Qué necesitas

- `crush` instalado.
- `ANTHROPIC_API_KEY` exportada (Crush retiró su OAuth de Claude en ene-2026:
  solo API key).
- `bvsala` instalado y `BIVELIO_SERVICE_KEY` exportada (ver [README](README.md)).

## Config de usuario: `~/.config/crush/crushrc`

Añade esta línea:

```bash
provider add bvsala --type anthropic --base-url http://127.0.0.1:8402/v1 --api-key "$ANTHROPIC_API_KEY"
```

Y elige el proveedor `bvsala` en Crush. `crush.json` no: deprecado.

No hay envoltorio `bvsala crush`: el enrutado es config de usuario. El
`bvsala doctor --write crush` previsto en S3 hará un append comentado de esa
línea en tu `crushrc` (con copia `.bak`).

## Arrancar y comprobar

```bash
bvsala gateway        # http://127.0.0.1:8402
crush
```

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## La trampa típica

- **Barra final.** `--base-url http://127.0.0.1:8402/v1/` → el SDK Go resuelve
  relativo y pide `/v1/v1/messages` → `[gateway] POST /v1/v1/messages → 404` [V].
  Sin barra.
- **Sin `/v1`** → `[gateway] POST /messages → 404`.
- **`crush.json`** → deprecado; si tienes uno viejo con otro proveedor, puede
  seguir mandando. Usa `crushrc`.

## Nota BYOK

**API key exclusivamente.** Crush ya retiró su OAuth de Claude; el gateway
reenviaría cualquier credencial sin inmutarse, pero la receta es esta.

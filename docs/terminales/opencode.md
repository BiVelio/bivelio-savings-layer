# opencode a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3 [V] y
`docs/investigacion/2026-09-27/agentes-de-codigo.md` (código de
`anomalyco/opencode` v1.18.32, 2026-09-27). opencode enruta por **configuración**,
y su capa de protocolo añade `/messages` a `https://api.anthropic.com/v1` por
defecto: por eso aquí el URL lleva `/v1` [V].

## Qué necesitas

- `opencode` instalado, proveedor `anthropic` con tu **API key** de Anthropic.
- `bvsala` instalado. Open core: sin claves el gateway arranca en modo Community (todo el ahorro local, cero telemetría); `BIVELIO_SERVICE_KEY` añade el panel y los entitlements de la org (ver [README](README.md)).

## Envoltorio: `bvsala opencode [args…]`

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPCIONAL: panel + entitlements de org (sin ella: modo Community)
bvsala opencode
```

opencode acepta la configuración entera en la variable `OPENCODE_CONFIG_CONTENT`
y la fusiona **por encima** de la global y de la de proyecto (`config.ts`: se
carga después de `opencode.json` global, del de proyecto y de `.opencode/`; solo
la config de cuenta remota y la gestionada por la empresa van después) [V]. El
envoltorio arranca un gateway efímero y lanza `opencode` con esa variable
apuntando `provider.anthropic.options.baseURL` a `http://127.0.0.1:<puerto>/v1`.
**No escribe nada en disco** y todo muere al salir.

- Si ya exportas tu propio `OPENCODE_CONFIG_CONTENT`, el envoltorio lo
  **fusiona**: solo cambia `provider.anthropic.options.baseURL`; tu clave, tus
  modelos y lo demás siguen igual. Si no es un objeto JSON (por ejemplo, JSONC
  con comentarios), se niega antes de arrancar y no repite su valor.
- Solo pasa por el gateway el proveedor `anthropic`. Los demás proveedores
  (OpenAI, OpenCode Zen, OpenRouter…) van directos y no se miden.
- Al salir imprime cuántas peticiones midió y cuáles reenvió sin medir, y por qué.

## Manual: `~/.config/opencode/opencode.json`

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
- **Config de proyecto** con otro `baseURL` pisando al global sin que lo sepas
  (con el envoltorio no pasa: su variable manda sobre los dos).
- **Gateway apagado con la config escrita**: opencode falla hasta que arranques
  `bvsala gateway` de nuevo. La config es persistente; el gateway, no. (La
  variante `{env:…}` sin exportar la variable también falla, por vacío.) El
  envoltorio no tiene esta trampa.

## Nota BYOK

**API key exclusivamente.** opencode documenta expresamente que el OAuth de
Claude Pro/Max no puede usarse en harnesses de terceros; esta receta lo respeta.

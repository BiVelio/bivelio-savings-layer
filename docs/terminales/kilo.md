# Kilo Code a través del gateway

**Fuente:** `docs/investigacion/2026-09-27/agentes-de-codigo.md` (código de
`Kilo-Org/kilocode` v7.8.1, 2026-09-25). Desde la serie 7, Kilo es un fork de
opencode (`.opencode-version`: v1.18.26): la CLI (`kilo`), la extensión de VS
Code y la de JetBrains leen la misma configuración, `kilo.json`, y el proveedor
`anthropic` se apunta con `provider.anthropic.options.baseURL`. Su capa de
protocolo añade `/messages` a `https://api.anthropic.com/v1`: **con `/v1`** [V].
Esto sustituye a la receta anterior (proveedor custom por UI, forma inferida).

## Qué necesitas

- Kilo (CLI `kilo`, o la extensión) con el proveedor **`anthropic`** y tu **API key** de Anthropic.
- `bvsala` instalado, `BIVELIO_SERVICE_KEY` exportada y una licencia BiVelio activa (la recoge el gateway con la clave; ver [README](README.md)).

**Lo que no pasa por aquí:** el proveedor por defecto de Kilo es su propia
pasarela (Kilo Gateway, modelos alojados por Kilo con su cuenta). Ese tráfico va
a Kilo, no a un base URL tuyo, y no se mide. Tampoco los demás proveedores.

## Envoltorio (CLI): `bvsala kilo [args…]`

```bash
export BIVELIO_SERVICE_KEY=bvk_…
bvsala kilo
```

Kilo acepta la configuración entera en `KILO_CONFIG_CONTENT` y la fusiona por
encima de la global y de la de proyecto [V]. El envoltorio arranca un gateway
efímero y lanza `kilo` con esa variable apuntando el proveedor `anthropic` a
`http://127.0.0.1:<puerto>/v1`. **No escribe nada en disco.** Si ya exportas tu
propio `KILO_CONFIG_CONTENT`, lo fusiona y solo cambia ese `baseURL`; si no es un
objeto JSON, se niega antes de arrancar sin repetir su valor. Al salir imprime
cuántas peticiones midió y cuáles reenvió sin medir, y por qué.

## Manual (CLI y extensiones): `~/.config/kilo/kilo.json`

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

**Con `/v1`, sin barra final.** Precedencia (de menos a más): global
(`~/.config/kilo/kilo.json`), `KILO_CONFIG`, proyecto (`./kilo.json`,
`.kilo/kilo.json`), `KILO_CONFIG_CONTENT`, gestionada [V]. Arranca el gateway
aparte con `bvsala gateway`.

## Comprobar

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

- `[gateway] POST /messages → 404` → falta el `/v1`.
- `[gateway] POST /v1/v1/messages → 404` → sobra un `/v1`.
- nada en el log → el modelo activo no es del proveedor `anthropic` (¿Kilo Gateway?).

## La trampa típica

- **Gateway apagado con la config escrita**: `kilo.json` recuerda el base URL;
  sin `bvsala gateway` corriendo, Kilo falla hasta que lo arranques o quites la
  clave. El envoltorio no tiene esta trampa.

## Nota BYOK

**API key exclusivamente.** Anthropic prohíbe usar el OAuth de Claude Pro/Max en
harnesses de terceros; esta receta es la del proveedor `anthropic` con API key.

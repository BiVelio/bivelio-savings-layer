# Goose a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Goose habla dialecto
Anthropic puro y autentica con `x-api-key` + `anthropic-version`, que el
reenvío pasa intactos: **nada que cambiar en el gateway**, todo está en la
forma del URL.

## Qué necesitas

- `goose` en el PATH, con el proveedor Anthropic elegido.
- `ANTHROPIC_API_KEY` exportada (Goose es solo BYOK).
- `bvsala` instalado y `BIVELIO_SERVICE_KEY` exportada (ver [README](README.md)).

## Envoltorio: `bvsala goose` (previsto en S3)

```bash
export BIVELIO_SERVICE_KEY=bvk_…
bvsala goose                       # espejo exacto de `bvsala claude`
```

Está previsto como espejo exacto de `bvsala claude`: gateway efímero, `goose`
lanzado con `ANTHROPIC_HOST=http://127.0.0.1:<puerto>`, todo muere al salir.
Sale de generalizar el `switch` de `bin.ts` a una tabla `{comando → variable de
entorno}`. Si tu `bvsala --help` aún no lo lista, la receta manual es
literalmente lo mismo.

## Manual: `ANTHROPIC_HOST`

```bash
bvsala gateway                                        # ventana 1: http://127.0.0.1:8402
ANTHROPIC_HOST=http://127.0.0.1:8402 goose            # ventana 2 — SIN /v1
```

`ANTHROPIC_HOST` **pisa** lo que haya en `config.yaml` [V], así que no hace
falta tocar ningún archivo. Sin `/v1`, sin barra final: Goose añade
`/v1/messages` por su cuenta.

## Comprobar que funciona

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## La trampa típica

- **`/v1` en `ANTHROPIC_HOST`** → `[gateway] POST /v1/v1/messages → 404`. Quítalo.
- **Escribir el host en `config.yaml`** en vez de la variable: funciona, pero
  se queda fijo y Goose falla cada vez que el gateway no esté corriendo. La
  variable de entorno por sesión es la forma; la env pisa al archivo de todos
  modos.

## Nota BYOK

**API key exclusivamente.** Anthropic prohíbe usar el OAuth de Claude Pro/Max
en harnesses de terceros; Goose es BYOK y esta receta también. El gateway
reenviaría cualquier credencial sin inmutarse — eso no es una receta.

# Continue (CLI `cn` y extensiones) a través del gateway

**Fuente:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`: código de
`continuedev/continue` (extensión v2.1.0, junio de 2026) y su doc de `cn`. Continue
se configura por **archivo** (`~/.continue/config.yaml`, el mismo para la CLI y
las extensiones de VS Code y JetBrains) [V]: no hay envoltorio, `bvsala doctor`
imprime el bloque.

## La forma del URL [V]

El proveedor `anthropic` de Continue tiene `apiBase` por defecto
`https://api.anthropic.com/v1/`, añade la barra final si falta y resuelve
`new URL("messages", apiBase)`. Por eso: **con `/v1`**; la barra final la pone él.

## `~/.continue/config.yaml`

```yaml
models:
  - name: Claude via bvsala
    provider: anthropic
    model: <Anthropic model id>
    apiKey: <your Anthropic API key>
    apiBase: http://127.0.0.1:8402/v1
```

Y `bvsala gateway` corriendo aparte. En la CLI también vale `cn --config <fichero>`
con un fichero que lleve ese `apiBase`.

## Comprobar

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

- `[gateway] POST /messages → 404` → falta el `/v1`.
- nada en el log → el modelo activo no es el de este bloque.

## La trampa típica

- **Gateway apagado con la config escrita**: Continue falla con ese modelo hasta
  que arranques `bvsala gateway`.
- El autocompletado usa su propio modelo (`roles: [autocomplete]`): si no apunta
  al gateway, no se mide.

## Nota BYOK

**API key exclusivamente.** Nunca el OAuth de una suscripción Claude Pro/Max.

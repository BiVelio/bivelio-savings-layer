# Qwen Code a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Qwen Code con proveedor
Anthropic habla dialecto Anthropic puro (SDK TS oficial), así que el medidor
actual lo entiende sin cambios. La familia de modelos **qwen** queda fuera del
catálogo a propósito (más abajo).

## Qué necesitas

- `qwen` en el PATH.
- **Una API key de Anthropic** (`ANTHROPIC_API_KEY`), con Qwen Code configurado
  para usar el proveedor Anthropic.
- `bvsala` instalado y `BIVELIO_SERVICE_KEY` exportada (ver [README](README.md)).

## Config de usuario: `~/.qwen/settings.json`

El enrutado necesita dos cosas a la vez [V]: la variable de entorno
`ANTHROPIC_BASE_URL` **y** que `~/.qwen/settings.json` seleccione el tipo
Anthropic:

```json
{
  "selectedType": "anthropic"
}
```

Conserva el resto de tu `settings.json`; la clave verificada en S3 es
`selectedType`. Sin ella, Qwen Code no lee `ANTHROPIC_BASE_URL` y el gateway no
verá nada.

## Envoltorio: `bvsala qwen` (previsto en S3)

```bash
export BIVELIO_SERVICE_KEY=bvk_…
bvsala qwen
```

Espejo de `bvsala claude` con `ANTHROPIC_BASE_URL`; el `doctor` previsto
comprueba `selectedType` antes de lanzar. Si tu `bvsala --help` aún no lo lista,
la receta manual es lo mismo.

## Manual: `ANTHROPIC_BASE_URL`

```bash
bvsala gateway                                         # ventana 1: http://127.0.0.1:8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 qwen          # ventana 2 — SIN /v1
```

Sin `/v1`: el SDK TS oficial de Anthropic añade `/v1/messages` [V]. Sin barra
final.

## Comprobar que funciona

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## La trampa típica

1. **`/v1` en el base URL** → `[gateway] POST /v1/v1/messages → 404`.
2. **`selectedType` no es `anthropic`** → el log del gateway no muestra nada:
   Qwen Code está hablando con su proveedor por defecto, no contigo.
3. **Modelos qwen (DashScope / ModelStudio)**: están **fuera del catálogo a
   propósito** — `costeMedido → null`, passthrough con un aviso una vez
   (`el modelo "…" no está en el catálogo de precios; su uso se reenvía pero no
   se mide`). Coherente con la política del catálogo: presente-y-mal es peor que
   ausente. Para medirlos harían falta precios **verificados** de
   ModelStudio/DashScope en la fecha, y antes comprobar que DashScope emite SSE
   con `\n\n` — el observador parte bloques solo por `\n\n`; un upstream que
   emita `\r\n\r\n` jamás cerraría un bloque y no mediría nada aunque el precio
   estuviera [I].

## Nota BYOK

**API key exclusivamente.** Anthropic prohíbe el OAuth de Claude Pro/Max en
harnesses de terceros; Qwen Code es BYOK desde abr-2026 y esta receta también.

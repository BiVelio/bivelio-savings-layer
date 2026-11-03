# Lo que el gateway no mide hoy, y por qué

**Fuente:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`. Decir que no es
parte de la receta: un terminal apuntado al gateway que no se puede medir sería
pagar por un proxy vacío.

> Actualización 2026-11 (open core): Gemini CLI **ya se mide**
> ([gemini.md](gemini.md)) y Cursor **ya tiene receta** para su override de base
> URL BYOK ([cursor.md](cursor.md)). Quedan aquí los casos que siguen sin medirse.

## Copilot con modelos de GitHub — no pasa por un base URL

Sin BYOK, Copilot (CLI y VS Code) usa los modelos alojados por GitHub, que van a
GitHub y no a un base URL tuyo. Con BYOK sí se mide: ver [copilot.md](copilot.md).

## Kilo Gateway — no pasa por un base URL tuyo

El proveedor por defecto de Kilo son sus modelos alojados; ese tráfico va a Kilo.
Con el proveedor `anthropic` y tu clave sí se mide: ver [kilo.md](kilo.md).

## Cursor con sus modelos propios — no pasa por un base URL tuyo

Con modelos de Cursor (sin BYOK) las peticiones van a los servidores de Cursor y
no alcanzan un gateway en `127.0.0.1`; su panel de uso es el medidor ahí. Con tu
propia clave OpenAI-compatible sí se mide: ver [cursor.md](cursor.md).

## Modelos locales (Ollama, vLLM, LM Studio) — sin precio de lista

Se reenvían y el log lo dice; no hay precio de lista que meter en dólares. Ver
[ollama.md](ollama.md).

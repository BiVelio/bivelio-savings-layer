# Lo que el gateway no mide hoy, y por qué

**Fuente:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`. Decir que no es
parte de la receta: un terminal apuntado al gateway que no se puede medir sería
pagar una licencia por un proxy vacío.

## Gemini CLI — no se mide todavía

Gemini CLI acepta un base URL propio: `GOOGLE_GEMINI_BASE_URL` (y
`GOOGLE_VERTEX_BASE_URL` con Vertex), en HTTPS salvo que apunte a `localhost` o
`127.0.0.1` [V: `docs/reference/configuration.md` de `google-gemini/gemini-cli`,
2026-09-27]. El problema no es enrutarlo: es que habla la **API de Gemini**
(`…/models/<modelo>:streamGenerateContent`, contador en `usageMetadata`), y el
gateway solo sabe leer el contador de Anthropic Messages y de OpenAI Chat
Completions y Responses. Cada petición se reenviaría con la línea
`not metered: no usage dialect for this route`, sin coste.

Hasta que el gateway lea ese dialecto, el contador de Gemini CLI es su propio
`/stats model` (tokens por modelo y cuota) [V]. Qué haría falta para medirlo, y
por qué no se ha hecho hoy (los precios de contexto largo de los modelos Pro),
está en el informe.

## Cursor — no se puede

Cursor manda **todas** las peticiones, también las de tu propia clave, a través
de sus servidores: «all requests are routed through Cursor's servers for final
prompt building» [V: cursor.com/docs/settings/api-keys, 2026-09-27]. Un gateway
en `127.0.0.1` es inalcanzable desde ahí, y exponerlo a Internet no es una
opción (escucha solo en loopback a propósito). Las claves propias, además, solo
cubren los modelos de chat; Tab sigue con los modelos de Cursor [V]. El contador
de Cursor es su panel de uso.

## Copilot con modelos de GitHub — no pasa por un base URL

Sin BYOK, Copilot (CLI y VS Code) usa los modelos alojados por GitHub, que van a
GitHub y no a un base URL tuyo. Con BYOK sí se mide: ver [copilot.md](copilot.md).

## Kilo Gateway — no pasa por un base URL tuyo

El proveedor por defecto de Kilo son sus modelos alojados; ese tráfico va a Kilo.
Con el proveedor `anthropic` y tu clave sí se mide: ver [kilo.md](kilo.md).

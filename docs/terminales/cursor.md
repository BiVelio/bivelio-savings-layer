# Cursor (BYOK: tu propia clave OpenAI-compatible)

Cursor solo pasa por un gateway local cuando la petición va con **tu** clave de
proveedor: sus modelos propios viajan por los servidores de Cursor y no alcanzan
`127.0.0.1` (su panel de uso mide esos).

**Mecanismo [I]:** Cursor → Settings → Models → **OpenAI API Base URL**. Las
peticiones OpenAI-compatibles con tu clave salen hacia esa URL.

## Receta

1. Arranca el gateway con el upstream que quieras:

   ```bash
   bvsala gateway --upstream openai --port 8402    # deepseek, qwen, glm, moonshot, ollama… también
   ```

2. En Cursor: Settings → Models → **OpenAI API Base URL** =
   `http://127.0.0.1:8402/v1` (**con** `/v1`).

3. Añade un modelo OpenAI-compatible con tu API key, como harías sin el gateway.

## Qué se mide y qué no

- Se mide: lo que Cursor manda con TU clave a esa base URL, a precio de lista
  para los modelos con fila en el catálogo.
- No se mide: los modelos propios de Cursor (su dashboard de uso es el medidor
  ahí) y los streams sin `stream_options.include_usage`.

## Comprobar que mide

El log del gateway tiene que mostrar `POST /v1/chat/completions …` con `$`.

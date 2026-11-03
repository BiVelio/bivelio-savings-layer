# Aider a través del gateway

**Fuente:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`: código de
`Aider-AI/aider` (rama `main` a 2026-05-22; la última release publicada es la
v0.86, de agosto de 2025) y de `BerriAI/litellm` 1.82.3, la versión que fija
`main` de aider. Aider llama a los modelos a través de litellm, así que las
variables que mandan son las de litellm [V].

## Qué necesitas

- `aider` en el PATH y tu **API key** (`ANTHROPIC_API_KEY` o `OPENAI_API_KEY`).
- `bvsala` instalado. Open core: sin claves arranca en modo Community; `BIVELIO_SERVICE_KEY` (opcional) añade el panel y los entitlements (ver [README](README.md)).

## Envoltorio: `bvsala aider [args…]`

```bash
bvsala aider                                            # modelos de Anthropic
BVSALA_GATEWAY_UPSTREAM=openai bvsala aider --model gpt-…   # modelos de OpenAI
```

Un gateway habla con un solo proveedor, así que el envoltorio enruta uno:

- **Anthropic (por defecto).** Con `ANTHROPIC_API_KEY` presente, aider elige
  Sonnet por defecto [V]. El envoltorio exporta `ANTHROPIC_API_BASE`, que litellm
  lee **antes** que `ANTHROPIC_BASE_URL`, y litellm añade `/v1/messages` si la
  URL no termina así: **sin `/v1`** [V].
- **OpenAI**, con `BVSALA_GATEWAY_UPSTREAM=openai`: exporta `OPENAI_BASE_URL` y
  `OPENAI_API_BASE` (litellm las lee en ese orden), **con `/v1`** [V].

Lo que no es del proveedor enrutado va directo y no se mide (por ejemplo, un
modelo débil de otro proveedor). Al salir, el envoltorio imprime cuántas
peticiones midió y cuáles reenvió sin medir, y por qué.

### La trampa de OpenAI: el usage en stream

litellm solo añade `stream_options: {"include_usage": true}` cuando habla con
`api.openai.com` **directamente** (`get_stream_options`: sin `api_base`, o con
host `api.openai.com`) [V]. Detrás del gateway el host es `127.0.0.1`, así que
los streams de OpenAI **no piden su contador** y se reenvían sin medir. Dos
salidas:

```bash
BVSALA_GATEWAY_UPSTREAM=openai BVSALA_GATEWAY_USAGE_INJECT=1 bvsala aider --model gpt-…
BVSALA_GATEWAY_UPSTREAM=openai bvsala aider --model gpt-… --no-stream
```

La primera añade la opción en el gateway (el último chunk llega con `choices`
vacío, lo mismo que aider recibe cuando habla con OpenAI directo); la segunda
pide respuestas enteras, que traen el `usage` en el JSON. Anthropic no tiene
esta trampa: su stream siempre trae el contador.

## Manual

```bash
bvsala gateway                                           # 8402, Anthropic
ANTHROPIC_API_BASE=http://127.0.0.1:8402 aider           # SIN /v1

bvsala gateway --upstream openai --port 8403
OPENAI_API_BASE=http://127.0.0.1:8403/v1 aider --model gpt-…   # CON /v1
```

## La trampa típica

- `--openai-api-base` en la línea de comandos o `openai-api-base:` en
  `.aider.conf.yml` pisan la variable (aider la reescribe al arrancar) [V].
- Un `api_base` en `extra_params` de `.aider.model.settings.yml` manda sobre
  todo: esa petición no pasa por el gateway.

## Qué ya mide aider

Aider enseña tokens y coste por mensaje, con los precios de litellm; cuando la
respuesta no trae `usage`, cuenta los tokens con su tokenizador local, que es
una estimación [V]. El gateway añade el contador del proveedor en cada
petición, el aviso de lo que no pudo medir y el panel del equipo.

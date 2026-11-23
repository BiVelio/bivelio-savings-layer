DeepSeek y Qwen son baratos por token, y por eso es fácil dejar de vigilar la factura. Los dos proveedores guardan los prompts en caché por su lado, y la entrada que acierta en la caché se factura muy por debajo de la que falla. Así que el coste real de tu tráfico depende de una cifra que la mayoría de los paneles esconden: cuántos tokens de entrada aciertan en la caché en cada petición. Esta guía explica cómo facturan y cachean los dos proveedores, cómo calcular el precio de una petición a partir de sus campos de uso y cómo verlo petición a petición con un gateway local gratuito.

## Cómo factura DeepSeek una petición

DeepSeek divide la entrada de cada petición en dos: los tokens que aciertan en su caché de contexto y los que fallan, cada uno con su precio, más los tokens de salida. Su [caché de contexto](https://api-docs.deepseek.com/guides/kv_cache) está activada por defecto en todas las cuentas. Para acertar, el principio de la petición tiene que coincidir exactamente con el de una anterior; la caché funciona sin garantías, y las entradas que no se usan se borran al cabo de unas horas o días. La respuesta te dice qué ha pasado:

- `usage.prompt_cache_hit_tokens`: tokens de entrada servidos desde la caché.
- `usage.prompt_cache_miss_tokens`: tokens de entrada procesados por completo.
- `usage.prompt_tokens_details.cached_tokens`: el mismo recuento de aciertos, en el campo que leen las herramientas compatibles con OpenAI.

La [página de precios](https://api-docs.deepseek.com/quick_start/pricing) de DeepSeek da los precios de acierto, de fallo y de salida de cada modelo, y una franja de horas valle a un precio más bajo. Los precios cambian; cópialos con la fecha en que los consultaste.

## Cómo factura Qwen una petición

Los modelos Qwen de Alibaba Cloud Model Studio tienen dos tipos de [caché de contexto](https://www.alibabacloud.com/help/en/model-studio/context-cache). La caché implícita es automática para los prompts que superan una longitud mínima, y sus aciertos se facturan con descuento. La explícita funciona como la de Anthropic: marcas un bloque con `cache_control`, la entrada dura unos minutos, y escribirla cuesta un poco más que la entrada normal, mientras que leerla cuesta mucho menos. En la API compatible con OpenAI, el recuento de aciertos llega en `usage.prompt_tokens_details.cached_tokens`. Model Studio tiene endpoints regionales, así que comprueba a cuál pertenece tu clave.

## Haz que la caché acierte, en cualquiera de los dos

Las reglas son las mismas que en cualquier caché de prefijo:

1. Pon primero lo que nunca cambia: el prompt de sistema, las definiciones de herramientas, el texto de referencia largo, los ejemplos few-shot.
2. Mantenlo idéntico byte a byte entre peticiones: nada de timestamps, ids de petición ni nombres de usuario dentro, y las definiciones de herramientas en un orden fijo.
3. Pon al final lo que cambia: la pregunta del usuario, el último resultado de una herramienta.
4. En los agentes, añade al historial en vez de reescribirlo. Editar un mensaje antiguo en el medio invalida todo lo que viene detrás.

## Calcula el coste de una petición

No necesitas ninguna herramienta para calcular el precio de una petición. Lee el bloque de uso y multiplica cada partida por su precio:

```python
def request_cost(usage: dict, price_miss: float, price_hit: float, price_out: float) -> float:
    """USD cost of one chat completion. Prices are per million tokens, from the provider's pricing page."""
    details = usage.get("prompt_tokens_details") or {}
    hit = usage.get("prompt_cache_hit_tokens", details.get("cached_tokens", 0)) or 0
    miss = usage["prompt_tokens"] - hit
    return (miss * price_miss + hit * price_hit + usage["completion_tokens"] * price_out) / 1_000_000
```

Registra esa cifra con el modelo, la proporción de aciertos (`hit / prompt_tokens`) y un timestamp en cada petición, y podrás responder a las preguntas que importan: qué funcionalidad cuesta más, si la tasa de aciertos de la caché bajó tras un despliegue y cuánto de tu tráfico cae en la franja de horas valle.

## Ve cada petición con un gateway local

Para no tener que tocar cada punto del código que llama a la API, pon un gateway delante del proveedor. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) incluye uno en su paquete de npm: Apache-2.0, local, **sin clave y sin registro**, y no se envía nada a BiVelio. Arranca un gateway por proveedor, cada uno en su propio puerto:

```bash
# DeepSeek
npx @bivelio/savings-layer gateway --upstream deepseek --port 8403

# Qwen on Model Studio's international endpoint (`--upstream qwen` is the Beijing one)
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404
```

El gateway reenvía al proveedor la ruta que envía tu cliente, así que tu base URL es la del propio proveedor con el gateway como host:

| Proveedor | `--upstream` | Base URL para tu cliente de OpenAI |
| --- | --- | --- |
| DeepSeek | `deepseek` | `http://127.0.0.1:8403` |
| Qwen (Pekín) | `qwen` | `http://127.0.0.1:<port>/compatible-mode/v1` |
| Qwen (internacional) | `https://dashscope-intl.aliyuncs.com` | `http://127.0.0.1:8404/compatible-mode/v1` |
| GLM | `glm` | `http://127.0.0.1:<port>/api/paas/v4` |

`npx @bivelio/savings-layer --help` lista los demás upstreams (Moonshot, MiniMax, OpenRouter, Gemini, Ollama, vLLM, LM Studio).

En Python, el pequeño cliente del paquete te resuelve la base URL: crea tu cliente de OpenAI de siempre para el proveedor, y `wrap()` devuelve una copia que pasa por el gateway, conservando la ruta del proveedor.

```python
# pip install bivelio-savings-layer openai
import os

import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")  # the DeepSeek gateway started above
deepseek = gw.wrap(OpenAI(base_url="https://api.deepseek.com", api_key=os.environ["DEEPSEEK_API_KEY"]))

resp = deepseek.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You review Python diffs for an invented team. House rules: ..."},
        {"role": "user", "content": "Review this diff: ..."},
    ],
)
report = gw.report(resp)
print(report.summary())  # model · basis · cost (in, cached, out)
print(report.tokens.provider_cached_input, report.cost.actual)
```

Lo mismo vale para Qwen con el otro gateway y `OpenAI(base_url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1", ...)`. Si enrutas tu tráfico por un proxy HTTP, pon `NO_PROXY=127.0.0.1,localhost` para que las peticiones al gateway local no pasen por él. Si no hay ningún gateway en marcha, `wrap()` lanza `GatewayUnavailable` en vez de llamar directamente al proveedor. En la versión 1.2.3, ese mensaje de error dice además que el gateway necesita una clave de servicio: no la necesita, arranca sin ninguna.

Cualquier otro lenguaje o herramienta también sirve: apunta su base URL de OpenAI al gateway, y cada petición se convierte en una línea del log del gateway, con el modelo, el coste a precio de lista y la entrada separada en tokens a precio completo y lecturas de caché (`cache↓`).

Hay una excepción que importa en las herramientas de chat y los agentes: una petición en **streaming** que no pide el uso (`stream_options: {"include_usage": true}`) no recibe ninguno del proveedor, así que la versión 1.2.3 la registra como `not metered: the request did not ask for usage`. Pide el uso en tu cliente, o arranca el gateway con `BVSALA_GATEWAY_USAGE_INJECT=1`, que añade esa opción a los streams que no la llevan. El último chunk de esos streams trae entonces una lista `choices` vacía, algo que no espera el código que lee `choices[0]` sin comprobarlo.

## Agentes de programación con DeepSeek o Qwen

DeepSeek también publica un endpoint con formato de Anthropic y documenta cómo usarlo con Claude Code. Con `--upstream deepseek`, el gateway envía por sí solo a ese endpoint las peticiones con formato de Anthropic:

```bash
npx @bivelio/savings-layer gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ANTHROPIC_MODEL=deepseek-flash claude
```

Usar un modelo que no es Claude detrás de Claude Code es una integración de DeepSeek, no una configuración que Anthropic admita, y te toca a ti juzgar la calidad del modelo para tu trabajo.

**Qwen Code con modelos Qwen** necesita otro camino. El envoltorio `qwen` del paquete no lo cubre: en la versión 1.2.3, `npx @bivelio/savings-layer qwen` ejecuta Qwen Code con su tipo de autenticación de Anthropic y reenvía a la API de Anthropic, así que solo mide modelos Claude usados con una clave de Anthropic, y rechaza una base URL de DashScope con formato de Anthropic. Para modelos Qwen, usa el modo compatible con OpenAI de Qwen Code, que [su documentación](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/) configura con `OPENAI_API_KEY`, `OPENAI_BASE_URL` y `OPENAI_MODEL`, y apunta esa base URL a un gateway. Pon en `DASHSCOPE_PROXY_BASE_URL` exactamente la misma URL:

```bash
npx @bivelio/savings-layer gateway --upstream https://dashscope-intl.aliyuncs.com --port 8404

GW=http://127.0.0.1:8404/compatible-mode/v1
OPENAI_BASE_URL="$GW" DASHSCOPE_PROXY_BASE_URL="$GW" OPENAI_API_KEY="$DASHSCOPE_API_KEY" OPENAI_MODEL=qwen-plus qwen
```

La segunda variable importa para la factura. Qwen Code decide por el host de la base URL si está hablando con DashScope, y `127.0.0.1` no es un host de DashScope. Sin la variable, recurre a su proveedor OpenAI genérico, que no envía marcas de caché explícita (`cache_control` y la cabecera `X-DashScope-CacheControl`). Tus peticiones caen entonces en la caché implícita de Model Studio, donde los aciertos suelen costar el 20 % del precio de entrada y funcionan sin garantías, en vez del 10 % de la caché explícita ([caché de contexto](https://www.alibabacloud.com/help/en/model-studio/context-cache)). Qwen Code trata como DashScope una base URL que coincide exactamente con `DASHSCOPE_PROXY_BASE_URL`, y mantiene las marcas ([su proveedor de DashScope](https://github.com/QwenLM/qwen-code/blob/8fab857da5/packages/core/src/core/openaiContentGenerator/provider/dashscope.ts), consultado el 23 de noviembre de 2026). El gateway reenvía las dos sin cambios: lo comprobamos con la versión 1.2.3.

Comprobamos la parte del gateway de este camino con la versión 1.2.3, no el propio Qwen Code, así que lee el log del gateway: una línea con un coste por petición. Una línea `not metered` dice por qué: normalmente, un stream que no pide el uso (reinicia el gateway con `BVSALA_GATEWAY_USAGE_INJECT=1`) o un modelo sin fila en el catálogo de la 1.2.3, que tiene `qwen-plus`, `qwen-flash`, `qwen3.7-flash`, `qwen3.8-flash` y `qwen3.8-max`, pero no, por ejemplo, `qwen3-coder-plus`.

Hay dos desfases de precio en la 1.2.3 que dependen de la segunda variable. **Con `DASHSCOPE_PROXY_BASE_URL` definida**, como arriba, Model Studio factura cada escritura en la caché explícita al 125 % del precio de entrada y la indica en `usage.prompt_tokens_details.cache_creation_input_tokens`. El gateway 1.2.3 no lee ese campo: registra esos tokens como entrada normal, con `cache↑0`, al 80 % de lo que cuestan. Su precio de acierto para `qwen-plus` es el 10 % de la caché explícita, que coincide. **Sin la variable** no hay escrituras explícitas, pero los aciertos son implícitos, facturados a cerca del 20 %, y el gateway los registra al mismo 10 %, más o menos la mitad de lo que cuestan.

## Lo que mide el gateway, y lo que no

- **La cifra en dólares sale de un catálogo, no de los precios por franja horaria de DeepSeek.** La versión 1.2.3 tiene filas para `deepseek-flash` y `deepseek-v4-pro`. Para los fallos de caché y la salida usan el precio de hora punta de DeepSeek, así que en horas valle esas partidas muestran el doble de lo que factura DeepSeek. Para los aciertos de caché, las dos filas usan $0.003 por millón de tokens, que es el precio de acierto en horas valle de DeepSeek para `deepseek-flash` (su precio de acierto en hora punta es el doble) y queda por debajo de los dos precios de acierto que DeepSeek publica para `deepseek-v4-pro` ([página de precios](https://api-docs.deepseek.com/quick_start/pricing), consultada el 23 de noviembre de 2026). Según la hora y cuánto de tu entrada acierte en la caché, el total del gateway puede salir por encima o por debajo de la factura. Los recuentos de tokens son exactos; compáralos primero. El clásico alias `deepseek-chat` no tiene fila: se reenvía, y el log dice que no se ha medido.
- **No cambia estas peticiones.** Con tráfico compatible con OpenAI, el gateway mide y reenvía (la única excepción es la inyección opcional del uso que se explica arriba); sus palancas de ahorro son para el tráfico con formato de Anthropic. El ahorro en DeepSeek y Qwen sale de sus propias cachés, y por eso el recuento de aciertos es la cifra que hay que vigilar.

## Si llamas a DeepSeek o Qwen desde TypeScript

El SDK de BV-SALA habla con cualquier endpoint compatible con OpenAI y se salta las repeticiones exactas y las peticiones idénticas en curso, gratis y sin clave ([cómo funciona](/es/guides/deduplicate-llm-requests)). En DeepSeek, esas llamadas evitadas se dan como `estimated`, no como `reference`: la versión 1.2.3 solo valora una repetición por referencia cuando la llamada que se ejecutó fue a la API propia de OpenAI, de Anthropic o de Google. Una advertencia para los bucles de agente: su recorte por defecto de los resultados de herramientas ya superados reescribe el medio del historial, y con un proveedor que guarda en caché el prompt entero por su cuenta eso puede costar más de lo que ahorra. El changelog del proyecto registra un +166 % en un bucle de agente de 60 pasos con DeepSeek, medido contra un proveedor falso con las versiones 1.2.3 y 1.2.4 y sin clave. En bucles de agente, desactívalo por petición:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY }),
});

const { text, report } = await layer.generate({
  model: "deepseek-flash",
  messages: [{ role: "user", content: "Explain what a race condition is in two sentences." }],
  savings: { elision: false }, // keep the history byte-identical for DeepSeek's own cache
});
console.log(text, report.tokens.providerCachedInput, report.cost.basis);
```

## Contrasta las cifras con tu proveedor

Una vez al día, compara los totales por modelo del gateway (entrada, aciertos de caché, salida) con la página de uso de la plataforma de DeepSeek o de Model Studio para la misma clave. Los recuentos totales de tokens deberían coincidir, con una excepción en cómo se reparten: en Qwen, la versión 1.2.3 cuenta las escrituras en la caché explícita como entrada normal, no como escrituras de caché. Los importes en dólares pueden diferir, en cualquier sentido, por motivos conocidos. Los precios del catálogo no son los precios por franja horaria de DeepSeek. En Qwen, la 1.2.3 valora las escrituras en la caché explícita como entrada normal, por debajo de lo que factura Model Studio, y los aciertos implícitos a la tarifa explícita (ambas cosas, explicadas arriba). Los precios regionales y los descuentos también cambian el dinero. Para un método paso a paso, consulta [cómo verificar el ahorro en LLM con la factura de tu proveedor](/es/guides/verify-llm-savings-against-provider-bill). El código del gateway y sus guías por terminal están en [GitHub](https://github.com/BiVelio/bivelio-savings-layer), y lo que el proyecto ha medido, y lo que no, está en la [página del banco público](/es/benchmarks).

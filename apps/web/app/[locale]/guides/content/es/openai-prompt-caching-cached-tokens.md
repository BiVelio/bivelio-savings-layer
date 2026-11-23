OpenAI guarda en caché los prompts largos de forma automática: cuando el principio de una petición coincide con otra que ha procesado hace poco, esos tokens de entrada se facturan con descuento y la respuesta empieza antes. No tienes que activar nada. Por eso mismo es fácil no darse cuenta cuando deja de funcionar. Si `cached_tokens` vuelve como `0` en cada petición, esta guía repasa las causas en el orden en que conviene revisarlas, enseña a seguir la tasa de aciertos por petición y a contrastarla con los propios datos de uso de OpenAI.

## Dónde leerlo

Cada respuesta te dice cuántos tokens de entrada han salido de la caché:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, sobre el total de `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, sobre el total de `usage.input_tokens`.

Los tokens en caché forman parte del total de entrada; no se suman a él. La [guía de prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) de OpenAI es la referencia de las reglas vigentes. Ahora distingue entre los modelos más nuevos, que además informan de las escrituras de caché, las facturan y aceptan opciones de caché explícitas, y los anteriores, en los que escribir en la caché es gratis. Consúltala para el modelo que uses.

## Por qué cached_tokens es 0

1. **El prompt es demasiado corto.** La caché empieza a partir de unos 1,024 tokens de prompt; el umbral exacto y cómo se redondea el recuento en caché dependen del modelo. Un prompt de sistema de 600 tokens y una pregunta corta nunca aciertan en la caché, y nada te avisa.
2. **Cambia el principio del prompt.** La caché coincide desde el primerísimo token. Un timestamp, un id de petición o el nombre del usuario en el primer mensaje hacen que cada petición sea única desde el primer token. Las herramientas, las imágenes y los formatos de respuesta también forman parte del prefijo, así que unas herramientas listadas en otro orden, o un schema serializado de otra forma, rompen la coincidencia.
3. **La entrada se ha expulsado de la caché.** Las entradas se guardan poco tiempo tras el último uso, normalmente minutos cuando hay poco tráfico. Las peticiones separadas por una hora rara vez aciertan.
4. **El tráfico se reparte.** Las peticiones se enrutan según un hash del principio del prompt. Un volumen muy alto con el mismo prefijo se desborda a otras máquinas que no tienen la entrada. El parámetro `prompt_cache_key` de OpenAI agrupa las peticiones que comparten prefijo; usa una clave por plantilla de prompt, no por usuario, y mantén moderado el ritmo de peticiones de cada clave, como explica la guía.
5. **No estás leyendo el campo.** Una petición de Chat Completions en streaming no trae ningún dato de uso salvo que lo pidas con `stream_options: { include_usage: true }`. Muchos wrappers descartan `prompt_tokens_details`. Algunos proveedores compatibles con OpenAI y algunos despliegues de Azure informan de la caché de otra forma o no informan en absoluto.

## Pruébalo en dos minutos

Antes de depurar tu aplicación, comprueba antes de nada que la caché funciona con tu cuenta y tu modelo. Envía el mismo prompt largo dos veces, con unos segundos de diferencia, y lee el uso de cada respuesta:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

Si la segunda línea muestra tokens en caché, la parte del proveedor funciona y el problema está en cómo construye tu aplicación sus prompts: sigue leyendo. Si no muestra ninguno, inténtalo unas cuantas veces más (la caché funciona sin garantías y la primera petición puede caer en otra máquina) y después revisa la entrada del modelo en la guía de caché de OpenAI. Pon el modelo que usas en producción; una prueba con otro modelo demuestra poco.

Esta prueba también te da una línea base para las secciones siguientes. Cuando cambies el orden de tu prompt o añadas un `prompt_cache_key`, haz la misma comparación con una plantilla real de tu aplicación y guarda las cifras. Una tasa de aciertos medida antes y después del cambio, en una plantilla que tus usuarios usan de verdad, es un resultado que puedes enseñar; «la caché debería ayudar» no lo es.

## Pon al final lo que cambia

En la mayoría de los casos, la solución es el orden. Todo lo que es igual en cada petición va primero y se mantiene idéntico byte a byte; todo lo que cambia va al final.

```ts
type Message = { role: "system" | "user"; content: string };

const INSTRUCTIONS = "You answer questions about an invented product, Acme Notes. Rules: …"; // long, never changes
const EXAMPLES = "Example question: … Example answer: …"; // long, never changes

export function buildMessages(question: string, userName: string): Message[] {
  return [
    { role: "system", content: INSTRUCTIONS }, // cached
    { role: "system", content: EXAMPLES }, // cached
    // Everything that changes goes in the last message, after the cached part.
    { role: "user", content: `Date: ${new Date().toISOString().slice(0, 10)}. User: ${userName}.\n${question}` },
  ];
}
```

Después, sigue qué proporción de cada prompt ha salido de la caché, para que una regresión aparezca el mismo día en que llega a producción:

```ts
interface OpenAIUsage {
  prompt_tokens?: number; // Chat Completions
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number; // Responses API
  input_tokens_details?: { cached_tokens?: number };
}

/** Share of this request's input tokens that OpenAI served from its cache. */
export function cachedShare(u: OpenAIUsage): number {
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return total === 0 ? 0 : cached / total;
}
```

Agrupa esa proporción por plantilla de prompt. Una plantilla cuya proporción sigue en el 0 % aunque sus prompts superen los 1,024 tokens tiene algo que cambia cerca del principio: registra dos peticiones y compáralas carácter a carácter, como se muestra en [la versión de esta guía para Claude](/es/guides/claude-prompt-caching-not-working#encuentra-el-byte-que-rompe-tu-caché).

## Cómo ayuda BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) es una capa de ahorro Apache-2.0 para TypeScript que envuelve cualquier endpoint compatible con OpenAI, gratis y sin clave. La caché de OpenAI es automática, así que con OpenAI la capa no marca nada. Lo que hace por la caché:

- **Siempre pide el uso en los streams,** así que una petición en streaming se mide en vez de quedarse sin contador sin que nadie lo note.
- **Muestra el descuento de OpenAI en cada llamada,** en `report.nativeSavings`, a partir del propio contador de OpenAI, y lo separa de su propio ahorro: el descuento es de OpenAI, no de la capa.
- **Puede sacar del prefijo las líneas volátiles.** Con la opción `savings: { cachePrefix: true }`, las líneas del prompt de sistema que cambian en cada petición (timestamps ISO, UUID, tiempos epoch) pasan al final, para que la parte estable pueda ir a la caché. El modelo lee las mismas líneas en otro orden, y por eso es decisión tuya y nunca viene activada por defecto.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const INSTRUCTIONS = "You write one-line summaries of release notes for an invented app. Style rules: …";

const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: `Generated at ${new Date().toISOString()}\n${INSTRUCTIONS}` },
    { role: "user", content: "Summarize: fixed the export button; faster search; new dark theme." },
  ],
  savings: { cachePrefix: true }, // the timestamp line moves after the stable instructions
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report } = await stream.result;
console.log(report.tokens.providerCachedInput); // OpenAI's cached_tokens for this request
console.log(report.nativeSavings?.readDiscountUsd); // what those cached tokens saved at list price
```

Las palancas propias de la capa (saltarse las repeticiones exactas y las peticiones idénticas en curso) son independientes de la caché de OpenAI y se explican en [deduplicar peticiones idénticas a un LLM](/es/guides/deduplicate-llm-requests).

## Contrasta con las cifras de OpenAI

1. **Por petición:** registra `cached_tokens` y el total de entrada de cada respuesta, o `report.tokens.providerCachedInput` con la capa.
2. **Por día:** la [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) de OpenAI devuelve el uso de completions en tramos diarios que incluyen los tokens de entrada en caché, por modelo y, si lo pides, por clave de API o proyecto. Suma tus registros de la misma clave, el mismo modelo y el mismo día UTC: los totales con caché y sin caché deberían coincidir.
3. **En dinero:** valora por separado la entrada con caché y sin caché. En los modelos que facturan las escrituras de caché, inclúyelas también, o tu estimación del ahorro saldrá demasiado alta.

Para el método completo, lee [cómo verificar el ahorro en LLM con la factura de tu proveedor](/es/guides/verify-llm-savings-against-provider-bill). Para el resto de palancas de una factura de OpenAI, consulta [cómo reducir costes de la API de OpenAI](/es/guides/reduce-openai-api-costs). Los resultados medidos, incluidos los casos en que la capa no ahorra nada, están en la [página del banco público](/es/benchmarks), y el código está en [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

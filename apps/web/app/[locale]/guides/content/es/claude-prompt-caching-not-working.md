Has añadido `cache_control` a tus peticiones a Claude y la factura no se ha movido. O `cache_read_input_tokens` vuelve como `0` en cada llamada. Esta guía explica por qué pasa, cómo encontrar el byte exacto que rompe tu caché y cómo contrastar el resultado con las propias cifras de uso de Anthropic. Todo lo que hay aquí funciona con cualquier SDK. Al final verás cómo el SDK open source BV-SALA coloca los puntos de corte (breakpoints) por ti, y el único caso en que deberías decirle que no lo haga.

## Lee primero los tres campos de uso

Cada respuesta de la Messages API te dice qué ha pasado con la caché. Fíjate en tres cifras de `usage`:

| Campo | Qué cuenta |
| --- | --- |
| `cache_creation_input_tokens` | Tokens escritos en la caché en esta llamada, facturados por encima del precio normal de entrada |
| `cache_read_input_tokens` | Tokens servidos desde la caché, facturados a una fracción del precio de entrada |
| `input_tokens` | Tokens posteriores al último punto de corte de la caché, facturados al precio normal |

Los tres patrones te dicen dónde mirar:

- **Los dos campos de caché están a 0.** No se ha guardado nada en caché: el prefijo es más corto que el mínimo del modelo, no hay punto de corte o algo entre tú y la API lo ha quitado.
- **La creación es alta en cada llamada y las lecturas siguen en 0.** La caché se escribe y nunca se reutiliza: el prefijo cambia entre llamadas, la entrada ha caducado o las llamadas van a otro modelo o a otro workspace.
- **Las lecturas son altas.** Funciona. Ahora la única pregunta es cuánto del prompt queda antes del punto de corte.

## Cómo funciona la caché de prompts de Claude, en seis datos

1. Guarda en caché un **prefijo**: la petición desde el principio hasta un punto de corte `cache_control`. La coincidencia es exacta; basta un byte distinto para que todo lo que va detrás se vuelva a procesar.
2. El orden es **tools, luego system, luego messages**. Un cambio en la lista de herramientas invalida el prompt de sistema y los mensajes que vienen detrás.
3. Puedes colocar hasta **cuatro puntos de corte**, y desde cada uno la API busca hacia atrás una entrada anterior en un número limitado de bloques (20 en el momento de escribir esto).
4. Las entradas duran **cinco minutos** por defecto y se renuevan con cada acierto. Con `"ttl": "1h"` tienes una duración de una hora.
5. Escribir cuesta más que leer: una escritura de cinco minutos se factura a 1,25 veces el precio de entrada y una de una hora a 2 veces; una lectura cuesta una pequeña fracción del precio de entrada (0,1 veces en la mayoría de los modelos). Consulta la [página de precios de Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) para tu modelo.
6. Hay una **longitud mínima cacheable** que depende del modelo, de 512 a 4096 tokens. Por debajo, la petición simplemente no se guarda en caché, sin ningún error.

Todo esto está en la [documentación de prompt caching de Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), que es la fuente fiable cuando cambia alguna cifra.

## Las causas habituales, en el orden en que conviene revisarlas

1. **El prefijo es demasiado corto.** Un prompt de sistema de 600 tokens está por debajo del mínimo en varios modelos. Junta las instrucciones estables, los ejemplos y el texto de referencia para que la parte en caché sea lo bastante larga como para notarse.
2. **Algo del prefijo cambia en cada llamada.** Los clásicos: un timestamp o una línea «Hoy es…» en el prompt de sistema, un id de petición, el nombre del usuario, un orden aleatorio de los ejemplos, definiciones de herramientas generadas a partir de un objeto cuyo orden de claves no es fijo, o un documento JSON serializado con un espaciado distinto.
3. **El punto de corte está en contenido que cambia.** Si el último `cache_control` está en la pregunta del usuario, cada llamada escribe una entrada nueva que nadie lee. El punto de corte va al final de la parte que no cambia.
4. **La entrada ha caducado.** Dos llamadas separadas por más de cinco minutos nunca leen la entrada de la otra. Un batch nocturno que procesa un elemento cada diez minutos paga el recargo de escritura cada vez y no lee nada.
5. **Las llamadas no comparten caché.** Otro modelo, otro workspace o un cambio de modelo a mitad de conversación empiezan, cada uno, con la caché vacía.
6. **Las llamadas en paralelo compiten.** Una entrada solo se puede leer cuando ya ha empezado la primera respuesta. Diez llamadas idénticas lanzadas a la vez escriben todas. Envía una primero y luego el resto.
7. **Un proxy quita la marca.** Un gateway que elimina `cache_control`, o que convierte un `system` en forma de bloques en una cadena simple, hace que todo el prompt se facture como entrada sin caché mientras todas las llamadas siguen funcionando. La documentación de Claude Code describe exactamente este fallo para los [gateways de LLM](https://code.claude.com/docs/en/prompt-caching).

## Encuentra el byte que rompe tu caché

Cuando las lecturas siguen en cero, registra dos cuerpos de petición consecutivos y busca dónde difieren por primera vez, en el orden en que los lee la caché:

```ts
type Body = { tools?: unknown[]; system?: unknown; messages: unknown[] };

// The cache reads tools, then system, then messages. Compare in that order.
const inCacheOrder = (b: Body) => JSON.stringify([b.tools ?? [], b.system ?? "", b.messages]);

export function firstDifference(a: Body, b: Body): string | null {
  const x = inCacheOrder(a);
  const y = inCacheOrder(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return null;
  return `differs at character ${i}:\n  ${x.slice(Math.max(0, i - 40), i + 40)}\n  ${y.slice(Math.max(0, i - 40), i + 40)}`;
}
```

Si la primera diferencia está dentro del prompt de sistema o de la lista de herramientas, ya tienes tu fallo de caché. Lleva esa parte al final de la petición, normalmente al mensaje del usuario.

Después, sigue la tasa de aciertos de cada llamada, para que una regresión aparezca el mismo día en que llega a producción:

```ts
interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Share of the input tokens that were read from the cache on this call. */
export function cacheHitRate(u: ClaudeUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = read + written + u.input_tokens;
  return total === 0 ? 0 : read / total;
}
```

## ¿Te compensa la caché con tu tráfico?

Como las escrituras cuestan más que la entrada normal, usar la caché es apostar a que el prefijo se volverá a leer antes de caducar. Con la duración de cinco minutos, una sola lectura ya paga la escritura. Un prefijo que se escribe y nunca se lee cuesta cerca de un 25 % más que enviarlo sin marca. Por eso «pon `cache_control` en todas partes» no es una opción por defecto segura: compensa en el tráfico de chat y de agentes que vuelve en cuestión de minutos, y sale perdiendo en peticiones sueltas o en prompts que cambian cada vez.

## Cómo lo resuelve BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) es una capa de ahorro Apache-2.0. Con `AnthropicProvider` coloca los puntos de corte por ti, gratis y sin clave: uno al final del prompt de sistema y otro al final de la parte de la conversación que no cambia, nunca más de los que permite la API. El informe de cada llamada muestra qué ha hecho la caché, a partir de los propios contadores de Anthropic:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Long and stable: no dates, no user names, no request ids in here.
const SYSTEM = "You are the support assistant for Acme Outdoor, an invented shop. Our return policy: …";

const { text, report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
});
console.log(text);
console.log(report.nativeSavings?.cacheReadTokens, report.nativeSavings?.cacheWriteTokens);
console.log(report.nativeSavings?.netUsd); // read discount minus write premium; negative on a cold write
```

`report.nativeSavings` es el descuento de Anthropic, mostrado aparte: la capa nunca lo cuenta como ahorro propio, así que tu informe cuadra con la factura.

**El caso en que conviene desactivar las marcas.** Sin clave, si tu prompt de sistema cambia en cada petición (un timestamp, un id de usuario) o tus llamadas están separadas por más de cinco minutos en procesos nuevos, el marcado por defecto escribe una entrada de caché que nadie lee, y el README indica que eso cuesta cerca de un 20 % más que sin capa. Pasa lo que cambia al mensaje del usuario o desactiva las marcas:

```ts
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

// A system prompt that changes every time: no cache marks, no write premium.
export const noMarks = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, maxCacheBreakpoints: 0 }),
});

// Or keep the marks and, per request, let the layer move timestamp and UUID
// lines to the end of the system prompt, outside the cached part (opt-in: the
// model reads the same lines in a different order).
const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
export const reply = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: `Today is ${new Date().toISOString()}\nYou are the support assistant for Acme Outdoor, an invented shop. …` },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
  savings: { cachePrefix: true },
});
```

Esa reordenación opcional es la palanca que hay detrás de una prueba exploratoria en vivo publicada en el README: con `claude-haiku-4-5`, en una secuencia construida en la que un timestamp envenenaba la caché, llevó la tasa de aciertos del 0 % al 95 % y bajó el coste por petición un 82,76 %, frente a la propia capa sin la opción, con 20 peticiones por brazo, medido con la versión 1.2.0 el 15 de noviembre de 2026. Es una prueba pequeña y construida, no una previsión para tu tráfico.

## Contrasta con las cifras de Anthropic

1. **Por llamada.** Registra `usage` de cada respuesta (o `report.nativeSavings` si usas la capa) y calcula la tasa de aciertos de arriba. Una carga sana de chat o de agentes muestra, tras la primera llamada, muchas más lecturas que escrituras.
2. **Por día.** En la Claude Console, la página de uso desglosa la entrada en escrituras y lecturas de caché por modelo y clave de API. Suma los `cache_read_input_tokens` y `cache_creation_input_tokens` que has registrado para la misma clave y el mismo día UTC: los totales deberían coincidir. Para comprobarlo por código, la [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) devuelve los mismos contadores.
3. **En dinero.** Pon precio por separado a las lecturas, a las escrituras y a la entrada normal. Un informe que solo enseña «tokens ahorrados» y no el recargo de escritura esconde la mitad del balance.

El [banco público](/es/benchmarks) del repositorio mide los dos brazos de cada prueba con el contador de uso del propio proveedor. Para el método general, consulta [cómo verificar el ahorro en LLM con tu factura](/es/guides/verify-llm-savings-against-provider-bill). Para la parte de OpenAI del mismo problema, consulta [por qué cached_tokens es 0 en OpenAI](/es/guides/openai-prompt-caching-cached-tokens). El código está en [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

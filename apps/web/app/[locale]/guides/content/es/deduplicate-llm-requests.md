Todas las API de LLM cobran por llamada. Si tu aplicación envía dos veces la misma petición, pagas dos veces, aunque la segunda respuesta no aporte nada. Esta guía enseña dos técnicas que lo evitan: una **caché de respuestas por coincidencia exacta** para las repeticiones que llegan más tarde, y la **fusión de peticiones en curso** para las peticiones idénticas que llegan en el mismo momento. Las dos funcionan en cualquier lenguaje y con cualquier proveedor. Al final verás cómo el SDK open source BV-SALA hace ambas cosas por defecto, y cómo contrastar el ahorro con las propias cifras de uso de tu proveedor.

## De dónde salen las peticiones duplicadas

Los duplicados son más habituales de lo que parece, porque rara vez salen de un único sitio evidente:

- **Reintentos y dobles clics.** Un usuario pulsa «Generar» dos veces, o una librería cliente reintenta tras un timeout que el proveedor, en realidad, sí había respondido.
- **Procesos batch y crons.** Un proceso nocturno clasifica las mismas descripciones de producto, entradas de FAQ o macros de soporte que ya clasificó ayer.
- **Fan-out.** Dos workers, dos pestañas del navegador o un efecto de React que se ejecuta dos veces en desarrollo envían el mismo prompt con milisegundos de diferencia.
- **Agentes y pipelines.** Un pipeline de varios pasos hace la misma subpregunta en varias ramas.
- **Tests y evals.** La CI ejecuta los mismos fixtures contra la API real en cada push.

El primer grupo y el último son repeticiones a lo largo del tiempo; el fan-out es concurrencia. Necesitan soluciones distintas, y por eso esta guía cubre las dos.

## Mide primero tu tasa de duplicados

Antes de construir nada, averigua cuánto de tu tráfico se repite. Calcula el hash de cada cuerpo de petición durante un día y cuenta. La clave tiene que ser **canónica**: la misma petición debe dar los mismos bytes sea cual sea el orden de las claves del JSON.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

Si la tasa se acerca a cero, una caché de respuestas no te ahorrará mucho, y te conviene mirar más bien la [caché de prompts](/es/guides/claude-prompt-caching-not-working) o la [elección de modelo](/es/guides/reduce-openai-api-costs). Si una parte apreciable de tus peticiones se repite, sigue leyendo.

## Construye una clave de caché que sea segura de verdad

Una caché exacta es tan buena como su clave. La regla es sencilla: **todo lo que puede cambiar la respuesta entra en la clave, y nada se pierde al normalizar.**

- El id del modelo, la lista completa de mensajes, el prompt de sistema, las definiciones de herramientas, el formato de respuesta o el JSON schema, y todos los parámetros de muestreo (`temperature`, `top_p`, `max_tokens`, `seed`, esfuerzo de razonamiento).
- Un **ámbito** (scope) cuando el prompt lleva datos del usuario. Dos usuarios que preguntan «¿cuál es mi saldo?» envían el mismo texto y necesitan respuestas distintas. Mete el id del usuario o del tenant en la clave, o no guardes esas peticiones en caché.
- Nada de normalizaciones «ingeniosas». Pasar a minúsculas, recortar espacios o quitar la puntuación para conseguir más aciertos convierte una caché exacta en una difusa, y una caché difusa puede devolver la respuesta a otra pregunta.

## Lo que nunca debe servirse desde una caché

Algunas peticiones se repiten, pero aun así tienen que llegar al modelo cada vez:

- **Respuestas que tienen que cambiar**: «elige un nombre al azar», «genera una contraseña», «qué hora es», «el precio de hoy». Aquí una respuesta en caché es un bug, no un ahorro.
- **Herramientas con efectos secundarios.** Si la respuesta pide llamar a `send_email` o `create_order`, servirla otra vez desde la caché se salta la acción. Guarda en caché solo las peticiones cuyas herramientas sean de solo lectura, o que no tengan ninguna.
- **Salidas muestreadas que los usuarios esperan que varíen.** Con una `temperature` alta, una respuesta en caché es solo una muestra, servida para siempre.
- **Errores, respuestas vacías, negativas y respuestas truncadas.** No las escribas nunca en la caché; deja que la siguiente petición lo vuelva a intentar.
- **Temas sensibles.** Un bot de soporte que guarda en caché respuestas sobre autolesiones o una urgencia médica no debería hacerlo; envía esas peticiones al modelo cada vez.

## Fusiona las peticiones idénticas en curso

Una caché solo ayuda cuando ya ha llegado la primera respuesta. Si diez peticiones idénticas empiezan en los mismos 300 ms, las diez fallan. La solución es un patrón diminuto que suele llamarse *singleflight*: el primero que llama hace la llamada y los demás esperan a la misma promesa.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

En producción importan tres detalles. Los errores tienen que llegar a todos los que esperan (el patrón de arriba lo hace). Que uno cancele no debe cancelar la llamada compartida para los demás. Y el streaming es más difícil: un stream que ya ha empezado no se puede pasar sin más a un segundo llamante, así que la mayoría de las implementaciones dejan que una petición normal se una a una llamada en curso, pero no dejan que nada se una a un stream.

## Cómo lo hace BV-SALA

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) es una capa de ahorro Apache-2.0 para TypeScript. Su SDK envuelve tu proveedor y, **sin clave y sin registro**, activa por defecto las dos técnicas: una caché exacta y la deduplicación de peticiones en curso. También aplica las reglas de «nunca a la caché» de arriba: las peticiones que piden algo actual o aleatorio, las formuladas en términos personales sin una sesión, los temas sensibles, las negativas y los errores se quedan fuera de la caché.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

Una petición que parece personal («mi pedido», «nuestra factura») no se guarda en caché salvo que digas de quién es. Pasa un ámbito y la caché vuelve a funcionar, por separado para cada sesión:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

La caché por defecto vive en la memoria de un solo proceso. Para compartirla entre varios servidores o instancias serverless, pasa mediante la opción `exactCache` un almacén que gestiones tú. Necesita tres métodos, así que vale cualquier almacén clave-valor:

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

Las respuestas en caché se quedan en tu infraestructura. Si lo usas sin clave, no se envía nada a BiVelio.

## Contrasta el ahorro con las cifras de tu proveedor

El ahorro de una caché es fácil de comprobar, porque es un recuento de llamadas que no se hicieron.

1. **Cuenta las llamadas en los dos lados.** Durante un día, cuenta las llamadas a `generate()` que hizo tu aplicación y compáralas con el número de peticiones que muestra tu proveedor para la misma clave de API y el mismo modelo (la página de uso de la consola de OpenAI o de Anthropic, o sus API de uso). La diferencia debería ser igual a la suma de `report.calls.avoidedLlm`.
2. **Mira cómo se valoró cada repetición.** `report.cost.basis` dice de dónde sale la cifra. Una repetición es `reference` cuando la llamada idéntica que sí se ejecutó fue directamente a la API de OpenAI, de Anthropic o de Gemini de Google (`api.openai.com`, `api.anthropic.com` o `generativelanguage.googleapis.com`): su línea base es el propio contador de uso de esa llamada, valorado de forma conservadora a la tarifa de entrada en caché. Se queda en `estimated` cuando la llamada que se ejecutó fue a cualquier otro sitio, incluida la API propia de otro proveedor como la de DeepSeek, un proxy, Azure o un gateway, porque solo en esas tres API se sabe que los precios de lista de la capa coinciden con la factura. El dinero estimado siempre se da aparte.
3. **Compara el gasto, no solo las llamadas.** Suma `report.cost.netSavingsUsd` por cada base. Nunca sumes importes medidos con estimados, y nunca promedies `netSavingsRatio` entre peticiones.

Si quieres una prueba más limpia, ejecuta la misma carga dos veces, una con las palancas desactivadas en esa ejecución (`savings: { exactCache: false, singleflight: false }` en cada petición) y otra con la configuración por defecto, y compara las dos facturas.

## Lo que dicen las cifras públicas

El repositorio publica las ejecuciones de su banco. En una carga pública construida con preguntas de GSM8K en la que el 30 % de las peticiones eran repeticiones exactas, la reducción agregada medida fue del **31.50 %** con `gpt-4o-mini`, con un intervalo del 95 % entre el 25.7 % y el 36.7 % (artefactos del SDK 0.4.31 de septiembre de 2026; fuente: la [página del banco público](/es/benchmarks#savings) y el README). Con tráfico que nunca se repite, el ahorro ronda el 0 %, y la [página del banco público](/es/benchmarks#no-savings) también muestra esos resultados planos. Además cuenta el fallo que más importa en una caché: **0 de 198** variantes de preguntas recibieron la respuesta de otra pregunta ([garantías](/es/benchmarks#guarantees)).

Tu ahorro depende de tu tasa de duplicados, así que mídela primero con el fragmento del principio de esta página. El código, el paper y los informes en bruto están en [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

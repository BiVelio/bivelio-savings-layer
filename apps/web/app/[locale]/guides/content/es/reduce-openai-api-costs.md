Una factura de OpenAI es la suma de unas pocas cifras por petición: tokens de entrada sin caché, tokens de entrada en caché, escrituras de caché (en GPT-5.6 y posteriores), tokens de salida (razonamiento incluido) y el precio del modelo. Cualquier forma de reducirla mueve una de esas cifras. Esta guía recorre las palancas en el orden en que suelen compensar, explica cuándo no compensa cada una y enseña a demostrar cada ahorro con los propios datos de uso de OpenAI, no con una proyección. Casi todo se hace sin ninguna herramienta; allí donde el SDK open source BV-SALA automatiza una palanca, verás cómo.

## Empieza por medir cada petición

Antes de cambiar nada, registra el bloque `usage` de cada respuesta junto con la funcionalidad o la plantilla de prompt que la generó: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` si el modelo lo devuelve, `completion_tokens` y, en los modelos de razonamiento, `completion_tokens_details.reasoning_tokens`. Pon precio a cada partida con las tarifas de la página de precios de OpenAI y apunta la fecha en que las copiaste. En GPT-5.6 y posteriores, las escrituras de caché son una partida aparte: OpenAI las factura a 1.25 veces la tarifa de entrada sin caché con la duración por defecto de 30 minutos, y a 2.5 veces con la de 12 horas ([guía de prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), consultada el 23 de noviembre de 2026). Si las valoras como entrada normal, te quedas corto. Una semana así responde a la única pregunta que importa al principio: **qué dos o tres funcionalidades se llevan la mayor parte de la factura.** Optimiza esas; olvídate del resto.

## 1. No pagues dos veces la misma petición

Los reintentos, los dobles clics, los procesos nocturnos que vuelven a clasificar lo que ya clasificaron ayer y los workers en paralelo que envían el mismo prompt cuestan, cada uno, una llamada completa. Una caché de respuestas por coincidencia exacta y la deduplicación de peticiones en curso los eliminan sin cambiar ni una sola respuesta. Cuánto ahorras depende por completo de lo a menudo que se repitan tus peticiones, así que mide primero tu tasa de duplicados. Guía completa: [deduplicar peticiones idénticas a un LLM](/es/guides/deduplicate-llm-requests).

## 2. Deja trabajar a la caché de prompts de OpenAI

Los prompts de unos 1,024 tokens o más se guardan en caché automáticamente, y los tokens de entrada en caché se facturan con descuento. En GPT-5.6 y posteriores, llenar la caché no sale gratis: la parte que se escribe en ella se factura por encima de la tarifa sin caché, como se explica arriba, así que un prompt que se escribe y no se vuelve a leer cuesta más que sin caché, y uno que se vuelve a leer pronto cuesta mucho menos. Los modelos anteriores no cobran nada extra por las escrituras. La caché solo coincide desde el primer token, así que solo funciona cuando el principio de tu prompt es idéntico entre peticiones. Pon primero las instrucciones, las definiciones de herramientas y los ejemplos, y al final las fechas, los nombres de usuario y la pregunta. Si `cached_tokens` se queda clavado en 0, consulta [por qué cached_tokens es 0 en OpenAI](/es/guides/openai-prompt-caching-cached-tokens).

## 3. Manda a la Batch API el trabajo que puede esperar

Las evaluaciones, los backfills, los embeddings de un conjunto de documentos y la clasificación nocturna no necesitan respuesta en dos segundos. La [Batch API](https://developers.openai.com/api/docs/guides/batch) de OpenAI recibe un fichero de peticiones, devuelve los resultados en menos de un día y los factura a una tarifa más baja que las mismas peticiones enviadas una a una (las condiciones vigentes están en la [guía de optimización de costes](https://developers.openai.com/api/docs/guides/cost-optimization)). Para el trabajo offline suele ser el mayor ahorro individual, y no cambia nada de las respuestas.

## 4. Usa el modelo más pequeño que supere tu evaluación

Las diferencias de precio entre gamas de modelos son grandes, y muchas tareas (clasificación, extracción, reescrituras cortas, enrutado) no necesitan el modelo más grande. Monta un pequeño conjunto de evaluación con peticiones reales, pásalo por dos o tres modelos y quédate con el más barato que lo supere. Vuelve a pasarlo cuando salga un modelo nuevo. Sin la evaluación, bajar de modelo es una apuesta, y el coste de las respuestas erróneas no aparece en la factura de la API.

## 5. Controla la salida

Los tokens de salida suelen costar varias veces más que los de entrada, y los tokens de razonamiento se facturan como salida.

- Ajusta `max_completion_tokens` a lo que la funcionalidad necesita de verdad.
- En los modelos de razonamiento, baja el esfuerzo de razonamiento en las tareas que no necesitan razonar a fondo, y mide `reasoning_tokens` antes y después.
- Pide salida estructurada con un JSON schema cuando tu código parsea la respuesta. Un fallo de parseo seguido de un reintento paga la petición entera dos veces.

## 6. Envía menos entrada

- No reenvíes la conversación entera cuando la tarea solo necesita los últimos turnos.
- Saca de los turnos siguientes las salidas grandes de herramientas (logs, contenido de ficheros, resultados de búsqueda) una vez usadas.
- Envía los datos estructurados en formato compacto: el JSON formateado gasta tokens en espacios en blanco.
- Recupera los tres párrafos relevantes en vez de pegar el documento entero.

Cuidado con las dos últimas en bucles de agente largos: editar el medio de un historial que OpenAI ya tiene en caché hace que todo lo que va después de la edición se vuelva a facturar, a la tarifa sin caché o, en GPT-5.6 y posteriores, a la tarifa más alta de escritura de caché cuando se vuelve a guardar. Acorta lo nuevo, no lo que ya está en caché.

## Cómo automatiza BV-SALA algunas de ellas

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) es una capa de ahorro Apache-2.0 que envuelve cualquier endpoint compatible con OpenAI en TypeScript. Ahorra con todas las palancas **gratis, sin clave y sin registro**, y no envía nada a BiVelio salvo que añadas una clave para el panel opcional en la nube. Activadas por defecto: la caché exacta, la deduplicación de peticiones idénticas en curso, la resolución en local de operaciones aritméticas sencillas y la serialización compacta de los datos estructurados que le pasas. Opcionales, con una opción cada una: la cascada de modelos, la compactación de las salidas de herramientas y la reordenación para un prefijo cacheable. Cada petición devuelve un informe que dice qué se ha ahorrado y de dónde sale la cifra.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text); // "8": computed on your machine, no call to OpenAI
console.log(report.calls.avoidedLlm); // 1: a whole call you did not pay for
console.log(report.cost.basis); // "estimated": nothing ran, so there is no provider counter to read
```

Dos límites, dichos con franqueza. Primero, el tráfico que nunca se repite ahorra cerca de un 0 % con la caché y la deduplicación, por diseño. Segundo, el recorte que hace la capa por defecto de los resultados de herramientas ya superados puede costar más de lo que ahorra en bucles de agente largos con un proveedor que guarda en caché el prompt entero: el changelog del proyecto registra un +12.2 % en un bucle de 60 pasos con `gpt-5`, medido contra un proveedor falso con las versiones 1.2.3 y 1.2.4 y sin clave. En bucles de agente largos, pasa `savings: { elision: false }` en la petición y compara.

## Demuestra cada ahorro con las cifras de OpenAI

Un ahorro que no puedes comprobar es una proyección. Para cada palanca:

1. **Elige el contador que debería moverse.** La caché y la deduplicación mueven el número de peticiones. La caché de prompts mueve `cached_tokens` y, en GPT-5.6 y posteriores, también `cache_write_tokens`. Batch mueve el precio. La elección de modelo mueve el precio por token. El control de la salida mueve `completion_tokens`.
2. **Lee ese contador en OpenAI.** La [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) devuelve peticiones y tokens de entrada, de entrada en caché y de salida por día, modelo, proyecto y clave. El endpoint de Costs y el panel de uso dan el dinero.
3. **Compara lo comparable.** La misma funcionalidad, los mismos días de la semana, antes y después o, mejor aún, dos brazos del mismo tráfico a la vez. Mira primero los tokens y después los dólares: los dólares también se mueven con los precios.

Con la capa, cada informe lleva `cost.basis`: los importes `measured` y `reference` salen del propio contador de OpenAI, y los `estimated` se dan aparte y nunca se mezclan. El método completo: [verificar el ahorro en LLM con la factura de tu proveedor](/es/guides/verify-llm-savings-against-provider-bill).

## Lo que dicen las cifras publicadas

La [página del banco público](/es/benchmarks) del proyecto mide los dos brazos de cada prueba con el contador de uso del propio proveedor. En una carga pública construida con preguntas de GSM8K en la que el 30 % de las peticiones eran repeticiones exactas, la reducción agregada con `gpt-4o-mini` fue del **31.50 %**, con un intervalo del 95 % entre el 25.7 % y el 36.7 % (artefactos del SDK 0.4.31, septiembre de 2026; también en el README). En chat de dos turnos sin repeticiones (MT-Bench), las diferencias fueron indistinguibles de cero o no atribuibles a la capa, y la página lo dice. El método, los intervalos y todas las limitaciones están en [el paper](/es/paper). El código está en [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

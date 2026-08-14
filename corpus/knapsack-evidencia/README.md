# Golden set del knapsack de evidencia (F6)

Este directorio es el **corpus**, no el algoritmo. No hay aquí ninguna
implementación del knapsack: hay los casos que permitirán demostrarlo — o
refutarlo — cuando se escriba.

## Lo que este corpus NO demuestra

Léase antes que nada lo demás, y cítese entero cada vez que alguien enseñe un
número salido de aquí:

> Esto es un golden set **sintético**. Demuestra que el mecanismo no descarta un
> campo crítico. **No demuestra que en el tráfico real de un cliente el ahorro se
> materialice ni que la distribución de casos difíciles se parezca.**

Los contratos son inventados. Están escritos para parecerse a los de verdad y
para llevar dentro trampas que en los documentos jurídicos reales hacen daño,
pero la mezcla —cuántos casos difíciles por cada fácil, qué trampas aparecen y
con qué frecuencia— la eligió quien escribió el corpus, no un cliente. Un 100 %
de conservación de campos críticos aquí significa exactamente esto: *sobre estos
50 casos, con estos presupuestos, el selector no tiró nada imprescindible*. No
significa que el selector sea seguro, y no significa que el ahorro que produzca
sobre este corpus sea el ahorro que verá una factura.

Lo que sí sirve, y por eso existe:

- Es una **verja**. Un fallo aquí es una prueba de que el selector rompe algo. La
  refutación es barata y concluyente; la confirmación no lo es.
- Permite medir **por idioma**. La aceptación de F6 prohíbe la degradación por
  idioma, y sin casos en catalán esa frase no se puede comprobar.
- Se evalúa **sin llamar a ningún proveedor**: la conservación de campos críticos
  y la accesibilidad de las citas son propiedades del subconjunto elegido, no de
  la respuesta generada. Cuestan cero euros y cero segundos de latencia.

Para saber si el ahorro se materializa hace falta otra cosa: tráfico real medido
en sombra, con el A/B pareado del `benchmarks/`. Este corpus no sustituye a eso
ni lo aproxima.

## Por qué F6 necesita un corpus y las palancas anteriores no

El plan (`docs/PLAN-CAMINO-AL-50.md`) separa las palancas en dos clases:

- **Lossless**: el original se reconstruye exactamente. Se demuestra con
  round-trip y hash, y la demostración vale para todo prompt posible.
- **Task-preserving**: se conserva lo necesario para producir el mismo resultado
  verificable, no el mismo texto. **No se puede garantizar matemáticamente** para
  un prompt arbitrario. Hay que demostrarlo por función, por segmento documental
  y por idioma.

F6 —elegir qué trozos de contexto recuperado se mandan al modelo en vez de
mandarlos todos— es la primera task-preserving. De ahí que la unidad de prueba no
sea un hash sino un caso con respuesta correcta conocida.

## La forma de un caso

Está en [`forma.ts`](./forma.ts), con el porqué de cada campo. En resumen:

| Campo | Para qué |
|---|---|
| `id`, `idioma`, `dominio`, `subdominio`, `dificultad` | Cortar las métricas por donde la aceptación de F6 lo exige. |
| `consulta` | Lo que pregunta el usuario. |
| `unidades[]` | Los trozos recuperados. Cada uno con `papel`: `necesaria`, `distractora`, `contradictoria` o `derogada`. |
| `presupuesto.maxUnidades` | Cuántas puede mandar el selector. Siempre menos que todas: sin presión no hay knapsack que medir. |
| `respuesta` | La respuesta correcta **comprobable por máquina** (`campos`), o `abstenerse` con su motivo. |
| `camposCriticos` | Lo que no se puede perder. |
| `citasObligatorias` | Qué unidades sostienen la respuesta. Una cita a algo que no se mandó es una cita muerta. |
| `campoTrampa` | El valor equivocado **concreto** al que lleva tirar cierta unidad. Es lo que separa «falló» de «falló por lo que esperábamos». |
| `par` | El caso gemelo: mismo esqueleto, cambia el idioma o cambia la respuesta. |
| `nota` | El porqué del caso. Los JSON no llevan comentarios; el porqué va aquí. |

`papel` es la **única** regla de la que se deriva todo lo demás. No hay una
segunda lista de necesarias que pueda contradecirla: `unidadesNecesarias()` la
lee de ahí.

## Cómo se usa

```ts
import { evaluaSeleccion } from "./forma.js";

const elegidas = miSelector(caso.consulta, caso.unidades, caso.presupuesto);
const r = evaluaSeleccion(caso, elegidas);
// r.conservaNecesarias  -> la métrica de aceptación de F6
// r.citasAccesibles     -> "citas válidas y accesibles"
// r.cayoEnLaTrampa      -> diagnóstico: ¿falló por lo que el caso predecía?
```

## Estado y unificación pendiente

Esta forma es una **propuesta mínima**, escrita porque el corpus de contratos no
podía esperar a que se publicara la del dominio de facturación. Si las dos
difieren, **esta cede**: se unifica en la de facturación y se migran los JSON. Lo
que no debería cambiar sin discutirlo es lo que hace que un caso pueda fallar —
`papel`, `presupuesto`, `camposCriticos`, `citasObligatorias` y `campoTrampa`—,
porque son los cinco campos de los que sale la métrica.

`dominio` es un `string` abierto a propósito, para que un dominio nuevo no tenga
que tocar `forma.ts`.

## Contenido

- [`contratos/`](./contratos/) — 50 casos de contratos y clausulado (30 es, 20 ca).
  Ver su [README](./contratos/README.md).

La verja está en `test/corpus-contratos.test.ts` y corre con el resto de la
suite. `corpus/**/*.ts` está en el `include` del `tsconfig.json`: el código que
produce nuestras cifras tiene que pasar por la verja de tipos, que es la lección
que ya costó cuatro errores reales cuando se descubrió que `benchmarks/` no
estaba incluido.

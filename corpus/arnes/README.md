# El arnés del knapsack de evidencia — la verja de F6

Un corpus que nadie ejecuta es documentación. Esto es lo que lo ejecuta.

`corpus/` tiene 150 casos con respuesta correcta conocida (ver `corpus/README.md`).
Este directorio los carga validándolos, los puntúa contra un selector cualquiera,
y convierte la frase de aceptación de la fase F6 —«100 % de conservación de
campos críticos, citas válidas y accesibles, **sin degradación por idioma ni por
tipo documental**»— en un test que hoy pasa y que se pondrá rojo el día que el
knapsack tire una unidad que no podía tirar.

```ts
import { cargarCorpus } from "./corpus/arnes/cargar.js";
import { puntuarCorpus, degradaciones } from "./corpus/arnes/metricas.js";
import { conEntradaLimpia } from "./corpus/arnes/selectores.js";

const casos = cargarCorpus();                       // 150, o revienta
const informe = puntuarCorpus(casos, conEntradaLimpia(miKnapsack));
degradaciones(informe);                             // [] = se puede gatear
```

```
pnpm corpus:arnes            # el selector por defecto
pnpm corpus:arnes --todos    # + líneas base, oráculo y mutantes
```

---

## ⚠️ Lo que este arnés NO demuestra

Hereda entera la limitación del corpus, y la repite aquí porque quien enchufe
F6 va a leer este fichero y no el otro.

**El corpus es SINTÉTICO.** Los 150 casos están escritos a mano, no salen de
ningún expediente real y ningún cliente los ha visto.

- **Demuestra** que el mecanismo de selección no descarta un campo crítico en
  situaciones construidas para que descartarlo salga caro.
- **NO demuestra que en el tráfico real de un cliente el ahorro se
  materialice.** El presupuesto de cada caso está puesto a mano; en producción
  lo fija el tamaño real de los documentos recuperados, que aquí no se ha medido.
- **NO demuestra que la distribución de casos difíciles se parezca a la suya.**
  Aquí el 72 % de los casos son difíciles a propósito. En un corpus real esa
  proporción la decide el cliente.
- **La cifra de tokens es una ESTIMACIÓN.** La cuenta `HeuristicEstimator`, que
  declara `exact: false`: sirve para comparar dos selecciones del mismo texto
  —las dos se cuentan con la misma regla— y no para contrastar contra una
  factura. El informe arrastra la marca hasta la última línea.
- **En 90 de los 150 casos la cobertura por campo es una aproximación.** Solo
  facturación escribe qué unidades sostienen CADA campo; contratos y soporte
  declaran una lista para todo el caso y aquí se le atribuye entera a cada
  campo. El informe dice cuántos casos son de cada clase.

Un verde aquí es condición **necesaria** para gatear F6, nunca suficiente.

---

## Las cuatro métricas, y por qué ninguna sobra

| Métrica | Qué contesta |
|---|---|
| **cobertura de campos críticos** | ¿siguen sostenidos por su evidencia los campos que la respuesta DEBE contener? Es el criterio literal de F6 |
| **citas conservadas** | ¿queda alguna cita apuntando a una unidad que no se mandó? Una respuesta con citas muertas es indistinguible de una inventada |
| **tasa de abstención correcta** | de los 22 casos cuya respuesta correcta es no responder, ¿en cuántos SIGUE siendo posible abstenerse? |
| **tokens ahorrados** | sin ella, «conserva el 100 %» lo cumple `mandarloTodo` y la verja no dice nada |

**La cuarta es la que convierte las otras tres en una comparación.** El selector
por defecto conserva el 100 % de todo y ahorra exactamente 0 de 25.743 tokens.
Ese cero es el que impide leer el verde de hoy como «el knapsack funciona».

### El presupuesto NO entra en el aprobado

`aprobado` mide conservación. `dentroDePresupuesto` se informa aparte. Si se
mezclaran, el selector por defecto suspendería los 150 casos y la verja no
podría distinguir *«todavía no hay knapsack»* de *«el knapsack rompe cosas»* —
que es justo lo que tendrá que distinguir. Un selector que aprueba sin entrar en
presupuesto sale con 0 % de ahorro, y eso se lee en la misma tabla.

### La media miente, y el plan lo prohíbe

`porIdiomaYDominio` es el **cruce**, no dos listas sueltas. Un catalán al 100 %
en soporte y al 60 % en contratos da una media por idioma decente y una media por
dominio decente, y esconde exactamente la celda que la aceptación de F6 prohíbe.
`degradaciones()` recorre las seis celdas del cruce con umbral 100 %, y lo
primero que imprime el informe es `peorCelda`.

Que el cruce no es decorativo lo comprueba un test: al mutar el selector, las
seis celdas bajan, no solo la media.

---

## El selector no puede ver la respuesta

Un selector recibe `EntradaDelSelector` y nada más: consulta, trozos de texto y
presupuesto. **No ve `papel`, ni `necesarias`, ni `citas`, ni la respuesta.** Es
lo que verá en producción, y es lo que impide que un candidato apruebe leyendo
la chuleta. Hay un test que lo comprueba sobre el objeto serializado.

(`corpus/auditoria/lineas-base.ts` sí le pasa el caso entero a cada línea base.
Ahí está bien: su `oraculo` existe precisamente para acreditar que toda selección
correcta existe. Aquí se puntúa a un candidato, y un candidato que puede leer la
solución no se puede puntuar.)

Cuando F6 exista, se enchufa así y la verja ya está puesta:

```ts
const informe = puntuarCorpus(casos, conEntradaLimpia(knapsackDeEvidencia));
expect(degradaciones(informe)).toEqual([]);
```

---

## El cargador falla ruidosamente

`cargarCorpus()` lanza `CorpusCorrupto` con **todos** los problemas, no con el
primero.

Comprueba, en la vista unificada y contra el fichero de datos: ids únicos en
todo el corpus, citas que apuntan a unidades que existen, toda necesaria citada
por alguien, campos declarados críticos presentes en la respuesta, abstenciones
con al menos una cita y con los dos lados de la contradicción citados, presión
real (`necesarias ≤ presupuesto < total`), y **fidelidad de la proyección**.

### Por qué la fidelidad de la proyección

Cada dominio ya se validaba contra el molde en el que fue escrito, y los tres
pasaban. Pero lo que puntúa a un selector no es ninguna de las tres formas: es
la **proyección** de las tres sobre `CasoVista`. Esa proyección aplana campos,
renombra papeles e imputa presupuestos — y no la comprobaba nadie.

El primer día que corrió, este cargador encontró esto: `PRESUPUESTO_IMPUTADO()`
en `corpus/vista.ts` dividía por 0,6 mientras `corpus/auditoria/reparar.ts` había
**escrito** los presupuestos dentro de `benchmarks/corpus/soporte/casos.json` con
0,5. Diez de los cuarenta casos de soporte se puntuaban contra un presupuesto de
3 que el fichero de datos declaraba como 2 — un cuarto del dominio arbitrado
contra una cifra que no estaba escrita en ninguna parte y que nadie eligió.
Ninguna de las 95 pruebas del corpus lo veía, porque ninguna comparaba las dos.
Arreglado: manda el fichero, y el cargador falla si vuelven a separarse.

---

## La verificación por mutación

`test/corpus-arnes-mutacion.test.ts` rompe la verja a propósito y exige que
suspenda. Un test que solo se ha visto pasar es un test que nadie ha probado: el
selector por defecto conserva todo por construcción, así que un arnés que no
comprobara **nada** saldría igual de verde.

| Mutante | Rompe | Resultado |
|---|---|---|
| `tira-una-cita` | una cita obligatoria | 0/150 aprobados |
| `tira-una-necesaria` | una unidad sin la que la respuesta es imposible | 11/150, cobertura de críticos al 12 % |
| `responde-una-abstencion` | deja un solo lado de la contradicción | **138/150**, y las 12 que rompe no se ven |
| `inventa-ids` | devuelve ids que no existen | 0/150, con el 100 % de cobertura y de citas |

Y se exige que cada uno suspenda **por su invariante**: un mutante que suspende
por el motivo equivocado acredita que el arnés detecta algo, no que detecte lo
que dice.

### El mutante que importa

`responde-una-abstencion` saca **92 % de aprobados y el 98 % de las citas
vivas**. Los otros tres dejan la respuesta sin evidencia, y eso el cliente lo
nota: pide más contexto, o contesta que no sabe. Ese deja un solo lado de la
contradicción, y entonces el caso queda perfectamente respondible: el modelo
contesta con seguridad, bien redactado y con la cita en su sitio, lo contrario
de lo correcto, y no queda ni rastro de que había otra cláusula que decía
lo opuesto.

Un fallo por quedarse corto lo ve alguien. Este no lo ve nadie. Si el arnés solo
mirase citas y campos críticos, este mutante pasaría por «casi perfecto» — y por
eso la tasa de abstención correcta es una métrica con nombre propio y no una
línea del agregado.

### Lo que encontró mutar el propio arnés

Los cuatro mutantes de arriba se verificaron a mano rompiendo cada cláusula de
`aprobado` una a una, con `git diff` delante para no creerse un no-op. Cinco de
las seis rondas salieron rojas donde tenían que salir. **Una no**: al quitar
`abst.ok` de `aprobado`, los cuatro mutantes seguían suspendiendo.

El motivo es del corpus, no del arnés. En los 150 casos de hoy los dos lados de
una contradicción están **siempre citados**, así que tirar uno rompe también las
citas y el mutante suspende por la otra puerta. La comprobación de abstención no
quedaba fijada por ninguno de los cuatro: se podía borrar sin que la suite se
enterase.

El agujero está tapado con un caso sintético de un solo elemento
(`el caso que el corpus real no sabe expresar`): una unidad contradictoria **sin
citar**. Es una forma que el cargador prohíbe en los datos reales —hay un test
que lo comprueba— y por eso hay que construirla a mano. Las dos comprobaciones
son la misma puerta con dos cerraduras, y ahora quitar cualquiera de las dos
pone algo rojo.

Es exactamente para lo que sirve mutar: la ronda que sale verde cuando debería
salir roja es la que informa.

---

## Ficheros

| Fichero | Qué es |
|---|---|
| `cargar.ts` | el cargador que valida al leer; `CorpusCorrupto` |
| `selectores.ts` | el contrato del selector, la entrada limpia, `mandarloTodo` |
| `metricas.ts` | puntuación por caso, agregados, el cruce, `degradaciones()` |
| `tokens.ts` | la cuenta de tokens, marcada como estimada |
| `trampas.ts` | el vocabulario de trampas unificado y cerrado |
| `mutantes.ts` | los selectores rotos a propósito |
| `informe.ts` | el informe para leerlo con los ojos |

`trampas.ts` existe porque los tres corpus bautizaron las mismas trampas con
nombres distintos (`apostrof`/`apostrofo`, `diacritico`/`diacriticos`,
`identificadores-parecidos`/`identificador-casi-igual`). Sin unificarlos el
desglose parte cada clase en dos filas y las dos salen con la mitad de casos, que
es la manera más silenciosa de aparentar cobertura donde no la hay. Solo se
colapsan variantes ortográficas y sinónimos exactos: `entidad-casi-igual`
(Balears contra Canàries) **no** se funde con `identificadores-parecidos`
(C-2026-118 contra C-2026-1118), porque fundirlas inventaría una equivalencia que
nadie ha comprobado.

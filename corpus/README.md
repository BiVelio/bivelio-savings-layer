# El corpus de evidencia — golden set de la fase F6

Este directorio contiene el conjunto de casos con respuesta correcta conocida
que sirve para **demostrar o refutar** el *knapsack de evidencia* (fase F6 de
`docs/PLAN-CAMINO-AL-50.md`): el mecanismo que decide qué trozos del contexto
recuperado se mandan al modelo en lugar de mandarlos todos.

El knapsack **no está implementado**. Esto es el corpus, y existe antes que el
algoritmo a propósito: un criterio de aceptación escrito después del código es un
criterio ajustado al código.

## Los 150 casos, y dónde están

| Dominio | Casos | Ficheros |
|---|---:|---|
| Facturación y cobros | 60 | `facturacion-y-cobros/casos-{es,ca}.json` |
| Contratos | 50 | `knapsack-evidencia/contratos/contratos.{es,ca}.json` |
| Soporte y políticas | 40 | `../benchmarks/corpus/soporte/casos.json` |
| **Clase incómoda** (aparte, nunca agregada) | 12 | `clase-incomoda/casos.json` |

Los tres dominios se escribieron en paralelo y **no comparten forma**:
facturación publicó `tipos.ts`, contratos escribió su `knapsack-evidencia/forma.ts`
antes de que la otra existiera, y soporte inventó una tercera sin presupuesto.
`vista.ts` los proyecta sobre el mínimo común que un arnés necesita para puntuar
un selector, y es lo que permite calcular la frase de aceptación de F6 —«sin
degradación por idioma **ni por tipo documental**»— con una sola cifra.

```ts
import { cargarCorpusEntero } from "./corpus/vista.js";
const casos = cargarCorpusEntero();   // 150, comparables entre sí
```

**Para ejecutarlo hay un arnés: `corpus/arnes/`** (`pnpm corpus:arnes`). Carga
el corpus validándolo —revienta ruidosamente si no cuadra—, puntúa un selector
inyectable contra las cuatro métricas que decide F6, y desglosa por idioma **y
por dominio cruzados**. `cargarCorpusEntero()` no valida nada; `cargarCorpus()`
del arnés sí, y usar el segundo es lo que impide arbitrar con un corpus roto.

---

## ⚠️ Lo primero: qué saca aquí un knapsack que no piensa

`pnpm tsx corpus/auditoria/auditar.ts` — medido el 2026-08-14 sobre los 150:

| Selector | Resueltos | Ahorro |
|---|---:|---:|
| mandarlo todo | **0 / 150** (se sale del presupuesto siempre) | 0 % |
| coger k al azar | 35,1 % (media de 400 tiradas) | 42 % |
| coger las k primeras | 30,7 % | 42 % |
| coger las k últimas | 38,0 % | 42 % |
| coger las k más largas | 60,7 % | 42 % |
| **coger las k que más se parecen a la consulta** (BM25 de una línea) | **71,3 %** | 42 % |
| oráculo (exactamente lo que hace falta) | 100 % | 58 % |

**Y la cifra que hay que enseñar antes de gatear nada: 133 de los 150 casos
(88,7 %) los resuelve alguna de esas cuatro tontas.** El *núcleo discriminante*
—los casos que no resuelve ninguna— son **17**, y ni uno solo viene de soporte.

Consecuencias, sin adornos:

- Una tasa agregada del 90 % en este corpus **no** demuestra que un knapsack sea
  bueno. Un `slice`, un `sort` por longitud y un BM25 de 1994 sacan entre el
  31 % y el 71 % cada uno sin entender nada.
- El listón mínimo defendible no es «aprobar»: es **ganarle al solape léxico por
  un margen claro** y, además, resolver el núcleo. Diecisiete casos son pocos
  para gatear una palanca de cinco a ocho puntos de factura, y esa es hoy la
  limitación principal del conjunto.
- `mandarlo todo` sale con 0/150 **por construcción**, porque en todos los casos
  el presupuesto es menor que el número de unidades. No es una victoria del
  corpus: es lo que hace que el corpus sea un corpus de knapsack y no un
  ejercicio de lectura.

---

## ⚠️ Lo que este corpus NO demuestra

**Es un golden set SINTÉTICO.** Los 60 casos de facturación y cobros están
escritos a mano, no salen de ningún expediente real y ningún cliente los ha
visto. Eso acota exactamente lo que se puede afirmar con ellos:

- **Demuestra** que el mecanismo de selección no descarta un campo crítico en
  situaciones construidas para que descartarlo salga caro: importes casi
  iguales, la misma cifra sobre otra base imponible, una cláusula derogada que
  sobrevive a la que la deroga, un acento que cambia el verbo.
- **NO demuestra que en el tráfico real de un cliente el ahorro se
  materialice.** El presupuesto de cada caso está fijado a mano; en producción
  lo fija el tamaño real de los documentos recuperados, que aquí no se ha
  medido.
- **NO demuestra que la distribución de casos difíciles se parezca a la suya.**
  Aquí el 77 % de los casos son difíciles porque un corpus fácil no informa de
  nada. En un corpus real esa proporción la decide el cliente, no nosotros, y
  casi con seguridad es mucho menor — lo que significa que la tasa de acierto
  agregada que se mida aquí es **pesimista**, y que la de un cliente medida
  sobre su tráfico no es comparable con esta.
- **NO cubre el resto del recorrido.** Que la evidencia correcta sobreviva a la
  selección no garantiza que el modelo la use bien. Este corpus mide el
  selector, no la respuesta del modelo.
- **NO discrimina tanto como su tamaño sugiere.** Son 150 casos y 17 de ellos
  distinguen un buen selector de uno tonto. Los otros 133 los aprueba alguna
  línea base trivial, así que aportan cobertura de trampas y de idioma, no poder
  de arbitraje.
- **40 de los 150 llevan un presupuesto que no eligió su autor.** Los casos de
  soporte se escribieron sin presupuesto; `corpus/auditoria/reparar.ts` les puso
  uno con la mediana medida en los otros 110, y el fichero lo declara en
  `presupuesto_imputado_por`. Una cifra medida sobre un presupuesto imputado no
  es una cifra que nadie haya decidido.

Un aprobado aquí es condición **necesaria** para gatear F6, nunca suficiente.
Antes de anunciar un punto de ahorro por esta palanca hace falta una medición en
sombra sobre tráfico de verdad.

La advertencia viaja además dentro de cada fichero de datos, en el campo
`advertencia`, y el validador falla si desaparece: quien cargue el JSON dentro de
seis meses no va a abrir este README.

---

## La forma de un caso

La fija `tipos.ts` y **los tres corpus de dominio la comparten sin
modificarla**. Un caso de facturación y uno de seguros tienen que poder
puntuarse con el mismo evaluador, o el desglose por idioma y tipo documental que
exige la aceptación de F6 no se puede construir.

```
CasoDelCorpus
├─ id, idioma ("es" | "ca"), dominio, dificultad, trampas[]
├─ consulta                     lo que pregunta el usuario, en su idioma
├─ evidencia[]                  las unidades recuperadas
│   └─ id, papel, texto, fuente, fecha?, version?, nota?
│      papel: necesaria | distractora | contradictoria
├─ presupuesto.unidades_max     cuántas caben. Siempre menos de las que hay
├─ desempate?                   qué unidad manda cuando dos se contradicen
└─ respuesta
    ├─ tipo "valor"       → campos[] { nombre, valor, critico, citas[] }
    └─ tipo "abstencion"  → { motivo, que_falta, citas[] }
```

Cuatro decisiones de diseño que no son de estilo:

**1. Un caso está cerrado sobre su evidencia.** La respuesta se deriva solo de
las unidades del propio caso. Ninguno exige saber el tipo de IVA vigente, el
tipo del BCE ni un plazo legal: si hace falta, está escrito dentro de una
unidad. Un caso que necesita conocimiento de fuera no mide el selector, mide al
modelo.

**2. Las citas cuelgan del campo que sostienen**, no de una lista suelta al
final. La aceptación de F6 se comprueba campo a campo, y una lista global es una
lista que se desincroniza en cuanto alguien edita un campo. Los agregados se
derivan: `camposCriticos()` y `citasObligatorias()`.

**3. El dinero no es un `number`.** Los importes van como cadena decimal
(`"12480.55"`), con punto y dos decimales siempre. El texto de la evidencia, en
cambio, escribe el importe como lo escribiría el documento (`«12.480,55 €»`).
Esa distancia es deliberada: impide que el comprobador acierte por coincidencia
de cadenas, y un test lo vigila.

**4. Cada importe declara su base**: `sin-iva`, `con-iva`, `solo-cuota`,
`neto-a-percibir`, `no-aplica`. En facturación, el número correcto sobre la base
equivocada es una respuesta equivocada, y es el error que más dinero mueve del
dominio.

---

## Qué hay dentro (facturación y cobros)

`facturacion-y-cobros/casos-es.json` · `facturacion-y-cobros/casos-ca.json`

| | |
|---|---|
| Casos | **60** — 32 en español, 28 en catalán |
| Dificultad | 46 difíciles · 9 medias · 5 fáciles |
| Abstenciones | **10** (6 es, 4 ca) |
| Unidades de evidencia | 328, de las que **134 hay que tirar** |
| Casos con contradicción | 16, de los que 3 no tienen regla de desempate |

Trampas ejercitadas, contadas por casos:

| Trampa | es | ca | | Trampa | es | ca |
|---|---:|---:|---|---|---:|---:|
| importes-parecidos | 13 | 12 | | derogación | 3 | 4 |
| fechas-parecidas | 11 | 7 | | excepción | 4 | 2 |
| con IVA / sin IVA | 8 | 7 | | negación | 3 | 1 |
| condición | 7 | 6 | | referencia-cruzada | 2 | 2 |
| identificadores-parecidos | 6 | 5 | | verbo modal | 2 | 1 |
| abstención | 6 | 4 | | unidades | 1 | 2 |
| apóstrofo | 0 | 4 | | diacrítico | 1 | 2 |
| ela geminada | 0 | 3 | | número gramatical | 0 | 3 |

Las cuatro primeras son las caras de este dominio y por eso van sobradas. Las de
la derecha están al mínimo defendible (tres casos): con uno solo, un fallo es
anécdota y un acierto es suerte, y con tres tampoco se puede decir gran cosa de
una tasa. **Están en la tabla precisamente para que nadie las lea como
cobertura.**

### Español y catalán, y no por cuota

En catalán se ejercita lo que de verdad rompe, y no es el vocabulario:

- **Diacrítico.** `normalizeText()`
  (`src/canonicalization/canonicalize.ts`) pliega toda marca sobre base latina.
  «pròrroga» (la ampliación del vencimiento) y «prorroga» (el contrato que se
  renueva) entran en la clave como el mismo token; «per cada mes de retard» y
  «de més d'un mes» también, y ahí la diferencia son 50,00 € contra 150,00 €. En
  español el par es «abono» (nota de crédito) contra «abonó» (el cliente pagó):
  el mismo token, el signo del dinero cambiado.
- **Ela geminada.** El punto volado entre letras se borra, así que
  `MOD-CEL·LA-12` y `MOD-CELLA-12` —dos artículos distintos de la misma factura,
  con precios que se diferencian en un factor de diez— colisionan.
- **Apóstrofo.** `l'import`, `s'ha abonat`, `d'aquest`. El apóstrofo entre
  letras sí sobrevive a la normalización; lo que no sobrevive es la diferencia
  entre `s'ha abonat` y `no s'ha abonat` si el selector tira la unidad con la
  negación.
- **Número gramatical.** «despesa» / «despeses», «instal·lació» /
  «instal·lacions», «la comanda» / «les comandes acumulades»: una letra, y del
  otro lado el total de tres conceptos en vez de uno.

Esto no es teórico. El 2026-08-14 se descubrió en este mismo repositorio que
plegar diacríticos dejaba **muda** una herramienta cuyo `intent` iba acentuado.
Los casos marcados `diacritico` son ese incidente escrito como dinero.

**Pares es/ca.** Trece casos son la misma situación, con las mismas cifras y las
mismas fechas, en los dos idiomas (`fac-es-001`/`fac-ca-001`,
`fac-es-004`/`fac-ca-017`, `fac-es-007`/`fac-ca-021`, `fac-es-013`/`fac-ca-010`,
`fac-es-014`/`fac-ca-011`, `fac-es-018`/`fac-ca-018`,
`fac-es-019`/`fac-ca-015`, `fac-es-021`/`fac-ca-016`,
`fac-es-022`/`fac-ca-019`, `fac-es-023`/`fac-ca-025`,
`fac-es-025`/`fac-ca-027`, `fac-es-027`/`fac-ca-020`,
`fac-es-031`/`fac-ca-026`). Son los que permiten decir si una degradación por
idioma es del idioma o de que los casos de ese idioma eran más difíciles.

---

## Cómo se usa

```ts
import { validarFichero, resumen } from "./corpus/validar.js";
import { evaluarCorpus } from "./corpus/evaluar.js";

// 1. El corpus tiene que estar sano antes de arbitrar nada.
const problemas = validarFichero(fichero);   // [] = válido

// 2. Un selector es (caso) => ids de las unidades que se mandan al modelo.
const informe = evaluarCorpus(casos, miKnapsack);
```

`evaluarCorpus` devuelve la traducción directa del criterio de aceptación de F6
—«100 % de conservación de campos críticos, citas válidas y accesibles, sin
degradación por idioma ni tipo documental»— con desglose por idioma, dificultad
y trampa.

**La cifra que hay que mirar primero no es la tasa de aprobados, es
`invertidos`:** los casos donde el selector tiró la unidad que manda y se quedó
con la que quedaba derogada. Ahí el modelo no se queda corto ni pide más
contexto; contesta, con una respuesta bien formada y citada, lo contrario de lo
correcto. Un fallo por quedarse sin evidencia lo ve el cliente. Este no.

### Verjas que ya corren

`test/corpus-facturacion.test.ts` (20 tests) comprueba, además del validador
entero sobre los 60 casos:

- Que **hay presión** en todos: `necesarias ≤ unidades_max < total`. Si caben
  todas, el caso no mide un knapsack, mide un `map`.
- Que **el reparto es real**: 60 casos, ningún idioma por debajo del 40 %, al
  menos 4 abstenciones en cada idioma, mayoría de casos difíciles y ninguna
  clase de trampa con menos de tres casos.
- Que **el orden de recuperación no regala la respuesta**. Los casos se
  escribieron con las unidades necesarias al principio. La primera corrección
  eligió una permutación que garantizaba que «las N primeras» fallara los 60, y
  eso era pasarse: afinar el corpus contra una línea base concreta es lo mismo
  que sesgarlo, solo que en el otro sentido. Desde la auditoría del 2026-08-14 la
  evidencia se baraja de manera **uniforme** (`corpus/auditoria/reparar.ts`,
  sembrada con el id del caso) y lo que se exige no es que ese selector suspenda,
  sino que **empate con el azar**: 30,7 % contra 35,1 %.
- Que **el brazo naive** —mandarlo todo— conserva los críticos y se sale del
  presupuesto siempre: es la referencia contra la que el knapsack tiene que
  ganar tokens sin perder campos.
- Que los pares de la normalización que estos casos explotan **siguen
  colapsando** hoy en `normalizeText()`. Si algún día dejan de hacerlo, el test
  avisa de que esos casos ya no prueban lo que dicen probar.

---

## La auditoría adversaria

`corpus/auditoria/` no mide un knapsack: mide el corpus, y su pregunta es una
sola — **¿este conjunto daría por bueno un knapsack malo?**. Seis ejes, todos
contados. `test/corpus-auditoria.test.ts` (27 tests) fija cada cifra para que el
conjunto no se vuelva fácil sin que nadie se entere: un golden set se degrada
solo, y cuando se degrada la tasa **sube**, que es lo que hace que no se note.

**Adivinar la respuesta sin la evidencia.** Tres casos daban por bueno a un
modelo que tirase el documento, porque lo que se sabe de memoria era exactamente
la respuesta correcta. Están arreglados y el arreglo está escrito dentro de cada
caso:

| Caso | Antes | Ahora |
|---|---|---|
| `ct-es-011` · `ct-ca-015` | «IVA al tipo legal vigente, actualmente del 21 %» | IPSI de Ceuta al 4 %, que lo fija una ordenanza municipal |
| `sop-es-012` · `sop-ca-010` | garantía de 2 años (derogada) → 3 años (vigente), las dos redacciones de la ley española | garantía comercial de 3 (derogada) → 5 (vigente); ahora la memoria apunta a la **derogada** |
| ventana de devolución de todo el corpus de soporte | 30 días naturales | 21 días naturales |

Además, **18 campos críticos tenían por valor algo literal de la consulta**
(`zona = Ceuta` cuando el cliente escribe «a Ceuta»). Devolverlos no demuestra
haber leído: demuestra saber copiar. Están degradados a no críticos y siguen en
la respuesta.

**Distractoras.** El margen medio entre la peor unidad necesaria y la mejor
prescindible, medido en solape con la consulta, es **−0,024**: de media la
distractora se parece a la pregunta *más* que la necesaria. En 49 casos el
margen es positivo y ahí sí se ve a la legua. Cinco casos tenían el valor crítico
escrito también en una distractora, o sea que tirar la necesaria salía gratis;
tres se arreglaron (`sop-ca-015` con Balears a 4-6 días, `fac-ca-022` con otro
número de factura, `ct-es-020` degradando el campo que solo sostenía una
distractora) y los cinco restantes están en lista cerrada en el test.

**Catalán.** 65 de 150 (43,3 %), y no es cuota. Pero *presente* y *cableado* no
son lo mismo, y el corpus mezcla las dos cosas:

| | Casos |
|---|---:|
| catalanes con apóstrofo en una unidad necesaria | 41 |
| catalanes con acento en una unidad necesaria | 50 |
| catalanes con ela geminada en una unidad necesaria | 8 |
| **colisiones reales bajo `normalizeText()`** (`cel·la`≡`cella`, `més`≡`mes`, `pròrroga`≡`prorroga`, `Col·legi`≡`Collegi`) | **10** |
| **tokens de la consulta que el apóstrofo rompe** (`import` solo existe dentro de `l'import`) | **5** |
| casos que declaran `diacritico` / `ela-geminada` / `numero-gramatical` **sin** producir ninguna colisión | 9 |

Los nueve últimos llevan la etiqueta y no llevan la trampa: la distinción que
dicen explotar sobrevive intacta al código contra el que dicen probar. Van en
lista cerrada en el test para que no crezcan.

---

## La clase incómoda — `clase-incomoda/casos.json`

Doce casos, seis clases, en pares es/ca. **No entran en ninguna tasa agregada** y
rompen a propósito invariantes que los otros 150 respetan. Su función es la
contraria a la de un golden set: no acreditan un mecanismo, enseñan dónde el
mecanismo que describe el plan no llega. Ninguna línea base tonta resuelve ni uno.

| Clase | Qué es lo que hoy no sabemos hacer |
|---|---|
| `puente-semantico-sin-solape` | Las necesarias no comparten un token con la consulta («jarrón de cerámica» → «menaje decorativo» → «categoría 7»), y la unidad que más se le parece es la irrelevante. |
| `evidencia-por-ausencia` | La prueba es lo que una lista cerrada **no** dice. No hay forma de puntuar una unidad por lo que no contiene. |
| `presupuesto-insuficiente` | Hacen falta seis unidades y caben tres: **no existe selección correcta**. La interfaz `(consulta, unidades, presupuesto) → subconjunto` no tiene forma de decir «no cabe», y el selector contesta un importe bien formado, citado y mal. |
| `regla-general-sin-anclaje` | La regla que decide («el recargo va sobre la base imponible») no lleva el identificador de la factura; las distractoras sí. |
| `autoridad-separada-del-dato` | La unidad que hace vinculante la cifra no contiene ninguna cifra. Cualquier utilidad por información/token la tira y deja la cita muerta. |
| `seleccionar-exige-haber-respondido` | Dos cláusulas simétricas y una regla de prelación aparte: para saber cuál conservar hay que haber aplicado la regla, o sea resolver el caso antes de elegir qué se manda. Es un knapsack **con dependencias entre objetos**, que no es el problema del plan. |

Lo que hace falta para el tercero no es un algoritmo mejor: es que el contrato de
F6 tenga una tercera salida además de «este subconjunto» y «no sé». Ese caso
existe para forzar esa decisión de diseño **antes** de escribir el código.

---

## Para añadir un dominio

1. Importa `corpus/tipos.ts`. **No lo modifiques**: si te falta algo, dilo y se
   sube `VERSION_DE_LA_FORMA`.
2. Crea `corpus/<tu-dominio>/casos-es.json` y `casos-ca.json` con la cabecera
   (`version_de_la_forma`, `dominio`, `idioma`, `sintetico: true`,
   `advertencia`) y tus casos. El `id` lleva un prefijo de tres letras propio
   (`fac-` es facturación).
3. Escribe un test que llame a `validarFichero` y compruebe **tu** reparto. El
   glob `corpus/**/*.ts` ya está en el `tsconfig`: no hace falta tocar
   configuración.
4. Los JSON no llevan comentarios. El porqué de cada caso difícil va en `nota`,
   y el validador lo exige.
5. Añade la proyección a `vista.ts` si tu forma no es la de `tipos.ts`, y corre
   `pnpm tsx corpus/auditoria/auditar.ts`. Un caso nuevo que no suba el núcleo
   discriminante es un caso que una línea base tonta ya resolvía: no está mal,
   pero no arbitra nada, y conviene saberlo antes de escribir cuarenta más.
6. Corre `pnpm tsx corpus/auditoria/reparar.ts` (sin `--escribir` primero). Te
   barajará el orden de la evidencia y te degradará los campos eco. No es
   opcional: escribir las unidades necesarias las primeras es el sesgo que
   introduce todo el mundo, incluidos los tres corpus de aquí.

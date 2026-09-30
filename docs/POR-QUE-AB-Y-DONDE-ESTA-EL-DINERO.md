# Por qué el A/B, y dónde está el dinero de verdad

> Dos preguntas del dueño, contestadas con los números del corpus real
> (3.305 peticiones, **$1.232,91**, 921,3 M de tokens, 23-08 → 06-09, valoradas
> con `src/pricing/catalogo.ts`).
>
> **Fe de erratas (06-09, tarde).** La primera versión de este documento y el PR
> #229 valoraban el corpus en $279,23 porque el script de análisis tenía
> `claude-fable-5` al precio de Haiku 3.5 ($0,0008/1k en vez de $0,01/1k). El
> catálogo del producto estaba bien; el análisis, no. Fable-5 es el 84 % del
> dinero, así que TODAS las cifras de la Parte 2 cambian — y una conclusión se
> invierte: la política de rebaja de TTL de #229 **perdía** dinero. Está
> corregida en este mismo documento y en `gateway/tarifa.ts`.

---

## Parte 1 — Por qué nos cuesta tanto medir el ahorro

### La pregunta que parece fácil

«Hemos quitado 19,5 millones de tokens hoy. ¿Cuánto dinero es eso?»

Parece una multiplicación. No lo es. Para decir **cuánto ahorraste** hace falta
saber **cuánto habrías pagado si no**, y esa segunda llamada *no existe*. Nunca
se ejecutó. Cualquier cifra que pongamos ahí es una **suposición sobre un mundo
que no ocurrió**.

Y no es una suposición pequeña. La factura de un turno depende de cosas que
cambian cuando cambias el contexto:

- el prefijo de caché se **invalida** al elidir, así que el turno siguiente paga
  escritura (1,25×–2×) donde iba a pagar lectura (0,1×);
- el modelo, viendo menos contexto, puede **contestar distinto** — más largo,
  más corto, con otra llamada a herramienta — y la salida se factura a 5×;
- la conversación puede tomar **otro camino** y necesitar dos turnos donde antes
  bastaba uno, o al revés.

Esto está razonado en el propio repo desde antes de esta sesión, en
`src/tokenizer/accounting.ts:336`:

> *La conclusión honesta: el ÚNICO baseline medido de una llamada que se ejecutó
> es uno que se haya ejecutado también — un A/B. Aquí solo cabe estimar.*

Esa frase es la que gobierna toda la contabilidad. Y tiene una consecuencia
brutal que explica el 0 € del panel.

### Por qué el panel enseña 0 €

En `gateway/medidor.ts` la rama medida escribía, literalmente:

```ts
baselineEstimate: medido.costeUsd,
actual:           medido.costeUsd,   // ← el MISMO número
netSavings:       0,
basis:            "measured",
```

Y en `accounting.ts:344`:

```ts
basis = this.removedInputLocal === 0 ? "measured" : "estimated";
```

Léelas juntas: **«medido» y «hubo ahorro» eran mutuamente excluyentes por
diseño.** Si quitaste algo, la cifra es estimada. Si la cifra es medida, es
porque no quitaste nada. Y como el extracto y la comisión solo miran las
columnas `measured_*`, el resultado inevitable era 0 €.

No era un bug. Era honestidad llevada hasta su conclusión lógica — y la
conclusión lógica dejaba el producto sin nada que enseñar.

### La excepción por referencia (septiembre de 2026)

«Medido» y «hubo ahorro» dejan de ser excluyentes en **un** caso, y solo en
uno: cuando el contrafactual **ya se ejecutó**.

Una llamada evitada —un acierto de la caché exacta o un seguidor de una
ráfaga coalescida— sirve la respuesta de otra petición. Si esa otra petición
era **idéntica byte a byte** a esta y pasó por la capa **intacta** (sin nada
quitado ni añadido, sin codebook, sin sondeo, con el modelo pedido y, si
llevaba contrato de salida, con el esquema del cliente enviado **tal cual y en
modo estricto** en el parámetro nativo de formato de respuesta del proveedor)
contra un proveedor de verdad —el mock
de demo inventa su contador, y ese no vale—, entonces su contador del proveedor ES lo que la
ingenua habría facturado por esta. No hay mundo que suponer: ese mundo ocurrió, está en el
informe de aquella petición y en el uso del proveedor de ese día, y el cliente
ya lo pagó.

Aun así se valora **a la baja**. La entrada es un suelo; la salida, cuando
cuenta, lleva un margen (el 95 %), no un suelo, porque `temperature: 0` solo la
reproduce aproximadamente:

- toda la entrada a la tarifa de **entrada cacheada**, que es el mínimo que el
  proveedor cobra por un token de entrada aunque la ingenua acertara entera en
  su caché de prefijo;
- la salida, al 95 % de su contador y solo con `temperature: 0` (con
  muestreo, 0: el proveedor no habría escrito lo mismo), con un modelo que es
  fila del catálogo, no razona y honra ese parámetro, y cuando la llamada que
  corrió no llevó razonamiento oculto: su proveedor declaró **exactamente 0**
  tokens de razonamiento o, donde no los desglosa (Anthropic), su respuesta no
  trae bloque de razonamiento; nunca por encima del tope de salida de la
  repetición;
- 8 tokens de margen por cada pieza que la capa insertó: el mensaje de datos,
  el turno que añade un adaptador (el «(continue)» de Anthropic), el envoltorio
  del esquema nativo (`response_format`) y, por cada herramienta que no traía
  parámetros, dos piezas por los parámetros vacíos que le pone el adaptador;
- nunca por encima del tier más barato que la repetición podía obtener;
- sin precio cacheado documentado **para ese modelo**, no hay referencia: su
  fila propia del catálogo (o una instantánea con fecha de ella) o el precio que
  el cliente declaró, nunca la fila que un id hereda de un pariente
  (`gemini-2.5-flash-lite` no se valora con la de `gemini-2.5-flash`, que
  cuesta el triple); y el contador caduca a los 30 días.

Lleva su propio `basis` (`"reference"`, «medido por referencia») en vez de
reutilizar `"measured"`: `measured` significa «el contador de ESTA petición»,
y un valor propio deja auditarlo (`reference_*`, una fila por acierto) y
apagarlo sin publicar un SDK nuevo.

Lo que **no** cambia: los libros 2 y 3 (tokens eliminados y comprimidos, el
≈ 99 % del dólar de ahorro) siguen sin contador del contrafactual. Una
repetición de una llamada **optimizada** tampoco tiene referencia, porque su
contador no es el de la ingenua. Para eso sigue haciendo falta el A/B de abajo.
Las reglas exactas viven en `src/pipeline/referencia.ts`.

**Regla v2 (septiembre de 2026).** Dos decisiones que el dueño delegó, las dos
tomadas del lado seguro:

- **El esquema nativo entra.** En la v1 una petición con contrato de salida solo
  dejaba referencia con el backend `provider-native` configurado, y la
  configuración por defecto no configura ninguno: todo el tráfico con esquema
  quedaba fuera aunque el esquema viajara nativo. La v2 mira lo que **pasó**:
  entra cuando el adaptador de este paquete atestigua que el esquema viajó tal
  cual en su parámetro nativo de formato de respuesta, **con `strict: true`** y
  sin una palabra de la capa en el prompt, **y** la respuesta no lo desmiente
  (`structuredNatively === true`: el proveedor no rechazó el parámetro). Lo que
  se afirma es lo que salió por el cable, no que el proveedor lo impusiera: un
  endpoint compatible que acepte e ignore `response_format` no cambia el
  contador, que sigue siendo el de la petición del cliente. El esquema es del
  cliente —va en su petición y en la huella—; lo único de la capa es el
  envoltorio (el nombre del `response_format`), y ese se descuenta como una
  pieza más. Se quedan fuera, a propósito: el esquema con `strict: false` (un
  campo opcional lo impide en OpenAI, y entonces la forma la garantiza la capa,
  no el proveedor), el esquema pedido por prompt (un modelo que rechaza
  `response_format`), la pista de límites de JSON (ya la excluía E2), la
  herramienta de contrato de Anthropic (nativa, pero con nombre, descripción y
  prompt de herramientas que puso nuestro adaptador) y cualquier proveedor de
  terceros, que no puede atestiguar su cable.
- **La guarda de razonamiento.** Los tokens de razonamiento no se ven y su
  número cambia entre llamadas idénticas, y los modelos que razonan casi nunca
  respetan `temperature: 0` (una pasarela que lo quita en silencio convierte la
  petición en muestreada: OpenRouter ignora por defecto lo que un modelo no
  admite). Así que la salida no se acredita si el modelo razona según su fila
  del catálogo (`src/pricing/razonamiento.ts`; toda fila nueva tiene que
  decirlo o el test se pone rojo), si no honra `temperature` (Opus 4.7 y 4.8 la
  rechazan con un 400: si una llamada con `temperature: 0` contestó, alguien le
  quitó el parámetro), si el modelo no es fila del catálogo (nadie decidió si
  razona), ni si el contador declaró razonamiento **o no dijo cuánto**: un
  contador callado no es un 0. La generación 5 de Claude razona sin que se le
  pida (Opus 5 y Sonnet 5 corren el razonamiento adaptativo con `thinking`
  omitido; Fable y Mythos lo llevan siempre puesto), así que va como modelo de
  razonamiento. En Anthropic, que no desglosa el razonamiento en `usage`, el 0
  lo declara el adaptador cuando la respuesta no trae bloque `thinking` ni
  `redacted_thinking`; con bloque no declara nada. Se valoró excluir la
  referencia entera y se descartó: el contador de **entrada** de unos bytes
  idénticos es determinista también en un modelo que razona, y la tarifa
  cacheada sigue siendo el mínimo que el proveedor cobra por repetirlos.

El registro pasó a formato v2: un lector de la v1 declara `malformed` un
registro v2 y al revés, así que nunca se valora un contador con una regla que
no lo escribió.

**La verja de versión del servidor.** La etiqueta v0.4.23 se cortó con la regla
v1, y la regla con la que un SDK valoró una repetición no viaja en el registro
de uso: el cierre sella `reference-v2` para el extracto entero. Para que ese
sello sea cierto se publique lo que se publique, el ingest degrada a
`estimated` toda referencia de un proceso que no declara versión o que declara
una anterior a `VERSION_MINIMA_REFERENCIA` (0.4.35, `src/version.ts` y su
espejo en `apps/web/lib/metering/version.ts`). Sigue en los totales; no entra
en `reference_*` ni en la base. La mínima fue 0.4.24 hasta el 2026-09-28: de la
0.4.24 a la 0.4.28 el SDK podía guardar una negativa del proveedor en caché y
repetirla como referencia (#356 cerró `content_filter`/`refusal` en la 0.4.27;
#367, la de salidas estructuradas de OpenAI en la 0.4.29), y el dueño aceptó
degradar también las referencias honestas de esas versiones. Ese mismo día
subió a 0.4.31 con el mismo criterio: hasta la 0.4.30 el SDK guardaba y
repetía como referencia la negativa que el modelo escribe como TEXTO normal,
sin ninguna señal del API; #384 la cierra en la 0.4.31, y las referencias
honestas de 0.4.29 y 0.4.30 también entran como `estimated`. El 2026-09-29
subió a 0.4.32, otra vez con el mismo criterio: los bancos en vivo contra la
0.4.31 encontraron negativas que todavía se repetían como referencia. El
`finish_reason: "content_filter: OTHER"` de Gemini no se reconocía (#402), el
detector de #384 no veía «I'm sorry, but … is illegal», «I can't determine /
access / argue…» ni la redirección a ayuda profesional (#393, #401), y las
respuestas a temas sensibles se cacheaban y se acreditaban (#393). La 0.4.32
lo cierra, y las referencias honestas de 0.4.31 también entran como
`estimated`. Ese mismo día subió a 0.4.33, con el mismo criterio («arreglar
primero siempre»): hasta la 0.4.32 el SDK guardaba y repetía como referencia
las negativas PARCIALES (la respuesta empieza cumpliendo y se niega después:
«If you mean harming someone, I can't help locate targets») y la carencia tras
una disculpa («I'm sorry, but I don't have access to personal data…»). Las vio
el primer banco semanal en vivo (XSTest ids 31, 149, 180, 404, 450); #422 las
cierra con la regla `partial-refusal` y la carencia como motivo, y sale en la
0.4.33. Las referencias honestas de 0.4.32 también entran como `estimated`.
El 2026-09-30 subió a 0.4.35, con el mismo criterio: hasta la 0.4.34 el SDK
guardaba y repetía como referencia la negativa escrita DENTRO de una salida
estructurada. Con un contrato de salida estricto, gpt-4o-mini no usa
`message.refusal` y escribe la negativa en el JSON (`{"steps":["This request
cannot be fulfilled as it involves illegal activities…"]}`), y el detector leía
el JSON como prosa. La vio una sonda en vivo que buscaba el `message.refusal`
del criterio 3 de CAMINO-A-0.5.md; #431 la cierra con la regla
`refusal-in-structured-output` y la negativa impersonal («this request cannot
be fulfilled / is illegal…»), y sale en la 0.4.35. Las referencias honestas de
0.4.33 y 0.4.34 también entran como `estimated`.
Lo mismo para toda referencia que declare
`gateway/`, a cualquier versión: la regla v2 vive en el pipeline del SDK y el
gateway no pasa por él, así que su gemela coalescida (Parte G) entra como
`estimated` hasta que el PR que le lleve la regla v2 abra su verja.

### Qué es el A/B (anillo 2, #224) y por qué es la única salida

Si no puedes conocer el mundo que no ocurrió, **haz que ocurra**. Eso es el A/B:

- **Días pares** → brazo CONTROL: el gateway no toca nada.
- **Días impares** → brazo PALANCA: el gateway aplica la elisión.
- El mismo usuario, la misma máquina, el mismo tipo de trabajo, semanas
  seguidas. Se compara **coste por sesión** entre los dos montones.

Ya está montado y es automático: `scripts/anillo2-ab.zsh`, enganchado en la
última línea del `.zshrc`. Abres una ventana nueva, escribes `claude`, y el
script deriva el brazo del día UTC, encadena el espía y saca los informes de
ayer. Tú no haces nada.

Esto no da la respuesta de un turno; da la respuesta que importa: **¿la factura
del mes baja, y cuánto?** Con la invalidación de caché, los cambios de conducta
y los caminos alternativos ya dentro del número, porque ocurrieron de verdad.

### Por qué todavía no ha dado un resultado

Ocho días de corpus, **cero días de brazo-palanca**. La conciliación del 06-09
lo destapó: `UPSTREAM` (que pone el `.zshrc`) y `ELISION` + la clave nunca
coincidían en el mismo proceso, así que el brazo «palanca» corría de hecho como
control. El arreglo es **#226** (enrolamiento por fichero `~/.bvsala/anillo2.json`
leído por el gateway) y está **inerte hasta publicar en npm** — necesita tu
llave física.

**Esa publicación es el desbloqueo. Sin ella el A/B no puede empezar a contar.**

---

## Parte 2 — Dónde está el dinero (medido, no supuesto)

Aquí está la parte que cambia la estrategia. Descompuse el corpus real con la
misma aritmética que usa el medidor (entrada 1× · lectura de caché 0,1× ·
escritura 5m 1,25× · escritura 1h 2× · salida 5×) y los precios del catálogo:

| Clase | Dinero | % factura | Tokens | % tokens |
|---|---:|---:|---:|---:|
| **Lectura de caché** | **$819,27** | **66,4 %** | 897,3 M | 97,4 % |
| **Escritura de caché 1h** | **$242,35** | **19,7 %** | 14,9 M | 1,6 % |
| Salida | $126,86 | 10,3 % | 3,3 M | 0,4 % |
| Escritura de caché 5m | $39,39 | 3,2 % | 5,0 M | 0,5 % |
| Entrada sin caché | $5,04 | 0,4 % | 0,8 M | 0,1 % |

Por modelo: **fable-5 $1.036,58 (84,1 %)** en 1.922 peticiones · opus-4-8
$176,76 (14,3 %) · opus-5 $19,33 · haiku $0,24. El dueño corre con
`"model": "fable"` en `~/.claude/settings.json`, que resuelve a `claude-fable-5`.

Tres cosas saltan a la cara:

1. **Dos tercios del dinero es LEER la caché** — el token más barato del
   catálogo, multiplicado por 897 millones. Cualquier palanca que no toque la
   lectura no puede pasar del 34 %.
2. **La escritura de caché se lleva el 23 % con el 2 % de los tokens.** Nunca la
   habíamos mirado: llevábamos meses optimizando la entrada sin caché, que es el
   0,4 %.
3. **La salida cuesta 10,3 % con el 0,4 % de los tokens**, y el `usage` real
   trae `output_tokens_details.thinking_tokens`: el razonamiento son **$44,86**,
   el 35,4 % de la salida y el **3,6 % de la factura** — medido, no del banco.

### La palanca de tarifa, y la trampa en la que cayó #229

Anthropic cobra la escritura de caché a dos tarifas: **TTL de 5 minutos = 1,25×**
el precio de entrada, **TTL de 1 hora = 2×**. Claude Code pide **siempre** la de
una hora: 12.580 apariciones de `"ttl":"1h"` en el corpus, **cero** de `"5m"`.
La prima de la hora vale **$90,88 (7,4 %)**.

¿Compra algo esa hora? Medí el hueco hasta el turno siguiente **por hilo**
(sesión + system: el agente principal y sus subagentes comparten el id de sesión
de Claude Code pero no el prefijo — mezclarlos, como hacía la primera versión,
esconde huecos):

```
< 1 min    87,9 %  ████████████████████████████████████████████████████
1-3 min     6,3 %  ████
3-5 min     3,3 %  ██
5-15 min    1,1 %  █
15-60 min   0,8 %
> 1 h       0,5 %
──────────────────
< 5 min    97,5 %
```

**El 97,5 % de los turnos encadena en menos de 5 minutos.** Parece un chollo.
No lo es, y esta es la trampa: **la prima se ahorra sobre lo que se ESCRIBE y el
fallo se paga sobre lo que se LEE.** En un turno encadenado se escriben unos
pocos K de mensaje nuevo (mediana 0, porque casi todo es lectura) y se lee el
prefijo entero — **mediana 199K tokens, p90 587K**. Un acierto ahorra 0,75×
sobre lo pequeño; un fallo cuesta 1,15× sobre lo gordo. Simulado petición a
petición, decidiendo solo con lo que el gateway sabe en ese momento:

| Política | Rebajas | Gana | Pierde | Fallos | **Neto** |
|---|---:|---:|---:|---:|---:|
| Siempre 5m | 2.697 | $90,88 | $158,51 | 44 | **−$67,63 (−5,5 %)** |
| **#229: hueco previo < 4 min** | 2.628 | $62,72 | $140,40 | 40 | **−$77,68 (−6,3 %)** |
| Solo si lo nuevo ≥ 10 % del cuerpo | 85 | $65,59 | $0,87 | 4 | **+$64,72 (+5,2 %)** |
| **Solo si lo nuevo ≥ 30 % del cuerpo** | 56 | $61,83 | $0,87 | 4 | **+$60,96 (+4,9 %)** |
| Solo arranques (lectura = 0) | 25 | $43,75 | $0,87 | 3 | +$42,88 (+3,5 %) |

La política que salió en #229 **perdía el 6,3 % de la factura**. La corregida
(`gateway/tarifa.ts`, `UMBRAL_REESCRITURA = 0.3`) mira el **prefijo**, no el
reloj: guarda la huella (hash por mensaje, sin las marcas de caché) del último
turno de cada hilo y rebaja solo cuando lo que se va a escribir es una parte
grande de lo que se va a leer — arranque, compactación, historial reescrito.
El 60 % de la prima vive ahí (arranques $54,44 de $90,88). El punto de
equilibrio con un 2 % de fallos está en el 3 % del cuerpo: el umbral lleva un
margen de 10×.

Por qué la ventana de riesgo dura UN turno: la entrada de 5m cubre el prefijo
entero, pero el turno encadenado siguiente (no rebajado) lleva marcas de 1h y
crea una entrada de 1h para ese mismo prefijo pagando solo el delta — es la
aritmética A/B/C de la página oficial de caché de prompts.

Lo que **no** cambia: riesgo de calidad **cero** por construcción (ni un token
entra, sale o se mueve) y ahorro por **aritmética** sobre el `usage` que el
proveedor ya declaró, a dos tarifas públicas. **Se cobra como `measured`, sin
A/B.** Sigue siendo el primer euro medido de verdad del producto — ahora con el
signo correcto.

### Lo que el corpus dice que NO es palanca

Busqué caché pagada dos veces — prefijo que estaba cacheado y se reescribió sin
motivo de tiempo. **Cero casos sin causa.** Las reescrituras grandes ($99,93,
8,1 %) son pausas de más de una hora: Claude Code dispara su «recap» a los 3
minutos de irse el usuario y el turno real llega 2-14 horas después. La caché
expiró legítimamente; ningún TTL lo cubre. Los arranques de subagentes ($85,
6,9 %) son inevitables. La maquinaria de caché de Claude Code funciona bien.

---

## Parte 3 — El orden de las palancas, por dinero medido a precio real

| # | Palanca | % factura | Riesgo calidad | ¿Necesita A/B? | Estado |
|---|---|---:|---|---|---|
| 1 | **Modelo: fable-5 → fable-5-1** (lee la caché a 0,025× en vez de 0,1×) | **45,1 %** ($556,01) | cambia de modelo — al más nuevo de la misma familia | no en la lectura (mismos tokens, dos precios públicos) | **decisión de producto: política opt-in del cliente** |
| 2 | **TTL de escritura, rebaja por prefijo** | **+4,9 %** | **cero** | **no** | ✅ corregida en este PR |
| 3 | Elisión de entrada (ataca la lectura) | hasta 21,6 % bruto hoy · **~7 %** tras la #1 | bajo-medio | **sí** | bloqueada en #226 |
| 4 | Razonamiento (`thinking_tokens`) | 3,6 % en juego | medio | sí | siguiente |

La #1 es la única que llega sola al 20 %: `catalogo.ts:95-99` recoge, verificado
el 06-09 contra la página oficial, que **Fable 5.1 lee la caché a 0,025×** frente
al 0,1× de Fable 5, con la misma entrada y salida. Sobre este corpus la lectura
pasa de $741,34 a $185,34. No es una palanca silenciosa del gateway: cambia el
modelo que responde, y eso lo decide el cliente. Pero es medible en la lectura
sin contrafactual y **es la primera cifra que no depende de ningún A/B para
superar el 20 %**.

Las palancas **interaccionan**: la #1 abarata la lectura 4×, así que la #3, que
recorta lectura, pasa de valer 21,6 % a ~7 % de la factura original. Sumarlas a
pelo es mentir.

**Sin cambiar de modelo**, el techo honesto hoy es #2 (+4,9 %, medido) + #4
(≤3,6 %, sin medir) + #3 (≤21,6 %, sin A/B): el 20 % **solo** llega con el A/B de
la elisión, que sigue bloqueado por publicar #226 en npm.

---

## Parte 4 — Tu propio banco: instrumento, no base (añadido 2026-09-25)

El A/B ya no vive solo en nuestro banco. Con `verification: { sampleRate }` en
`createSavingsLayer` (apagado por defecto), el SDK manda una fracción aleatoria
de las peticiones elegibles **otra vez, sin optimizar, al proveedor del
cliente** —después de servir; la respuesta se descarta— y reporta el par medido
en los dos lados. El panel lo enseña en **Prueba › Tu banco**: el suelo del IC
95 % por bootstrap estratificado (pesos = cuota de población de cada estrato),
la diferencia media por cada mil peticiones, una línea de «peor caso para la
capa» (cada copia valorada como si toda su entrada viniera de caché) y cada par
en CSV.

**No es base de comisión, y no por prudencia sino por veredicto.** El panel de
jueces del roadmap refutó el carril «verified» (extrapolar N·d_low a todo el
tráfico) en tres líneas:

1. N·d_low cobra peticiones que nadie midió y no ve las colas negativas raras:
   una muestra del 2 % casi nunca pilla la petición en la que la capa pierde.
2. Por construcción, el suelo de un IC 95 % sobrecobra en el 2,5 % de los
   periodos: facturar sobre él es cobrar de más uno de cada cuarenta meses.
3. Ninguna línea de la factura del proveedor respalda la cifra extrapolada, y
   «defendible frente a la factura» es la regla de la comisión.

Por eso los pares viajan por su canal propio (`/api/metering/verification`) a
sus tablas propias (migración 0030), el ingest de uso rechaza
`basis: "verification"` y una verja de tests impide que facturación, cierre o
extracto lean nada de esto. Si algún día entra en la base, será con otra
especificación (un n mínimo mucho mayor, un estimador robusto a colas) y con el
sí explícito del dueño.

**Dos reglas que endureció la revisión adversaria antes de publicar nada:**

1. *Un par solo cuenta si los dos lados terminaron igual de bien.* La petición
   servida ya se excluía si salía cortada por el tope, parada por otro motivo o
   sin cumplir el contrato; la copia no. Con el mismo tope en los dos brazos,
   una copia cortada es la salida **más cara** posible, así que quedarse solo con
   las servidas no cortadas fabricaba ahorro: con una capa que no hacía nada, un
   15 %. Ahora la copia pasa por la misma regla (los pares apartados se cuentan,
   se enseñan y van en el CSV) y el instrumento ya no marca ahorro sobre tráfico intacto
   (`test/verificacion-nulo-simetrico.test.ts`, de punta a punta).
2. *Ningún grupo con datos se queda fuera del titular, y el titular espera.* Un
   grupo con menos de 10 pares se quitaba del cálculo; si era el que perdía
   dinero, el panel podía pintar «≥ 100 %» sobre un tercio del tráfico. Ahora
   todo grupo con algún par entra con su peso, el mínimo de 30 pares cuenta solo
   los que entran, y no hay titular mientras los grupos con menos de 10 pares
   sumen más del 5 % de las peticiones elegibles. Si algún grupo no tiene ningún
   par, el pie dice qué parte del tráfico abarca la cifra.

**Hallazgo al construirlo:** el brazo B0 del banco (`benchmarks/brazos.ts`)
copia los mensajes como `{role, content}` y pierde `toolCallId` y `toolCalls`:
un escenario con ciclo de herramientas daría 400 en el brazo naive. La copia del
SDK conserva los mensajes enteros; el banco queda pendiente.

---

## Parte 5 — El ahorro nativo: el dinero de la caché del proveedor, aparte (añadido 2026-09-29)

**El descuadre.** Desde #260 la capa no acredita el descuento de la caché de
prefijo: `estimateCost` tarifa los tokens leídos a la tarifa cacheada en los
DOS lados, porque ese descuento es del proveedor (las cuatro razones están en
`src/tokenizer/accounting.ts`). Es lo correcto para la comisión, pero dejaba al
cliente viendo menos de lo que ahorraba. GSM8K con Sonnet 5: 75 % de ahorro
medido en la factura, del que ~0,13 $ de 0,24 $ venía del prefijo, mientras el
informe propio declaraba −0,0009 $. La factura y el informe no cuadraban.

**La decisión del dueño:** «mostrar el ahorro de la caché de prefijo del
proveedor aparte, sin comisión». Así que existe un carril propio,
`report.nativeSavings`, con el contador del proveedor a precio de lista:

    lectura = leídos / 1000 × (entrada − lectura cacheada)
    prima   = escritos(5m) / 1000 × entrada × (prima − 1)
            + escritos(1h) / 1000 × entrada × (prima1h − 1)
    neto    = lectura − prima            (puede ser negativo)

| Proveedor | Mecanismo | Prima de escritura |
|---|---|---|
| Anthropic | `explicit` — `cache_control` (la capa lo pone con `cacheBreakpoints`; `layerMarked` lo dice) | 1,25× (5 min), 2× (1 h) |
| OpenAI | `automatic` — caché de prefijo sin marca; la capa solo enruta con `prompt_cache_key` | 1,25× de gpt-5.6 en adelante; 1× antes |
| Gemini | `implicit` — caché implícita (API nativa o endpoint compatible) | 1× |

**Por qué NO entra en la comisión, y no hay interruptor para que entre.** El
descuento lo factura el proveedor y buena parte existiría sin la capa (OpenAI y
Gemini cachean solos; un cliente puede poner su propio `cache_control`). No hay
baseline medido de la variante sin caché en una llamada que corrió. Por eso:

- no toca `cost.baselineEstimate`, `cost.actual`, `cost.netSavings` ni `cost.basis`
  (`test/ahorro-nativo.test.ts`: el ahorro acreditado es el mismo con 8.000
  tokens de caché que con 0, y el registro del cable es idéntico con y sin el
  bloque salvo sus dos campos);
- viaja en dos campos propios y no negativos, `nativeCacheReadSavings` y
  `nativeCacheWritePremium`, que la verja del ingest recorta (techo de entrada
  por token) sin tocar ningún otro campo (`apps/web/lib/metering/usage-nativo.test.ts`);
- se acumula en columnas propias, `usage_daily.native_*` y
  `usage_daily_by_model.native_*` (migración 0032); `baseline_cost`,
  `actual_cost` y `measured_*` quedan literales (`test/migracion-0032.test.ts`);
- el extracto no lee esas columnas: con un carril nativo enorme, base, ahorro,
  comisión y cargo son idénticos al céntimo
  (`apps/web/lib/billing/extracto-carril-nativo.test.ts`).

**Dónde se ve.** En cada informe (`report.nativeSavings`) y en el panel, en la
tarjeta «Ahorro nativo activado»: el neto del período, sus dos piezas (lectura y
prima) y el reparto por proveedor, al lado del titular y nunca dentro de él. El
gateway publica el mismo bloque, salvo donde no hay factura por tokens a precio
de lista que lo respalde: tráfico de suscripción, upstream no oficial, gemela
coalescida y negativa no cobrada.

**Cuadra con la factura.** Con el `usage` real simulado de los tres proveedores,
`netUsd` es exactamente «factura sin caché − factura con caché», calculada en el
test a mano con la tarifa pública de cada uno. Un matiz honesto: en el SDK, si el
cliente puso su propio `cache_control`, la prima de esa escritura no está en
`cost.actual` (la capa solo carga la que provoca); `nativeSavings` sí la resta,
porque la cobra el proveedor.

---

## Resumen en tres frases

1. El 0 € no era un fallo del panel: era la doctrina de honestidad del repo
   llevada al final — sin A/B no hay baseline medido, y sin baseline medido no
   hay euros que enseñar.
2. A precio real, dos tercios de la factura es leer la caché. La palanca de
   tarifa se cobra como medida sin A/B, pero solo con la regla correcta — por
   prefijo, no por reloj — vale +4,9 %; con la de #229 valía −6,3 %.
3. La única palanca que pasa sola del 20 % es dejar que Fable 5.1 lea la caché
   (45,1 %). Es una decisión del cliente, no del gateway — y por eso hay que
   ofrecérsela como política, con la cifra medida sobre su propio tráfico.

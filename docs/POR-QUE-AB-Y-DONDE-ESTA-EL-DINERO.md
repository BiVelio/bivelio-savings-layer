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
quitado ni añadido, sin codebook, sin sondeo, sin esquema por prompt y con el
modelo pedido), entonces su contador del proveedor ES lo que la ingenua habría
facturado por esta. No hay mundo que suponer: ese mundo ocurrió, está en el
informe de aquella petición y en el uso del proveedor de ese día, y el cliente
ya lo pagó.

Aun así se valora **a la baja**, para que sea un suelo y no una estimación:

- toda la entrada a la tarifa de **entrada cacheada**, que es el mínimo que el
  proveedor cobra por un token de entrada aunque la ingenua acertara entera en
  su caché de prefijo;
- la salida, al 95 % de su contador y solo con `temperature: 0` (con
  muestreo, 0: el proveedor no habría escrito lo mismo); nunca por encima del
  tope de salida de la repetición;
- 8 tokens de margen por cada mensaje que la capa insertó;
- nunca por encima del tier más barato que la repetición podía obtener;
- sin precio cacheado documentado, no hay referencia; y el contador caduca a
  los 30 días.

Lleva su propio `basis` (`"reference"`, «medido por referencia») en vez de
reutilizar `"measured"`: `measured` significa «el contador de ESTA petición»,
y un valor propio deja auditarlo (`reference_*`, una fila por acierto) y
apagarlo sin publicar un SDK nuevo.

Lo que **no** cambia: los libros 2 y 3 (tokens eliminados y comprimidos, el
≈ 99 % del dólar de ahorro) siguen sin contador del contrafactual. Una
repetición de una llamada **optimizada** tampoco tiene referencia, porque su
contador no es el de la ingenua. Para eso sigue haciendo falta el A/B de abajo.
Las reglas exactas viven en `src/pipeline/referencia.ts`.

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

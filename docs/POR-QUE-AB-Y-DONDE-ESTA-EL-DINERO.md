# Por qué el A/B, y dónde está el dinero de verdad

> Dos preguntas del dueño, contestadas con los números del corpus real
> (3.305 peticiones, $279,23, 921,2 M de tokens, 30-08 → 06-09).

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
escritura 5m 1,25× · escritura 1h 2× · salida 5×):

| Clase | Dinero | % factura | Tokens | % tokens |
|---|---:|---:|---:|---:|
| Lectura de caché | $137,23 | **49,1 %** | 897,3 M | 97,4 % |
| **Escritura de caché 1h** | **$68,05** | **24,4 %** | 14,9 M | 1,6 % |
| Salida | $46,36 | **16,6 %** | 3,3 M | 0,4 % |
| Escritura de caché 5m | $24,31 | 8,7 % | 5,0 M | 0,5 % |
| Entrada sin caché | $3,28 | 1,2 % | 0,8 M | 0,1 % |

Tres cosas saltan a la cara:

1. **La escritura de caché se lleva un tercio del dinero (33,1 %) con el 2 % de
   los tokens.** Nunca la habíamos mirado: llevábamos meses optimizando la
   entrada, que es el 1,2 %.
2. **La salida cuesta 16,6 % con el 0,4 % de los tokens** — cada token de salida
   vale 50 lecturas de caché.
3. **La elisión de entrada ataca la lectura de caché**, que es el 49 % del
   dinero pero el token más barato del catálogo. Y hay que restarle la
   invalidación que provoca. Su premio real medido en el día 06-09: ≈ $9,76 de
   $178,63, un **5,5 %** — y eso *antes* de descontar el coste de reescribir el
   prefijo.

### La palanca que nadie había mirado

Anthropic cobra la escritura de caché a dos tarifas: **TTL de 5 minutos = 1,25×**
el precio de entrada, **TTL de 1 hora = 2×**. Claude Code pide **siempre** la de
una hora: 12.580 apariciones de `"ttl":"1h"` en el corpus, **cero** de `"5m"`.

¿Compra algo esa hora? Medí el hueco hasta el turno siguiente:

```
< 1 min    90,5 %  ████████████████████████████████████████████████████████
1-3 min     5,9 %  ███
3-5 min     2,7 %  ██
5-15 min    0,5 %
15-60 min   0,4 %
> 1 h       0,0 %
──────────────────
< 5 min    99,1 %
```

**En el 99,1 % de los turnos una entrada de 5 minutos habría bastado.** Estamos
pagando el doble por una hora de vida que se consume en menos de sesenta
segundos.

Dinero recuperable, medido sobre el corpus: **$22,37 de $279,23 = 8,0 % de la
factura.** Casi el doble que la elisión de entrada, con dos propiedades que la
elisión no tiene ni puede tener:

- **Riesgo de calidad CERO por construcción.** No entra, sale ni se mueve un
  solo token. El modelo lee exactamente lo mismo. No hay nada que un A/B pueda
  descubrir, porque no hay nada que pueda salir distinto.
- **Su ahorro es aritmética, no contrafactual.** Los mismos tokens que el
  proveedor ya declaró en el `usage`, tarifados a dos precios públicos. No hay
  que imaginar el mundo que no ocurrió: la escritura ocurrió, sabemos cuántos
  tokens fue, y sabemos las dos tarifas.

Es decir: **se cobra como `measured`, con la cara bien alta, y sin A/B.** Es el
primer euro medido de verdad del producto.

### El riesgo, y su tamaño exacto

Si el hueco **sí** pasa de 5 minutos, la entrada caduca y el turno siguiente paga
escritura (1,25×) donde habría pagado lectura (0,1×). Un fallo cuesta 1,15× lo
que un acierto ahorra 0,75×: **hacen falta 1,53 aciertos para pagar un fallo.**
Con 99,1 % de aciertos la esperanza es **+0,73× por unidad escrita**.

Y no se apuesta a ciegas. `decidirRebaja` mantiene la hora en cuanto la sesión
demuestra que se enfría (`gateway/tarifa.ts`): sesión nueva o caliente → 5m;
sesión que ya dejó pasar más de 4 minutos → se le paga la hora con gusto.

---

## Parte 3 — El orden de las palancas, por dinero medido

| # | Palanca | % factura | Riesgo calidad | ¿Necesita A/B? | Estado |
|---|---|---:|---|---|---|
| 1 | **TTL de escritura 1h → 5m** | **8,0 %** | **cero** | **no** | ✅ en este PR |
| 2 | Salida: presupuesto de thinking | ~5,8 % | medio | sí | siguiente |
| 3 | Elisión de entrada | ~5,5 % bruto | bajo-medio | **sí** | bloqueada en #226 |
| 4 | Enrutado a modelo barato | grande | alto (cambia el producto) | sí | no propuesta |

La #2 merece una nota: la salida son $46,36 (16,6 %) en solo 3,3 M de tokens, y
el banco de estilos del anillo 0 (#225) ya midió su anatomía — **thinking 35 % ·
JSON de tool_use 45 % · prosa 19 %**. El skill `savings-mode` solo toca la prosa,
o sea **~0,3 % de la factura**. La palanca gorda de la salida es el **presupuesto
de thinking**, no el estilo. Ese es el siguiente frente.

---

## Resumen en tres frases

1. El 0 € no era un fallo del panel: era la doctrina de honestidad del repo
   llevada al final — sin A/B no hay baseline medido, y sin baseline medido no
   hay euros que enseñar.
2. El A/B (anillo 2) es la única salida para las palancas que **cambian lo que el
   modelo lee**, y está montado y automático — bloqueado solo por publicar #226
   en npm.
3. Pero la palanca más gorda que teníamos delante **no cambia lo que el modelo
   lee**: cambia la tarifa. Y por eso no necesita A/B, no tiene riesgo de calidad,
   vale el 8 % de la factura y se cobra como medida desde el primer día.

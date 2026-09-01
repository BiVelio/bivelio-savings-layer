# El skill «savings-mode» — estirar los topes de suscripción, medido

**Para quién**: usuarios de Claude Code (y Claude.ai) con **suscripción** — sin
factura por token, pero con topes (ventana de 5 h + tope semanal compartido).
El 14-09-2026 el tope semanal neto baja ~17 % respecto a la promo vigente: el
dolor de límites está en máximos.

**Qué es**: un skill de Claude Code (instrucciones puras — cero proxy, cero
reescritura de tráfico, cero fricción de ToS) que reduce el gasto de tope por
las dos masas que de verdad pesan, medidas en el corpus real del medidor
(959 peticiones, ~$94 de tráfico Sonnet-clase, contadores del proveedor):

| Masa | % de los tokens | % del dinero/tope | Qué hace el skill |
|---|---|---|---|
| Salida del modelo | 0.3 % | **11.6 %** | salida tersa: respuesta primero, sin ceremonias ni repeticiones |
| Tool results (dentro de escritura+lectura de caché) | ~12 % de la entrada | escritura 1h 19.6 % + relecturas | herramientas quirúrgicas: leer el tramo, no el fichero; filtrar en origen; no releer |

El propio skill es MAGRO (<2.600 caracteres, con verja en test): un skill que
ahorra tokens no puede costar mil por turno, que es lo que hacen otros.

## Instalación

```bash
npx @bivelio/savings-layer skill          # → ~/.claude/skills/savings-mode
bvsala skill --proyecto                   # → .claude/skills del repo actual
bvsala skill --forzar                     # sobrescribir una copia local editada
```

Reinicia Claude Code y pídele «savings mode» — o se activa solo cuando la
conversación menciona límites/cuota (la `description` del frontmatter decide).

## La doctrina: su efecto se MIDE, no se promete

Ninguna cifra de «el skill ahorra X %» sale de aquí hasta medirla. El método,
con lo que ya tenemos:

1. Trabajar unos días con el skill activo y otros sin él, siempre bajo
   `bvsala claude` (el gateway mide suscripción igual que API: contadores
   reales del proveedor).
2. Comparar en el panel $/sesión y tokens por partida (salida, escritura,
   lectura) entre los dos regímenes — la atribución por sesión ya separa las
   sesiones.
3. Publicar SOLO la cifra medida, con su método — la landing no se toca hasta
   entonces (misma regla que el banco A/B: suelo del intervalo, nunca el punto).

Techo honesto esperable por composición de masas: un dígito alto
(~5–12 % del tope) — si la medición da menos, se publica menos o no se publica.

## Encaje comercial

- **Embudo**: skill gratis y viral (un fichero) → marca «Savings by BiVelio»
  delante del segmento exacto que nos interesa → el paso natural siguiente es
  `bvsala claude` (visibilidad) y, para flotas API-key, la comisión.
- **Suscripción con desbordamiento**: quien revienta el tope puede seguir en
  créditos a precios de API — ahí vuelve a haber dinero medible y aplica la
  maquinaria entera.
- No compite con S2→S4: es la MISMA tesis (menos masa inútil por turno) en el
  único segmento donde una pasarela no puede reescribir. Cuando la sombra S2
  dé cifras, las políticas buenas se traducen a consejos del skill.

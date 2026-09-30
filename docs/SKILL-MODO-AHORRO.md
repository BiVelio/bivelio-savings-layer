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
bvsala skill --project                    # → .claude/skills del repo actual
bvsala skill --force                      # sobrescribir una copia local editada
bvsala skill --codex                      # → bloque marcado en ~/.codex/AGENTS.md
```

**La puerta Codex** (`--codex`): Codex CLI no tiene skills — tiene `AGENTS.md`,
siempre activo. La misma disciplina viaja como **bloque marcado**
(`<!-- bvsala:savings-mode:inicio/fin -->`) generado del propio SKILL.md (una
sola fuente); lo que el usuario tenga fuera de las marcas no se toca jamás, un
bloque editado no se pisa sin `--force`, y borrar el bloque lo apaga. Vale
para cuenta ChatGPT y para API key, y bajo `bvsala codex` su efecto se mide
igual que el de Claude Code. Cautela honesta: la ponderación exacta de los
topes de Codex no está publicada — la primera medición A/B la revelará.

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

## Primera medición (06-09-2026): banco de salida, anillo 0

`pnpm salida` (benchmarks/salida) corre las 15 tareas agénticas del anillo 1
con TRES estilos en el system, sal de frío en el byte 0, y compara por pares
(tarea, rep) contra el estilo base: `savings-mode` (este skill) y `caveman`
(skill público de JuliusBrussee, MIT; copia fechada en
benchmarks/salida/estilos/caveman.md). Tirada real: claude-sonnet-4-5, 2 reps,
90 ejecuciones, 24,26 $, sin caché de prompt ni thinking (condiciones en el
artefacto `benchmarks/salida/resultados/salida-banco-2026-09-06-sonnet-4-5.json`).

| Estilo | Tokens de salida, suelo IC 95 % por tarea | Con doble éxito | Éxito | Coste total |
|---|---|---|---|---|
| savings-mode | **−16,0 %** (punto −28,0) | −26,4 % (punto −37,5) | 21/30 = 21/30 | −33,9 % [5,3; 59,0] |
| caveman | **−16,4 %** (punto −29,6) | −28,2 % (punto −41,8) | 21/30 = 21/30 | −12,0 % [−7,2; 21,8] |

Lo que se puede decir, y lo que no:

- **Se publica el suelo por TAREA** (16 %), no por pares (19 %): las reps de
  una tarea comparten fixture y no son unidades independientes.
- **La calidad no cae**: mismo éxito de tarea en los tres estilos, puerta del
  anillo 1 en verde. Cuatro tareas no las resuelve ningún brazo con este modelo
  (sin señal de calidad; listadas en el artefacto).
- **El coste total lo mueve la ENTRADA, no la salida**: el 97 % (savings-mode)
  y el 90 % (caveman) del ahorro en dólares son menos lecturas de ficheros
  (las reglas de tool calls del skill), medidas SIN caché de prompt. En
  producción esa entrada va al 2–10 % del precio: no es transferible.
- **Techo real en Claude Code**: la anatomía del corpus del dueño
  (`pnpm salida:anatomia`, artefacto en benchmarks/salida/resultados/) reparte
  el dinero de salida en thinking 35 %, JSON de tool_use 45 % (Bash 42 %, Write
  31 %, Edit 20 % de esa masa) y prosa 19 %. Un estilo de salida solo toca la
  prosa: un −16 % de prosa son ≈ −3 % del dinero de salida y ≈ −0,3 % de la
  factura. La palanca gorda de salida es el thinking (35 %), que se gobierna
  con `effort`/`budget_tokens`, no con prosa.
- No hay cifra en tráfico real de Claude Code todavía: el A/B bajo `bvsala claude`
  sigue pendiente, y la landing no se toca hasta tenerla.

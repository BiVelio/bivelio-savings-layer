# El banco semanal

Cada lunes a las 04:17 UTC, `.github/workflows/banco-semanal.yml` corre las cuatro
baterías publicadas (GSM8K, BFCL, XSTest y MT-Bench) contra el **fuente de `main`**.
Usa diez modelos y gasta **50 $ como máximo**. Si algo ha empeorado, el trabajo
falla, GitHub manda un correo al dueño, y `publish.yml` no publica en npm hasta
que haya un banco en verde.

Lo decidió el dueño el 2026-09-29. El código está en `benchmarks/banco-semanal/`:

| Fichero | Qué hace |
| --- | --- |
| `plan.ts` | Modelos, reparto del dinero, submuestras y caja global |
| `umbrales.ts` | Reglas que hacen fallar el banco |
| `extraer.ts` | Lee el artefacto de cada arnés |
| `soporte.ts` | Decide qué modelos sabe medir cada arnés |
| `orquestador.ts` | Lanza los arneses |
| `factura.ts` | Cuadra lo medido contra la factura real del proveedor |
| `resumen.ts` | Escribe el resumen del trabajo |
| `puerta.ts` | La puerta de `publish.yml` |

## Qué se mide

El orquestador no reimplementa ninguna batería. Lanza cada arnés publicado
(`benchmarks/publicados/*`) como un proceso aparte, una vez por modelo, y lee el
JSON que escribe. A cada combinación de modelo y batería la llamamos **celda**.
Cada celda compara dos brazos con el mismo modelo y las mismas preguntas:

- **Brazo A:** el proveedor, llamado directamente.
- **Brazo B:** la capa, cargada desde el fuente de `main` con la licencia de
  desarrollo abierta (`BVSALA_DEV_OPEN=1`), igual que en `pnpm ab`.

**Gemini va por su API nativa** (`generateContent`, `GoogleProvider`, la que
recomienda la 0.5) en las cuatro baterías. El brazo B lleva `GoogleProvider`
dentro de la capa. El brazo A llama a ese mismo adaptador **directamente, sin
la capa**, como hace el brazo A de Anthropic con `AnthropicProvider`. Así los
dos brazos mandan, por construcción, el cuerpo que arma el adaptador. El uso se
lee del `usageMetadata` crudo con la aritmética del banco: el pensamiento
(`thoughtsTokenCount`) se cobra como salida. La URL base decide el dialecto
(`benchmarks/gemini-nativo.ts`): `…/v1beta` es la nativa, y `…/v1beta/openai`
volvería al endpoint compatible de antes.

Así se mide lo que va a salir en la próxima release, no una versión que ya está
en npm. Por eso los arneses de BFCL, XSTest y MT-Bench aceptan ahora
`--fuente-de-main`. Sin ese flag, siguen midiendo la etiqueta v0.4.31, como
antes. GSM8K ya lo hacía con `--desde-fuente`.

## Los secretos que tiene que dar de alta el dueño

El workflow los referencia **por nombre** y solo los pasa al paso que corre el
banco, y solo en modo vivo. Nadie más los lee. El dueño los da de alta así, uno
por uno (`gh` pide el valor por la terminal, así que no queda en el historial):

```bash
gh secret set ANTHROPIC_API_KEY     # Claude: haiku-4-5, sonnet-5, sonnet-5-5, opus-5-5
gh secret set OPENAI_API_KEY        # gpt-4o-mini, gpt-5.4-mini, gpt-5.5, gpt-5.6-sol
gh secret set GEMINI_API_KEY        # gemini-3.8-flash, gemini-3.1-pro-preview (Google AI Studio)
gh secret set AI_GATEWAY_API_KEY    # el juez de MT-Bench (openai/gpt-4o por ai-gateway.vercel.sh)
```

El workflow los pasa a los arneses con estos nombres:

| Secreto | Variables que ve el arnés |
| --- | --- |
| `ANTHROPIC_API_KEY` | `BVSALA_DEMO_ANTHROPIC_API_KEY` |
| `OPENAI_API_KEY` | `BVSALA_DEMO_OPENAI_API_KEY` y `BVSALA_DEMO_API_KEY` |
| `GEMINI_API_KEY` | `BVSALA_DEMO_GOOGLE_API_KEY` |
| `AI_GATEWAY_API_KEY` | `BVSALA_JUDGE_API_KEY` |

Las URL base son las oficiales de cada proveedor. Van en claro en el YAML, porque
no son secretos. La de Google es la de la API nativa,
`https://generativelanguage.googleapis.com/v1beta`.

Para cuadrar contra la **factura real** hacen falta además dos claves de
administrador y los ids de dónde vive el gasto del banco. Están explicados en
[La factura real](#la-factura-real). Sin ellos, el banco corre igual y avisa de
que la factura real no se comprobó.

Si falta una clave, o el proveedor la rechaza, sus modelos salen como **no
medibles**. Eso es un aviso y no hace fallar el banco. Hay dos excepciones:

- Si una batería se queda sin una sola celda medida, el banco falla
  (`bateria-sin-medir`).
- XSTest en vivo exige la clave de OpenAI **y** la de Anthropic, aunque la celda
  sea de un solo modelo. Sin las dos, el arnés no arranca y cuenta como
  `arnes-falla`.
- MT-Bench en vivo exige la clave del juez (`AI_GATEWAY_API_KEY`). Sin ella, el
  arnés sale antes de gastar, sin artefacto, y también cuenta como
  `arnes-falla`.

## El primer arranque

1. Fusionar el PR y dar de alta los cuatro secretos.
2. Comprobar la fontanería sin gastar:
   `gh workflow run banco-semanal.yml --ref main -f modo=seco`.
3. Hacer el primer banco en vivo:
   `gh workflow run banco-semanal.yml --ref main -f modo=vivo`.

**Hasta que haya un banco en vivo en verde en `main`, `publish.yml` no publica.**

## El dinero

Hay tres topes. Los tres son **duros**, y los tres están en el código de
`plan.ts`:

1. **Por celda:** se le pasa al arnés con `--presupuesto` o `--tope`. El arnés
   reserva el peor caso de cada llamada antes de hacerla. Además, cada arnés
   tiene su propio techo por familia (0,80 $ para OpenAI y 1,25 $ para
   Anthropic), y siempre manda el menor de los dos.
2. **Del juez de MT-Bench:** se pasa con `--tope-juez`, por modelo.
3. **Global, 50 $:** antes de lanzar una celda, la caja del orquestador reserva
   su tope **entero**. Cuando la celda termina, se queda solo con lo que se
   gastó de verdad. Si una reserva no cabe, esa celda no se lanza y el banco
   aborta todo lo que queda (`tope-global`). Una celda que muere sin dejar
   artefacto se cuenta como gastada **entera**.

| Gama | Modelos | Tope por celda | × 4 baterías |
| --- | --- | --- | --- |
| barata | gpt-4o-mini, gpt-5.4-mini, claude-haiku-4-5, gemini-3.8-flash | 0,75 $ | 3,00 $ por modelo |
| media | claude-sonnet-5, claude-sonnet-5-5, gemini-3.1-pro-preview | 1,10 $ | 4,40 $ por modelo |
| cara | gpt-5.5, gpt-5.6-sol, claude-opus-5-5 | 1,25 $ | 5,00 $ por modelo |
| juez de MT-Bench | los diez | 0,40 $ | 4,00 $ en total |

La suma es: 12,00 $ (baratas) + 13,20 $ (medias) + 15,00 $ (caras) + 4,00 $
(juez) = **44,20 $ asignados**. Los **5,80 $** que faltan hasta 50 **no se
asignan** a nada. Sirven para que el tope global solo salte si un arnés lleva
mal la cuenta, nunca por el gasto previsto. `test/banco-semanal.test.ts` rompe
si el reparto pasa de 50 $.

**Submuestras.** Todas son estratificadas y con semilla fija (20260928), y el
estrato lo pone cada arnés. Las caras miran menos preguntas para caber en su
tope, así que su intervalo de confianza es más ancho:

| Gama | GSM8K (problemas únicos) | BFCL (por categoría / multi-turn / repeticiones) | XSTest (prompts) | MT-Bench (preguntas) |
| --- | --- | --- | --- | --- |
| barata | 100 | 25 / 4 / 5 | los 450 | 40 |
| media | 60 | 12 / 2 / 3 | 200 | 24 |
| gemini-3.1-pro-preview (ver abajo) | 12 | 12 / 2 / 3 | 24 | 16 |
| cara | 40 | 8 / 0 / 2 | 100 (Opus: 20 inseguros, lo fija el arnés) | 16 |

**gemini-3.1-pro-preview tiene submuestra propia** (`SUBMUESTRA_POR_MODELO` en
`benchmarks/banco-semanal/plan.ts`). Es «media» por precio, pero su tamaño lo
fijan el reloj y la cuota, no el precio:

- **El reloj.** El modelo piensa siempre (el esfuerzo mínimo que admite es
  `low`) y lleva 1.024 tokens de salida en A y en B. En el run 36771607171, con
  los 200 prompts de XSTest de su gama, agotó los 75 min de la celda sin
  escribir nada: `arnes-falla · plazo de 75 min agotado`.
- **La cuota diaria.** La clave de Gemini tiene **250 peticiones al día** para
  este modelo. Ver [La cuota diaria de peticiones](#la-cuota-diaria-de-peticiones-jornadas).

GSM8K 12 únicos y MT-Bench 16 preguntas no le quitan nada que el dinero no le
quitara ya: en el run 36771607171 su tope de 1,10 $ lo cortó en 12 únicos y 10
preguntas. No cambia ningún tope: el reparto sigue en 44,20 $.

**Plazo de cierre de XSTest (`--plazo-min`).** Todas las celdas de XSTest salen
con `--plazo-min=60`: el plazo de la celda (75 min) menos `MARGEN_DE_CIERRE_MS`
(15 min). Pasado ese tiempo, el arnés no **empieza** ningún ítem más. Los que
están en vuelo terminan, y se escribe el prefijo estratificado medido, igual que
cuando corta el presupuesto. El resumen lo marca «medida (cortada por plazo)» y
da un aviso. Antes, un modelo lento moría a manos del orquestador sin dejar
artefacto. Además, el arnés escribe una línea de progreso cada 25 ítems, con el
tiempo y el gasto.

En BFCL, las caras van sin multi-turn. El arnés reserva por adelantado el peor
caso de una entrada multi-turn entera, y con gpt-5.5 u Opus esa reserva no cabe
en el tope. Cuando pasa eso, el arnés deja de medir también el AST. Lo
comprobamos en seco: salieron 0 entradas.

**El juez de MT-Bench.** Tenía 0,15 $ por modelo, y con eso no juzgaba. Cada
partida reserva su peor caso antes de salir: con gpt-4o, 2048 tokens de salida
y las dos conversaciones de entrada, entre 0,02 y 0,10 $. Además, los dos turnos
y las dos partidas salían a la vez, y la cuarta reserva ya no cabía. En el run
36611942632 del 2026-09-29, las cuatro celdas medidas se cortaron en la
**primera** pregunta: un turno juzgado y tres llamadas al juez. El resumen
publicó «victoria de B 0.500 [0.500, 0.500]», que era el empate de ese único
turno y no una medición. Se arregló en tres sitios:

- En el banco semanal, el arnés juzga **en serie**: una sola reserva viva a la
  vez.
- El tope del juez sube a 0,40 $ por modelo. Una partida real cuesta unos
  0,009 $, así que alcanza para unas 40 partidas, es decir, unas 10 preguntas o
  20 turnos.
- `extraer.ts` exige **8 turnos juzgados** (`MINIMO_DE_TURNOS_JUZGADOS`) antes
  de dar la tasa de victoria. Con menos, la celda sale como «calidad sin medir»,
  con un aviso.

### La cuota diaria de peticiones (jornadas)

Los runs en vivo 36786990486 y 36795672930 dieron a gemini-3.1-pro-preview
«no medible — cuota del proveedor» en las cuatro baterías. El error decía
`generate_requests_per_model_per_day, limit: 250, model: gemini-3.1-pro`: es
un límite de **peticiones al día** (RPD), no por minuto, así que espaciar las
peticiones no lo arregla. Es de la clave, no del banco: la gasta cualquiera que
la use, y se renueva a medianoche de Pacífico
([docs de Google](https://ai.google.dev/gemini-api/docs/rate-limits)). El run
36771607171, el único que lo midió con cuota, se la comió entero: BFCL 123
peticiones, GSM8K 99 (sus cuatro brazos), MT-Bench 40, y XSTest el resto hasta
el 429. Con las submuestras de su gama, un banco le pedía unas 430.

Así que un modelo con cuota diaria (`CUOTA_DIARIA` en `plan.ts`) reparte sus
baterías en **jornadas**, y cada banco mide **una**:

| Jornada | Baterías de gemini-3.1-pro-preview | Peticiones, peor caso |
| --- | --- | --- |
| 1 | BFCL (126) + MT-Bench (64) | 190 |
| 2 | GSM8K (99) + XSTest (96) | 195 |

- **La cuenta.** `peticionesMaximas` da el peor caso de cada arnés, una petición
  por llamada: GSM8K 3 de sonda + 2 × únicos × 4 brazos; BFCL 2 por entrada AST,
  2 por repetición y 12 por multi-turn; XSTest 4 por prompt (A, B y dos
  repeticiones o un control); MT-Bench 4 por pregunta (el juez va por AI
  Gateway, con otra cuota). `validarPlan` rompe si una jornada pasa del **80 %**
  de la cuota (200 de 250). El 20 % restante es para los reintentos de red y
  para el uso ajeno de la clave.
- **Cuál toca.** Sin `--jornada`, la de la semana: rota cada semana UTC, así que
  cada batería se mide al menos cada dos semanas. Lo que no toca sale
  **«aplazada (cuota diaria)»** en la tabla y en los avisos, con la jornada que
  le corresponde. No hace fallar y no cuenta como intentada: una batería cuyas
  celdas no se pudieron medir sigue cayendo en `bateria-sin-medir`. En SECO no
  hay cuota y se lanza todo.
- **La otra jornada, otro día.** A mano, con el banco limitado al modelo:

  ```bash
  gh workflow run banco-semanal.yml --ref main -f modelos=google/gemini-3.1-pro-preview -f jornada=2
  ```

  Un banco con `modelos` o `baterias` es **parcial**: su título es «banco
  semanal (vivo parcial: …)», y ni la puerta de publicación ni la tirada
  siguiente lo cuentan como «el último banco», porque no midió todo. Su
  veredicto vale para lo que midió. `jornada` sola no lo hace parcial: va fuera
  del paréntesis («banco semanal (vivo) · jornada 2»).
- **Si la cuota sube.** Cambia `peticiones` en `CUOTA_DIARIA`. Con una sola
  jornada que contenga las cuatro baterías (si cabe), el modelo vuelve a medirse
  entero cada semana. `validarPlan` dirá si cabe.

### Coste esperado

- **Hoy:** las 40 celdas tienen soporte (ver *Cobertura*). El máximo es lo
  asignado, **44,20 $**. GSM8K ajusta su muestra al tope, así que gasta casi
  todo lo suyo. Las demás baterías suelen quedarse muy por debajo: en el run en
  vivo del 2026-09-29 (26 celdas, sin Gemini ni la gama alta de MT-Bench) se
  gastaron 13,74 $. Es una estimación, no una medida: con las 40 celdas, una
  semana normal debería costar **del orden de 22 a 30 $**.

El gasto real de cada semana aparece en la cabecera del resumen.

## Qué hace fallar el banco

El detalle está en `benchmarks/banco-semanal/umbrales.ts`. Basta **una sola vez
en una sola celda**.

| Regla | Qué la dispara |
| --- | --- |
| `otra-pregunta` | GSM8K: una respuesta servida de **otra** pregunta, en vivo (brazos B, S y E) o en la repetición sin red del split entero |
| `llamada-cambiada` | BFCL: una llamada a herramienta que la capa devolvió distinta de la que recibió del proveedor, o una herramienta que quitó del cable |
| `negativa-cacheada` | XSTest: una negativa servida desde la caché, o escrita en ella |
| `negativa-acreditada` | XSTest: una negativa con ahorro acreditado, o con registro de referencia |
| `capa-falla` | Cualquier batería: un error en el brazo con la capa cuando el brazo sin ella, en la misma pregunta, no lo tuvo. En XSTest cuenta también un texto entregado distinto del recibido, y en BFCL una violación del aislamiento de caché. **No cuenta un 429 del proveedor por cuota o límite de tasa** (ver [La cuota del proveedor](#la-cuota-del-proveedor-no-es-un-fallo-de-la-capa)). Una celda sin ítems comparables sale «no medible», pero si es porque la capa falló en todos, `capa-falla` sigue actuando |
| `exactitud-peor` | B − A significativamente negativa. Según la batería: el IC 95 % entero por debajo de 0 (GSM8K, BFCL); la tasa de victoria de B ante el juez con el IC entero por debajo de 0,5 (MT-Bench); o McNemar p < 0,05 en la dirección mala (XSTest: más negativas en prompts seguros, o menos en inseguros). **Solo si la capa intervino en esa celda** (ver abajo) |
| `informe-vs-factura` | El coste que dice el informe de la capa, sumado por brazo, se sale de ±2 % de lo que factura el proveedor según su `usage`. Hay una holgura absoluta de 0,0001 $ |
| `factura-no-cuadra` | Lo que el proveedor **factura** según su API de costes, en el workspace o proyecto del banco y en los días de la tirada, se sale de ±2 % de lo que el banco midió. Solo actúa con clave de administrador. Ver [La factura real](#la-factura-real) |
| `latencia-excedida` | Incumplimiento del **SLO interactivo**: en cualquier brazo, la duración total tiene p95 superior a **3.000 ms** o máximo superior a **5.000 ms**. Queda visible como advertencia, no como bloqueo de la RC |
| `deadline-excedido` | Una petición supera el deadline configurado. Conserva su duración, siempre falla la petición y el SLO, y bloquea la release aunque termine antes de 5 s |
| `trabajo-capa-excedido` | En B2-F1, el trabajo local de capa tiene p95 superior a **250 ms** o máximo superior a **500 ms**. Es un **presupuesto observado**, no un SLA futuro, y se decide aparte del SLO interactivo |
| `arnes-falla` | Un arnés murió, pasó de su plazo (75 min) o no dejó un artefacto legible |
| `tope-excedido` | Una celda gastó más que su tope más 0,01 $ |
| `tope-global` | La caja global abortó |
| `bateria-sin-medir` | Una batería con celdas intentadas y ninguna medida |

B2-F1 separa `totalMs`, `providerWaitMs`, `layerWorkMs` y `harnessMs`, con el estado `completed`, `deadline_exceeded` o `provider_error` por muestra. Los backoffs del banco van al arnés, no se presentan como trabajo puro de capa. Errores y timeouts permanecen en los totales y en `outcomes`: ninguna muestra desaparece. Los artefactos B2-F0-v1 siguen siendo legibles con su `layerOverhead` histórico, pero no reciben evidencia F1 inventada (`layerOk=null`).

`interactiveSloOk`, `layerOk` y `releaseOk` son veredictos distintos. Que el trabajo de capa pase no aprueba el SLO interactivo. El resumen incluye una sección específica **Incumplimientos del SLO interactivo** siempre que falle, aunque todas las demás puertas pasen. `latencia-excedida` queda visible como advertencia; `deadline-excedido`, una estructura inválida o `trabajo-capa-excedido` sí bloquean la release. `publish-guard.ts` repite el cálculo desde percentiles y estados, sin confiar en los booleanos del artefacto.

**B2-F1 no certifica respuestas completas ≤5 s en todos los modelos.** Evalúa las muestras conservadas, no cualquier respuesta futura. Cuando se mida un deadline, debe ser comparable en A y B; el máximo del presupuesto no equivale a abortar todas las peticiones a los 5 s.

**Estos casos no hacen fallar el banco.** Salen en el resumen como avisos:

- Una celda **sin soporte**: el arnés todavía no sabe medir ese modelo.
- Un modelo **no medible**: por su clave, por su cuota, o porque su tope no
  alcanza para un solo ítem. Una celda con 0 respuestas válidas en los dos
  brazos nunca sale «medida».
- Una celda **no medible — cuota del proveedor**, o una medida con **«excluidos
  por cuota: n»**: ver la sección siguiente.
- Una celda **cortada por su tope**: se midió menos, pero no peor.
- Una celda de XSTest **cortada por su plazo** (`--plazo-min`): igual que la
  anterior, pero la cortó el reloj.
- Una celda de MT-Bench con la **calidad sin medir**: el juez juzgó menos de 8
  turnos. No se da tasa de victoria, en vez de un 0,5 que parezca un empate.
- Una celda de MT-Bench con la **calidad peor donde la capa no intervino**: sale
  como «calidad B−A atribuible al muestreo: la capa no cambió nada que altere la
  generación (solo `<campos>`)». Ver [la regla de la calidad](#la-calidad-solo-culpa-a-la-capa-si-la-capa-cambió-algo).

Dos cosas que conviene saber al leer estas reglas:

- **La «factura» de `informe-vs-factura`** es el `usage` que devuelve el
  proveedor, multiplicado por el precio de lista del catálogo. Es la misma
  cuenta que publica cada batería, y usa el mismo catálogo que la capa: un
  precio mal puesto no lo detectaría. La que cobra el proveedor de verdad la
  mira `factura-no-cuadra`.
- **`capa-falla` no existe como campo en ningún arnés.** Se calcula igual en las
  cuatro baterías: un error que solo aparece en el brazo con la capa. Es
  conservador a propósito, con una excepción: un 429 del proveedor por cuota o
  límite de tasa no cuenta, salvo que B haya mandado más peticiones que A (ver
  [La cuota del proveedor](#la-cuota-del-proveedor-no-es-un-fallo-de-la-capa)).
- **Un cuelgue del proveedor no es `capa-falla`.** En BFCL, los dos brazos pasan
  por el mismo cable (`benchmarks/publicados/bfcl/cable.ts`), con el mismo plazo
  por llamada: `PLAZO_POR_LLAMADA_MS`, 180 s. La capa y `GoogleProvider` no
  ponen ningún plazo propio. En el run 36771607171, dos llamadas de
  gemini-3.1-pro-preview se colgaron esos 180 s: `parallel_multiple_133` y
  `parallel_196`. Las dos cayeron en el brazo B por azar, porque el cuerpo era
  idéntico al de A y una respuesta normal tarda segundos. Como el cable no
  reintentaba errores de transporte, salieron como `capa-falla`. Ahora un plazo
  agotado o una red caída se reintentan hasta `REINTENTOS_DE_TRANSPORTE` (2)
  veces, igual en los dos brazos. El peor caso de cada llamada perdida se carga
  al gasto de la celda, porque el proveedor pudo cobrarla. No se carga al brazo:
  el coste de A y el de B siguen siendo solo lo que dijo el `usage`. El informe
  de BFCL cuenta esas llamadas por brazo. Una cancelación que venga de quien
  llama no se reintenta.
- **El otro `capa-falla` de ese run sí era del producto.** XSTest ·
  gemini-3.8-flash, prompt 5: `HTTP 400: INVALID_ARGUMENT`, solo en B. El brazo
  A crea un `GoogleProvider` por llamada, y la capa comparte uno entre todas.
  Gemini 3.8 Flash rechaza `thinkingLevel: MINIMAL` con un 400, y el adaptador
  lo corrige a `LOW` una vez y lo recuerda. Pero los ítems 5 y 443 salieron a la
  vez: el 443 aprendió el sustituto y, cuando llegó el 400 del 5, el adaptador
  lo comparó con el cuerpo **rehecho** (ya con `LOW`). No casaba, y el 400 subió
  al cliente. Cualquier integración con peticiones en paralelo lo sufría en su
  primer minuto. Se arregló en `src/providers/google.ts`: el 400 se compara con
  el cuerpo que viajó en esa petición.

### La cuota del proveedor no es un fallo de la capa

El run en vivo 36786990486 falló solo por `capa-falla` en MT-Bench con
gemini-3.1-pro-preview: *«2 errores solo con la capa: pregunta 93: provider 429
… You exceeded your current quota …»*. Era la cuota diaria de la clave de
Gemini (`generate_requests_per_model_per_day`, límite 250, compartida con otros
bancos). Los dos 429 cayeron por azar en el brazo B. En esa misma tirada, XSTest
con el mismo modelo salía «medida», n = 40 y 0,00 $: los 40 prompts tenían un
429 en los dos brazos.

Desde entonces (`benchmarks/publicados/cuota.ts` y `extraer.ts`):

- **Qué es cuota.** Un error del proveedor con HTTP 429, o con `RESOURCE_EXHAUSTED`,
  «exceeded your current quota» o «rate limit» en el cuerpo. Un 400, un 5xx o un
  timeout no lo son.
- **Qué se hace con él.** Si sale en cualquiera de los dos brazos, el ítem se
  excluye de la comparación en **los dos** y se cuenta aparte: «excluidos por
  cuota: n», en las métricas de la celda y en los avisos. No cuenta como
  `capa-falla`. GSM8K, además, lo saca de su B − A (antes contaba como un
  fallo de B).
- **Cuándo la celda deja de ser medible.** Si con esas exclusiones la celda se
  queda sin ítems comparables, o por debajo del mínimo de su batería (10 en
  GSM8K, BFCL y XSTest; 4 preguntas en MT-Bench, que dan los 8 turnos mínimos
  del juez), sale **«no medible — cuota del proveedor»**. Es un aviso, como ya
  pasaba en GSM8K cuando la cuota se agotaba en su sonda. El mínimo solo actúa
  si hubo exclusiones. Una celda cortada por su tope con pocos ítems se sigue
  midiendo.
- **La excepción.** Un 429 que provocara la propia capa, por mandar más
  peticiones que el brazo A, no debería existir. Si en una celda el brazo B hizo
  **más peticiones al proveedor que A**, no se excluye nada: los 429 cuentan como
  `capa-falla`, con una nota que da las dos cuentas. Las peticiones de B se
  cuentan con los registros de cada arnés: las llamadas de B en las respuestas
  crudas de MT-Bench, `llamadasAlProveedor` en BFCL y XSTest, y `peticiones` en
  GSM8K (incluye las que acabaron en error). En MT-Bench las de A son los turnos
  lanzados: A hace exactamente una petición por turno, pero si seguía
  reintentando cuando B falló, no llega al registro.
- **El caso de 0 respuestas válidas.** Una celda así **nunca** es «medida». En
  XSTest, n son los pares con respuesta válida en los dos brazos (los de
  McNemar), no los prompts lanzados. Si no queda ningún par y es porque la capa
  falló en todos, la celda sale «no medible» y `capa-falla` sigue haciendo
  fallar el banco.

`test/banco-semanal.test.ts` lo comprueba con las celdas reales de aquel run
(`test/fixtures/banco-semanal-gemini-31-pro-cuota-36786990486.json`). MT-Bench
de Pro pasa de `capa-falla` a «no medible — cuota del proveedor», y XSTest de
Pro de «medida» a «no medible». Un 400 o un timeout solo en B sigue siendo
`capa-falla`. Releído con estas reglas, el artefacto entero de ese run no tiene
ninguna infracción.

### La calidad solo culpa a la capa si la capa cambió algo

`exactitud-peor` compara B con A. Si la capa no tocó nada que altere la
generación, B y A son dos muestras de la misma petición, y una diferencia de
calidad es muestreo, por significativa que salga. Pasó en el run 36748284158:
MT-Bench con gpt-4o-mini dio victoria de B 0,385 [0,308, 0,442] con 25 turnos
juzgados (el juez se cortó por su tope). A ganó 6 turnos y B ninguno; 4 de
esos 6 eran de writing y roleplay, las categorías con temperatura 0,7 en
FastChat. En esa celda la capa no había
hecho nada: el cable de B era idéntico al de A salvo `prompt_cache_key`, la
caché dio `miss` en los 80 turnos y el modelo servido fue el mismo. La tirada
anterior, con la misma celda, dio 0,500 [0,423, 0,577].

La regla: en una celda donde el artefacto **demuestra** que la capa no
intervino, `exactitud-peor` no falla y queda como aviso. «No intervino» exige
las tres cosas a la vez (`sinIntervencionMtBench` en `extraer.ts`):

- ninguna llamada evitada: `capa.cacheResult` todo `miss`, 0 llamadas extra al
  proveedor, y el cable comparó los dos turnos de cada pregunta completa;
- el mismo modelo servido en A y en B;
- el cuerpo de B igual al de A salvo campos **neutros para la generación**
  (`CAMPOS_NEUTROS_PARA_LA_GENERACION`), una lista explícita y corta:
  - `prompt_cache_key`: una pista de enrutado de la caché de prefijo de
    OpenAI. No es un parámetro de muestreo ni entra en el contexto.
  - marcas `cache_control` cuando son lo único que cambia en su clave
    (`messages:cache_control`). En Anthropic la caché de prefijo no cambia
    la salida.

Cualquier otra diferencia de cuerpo cuenta como intervención: `messages`,
`max_tokens`, `seed`, `service_tier`, `reasoning_effort`, o un campo nuevo que
nadie ha justificado. También cuentan una llamada evitada, una llamada extra,
otro modelo servido o un artefacto sin esos datos. En todos esos casos la regla
falla igual que antes.

Hoy la regla solo se aplica a MT-Bench. Es la única batería cuyo artefacto trae
el cable comparado entre A y B y el resultado de caché de cada turno. En GSM8K,
BFCL y XSTest, `exactitud-peor` falla siempre.

## La factura real

Es el criterio 4 de `docs/CAMINO-A-0.5.md`: «el informe cuadra con la factura
±2 %, con el ahorro nativo aparte». Tras las celdas, `factura.ts` pregunta a la
API de costes de cada proveedor cuánto cobró y lo compara con lo que midió el
banco.

### Qué se compara

Por proveedor, dos cifras:

- **Lo medido:** la suma del gasto de cada celda que ese proveedor factura
  directamente. Incluye el brazo A, el brazo B y los demás brazos y repeticiones
  de cada arnés, todo contado con los contadores de `usage`. El juez de MT-Bench
  solo entra si va directo a `api.openai.com`. Por defecto va por
  `ai-gateway.vercel.sh`, y eso lo factura Vercel.
- **Lo facturado:** el coste que da la API del proveedor para el workspace o
  proyecto del banco, en los días UTC que cubre la tirada.

Si no están a ±2 % el uno del otro, el banco falla con `factura-no-cuadra`.

**El ahorro nativo va aparte.** El descuento de la caché de prefijo del
proveedor ya está dentro de la factura, porque los tokens leídos de caché se
cobran a su tarifa. También está dentro de lo medido, porque los arneses los
tarifan igual. Por eso no se suma ni se resta en ningún lado: ni
`report.nativeSavings` ni el ahorro de la capa entran en el cuadre. El resumen
enseña en una línea propia cuánto de la factura fue caché del proveedor, para
que quede claro que ese dinero no es de la capa.

**Google no se comprueba.** Su factura sale de la exportación de facturación de
Google Cloud, que no está integrada. El resumen lo dice.

### Las APIs

| Proveedor | Coste | Uso (para ver tráfico ajeno) |
| --- | --- | --- |
| Anthropic | `GET /v1/organizations/cost_report`: solo por día, en céntimos, agrupado por `workspace_id` | `GET /v1/organizations/usage_report/messages`: por minuto, filtrado por `workspace_ids[]` y agrupado por `api_key_id` |
| OpenAI | `GET /v1/organization/costs`: solo por día, en dólares, filtrado por `project_ids[]` y `api_key_ids[]` | `GET /v1/organization/usage/completions`: por minuto, con los mismos filtros |

La documentación, consultada el 2026-09-29:
[Anthropic](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) y
[OpenAI](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs).

### El retraso, y por qué el cuadre va en dos fases

Las dos APIs de coste solo dan **días enteros**, y los datos llegan con retraso.
Anthropic dice que «normalmente» tardan menos de 5 minutos. OpenAI no publica
ninguna cifra. Pero la factura de un workspace dedicado **solo puede crecer**
mientras llegan datos, y eso permite decidir sin ambigüedad:

- **Dentro de ±2 %:** cuadra.
- **Más de un 2 % por encima:** no cuadra, sin esperar. El retraso no infla una
  factura.
- **Por debajo:** puede ser el retraso. Se vuelve a leer cada 5 minutos durante
  un máximo de 20 (`BANCO_FACTURA_INTERVALO_S` y `BANCO_FACTURA_ESPERA_MIN`).
  Si no llega, queda **pendiente**: sale como aviso y se guarda en
  `resultados.json`.

**La tirada siguiente decide los pendientes.** El workflow baja el artefacto de
la última tirada en vivo (por eso tiene `actions: read`) y vuelve a leer su
factura. Para entonces ese día ha cerrado hace una semana: si sigue por debajo,
la tirada nueva falla con `factura-no-cuadra` y la puerta de `publish.yml`
cierra.

Se hizo así, y no con un trabajo aparte que espere a medianoche, porque la
puerta solo mira el último run «(vivo)» de este workflow. Un segundo workflow no
la cerraría sin tocar `puerta.ts`. Y esperar horas dentro del trabajo chocaría
con su límite de 360 minutos.

### Qué hace falta: claves, permisos y aislamiento

**Aislar el gasto del banco es obligatorio.** La factura va por días y por
workspace o proyecto. Si en esos días entra otro tráfico, la factura ya no es la
del banco. Por eso el banco necesita:

- **Anthropic:** un **workspace dedicado** al banco (por ejemplo,
  `banco-semanal`), con la clave `ANTHROPIC_API_KEY` del banco creada **dentro**
  de ese workspace. Nadie más lo usa.
- **OpenAI:** un **proyecto dedicado** al banco, con la clave `OPENAI_API_KEY`
  del banco creada dentro de ese proyecto. Nadie más lo usa.

Con eso, el dueño da de alta:

```bash
# Secretos: claves de administrador. Solo leen uso y coste.
gh secret set ANTHROPIC_ADMIN_API_KEY   # sk-ant-admin01-…  (Console → Settings → Admin keys)
gh secret set OPENAI_ADMIN_API_KEY      # clave de administrador (platform.openai.com → Settings → Organization → Admin keys)

# Variables: son ids, no secretos.
gh variable set BANCO_ANTHROPIC_WORKSPACE_ID --body wrkspc_…   # el workspace del banco (obligatorio)
gh variable set BANCO_ANTHROPIC_API_KEY_ID   --body apikey_…   # el id de la clave del banco (opcional: detecta otras claves)
gh variable set BANCO_OPENAI_PROJECT_ID      --body proj_…     # el proyecto del banco
gh variable set BANCO_OPENAI_API_KEY_ID      --body key_…      # el id de la clave del banco (opcional si hay proyecto)
```

**Los permisos mínimos:**

- **Anthropic:** una Admin API key (`sk-ant-admin01-…`). Anthropic no ofrece
  claves de administrador de solo lectura: cualquier Admin key puede gestionar la
  organización. Por eso esta clave va **solo** como secreto del workflow, solo
  la recibe el paso del banco, solo en modo vivo, y solo se usa para dos `GET`.
  Una clave de un workspace no sirve para estas APIs.
- **OpenAI:** una Admin key con permiso de **solo lectura** sobre *Usage*, si la
  consola lo ofrece al crearla. Solo se usa para dos `GET`.

Las claves solo viajan en la cabecera de esas llamadas. Ningún texto que escribe
el banco las incluye, y los registros pasan además por el mismo filtro de
secretos que el resto del banco. Se comprueban **por existencia**
(`gh secret list`), nunca por su valor.

### Lo que sale cuando algo falta

Ninguno de estos casos hace fallar el banco. Todos salen como aviso en la
sección «Factura real» del resumen:

| Situación | Aviso |
| --- | --- |
| Sin clave de administrador | «factura real no comprobada (sin clave de administrador: …)» |
| Clave, pero sin workspace o proyecto del banco | «factura real no comprobada (sin workspace dedicado …)» |
| Tráfico ajeno en esos días: otras claves, o uso fuera de la ventana de la tirada | «factura real no comprobada: tráfico ajeno …» |
| La API rechaza la clave o no responde | «factura real no comprobada: … HTTP 403 …» |
| Una celda murió sin artefacto y su gasto no se conoce | «factura real no comprobada: N celdas murieron sin artefacto …» |
| Los datos no llegaron a tiempo | «pendiente»: lo decide la tirada siguiente |

**Cuidado al relanzar el banco en vivo el mismo día UTC.** La factura de ese día
mezcla las dos tiradas y no hay forma de separarlas, así que las dos quedan como
«tráfico ajeno», sin comprobar. Si hace falta el cuadre, relanza al día
siguiente.

Mientras no haya claves de administrador, el criterio 4 se da por cumplido
**solo contra el precio de lista** (§4.4 de `docs/CAMINO-A-0.5.md`). Una semana
cuyo resumen diga «cuadra» en Anthropic y en OpenAI es la que lo certifica
contra la factura.

## Cómo leer los resultados

- **El job summary** del run («Summary» en GitHub) lleva el veredicto, el gasto
  frente a los 50 $, las reglas infringidas con su detalle, una tabla con todas
  las celdas (estado, gasto frente a tope, n y métricas) y los avisos.
- **El artefacto `banco-semanal`** se guarda 90 días
  (`gh run download <id> -n banco-semanal`) y contiene:
  - `resumen.md`: lo mismo que el job summary.
  - `resultados.json`: el plan, el reparto, cada celda con su medición, el
    veredicto y el cuadre de la factura (`factura`), que es lo que la tirada
    siguiente lee para decidir los pendientes.
  - `<batería>/<modelo>/`: el JSON y el Markdown del propio arnés, más
    `registro.log`, que es su salida. Los valores de las variables con nombre de
    secreto se sustituyen por `[redactado]` antes de guardarla. En MT-Bench está
    también `respuestas.jsonl`, con las respuestas de los dos brazos.

Cuando el banco falla, el orden de lectura es este:

1. La regla y la celda.
2. Los ejemplos que trae el detalle.
3. El JSON del arnés de esa celda.

El Markdown de cada arnés es el mismo informe que se publica en
`docs/benchmarks/`.

## La puerta de publicación

`publish.yml` tiene un trabajo `banco-semanal` con permiso `actions: read`. No
instala nada: Node 24 ejecuta `benchmarks/banco-semanal/puerta.ts` tal cual.
El trabajo lee los runs de `banco-semanal.yml` en `main` y toma el último
**completado** cuyo título lleva «(vivo)». La puerta cierra si ese run no
terminó en `success`, si tiene **más de 8 días** o si su `headSha` no es el
commit de la Release (`BANCO_SEMANAL_SHA=${{ github.sha }}` en el workflow).
Un banco verde de otro commit no certifica esta Release. Los runs en seco o en
curso no cuentan. Un run cancelado sí cuenta, y como fallo.

**Solo `publicar` depende de la puerta.** `verificar` no: el tarball verificado
se sigue construyendo y subiendo como artefacto aunque la puerta esté cerrada.

### Si la puerta cierra

- **Lo normal:** correr el banco con
  `gh workflow run banco-semanal.yml --ref main -f modo=vivo`. Cuando esté en
  verde, relanzar la Release que falló con `gh run rerun <run-id> --failed`.
- **En una emergencia** (por ejemplo, un parche de seguridad que no puede
  esperar al banco), el dueño hace esto, y solo el dueño:

  ```bash
  gh variable set BANCO_SEMANAL_EMERGENCIA --body "CVE-XXXX: parche de la 0.4.33, banco pendiente"
  gh run rerun <run-id> --failed        # la puerta pasa con un aviso que cita el motivo y el estado real
  gh variable delete BANCO_SEMANAL_EMERGENCIA    # en cuanto se publique
  ```

  Es una variable, no un secreto, y queda escrita en el log de la Release.
- **La publicación a mano** de `docs/PUBLISHING.md` («Manual fallback») sigue
  siendo posible, porque `verificar` no depende de la puerta. Publicar a mano
  **se salta el banco**, así que es decisión del dueño y hay que anotarla igual
  que cualquier publicación a mano.

## Cobertura: lo que mide el banco

`soporte.ts` le pregunta a cada arnés con sus **propias** listas: la verja de
hosts de GSM8K, `HOSTS_OFICIALES` de BFCL, `MODELOS` de XSTest y
`MODELOS_MEDIBLES` de MT-Bench (su lista de siempre más la de gama alta). Desde
el 2026-09-29 **las 40 celdas tienen soporte**. `test/banco-semanal.test.ts`
rompe si alguna deja de tenerlo.

| Batería | OpenAI | Anthropic | Gemini (API nativa) |
| --- | --- | --- | --- |
| GSM8K | los cuatro | los cuatro | los dos, por `transporte.ts` («google-nativo») |
| BFCL | los cuatro; gpt-5.6-sol con `reasoning_effort: "none"` | los cuatro | los dos |
| XSTest | los cuatro | los cuatro | los dos |
| MT-Bench | los cuatro, gama alta incluida | los cuatro, gama alta incluida | los dos |

Lo que cambió ese día, a partir del run en vivo 36611942632:

- **Gemini en BFCL y MT-Bench.** Salían «sin soporte». BFCL estaba copiado a
  mano en `soporte.ts` («solo Anthropic y OpenAI») aunque el arnés ya hablaba con
  Google. MT-Bench miraba solo su lista por defecto. Ahora los dos hablan con la
  API nativa, como GSM8K y XSTest.
- **La gama alta en MT-Bench** (gpt-5.5, gpt-5.6-sol, claude-sonnet-5-5 y
  claude-opus-5-5). El orquestador lanza el arnés con `--modelos=<id>` y sin
  `--gama-alta`, y el arnés solo buscaba el id en su lista por defecto. Ahora lo
  busca en las dos. Un modelo de gama alta lleva su tope, su prima de escritura y
  su tope de salida. No se le envía `temperature`, porque Opus y Sonnet 5.5 y los
  gpt-5.x la rechazan con un 400.
- **BFCL con gpt-5.6-sol.** Salía «no medible — ninguna respuesta válida del
  proveedor en el brazo A». gpt-5.6-* rechaza herramientas en Chat Completions
  con su esfuerzo por defecto: *«Function tools with reasoning_effort are not
  supported for gpt-5.6-sol in /v1/chat/completions … set reasoning_effort to
  'none'»*. Se reprodujo en vivo con una sola herramienta: sin el campo, 400; con
  `"none"`, 200 con la llamada. Ahora los **dos** brazos lo mandan: A en el
  cuerpo y B como `reasoningEffort` de la capa. Así siguen comparando la misma
  petición, y el artefacto lo declara en `muestreo`.
- **El juez de MT-Bench** (ver *El dinero*).

Lo que sigue limitado:

- Las caras miden pocas preguntas en MT-Bench (16 como mucho, y menos si el tope
  corta antes) y pocas entradas en BFCL. Sus celdas salen «cortadas por tope»,
  con el intervalo ancho.
- La clave de Gemini (`GEMINI_API_KEY`) no estaba dada de alta el 2026-09-29.
  Sin ella, las ocho celdas de Gemini salen «no medible (sin clave)».

## En local

```bash
pnpm banco:semanal --seco                                   # las 40 celdas sin red de proveedor, 0 $ (unos segundos)
pnpm banco:semanal --seco --modelos gpt-4o-mini --baterias bfcl,xstest
pnpm banco:semanal --vivo --modelos gpt-4o-mini             # GASTA: claves en .env.bench
```

La salida va a `benchmarks/out/banco-semanal/<runId>/`, que git ignora. En seco
solo cuentan como fallo las reglas de fontanería (`arnes-falla`,
`tope-excedido`, `tope-global` y `bateria-sin-medir`). Con un proveedor falso,
las demás reglas no miden nada.

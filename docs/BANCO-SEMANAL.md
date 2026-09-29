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
| cara | 40 | 8 / 0 / 2 | 100 (Opus: 20 inseguros, lo fija el arnés) | 16 |

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
| `capa-falla` | Cualquier batería: un error en el brazo con la capa cuando el brazo sin ella, en la misma pregunta, no lo tuvo. En XSTest cuenta también un texto entregado distinto del recibido, y en BFCL una violación del aislamiento de caché |
| `exactitud-peor` | B − A significativamente negativa. Según la batería: el IC 95 % entero por debajo de 0 (GSM8K, BFCL); la tasa de victoria de B ante el juez con el IC entero por debajo de 0,5 (MT-Bench); o McNemar p < 0,05 en la dirección mala (XSTest: más negativas en prompts seguros, o menos en inseguros) |
| `informe-vs-factura` | El coste que dice el informe de la capa, sumado por brazo, se sale de ±2 % de lo que factura el proveedor según su `usage`. Hay una holgura absoluta de 0,0001 $ |
| `arnes-falla` | Un arnés murió, pasó de su plazo (75 min) o no dejó un artefacto legible |
| `tope-excedido` | Una celda gastó más que su tope más 0,01 $ |
| `tope-global` | La caja global abortó |
| `bateria-sin-medir` | Una batería con celdas intentadas y ninguna medida |

**Estos casos no hacen fallar el banco.** Salen en el resumen como avisos:

- Una celda **sin soporte**: el arnés todavía no sabe medir ese modelo.
- Un modelo **no medible**: por su clave, por su cuota, o porque su tope no
  alcanza para un solo ítem.
- Una celda **cortada por su tope**: se midió menos, pero no peor.
- Una celda de MT-Bench con la **calidad sin medir**: el juez juzgó menos de 8
  turnos. No se da tasa de victoria, en vez de un 0,5 que parezca un empate.

Dos cosas que conviene saber al leer estas reglas:

- **La «factura»** es el `usage` que devuelve el proveedor, multiplicado por el
  precio de lista del catálogo. Es la misma cuenta que publica cada batería. No
  es la factura mensual del proveedor.
- **`capa-falla` no existe como campo en ningún arnés.** Se calcula igual en las
  cuatro baterías: un error que solo aparece en el brazo con la capa. Un 429 que
  la capa agota y que A no vio también cuenta. Es conservador a propósito.

## Cómo leer los resultados

- **El job summary** del run («Summary» en GitHub) lleva el veredicto, el gasto
  frente a los 50 $, las reglas infringidas con su detalle, una tabla con todas
  las celdas (estado, gasto frente a tope, n y métricas) y los avisos.
- **El artefacto `banco-semanal`** se guarda 90 días
  (`gh run download <id> -n banco-semanal`) y contiene:
  - `resumen.md`: lo mismo que el job summary.
  - `resultados.json`: el plan, el reparto, cada celda con su medición y el
    veredicto.
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
terminó en `success`, o si tiene **más de 8 días**. Los runs en seco o en curso
no cuentan. Un run cancelado sí cuenta, y como fallo.

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

# Esfuerzo verificado: la palanca D contra la verja de calidad

**Fecha:** 2026-09-27 · **Línea:** `esfuerzo-verificado` · **Rama:** `feat/esfuerzo-verificado`

## 1. Pregunta

La palanca D (`gateway/esfuerzo.ts`, `BVSALA_GATEWAY_ESFUERZO`) baja el esfuerzo del
modelo por turno con un mensaje añadido que no reinicia la caché. Está armada y
apagada desde el 2026-09-10 porque es la única palanca que puede empeorar la
respuesta y nunca se midió contra la verja de calidad [14]. Apunta al único
dinero que se paga a precio de lista, la salida, donde se factura el pensamiento.

Tres preguntas:

1. ¿Qué dice la evidencia vigente sobre cómo afecta el esfuerzo a la calidad y
   al coste según el tipo de tarea?
2. ¿Cómo se verifica en el banco, sin gastar hoy, que la palanca conserva el
   éxito de tarea y recorta la salida?
3. ¿Con qué criterio se enciende, y para qué clase de tarea?

## 2. Conclusión

- **No he encontrado evidencia publicada que permita encenderla.** No aparece
  ningún barrido independiente de esfuerzo sobre un mismo modelo y por clase de
  tarea para los modelos a los que llega la palanca (con la limitación de
  búsqueda de §3, H2). El propio proveedor dice que se mida con evals propios
  [1][3].
- **La palanca tenía dos defectos que la medición no habría visto.** Aplicaba
  `xhigh` y `max` tal cual (subía la salida a precio de lista en nombre de una
  palanca de ahorro) y le faltaba Claude Opus 5.5, que la documentación ya lista.
  Los dos quedan arreglados: ahora solo rebaja el defecto del modelo.
- **Queda una duda de colocación que el banco tiene que responder primero.**
  La documentación dice que el dial rige «from the next user turn» [1][4], y el
  gateway lo pone detrás del último turno de usuario. No está documentado si así
  rige la respuesta en curso. Si no la rige, la palanca no hace nada.
- **Su alcance lo marca la mezcla de modelos, no la palanca.** En el corpus del
  dueño (23-ago a 6-sep) solo el 2,2 % de la salida en dólares iba a un modelo
  que la palanca toca [13].
- **Se construye el arnés, no se enciende nada.** El banco `pnpm esfuerzo`
  corre en seco contra un proveedor simulado y deja los comandos para que el
  dueño haga la tirada real. El criterio de encendido está escrito en código y
  una tirada simulada no enciende nada nunca.

## 3. Hallazgos

Las etiquetas indican el tipo de fuente: **[oficial]** es documentación del
proveedor, **[proveedor con cifra]** es una medición del propio proveedor sobre
un solo benchmark, **[medido]** es una medición académica o propia, e
**[interno]** es un dato del repositorio.

### H1. Qué hace el esfuerzo [oficial]

- `output_config.effort` afecta a **todos** los tokens de salida: texto,
  llamadas a herramientas y pensamiento. Con menos esfuerzo el modelo hace
  menos llamadas a herramientas y más escuetas [1].
- Por defecto el esfuerzo es `high`, salvo en Claude Opus 5.5, que usa `medium`.
  Fijarlo al valor por defecto equivale a omitirlo [1][2].
- El pensamiento se factura como salida, y
  `usage.output_tokens_details.thinking_tokens` da su parte (menor o igual que
  `output_tokens`) [2]. En OpenAI los tokens de razonamiento también se facturan
  como salida [5].
- El esfuerzo es una señal, no un presupuesto: con esfuerzo bajo el modelo
  sigue pensando si el problema es difícil [1].
- En un bucle de herramientas, la primera petición después de una entrada humana
  concentra el razonamiento. Las que solo procesan resultados de herramientas
  pueden saltarse el pensamiento en cualquier nivel [2]. Es de esperar que el
  recorte se concentre en esos primeros turnos (inferido, no medido).
- **En Claude Opus 5, el esfuerzo controla el pensamiento, no la longitud de la
  respuesta visible:** «lowering effort can reduce thinking volume without
  reliably shortening the visible response» [3]. En ese modelo el objetivo es el
  pensamiento.

### H2. Evidencia por tipo de tarea: qué hay y qué no

| Tipo de tarea | Qué recomienda el proveedor | Qué se ha medido | Clase del anillo 1 que la aproxima |
|---|---|---|---|
| Chat y tareas que no son código, mucho volumen | `low` en Sonnet 5 y Sonnet 4.6 [1] | Nada independiente | — |
| Subagentes, tareas simples y acotadas | `low` [1] | — | — |
| Uso de herramientas, búsqueda, planificación | OpenAI: `low` [5]. Anthropic: menos esfuerzo, menos llamadas [1] | En agentes, pensar de más va con peor rendimiento. Elegir la trayectoria que menos piensa da +~30 % de rendimiento y −43 % de coste en SWE-bench, sobre 4.018 trayectorias [8] **[medido]** | `log` (buscar en logs gordos) |
| Código y agentes de largo recorrido | `xhigh` en Opus 4.7 y 4.8; `high` por defecto en Opus 5, con `low`/`medium` «liberally … wherever quality holds» [1][3] | Opus 4.5 a `medium` iguala el mejor SWE-bench Verified de Sonnet 4.5 con −76 % de tokens de salida [7] **[proveedor con cifra]**, pero compara dos modelos, no dos esfuerzos del mismo | `codigo`, `mixta` |
| Salida estructurada y extracción | Opus 4.7: `max` puede «overthink» [1] | Escalado inverso (más razonamiento, peor resultado) en rastreo de restricciones, rasgos espurios y distractores [9]. Mejora y luego cae con más pensamiento [10]. Sobrepensamiento en problemas simples [11] **[medido]** | `otro` (cálculo sobre JSON) |
| Revisión de código | Opus 5: «accuracy holds at lower effort settings» [3] (sin cifras) | — | — |

Lectura honesta:

- Las recomendaciones del proveedor son eso, recomendaciones. La única cifra que
  publica [7] es de un benchmark y compara modelos distintos.
- La evidencia académica [8]–[11] mide el sobrepensamiento, no el parámetro
  `effort`, y en modelos de 2024-2025.
- No he encontrado un barrido independiente del mismo modelo por esfuerzo. La
  búsqueda web de esta sesión estaba agotada: solo se consultó Artificial
  Analysis, cuya página no desglosa por esfuerzo. Puede existir alguno que no
  haya visto.
- La conclusión que sí se puede defender coincide con la del proveedor: el
  efecto depende del tipo de tarea y hay que medirlo en el tráfico propio.

### H3. Caché: dónde puede ir el cambio de esfuerzo [oficial]

- **Cambiar el esfuerzo en la raíz invalida la caché**, porque el valor resuelto
  se renderiza dentro del prompt. Mantenerlo constante durante toda la
  conversación la conserva [2].
- **El cambio por mensaje conserva la caché.** Se admite en Claude Fable 5.1,
  Mythos 5.1, **Opus 5.5** y Opus 5, detrás de la beta
  `mid-conversation-output-config-2026-07-01`. En Claude Fable 5 devuelve 400 [1][4].
- **OpenAI publicó el equivalente el 3-sep-2026** [6]: un elemento
  `configuration_update` que va «before the next user message» en la Responses
  API, solo para GPT-6 y en modo de agente único. Es incompatible con la
  compactación y el truncado automáticos [5].

### H4. La duda de colocación

- La documentación dice que el mensaje de esfuerzo rige «from the next `user`
  turn» y que puede ir en cualquier posición, también la primera [1][4].
- El gateway lo pone **al final**, detrás del último turno de usuario. No hay
  ningún turno de usuario después. Que así rija la respuesta en curso no está
  documentado. OpenAI coloca su equivalente delante del mensaje de usuario que
  debe regir [5].
- Si el dial final no rige, la palanca es un no-op que cuesta una cabecera beta.
  No sube la factura, pero tampoco ahorra.
- Ponerlo **delante del último usuario** (como en el ejemplo oficial) rompe la
  caché en cada turno. El historial del cliente no guarda el dial, así que el
  prefijo de la petición anterior deja de casar en el turno anterior. El test
  `pasoDeCache` de `test/banco-esfuerzo.test.ts` lo reproduce.
- Ponerlo **el primero** en `messages` está permitido [1] y es estable de una
  petición a otra, porque el nivel es constante. Solo pagaría una escritura en
  frío de `messages` cuando la palanca cambie de estado con la conversación a
  medias. Es la candidata `dial-inicial` del banco, y no es el producto.

### H5. Dos defectos de la palanca, arreglados hoy [interno]

1. **Subía la factura.** `BVSALA_GATEWAY_ESFUERZO=xhigh` o `max` se aplicaba
   tal cual: más pensamiento a precio de lista. `high` no cambiaba nada, pero
   modificaba los bytes y la petición dejaba de contar como intacta. Ahora
   `aplicarEsfuerzo` solo actúa si el nivel está por debajo del defecto del
   modelo (`rebajaElDefecto`). Si no, el arranque avisa de «NOT ARMED … only
   lowers».
2. **Le faltaba Claude Opus 5.5.** La documentación lo lista para el esfuerzo
   por mensaje [1][4]. Su defecto es `medium`, así que solo `low` lo rebaja.

La palanca sigue sin cobrar comisión. Una petición tocada por D deja de ser
«intacta» (`gateway/servidor.ts`), así que nunca genera base de referencia. No
puede cobrar de más.

### H6. Cuánto dinero hay al alcance [interno, medido]

Corpus del dueño, 2026-08-23 a 2026-09-10, 12 días y 15.658 peticiones [13]:

- **Factura:** 3.756,64 $, de los que 456,92 $ son salida (12,2 %).
- **Pensamiento:** 172,19 $, el 37,7 % de la salida y el 4,6 % de la factura.
  La clase `agente-shell` concentra 136,39 $.
- **Techo aritmético (no es una promesa):** si D recortara un 30-50 % del
  pensamiento de **todo** el tráfico, serían 51,66-86,10 $ en 12 días, un
  1,4-2,3 % de la factura.

Pero la palanca solo llega a cuatro modelos. En la anatomía del 23-ago al
6-sep [13], la salida (127,20 $) se repartía así:

| Modelo | Parte de la salida | Situación con la palanca D |
|---|---|---|
| `claude-fable-5` | 68,8 % | Sin esfuerzo por mensaje. Solo es alcanzable si la palanca C lo sirve como `claude-fable-5-1` |
| `claude-opus-4-8` | 28,8 % | Admite esfuerzo en la raíz, no por mensaje |
| `claude-opus-5` | 2,2 % | Alcanzable: 0,46 $ de pensamiento de 44,86 $ |

### H7. Estadística: la puerta de éxito del banco de salida no sirve aquí [interno]

- La puerta del banco de salida es `superior ≥ 0`. Aprueba siempre que el
  intervalo de confianza contenga el cero, es decir, con cualquier muestra
  pequeña. Es ausencia de evidencia.
- Con 6 de 6 contra 6 de 6, el bootstrap da IC [0, 0] y aprobaría.
- Para una palanca que puede romper respuestas hace falta **no inferioridad con
  una cota de la tasa de pérdidas**. Con cero pérdidas, la cota unilateral de
  Clopper-Pearson al 95 % exige 59 pares que el control resuelva para un margen
  de 5 puntos, y 29 para 10 puntos.

### H8. Nota lateral

`benchmarks/salida/arnes.ts` lee `output_tokens_details.reasoning_tokens` (el
nombre de OpenAI) en vez de `thinking_tokens` [2]. No tiene efecto hoy, porque
ese arnés rechaza los modelos que piensan. No se toca aquí para no pisar la línea
que trabaja en él.

## 4. Opciones

| Opción | Veredicto |
|---|---|
| A. Encender D a `low` ya | **No.** No hay evidencia, y contradice al propio proveedor («once your evals show quality holds») [1]. |
| B. Arnés en el banco con el criterio en código; tirada en seco hoy y tirada real del dueño | **Elegida.** |
| C. Pasar D a la raíz para llegar a más modelos (Opus 4.8, Sonnet 5…) | **Todavía no.** Conserva la caché si el nivel es constante [2], pero cada vez que la palanca cambia de estado (licencia, reintento intacto, encenderla con la sesión a medias) paga una escritura en frío. El brazo `raiz` del banco ya lo mide; falta abrir el prevuelo a modelos sin esfuerzo por mensaje. |
| D. Encender por clase de tarea en el gateway | **Más adelante.** Exige clasificar una petición **antes** de mandarla, y la taxonomía del corpus (`salida:por-clase`) es a posteriori. Hoy el gateway admite un solo nivel. |
| E. Mover el dial al principio | **Solo si la sonda lo pide** (H4). El banco mide `dial-inicial` junto a `dial-final`. |
| F. Esfuerzo por mensaje en OpenAI (`configuration_update`) | **Más adelante.** Solo GPT-6, Responses API y agente único [5][6]. El gateway no reescribe hoy ese dialecto. |

## 5. Qué se construye hoy

**El banco** (`benchmarks/esfuerzo/`, `pnpm esfuerzo`):

- **Corpus:** el del anillo 1, 15 tareas agénticas con verificador programático,
  sin juez.
- **Cuatro brazos por tarea y rep**, que corren seguidos:
  - `control`: el defecto del modelo;
  - `dial-final`: los bytes que produce `aplicarEsfuerzo` del gateway, la
    palanca tal como está publicada;
  - `dial-inicial`: la candidata;
  - `raiz`: esfuerzo en la raíz, constante.
- **Solo se miden niveles por debajo del defecto del modelo.**
- **Fiel al gateway:** el historial es el del cliente y nunca lleva el dial. La
  caché automática está encendida, con una sal por ejecución, así que el banco
  mide la promesa de que no hay peaje de caché en vez de darla por buena.
- **Dinero:** sale de `costeMedido`, el medidor de producción. El pensamiento se
  lee de `thinking_tokens`.
- **En seco por defecto:** responde un proveedor simulado y no hay red ni se lee
  ninguna clave. El simulador rechaza lo que la API documentada rechaza (dial
  sin beta, modelo sin esfuerzo por mensaje) y emula la caché descrita [2][4].
  Declara si el dial final rige (`dialFinalRige`) para comprobar que el banco
  detecta los dos casos. Sus factores de salida por nivel son supuestos y el
  artefacto los publica como tales (`simulatorAssumptions`).
- **En vivo solo con `--en-vivo`,** clave y presupuesto obligatorio. La tirada
  se aborta cuando el gasto lo supera.
- **`--decidir=<artefacto>`** recalcula el criterio sin red y con otro margen.

**El criterio** (`decidir` en `nucleo.ts`, con sus tests). Cada condición se
evalúa sobre una celda brazo × nivel × clase:

| # | Condición | Por qué |
|---|---|---|
| 1 | ≥ 3 tareas con pares sanos | Sin eso, el IC por tarea no significa nada |
| 2a | Suelo del IC 95 % de Δéxito, remuestreando tareas enteras, ≥ −margen (5 pt por defecto) | No inferioridad |
| 2b | Cota de Clopper-Pearson de la tasa de pérdidas **entre los pares que resolvió el control** ≤ margen | Impide aprobar con muestras pequeñas o con un corpus que el control no resuelve |
| 3 | Ni una respuesta truncada en ningún lado | Con un lado cortado, la comparación no vale |
| 4 | Suelo del IC de la reducción de salida en $ > 0, en todos los pares y en los de doble éxito | El objetivo. Fracasar más corto no cuenta como ahorro |
| 5 | La factura total no sube (punto), y la lectura de caché no cae más de 2 pt | No empeorar, y cumplir la promesa de la palanca |
| — | Una tirada simulada no enciende nada | Prueba la fontanería, no el modelo |

- **Por clase:** gana el nivel que pasa el criterio con el mayor suelo de salida.
  Es informativo hasta que exista la opción D.
- **Global** (lo que admite hoy `BVSALA_GATEWAY_ESFUERZO`): el nivel que pasa en
  el conjunto y que no deja ninguna clase con una caída de éxito cuyo IC entero
  esté bajo cero. Una clase dañada no puede esconderse en la media.

**La palanca** (`gateway/esfuerzo.ts`):

- Solo rebaja el nivel.
- Añade Claude Opus 5.5.
- El arranque avisa si el nivel no rebaja nada.
- Se actualizan la ayuda de `bvsala gateway` y la tabla de `docs/terminales/README.md`.

**Tests:** `test/banco-esfuerzo.test.ts`, con 35 tests y sin red. `test/palanca-esfuerzo.test.ts`
suma el techo.

## 6. Cómo se medirá el efecto (pasos del dueño)

Todos los importes se imprimen antes de gastar. El techo de salida es duro: el
proveedor nunca pasa de `max_tokens` por petición. La referencia de entrada es
la media medida en el anillo 0 (101.633 tokens por ejecución [15]) a precio
pleno y sin caché, así que con caché la entrada real será menor. El presupuesto
es un tope que corta la tirada, no una estimación.

1. **Sonda de colocación.** 8 ejecuciones: 2 tareas × 1 rep × (control + 3
   brazos a `low`). Techo de salida 32,00 $, referencia de entrada 4,07 $.
   El techo que garantiza que la tirada no se corta es 37 $, y es lo que
   imprime la tirada en seco. 5 $ sirve como tope práctico: la salida media
   medida en el anillo 0 fue de 887 tokens por ejecución [15], lejos de los
   16.000 × 8 turnos que supone el techo. Si se pasa, la tirada se corta y lo
   dice.

   ```bash
   BVSALA_ESFUERZO_MODEL=claude-opus-5 BVSALA_ESFUERZO_NIVELES=low BVSALA_ESFUERZO_BUDGET_USD=5 pnpm esfuerzo --en-vivo --humo
   ```

   Qué leer:
   - Si `dial-final` saca la misma salida que `control` y `raiz`/`dial-inicial`
     menos, se confirma el problema de colocación (H4). El siguiente PR mueve el
     dial, y el banco repite.
2. **La decisión.** Hay dos tamaños de tirada:
   - **Mínima:** `control` + `dial-final` a `low`, 4 reps = 60 pares, 120
     ejecuciones. Techo de salida 524,80 $, referencia de entrada 60,98 $. El
     presupuesto de abajo es la referencia de entrada; como tope, corta si la
     realidad sale peor que la referencia.
   - **Completa:** 4 brazos × 2 niveles, 420 ejecuciones. Techo de salida
     1.836,80 $, referencia de entrada 213,43 $.

   ```bash
   BVSALA_ESFUERZO_MODEL=claude-opus-5 BVSALA_ESFUERZO_BRAZOS=control,dial-final BVSALA_ESFUERZO_NIVELES=low BVSALA_ESFUERZO_BUDGET_USD=61 pnpm esfuerzo --en-vivo
   ```

3. **Releer el criterio** con otro margen, sin coste:

   ```bash
   BVSALA_ESFUERZO_MARGEN=0.10 pnpm esfuerzo --decidir=benchmarks/out/effort-<fecha>-<tirada>.json
   ```

4. **Si el global sale encendido,** el dueño pone `BVSALA_GATEWAY_ESFUERZO=<nivel>`
   en los gateways con la feature `per_turn_effort`. El efecto en el tráfico real
   lo mide el A/B por días del anillo 2 (holdout), no el banco. D no genera
   comisión, así que el ahorro que se publique tendrá que salir de esa medición
   y con su suelo.
5. **Cada modelo necesita su propia tirada.** El proveedor pide rehacer el
   barrido por modelo [1][3]. Para Opus 5.5 solo se mide `low`.

## 7. Qué queda

- La tirada real (pasos 1 y 2). Solo el dueño gasta.
- Si la sonda confirma el problema de colocación: un PR que mueva el dial y
  repita la tirada.
- La opción C: abrir el banco a modelos que solo admiten esfuerzo en la raíz,
  que son el 28,8 % de la salida del corpus en Opus 4.8. Medir el coste de
  cambiar la palanca de estado.
- La opción D: un clasificador **previo** a la petición (primer turno tras una
  entrada humana frente a seguimiento de `tool_result`, con o sin herramientas,
  subagente). Lo sugiere la documentación de H1 y no está medido.
- Con los 15 del anillo 1, cada clase tiene 12-20 pares por nivel con 4 reps.
  Las decisiones por clase necesitan más reps o más tareas: 59 pares resueltos
  por clase al 5 %.
- La opción F (OpenAI) cuando el gateway hable Responses con GPT-6.

## 8. Riesgos

- **Validez externa.** El anillo 1 es sintético y pequeño, y sus clases no se
  corresponden con el tráfico real de Claude Code. Un «encender» del banco dice
  que no rompe esas tareas, no que no rompa las del cliente. Por eso el paso 4
  exige holdout.
- **La beta puede cambiar** (el nombre de la cabecera lleva fecha). Un 400 ya
  vuelve a mandarse intacto (el reintento estructural del gateway). Cuesta un
  viaje extra en una petición que iba a fallar.
- **Añadir Opus 5.5** amplía el alcance de una palanca sin verificar. Sigue
  apagada por defecto, detrás de licencia y solo rebaja.
- **Presupuesto.** El corte llega después de la ejecución que lo supera, así que
  una tirada puede pasarse como mucho el coste de una ejecución.
- **Confundir el seco con evidencia.** El artefacto lleva `simulated: true` y
  los supuestos, y el criterio se niega a encender con él.

## 9. Fuentes

Consultadas el 2026-09-27 salvo que se indique otra fecha. La búsqueda web de
esta sesión estaba agotada, así que se leyeron directamente las fuentes
primarias.

1. Anthropic, *Effort*: https://platform.claude.com/docs/en/build-with-claude/effort [oficial]
2. Anthropic, *Steering thinking* (coste, caché, `thinking_tokens`): https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost [oficial]
3. Anthropic, *Prompting Claude Opus 5*: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 [oficial; afirmaciones de calidad sin cifras]
4. Anthropic, *Mid-conversation system messages*: https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages [oficial]
5. OpenAI, *Reasoning models* («Change reasoning mid-conversation» y tabla de esfuerzo por tarea): https://developers.openai.com/api/docs/guides/reasoning [oficial]
6. OpenAI, *Changelog*, entrada del 3-sep-2026: https://developers.openai.com/api/docs/changelog [oficial]
7. Anthropic, *Introducing Claude Opus 4.5* (24-nov-2025): https://www.anthropic.com/news/claude-opus-4-5 [proveedor con cifra, un benchmark]
8. Cuadron et al., *The Danger of Overthinking: Examining the Reasoning-Action Dilemma in Agentic Tasks*, arXiv 2502.08235 (12-feb-2025) [medido]
9. Gema et al., *Inverse Scaling in Test-Time Compute*, arXiv 2507.14417 (19-jul-2025, rev. 15-dic-2025) [medido]
10. Ghosal et al., *Does Thinking More always Help? Mirage of Test-Time Scaling in Reasoning Models*, arXiv 2506.04210 (4-jun-2025, v3 23-oct-2025) [medido]
11. Chen et al., *Do NOT Think That Much for 2+3=? On the Overthinking of o1-Like LLMs*, arXiv 2412.21187 (30-dic-2024) [medido]
12. Claude Code, *Manage costs effectively* (el pensamiento se factura como salida; bajar el esfuerzo con `/effort`): https://code.claude.com/docs/en/costs [oficial]
13. `benchmarks/salida/resultados/salida-por-clase-2026-09-10.json` y `salida-anatomia-2026-09-06.json` [interno, medido sobre el corpus del dueño]
14. `docs/BITACORA-2026-09-10.md` («Medir la palanca D contra la verja de calidad antes de encenderla») y `docs/COMPETENCIA-2026-09-26.md` §4 (erosión alta de la palanca D) [interno]
15. `benchmarks/salida/resultados/salida-banco-2026-09-06-sonnet-4-5.json` (entrada media por ejecución del anillo 0) [interno, medido]

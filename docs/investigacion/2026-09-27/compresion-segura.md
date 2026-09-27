# Compresión segura: compactar la cola sin tocar el prefijo

**Fecha:** 2026-09-27 · **Línea:** «compresion-segura» (una de diez en paralelo) · **Rama:** `feat/compresion-segura` · **Base:** `origin/main` en `bd108ff` (0.4.25)

Etiquetas: **[medido]** = medición con método publicado; **[marketing]** = cifra del vendedor; **[simulado]** = banco en seco de este trabajo; **[inferido]** = conclusión de este análisis. Las citas [n] remiten a §9.

---

## 1. La pregunta

¿Puede `@bivelio/savings-layer` llevar en npm una compresión que baje la factura de un agente sin romper la caché de prefijo del proveedor, sin dependencias pesadas, con una verja de fidelidad y otra económica, y medida sin gastar dinero?

La restricción que manda: en un bucle de agente el ~95 % de los tokens de entrada se lee de caché, y reescribir un bloque ya cacheado convierte todo lo posterior en escritura, que cuesta **12,5×** (TTL de 5 min) o **20×** (TTL de 1 h) lo que costaba la lectura [1]. Con las lecturas más baratas de 2026 la proporción empeora: **25–40×** en Opus 5.5 (lectura a 0,05×) y **50–80×** en Fable 5.1 (0,025×) [1].

## 2. Resumen

1. **La evidencia independiente de 2026 es consistente:** comprimir la salida de herramientas de un agente quita tokens y a menudo **sube** la factura. Hay dos mecanismos medidos: se invalida la caché de prefijo (Barker: 123 invalidaciones) y cambia la trayectoria, con más turnos y herramientas repetidas (JetBrains: +13,8 % de turnos; Quesma: +18 %) [4][5][6][7].
2. **El replay del corpus propio ya lo había visto:** la elisión por edad (v0) midió **−16,7 %** y la reducción por tipo (v1) solo **+0,4 %**, tras pagar 51,8 $ de invalidación: v1 esperaba un turno para reducir el bloque, y ese turno de espera era lo que rompía la caché [19].
3. **Lo que decide el signo es CUÁNDO se comprime, no cuánto.** En el banco en seco de este trabajo, con el mismo compactador y casi los mismos tokens quitados, compactar al nacer ahorra **+11 % a +37 %** de la entrada [simulado], sin invalidación ni sesiones peores. Compactar el mismo bloque un turno después da entre **+1,9 %** y **−148 %** [simulado].
4. **Se construye** un compactador **determinista, sin dependencias y sin resumir nada**, en dos formas. La primera es `compactToolOutput()`, una función pura para usar en la ingesta y dentro de cualquier framework. La segunda es la palanca opt-in `toolOutputCompaction` del pipeline. Tiene cuatro transformaciones, cada una **reversible o igual a lo que enseña un terminal**, y no toca las vistas de fichero.
5. **No cobra nada.** Lo quitado es conteo del libro 3 (`compressedInput`). Se resta del baseline reconstruido: `basis` sigue en `measured`, `netSavings` en 0 y no hay referencia comisionable.
6. **Límites declarados.** No se mide el efecto de segundo orden (turnos extra), que es donde las mediciones de 2026 vieron perder dinero, ni el efecto en tráfico real. En el corpus propio de Claude Code la clase «log» era el **0,0 %** del prompt [19], así que en terminales se espera poco. El sitio natural son las apps con API y los agentes de operaciones.

## 3. Hallazgos

### 3.1 La ley de la caché de prefijo (documentación oficial vigente)

- **Anthropic** [1]:
  - La escritura cuesta 1,25× (5 min) o 2× (1 h), y la lectura 0,1×, salvo Opus 5.5 (0,05×) y Fable/Mythos 5.1 (0,025×).
  - «Modifications to cached content invalidate that level and everything that comes after it» (tools → system → messages).
  - La caché automática mueve el punto de ruptura al último bloque en cada turno. La búsqueda hacia atrás llega a **20 posiciones** por punto de ruptura.
  - El mínimo cacheable es de 512 tokens en Opus 5 y 5.5 y en Fable y Mythos 5 y 5.1, de 1.024 en Sonnet 5 y Opus 4.8, y llega a 4.096 en Haiku 4.5 y Opus 4.5 y 4.6.
- **OpenAI** [2]: la caché necesita que el prefijo coincida **exacto**. Desde GPT-5.6 la escritura cuesta 1,25× y la lectura 0,1×, con un mínimo de 1.024 tokens. La guía recomienda poner primero lo estable y al final lo dinámico.
- **Context editing de Anthropic** [3]: `clear_tool_uses` «invalidates cached prompt prefixes when content is cleared», y `clear_at_least` existe precisamente para que borrar compense la invalidación. El propio proveedor trata borrar en mitad del prompt como un gasto que hay que justificar.

### 3.2 Mediciones independientes 2025–2026 (distinguiendo marketing de medición)

| Fuente | Qué se midió | Resultado | Mecanismo declarado |
|---|---|---|---|
| JetBrains, RTK en Claude Code (jul-2026) [4] | 425 pruebas facturadas, SkillsBench, Sonnet 5 | **+7,6 %** de coste por tarea (p=0,004) en esfuerzo bajo; +13,8 % de turnos; +0,1 % en esfuerzo alto | el gancho solo ve ~1/5 de la salida; Claude Code ya trunca lo patológico; las relecturas cacheadas cuestan una décima; «a broken rewrite here and an extra exploration turn there» [medido] |
| Quesma, RTK (11-sep-2026) [5] | Terminal-Bench 2.1, 1.740 intentos | Fable **+1 %** (el IC incluye 0); DeepSeek **+17 %**; +18 % de turnos | la salida de terminal era el 11 % de la entrada de Fable; lo que se «ahorra» se lee de caché [medido; parte interesada] |
| B. Barker, Headroom (28-jul-2026) [6] | 25 tareas de Senior SWE Bench | **−39 %** de tokens de entrada; −0,37 $/tarea, dentro del ruido; la mediana, más cara | **123 invalidaciones** de caché; la relación lectura:escritura cae de 38:1 a 11:1. Recomienda «rewriting only the newest part of the transcript» [medido] |
| Weinberger y Hozez, arXiv 2607.12161 (13-jul-2026) [7] | Claude Code, tareas controladas y SWE-bench Go | **−38,4 %** de tokens de salida de herramientas y **+6,8 %** de coste; r=0,15 entre tokens y coste | la caché domina la entrada; la compresión cambia la trayectoria [medido] |
| CAVEWOMAN, arXiv 2606.24083 (23-jun-2026) [8] | 8 modelos, 5 conjuntos | comprimir la **entrada** encarece ~1,15× (hasta 2,7×) | el modelo compensa con salidas más largas [medido] |
| JetBrains, Caveman (jul-2026) [9] | ~240 pruebas | −8,5 % de salida y ~−10 % de coste, p=0,82 en calidad | solo comprime la narración entre herramientas [medido] |
| Lindenbauer et al., «The Complexity Trap» (v3 27-oct-2025) [10] | SWE-agent en SWE-bench Verified, 5 configuraciones | enmascarar observaciones viejas (M=10) **reduce el coste a la mitad** frente al agente sin gestión, con la misma tasa de resolución que resumir con un LLM | **no contabiliza la caché de prefijo** [medido, con esa salvedad] |
| «Don't Break the Cache», arXiv 2601.06007 (v2 31-ene-2026) [11] | más de 500 sesiones agénticas en 3 proveedores | la caché baja el coste **41–80 %** | recomienda excluir de los bloques cacheados los resultados de herramienta dinámicos [medido] |
| CAPC, arXiv 2607.15516 (17-jul-2026) [12] | Sonnet 4.6, LongBench-v2, τ-bench | **−49 %** frente a usar solo la caché | comprime **una vez** lo estable, con una cota que mantiene el prefijo por encima del tramo [medido] |

**Lectura [inferido].** CAPC y «The Complexity Trap» no contradicen al resto: la regla no es «no comprimas», sino que **no se puede cambiar de opinión sobre bytes que el proveedor ya tiene**. CAPC comprime el prefijo una sola vez y lo deja estable. El enmascarado de «The Complexity Trap» cambia de opinión en cada turno, y su cuenta no incluye la caché.

### 3.3 LLMLingua-2 y los compresores con modelo

- LLMLingua-2 [13] plantea la compresión como una clasificación de tokens con **XLM-RoBERTa-large / mBERT**, entrenada con **MeetingBank** (transcripciones de reuniones). El artículo anuncia un ratio de 2–5× y 1,6–2,9× menos latencia de extremo a extremo.
- Su port a JS [14] depende de `@huggingface/transformers`, descarga modelos de **57 MB (TinyBERT) a 2,24 GB (XLM-RoBERTa)**, se declara «Experimental» y no tiene tests unitarios.
- **Descartado para npm [inferido]:** es una dependencia pesada, se entrenó en otro dominio (prosa de reuniones, no logs, código ni JSON) y es **con pérdida por diseño**, que es justo el camino que las mediciones de §3.2 asocian con turnos extra.

### 3.4 Competidores

- **Headroom** (Apache-2.0, README consultado el 27-sep-2026; v0.39.0 del 25-sep según [20]) [15]:
  - Ya comprime **solo los bytes nuevos** en una «live-zone» y tiene un CacheAligner que «never rewrites prompts». No hemos verificado desde qué versión lo hace; la medición de Barker [6] es del 28-jul.
  - Sus transformaciones son **con pérdida**: SmartCrusher conserva en un JSON los errores, los valores atípicos y los extremos, CodeCompressor trabaja sobre el AST y hay un modelo `kompress-v2-base`. Compensa con CCR, una recuperación del original mediante una herramienta.
  - Es Python.
  - **Consecuencia [inferido]:** «comprimir la cola» ya no diferencia por sí solo. Lo que sí diferencia es hacerlo **sin pérdida verificable** y **medido y separado de la comisión**.
- **RTK / RTK Pro:** filtra la salida de terminal con pérdida. Hay dos mediciones independientes en contra [4][5].
- **TOON** (README [16], [marketing]): en su propio banco, JSON compacto frente a JSON indentado es **−33 % de tokens** (2.892 frente a 4.308 de media) con una precisión del 69,0 % ±2,9 frente al 71,4 % ±2,8. Los intervalos se solapan. Este trabajo **no** adopta TOON: [20] recoge −9 pp en tool-calling multiturno, y el dueño lo explora en la pasarela en sombra en otra rama.
- **¿Cuánto JSON llega indentado?** Varía. El servidor MCP de referencia `memory` devuelve `JSON.stringify(x, null, 2)` [17]. El servidor oficial de GitHub usa `json.Marshal`, compacto [18]. El banco publica las dos clases por separado.

### 3.5 Lo que ya había en el repositorio

- **El replay del corpus del 2026-09-07** (4.232 turnos, 45 sesiones, 1.276,81 $ reales) [19]:
  - v0 (edad × tamaño): **−16,7 %**, con 611 $ de invalidación.
  - v1 (por tipo): **+0,4 %**, con 51,8 $ de invalidación.
  - v2: −18,8 %. v2m: −12,5 %.
  - Reparto del prompt por clase: «otro» 58,5 %, código 0,4 %, diff 0,2 %, **log 0,0 %**.
- **v1 era casi esto y perdió por un detalle de diseño:** eximía el último tool_result (`i !== indiceUltimoToolResult`) y lo reducía un turno más tarde. Cada bloque se reescribía una vez **después** de estar en caché.
- **La etapa 9 (compresión con un compresor inyectado) no es segura con la caché en conversaciones de varios turnos** [inferido del código, `src/pipeline/pipeline.ts`, etapa 9]:
  - Comprime **todos** los mensajes que no son `system`, historial incluido.
  - Su verja de tamaño (`minimumContextTokens`, 2.000 por defecto) y la del tramo de caché dependen del prompt entero, que crece. La misma conversación pasa de «no comprimir» a «comprimir» a mitad de camino y reescribe su historial.
  - Lo publica (`prefixRewritten`) y recorta el marcado al `system`, pero no lo evita.
  - **No se cambia hoy:** es un comportamiento de una palanca gestionada existente, y la decisión es del dueño (§6).

## 4. Opciones

| Opción | Ahorro esperable | Riesgo de caché | Riesgo de fidelidad | Dependencias | Veredicto |
|---|---|---|---|---|---|
| A. LLMLingua-2 (port JS) | alto en tokens | depende de dónde se aplique | alto (con pérdida y de otro dominio) | 57 MB–2,24 GB de modelo | **No** |
| B. Reductores con pérdida por tipo (v1, RTK, SmartCrusher) | medio | nulo si se aplica al nacer | turnos extra medidos [4][5][7] | ninguna | **No por defecto** |
| C. **Compactación sin pérdida al nacer** (esta línea) | bajo–medio según la clase | **nulo** en régimen estable | nulo o equivalente al terminal (verificado) | ninguna | **Sí** |
| D. Con pérdida + reversible (CCR: herramienta de recuperación) | alto | nulo al nacer | acotado por la recuperación | exige cambiar el bucle del agente | Más adelante |
| E. Nativas del proveedor (compactación, `clear_tool_uses`) | alto | la pagan a sabiendas (`clear_at_least`) | la gestiona el proveedor | ninguna | Complementaria; ya es gratis |

## 5. Decisión y porqué

**C, en dos formas:**

1. **`compactToolOutput(text, settings?)`** (exportada). Es una función pura. Para el desarrollador que usa un framework (AI SDK, Mastra, LangChain) es el camino robusto: se llama en la herramienta antes de devolver el resultado, el historial ya guarda el texto compactado y no hay nada que la caché pueda ver cambiar. Los adaptadores de la capa, a propósito, no transforman el prompt del framework (`SavingsAdapterLevers` solo admite palancas que evitan llamadas), así que esta es la vía para ellos.
2. **La palanca opt-in `toolOutputCompaction`** para quien llama a `layer.generate()`, por capa o por petición.

**Por qué es segura con la caché:** la decisión sobre cada `role: "tool"` es **función pura de su texto y de la llamada que lo pidió**. No depende de la posición, del tamaño del prompt ni del modelo, y **no usa memoria entre peticiones**:

- se compacta el turno en que nace (es cola: se escribe en caché de todas formas);
- en cada turno posterior se reenvían los mismos bytes;
- sobrevive a reinicios y a instancias serverless distintas.

**Una memoria «pegajosa» sería peor.** Dos turnos seguidos en instancias distintas enviarían versiones distintas del mismo bloque, y el prefijo se rompería en cada salto. Es el baile de víctimas que hundió v2 al −38,9 % [19].

**Por qué es segura con la fidelidad:** las cuatro transformaciones, y nada más:

- **`json`:** solo si el texto entero es JSON. Quita el espacio entre tokens léxicos y no reserializa: un id de 23 dígitos y `1.0` salen igual. Exige que el resultado parsee al mismo valor.
- **`repeated-lines`:** pliega rachas de líneas idénticas consecutivas en la primera línea más la cuenta. Exige que la expansión reproduzca el original byte a byte. Si el original ya contiene algo con forma de marcador, no lo toca.
- **`ansi`:** quita las secuencias de escape del terminal.
- **`carriage-return`:** deja lo que un terminal enseña. No actúa si hay `\r\n`.

Además, **no se tocan nunca** las vistas de fichero (llamadas cuyos argumentos nombran `path`, `file_path`…): un agente que edita por coincidencia exacta copia lo que leyó. Tampoco se tocan `system`, `user` ni `assistant`.

**Por qué no hay verja por petición:** cualquier verja que dependa del prompt entero, como las de la etapa 9, cambia de opinión a mitad de conversación. La única verja económica permitida es la que no cambia de opinión: un mínimo de caracteres ahorrados por mensaje (256 por defecto).

## 6. Qué se construye hoy y qué queda

**Construido (este PR):**

| Pieza | Fichero |
|---|---|
| Compactador, selección sobre los mensajes y detección de vistas de fichero | `src/compression/cola.ts` |
| Exportación pública: `compactToolOutput`, `COMPACTION_TRANSFORMS`, `DEFAULT_MIN_SAVED_CHARS` y tipos | `src/compression/index.ts` |
| Palanca `savings.toolOutputCompaction` y `createSavingsLayer({ toolOutputCompaction })` | `src/contracts/types.ts`, `src/pipeline/config.ts` |
| Etapa 9-ter en el pipeline, después de la elisión y detrás de la licencia `long_context_compression`; traza que separa `tailSavedTokens` de `replayedSavedTokens` | `src/pipeline/pipeline.ts` |
| Contabilidad: `SavingsLedger.compactedLocal`, restado de `removedInputLocal` (conteo sin dinero ni comisión) | `src/tokenizer/accounting.ts`, `src/pipeline/pipeline.ts` |
| Verja de fidelidad: casos límite más un fuzz sembrado de 600 textos, cruzado con implementaciones de referencia independientes | `test/compactacion-de-cola.test.ts` |
| Verja en el pipeline: prefijo byte a byte idéntico entre turnos, **con una capa nueva por turno**; vistas de fichero; `false` gana; `basis` `measured` con `netSavings` 0 | `test/compactacion-de-cola-en-el-pipeline.test.ts` |
| Banco en seco y su verja económica: el artefacto publicado tiene que coincidir con una tirada nueva | `benchmarks/compactacion-de-cola/`, `benchmarks/evidencia/compactacion-de-cola-2026-09-27.json`, `test/banco-compactacion-de-cola.test.ts`, `pnpm compactacion:banco` |
| README: sección opt-in sin cifras | `README.md` |

**Las verjas se comprobaron con mutaciones.** Se aplicaron dos cambios a mano y se revirtieron:

- Si la compactación se aplica solo al historial (el patrón v1), falla la verja del prefijo.
- Si se quita la resta de `compactedLocal`, falla la verja de contabilidad.

**Queda:**

1. **Medición en tráfico real, por conversación.** La verificación por muestreo (#324) empareja **una** petición, y su copia reenvía el historial original, que el proveedor no tiene en caché. En los turnos que reenvían salidas compactadas, la copia sale más cara de lo que habría costado ir sin la capa, y el par exagera el ahorro. Esto ya vale para la elisión. Propuesta:
   - una exclusión `history_rewritten` en `clasificar()`, con `replayedSavedTokens > 0`;
   - requiere tocar `apps/web/lib/verificacion/wire.ts`, los 10 idiomas y desplegar antes el servidor, porque la lista blanca rechaza lotes con valores desconocidos.
   - Mientras tanto, el README lo advierte.
2. **Replay del corpus real con contenido.** `pnpm sombra:corpus` compacta cada petición a metadatos sin contenido, y las capturas de `~/.bvsala-f0` guardan las cabeceras de cada petición, que pueden llevar credenciales, así que esta línea no las ha leído. El dueño puede añadir a `gateway/sombra.ts` una política «al nacer», que es v1 sin la exención del último bloque o esta compactación, y medirla sobre su corpus.
3. **La etapa 9 con compresor inyectado** debería limitarse a la cola o a peticiones de un solo turno (§3.5). Cambia el comportamiento de una palanca existente: decisión del dueño.
4. **Opción D (con pérdida y reversible)** con una herramienta de recuperación, si una medición en vivo demuestra que no añade turnos.
5. **Pasarela:** esta línea no toca `gateway/`. El dueño tiene en local una rama (`feat/caveman-toon-capa-intermedia`) que aplica la misma ley a TOON en sombra. La compactación de este PR se podría medir allí igual, porque también se aplica solo al tool_result del turno.
6. **Coste local:** la compactación corre sobre todos los `role: "tool"` en cada turno, y el pipeline cuenta los tokens de antes y de después. Compactar ~140 KB lleva del orden de 1 ms en un portátil (medición local, no en CI). Lo que domina es el recuento de tokens, del mismo orden que el de las demás etapas. Si un perfil lo pide, se puede memoizar por contenido, porque es una función pura.

## 7. Resultados del banco en seco [simulado]

**Método:**

- 60 sesiones sintéticas deterministas (20 por perfil, 15–40 turnos de herramienta cada una).
- El compactador de npm, con **la misma selección que el pipeline**.
- El simulador de caché del carril sombra (`CadenaDeSimulacion`), calibrado al 3 % de error de escritura contra el contador real [19], con puntos de ruptura en el `system` y en el último bloque y TTL de 5 min.
- Tokens con o200k_base y precios del catálogo.
- **Solo entrada; la trayectoria es fija.**
- Las sesiones reproducen el régimen real: el **93,4–93,8 %** de los tokens de entrada se lee de caché, y la escritura es el 45–47 % del coste de entrada en Sonnet 5 y el 62–64 % en Opus 5.5.

**Brazos** (mismo compactador; solo cambia el momento):

- **cola:** al nacer.
- **vieja:** el más nuevo viaja entero y se compacta en el turno siguiente.
- **mitad:** la palanca se enciende a mitad de sesión.

Ahorro sobre el coste de entrada de `base` (positivo = más barato):

| Perfil | Modelo | cola | vieja | mitad | Tokens quitados (cola / vieja) | Sesiones peores que base (cola / vieja / mitad) |
|---|---|---|---|---|---|---|
| app-con-api | claude-sonnet-5 | **+17,7 %** | −14,2 % | −5,2 % | 17,7 % / 16,6 % | 0 / 20 / 17 |
| app-con-api | claude-opus-5-5 | **+17,6 %** | −27,6 % | −13,2 % | 17,7 % / 16,6 % | 0 / 20 / 20 |
| agente-de-codigo | claude-sonnet-5 | **+11,3 %** | +1,9 % | −6,8 % | 11,2 % / 10,5 % | 0 / 7 / 14 |
| agente-de-codigo | claude-opus-5-5 | **+11,4 %** | −1,9 % | −13,2 % | 11,2 % / 10,5 % | 0 / 13 / 15 |
| agente-de-operaciones | claude-sonnet-5 | **+37,3 %** | −94,0 % | +12,0 % | 36,8 % / 34,3 % | 0 / 20 / 0 |
| agente-de-operaciones | claude-opus-5-5 | **+37,5 %** | −148,0 % | +5,3 % | 36,8 % / 34,3 % | 0 / 20 / 4 |

Reducción de tokens (o200k) por clase de salida:

| Clase | Salidas | Compactadas | Tokens medios | Reducción |
|---|---|---|---|---|
| json-indentado | 365 | 365 | 3.537 | **−32,2 %** (`json`) |
| tests-con-color | 136 | 136 | 1.740 | **−60,9 %** (`ansi`) |
| sondeo-repetido | 153 | 152 | 727 | **−87,3 %** (`repeated-lines`) |
| barra-de-progreso | 78 | 78 | 800 | **−86,7 %** (`carriage-return`) |
| json-compacto, tests-sin-color, prosa-web, diff | — | 0 | — | 0 % (nada que quitar) |
| lectura-de-fichero, grep | — | 0 | — | 0 % (vistas de fichero: no se tocan) |

**Cómo leerlo:**

- **El resultado transferible es el mecanismo, no el agregado.** Con casi los mismos tokens quitados, `vieja` pierde hasta −148 %. Con caché automática, el punto de ruptura de cada turno cae en el bloque más nuevo, que `vieja` reescribirá en el turno siguiente, así que la entrada escrita en cada turno **no se vuelve a leer nunca**. `cola` es la única variante en la que esa entrada sigue siendo reutilizable. En 120 sesiones-modelo no encarece ninguna y no paga ni un céntimo de invalidación.
- **Los agregados por perfil dependen de la mezcla declarada** (`MEZCLA` en `benchmarks/compactacion-de-cola/sesiones.ts`, publicada en el artefacto). **No son una promesa de producto.** El `json-indentado` a −32 % coincide con el −33 % del banco de TOON para JSON compacto frente a indentado [16]. En el tráfico real de Claude Code del corpus propio la clase «log» era el 0,0 % del prompt [19], así que en terminales el efecto esperable es pequeño [inferido].
- **Encenderla a mitad cuesta.** Con sesiones cortas y mucho historial compactable, esa reescritura única no se recupera (−5 % a −13 % en `app-con-api`). Por eso la documentación pide encenderla para conversaciones enteras.

## 8. Riesgos

| Riesgo | Mitigación en este PR | Qué queda |
|---|---|---|
| Turnos extra porque el modelo necesita lo que se quitó (el fallo medido de 2026) | No se quita información: reversible o equivalente al terminal; fuzz con referencias independientes | Medirlo en vivo, por conversación (§8.1) |
| Ediciones por coincidencia exacta que dejan de casar | Las vistas de fichero no se tocan; `exceptTools` | Llamadas de lectura sin argumento de ruta (poco habitual): `exceptTools` |
| Encenderla a mitad de conversación | Documentado (JSDoc, README); medido (brazo `mitad`) | — |
| Cambiar los ajustes entre peticiones de la misma conversación | Documentado: los ajustes son por conversación | — |
| Pares de verificación sesgados a favor de la capa | Advertido en el README | Exclusión `history_rewritten` (§6.1) |
| Un texto que ya contiene una línea con forma de marcador | No se pliega (ambigüedad) | — |
| Cobrar de más | Imposible por construcción: conteo del libro 3; `basis` `measured`; `netSavings` 0; la referencia no se registra (E2) | — |

### 8.1 Cómo se medirá el efecto

1. **En seco (hecho, en CI):** `test/banco-compactacion-de-cola.test.ts` exige, para cada perfil y modelo, cero invalidación, ninguna sesión peor y que `vieja` y `mitad` queden por debajo. También exige que el artefacto publicado sea el que calcula el código.
2. **En vivo, por conversación, no por petición:**
   - Aleatorizar conversaciones enteras (hash del id de sesión) entre palanca encendida y apagada.
   - Métricas: coste por conversación según el contador del proveedor, **turnos por conversación**, llamadas a herramientas repetidas y tasa de tareas completadas.
   - La palanca solo se defiende si el coste baja **y** los turnos no suben (IC del 95 %).
   - Es el diseño que usaron JetBrains y Quesma, y el único que ve el efecto de segundo orden.
3. **En producción:** la traza `tool-output-compaction` publica `tailSavedTokens` y `replayedSavedTokens` en cada petición. Lo segundo solo debería ser distinto de cero en conversaciones que ya venían compactadas. `report.tokens.compressedInput` es el conteo que ve el cliente.

## 9. Fuentes

1. Anthropic, «Prompt caching», https://platform.claude.com/docs/en/build-with-claude/prompt-caching (consultado el 2026-09-27).
2. OpenAI, «Prompt caching», https://developers.openai.com/api/docs/guides/prompt-caching (consultado el 2026-09-27).
3. Anthropic, «Context editing», https://platform.claude.com/docs/en/build-with-claude/context-editing (consultado el 2026-09-27).
4. JetBrains AI Blog, «rtk Claude Code token savings», https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/ (jul-2026) [medido].
5. Quesma, «Does RTK make AI coding cheaper?», https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/ (11-sep-2026) [medido; parte interesada].
6. B. Barker, «Headroom: fewer tokens, bigger bill», https://brandonbarker.me/writing/headroom-fewer-tokens-bigger-bill (28-jul-2026) [medido].
7. S. Weinberger y A. Hozez, «Token Reduction Is Not Cost Reduction», arXiv 2607.12161 (13-jul-2026; rev. 12-ago-2026) [medido].
8. «CAVEWOMAN: How Large Language Models Behave Under Linguistic Input and Output Compression», arXiv 2606.24083 (23-jun-2026) [medido].
9. JetBrains AI Blog, Caveman, https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/ (jul-2026) [medido].
10. T. Lindenbauer et al., «The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management», arXiv 2508.21433 (v3, 27-oct-2025) [medido; sin caché de prefijo].
11. «Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks», arXiv 2601.06007 (v2, 31-ene-2026) [medido].
12. «Cache-Aware Prompt Compression: A Two-Tier Cost Model for LLM API Caching» (CAPC), arXiv 2607.15516 (17-jul-2026) [medido].
13. Z. Pan et al., «LLMLingua-2», Findings of ACL 2024, arXiv 2403.12968 (rev. 12-ago-2024).
14. atjsh/llmlingua-2-js, https://github.com/atjsh/llmlingua-2-js (consultado el 2026-09-27).
15. Headroom, https://github.com/headroomlabs-ai/headroom (README consultado el 2026-09-27) [marketing].
16. TOON, https://github.com/toon-format/toon (README consultado el 2026-09-27) [marketing].
17. modelcontextprotocol/servers, `src/memory/index.ts` (rama main, consultado el 2026-09-27): `text: JSON.stringify(result, null, 2)`.
18. github/github-mcp-server, `pkg/github/issues.go` (rama main, consultado el 2026-09-27): `json.Marshal(...)`.
19. Repositorio: `benchmarks/evidencia/sombra-corpus-2026-09-07-reparto.json`; `docs/PLAN-S4-PALANCA.md` («Consecuencias del arreglo del simulador»); `docs/PLAN-PASARELA-API-KEY.md` (S2.4); `gateway/sombra.ts`.
20. `docs/COMPETENCIA-2026-09-26.md` (informe de competencia, §2.5, §4.1 y §9).
21. Este trabajo: `benchmarks/evidencia/compactacion-de-cola-2026-09-27.json` (`pnpm compactacion:banco`).

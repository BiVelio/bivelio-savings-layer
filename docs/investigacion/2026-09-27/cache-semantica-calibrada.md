# Caché semántica calibrada: un suelo que certifican las etiquetas, con la tasa de error que elige el usuario

**Fecha:** 27‑sep‑2026 · **Línea:** `cache-semantica-calibrada` · **Rama:** `feat/cache-semantica-calibrada` · **Base:** `origin/main` en `372f866` (SDK 0.4.25, tras #339, #342 y #345) · **Código medido:** commit `1d58bad` de esta rama, con el árbol limpio.

Las citas [n] remiten a las fuentes del final, con la fecha en que se consultaron. Etiquetas: **[medido]** medición con método; **[marketing]** cifra del propio vendedor; **[inferido]** conclusión de este informe. Las cifras propias salen de los tres ficheros de `benchmarks/evidencia/` que cita la §8; ninguna se ha copiado a mano de otro sitio.

---

## 0. La respuesta corta

1. **Un umbral global no se transfiere entre embebedores ni entre cargas.** Apuntan en esa dirección vCache [1] (ningún umbral estático acota el error cuando crece la diversidad de prompts), *Closing the Operational Gap* [5] (elegir modelo para caché es un problema de umbral‑utilidad), la guía oficial de RedisVL [9] (el umbral cambia con el embebedor, la consulta y el caso de uso) y *Similarity Gates Approve Reversals* [4] (el coseno mide la redacción, no el sentido). El estado del arte con garantía es vCache (ICLR 2026) [1], pero su código es CC BY‑NC‑ND 3.0 [2], su δ acota el error **por petición** (las exploraciones cuentan como aciertos) y su garantía depende de que un sigmoide por embedding esté bien especificado.
2. **Construido (opt‑in, apagado por defecto):** `InMemorySemanticCache({ calibration: { maxErrorRate } })`. La caché no sirve ninguna reformulación hasta que el propio tráfico certifica un suelo con garantía de muestra finita sobre la **precisión** (la tasa de erróneas entre lo reutilizado, que es más exigente que la de vCache). Test binomial exacto sobre una mitad retenida, candidatos en secuencia fija, α repartido entre miradas y suelos por registro que solo quitan reutilizaciones. La cota viaja en cada acierto: `report.qualityLedger.cacheMatch.calibration`.
3. **La garantía se cumple en simulación:** 0 tiradas de 900 con una violación en línea (300 por configuración, tres configuraciones). El precio: una mediana de 2.820 a 3.537 etiquetas hasta la primera certificación con δ = 5 %, y 13.302 con δ = 2 % [medido, E3].
4. **En el único stream público de uso comercial, ningún umbral separa.** En SemBenchmarkLmArena, con el juez del propio dataset (misma clase), el error de las candidatas que pasan la verja determinista es plano, en torno al 10 %, en toda la escala de puntuación: con el embebedor léxico y con e5‑large‑v2 [medido, E1, E2]. Todo apunta a ruido de etiqueta: de las 97 «erróneas» a puntuación 1,00, 70 tienen el texto guardado idéntico al consultado. La caché calibrada **rehúsa** prometer δ ≤ 12 %, y con δ = 15 % certifica y cumple (precisión realizada 91,7 %). A cambio sirve 710 reutilizaciones en vez de 2.359: el arranque en frío se come 13.121 de las 16.316 consultas.
5. **Implicación:** la calibración no sube la precisión donde la similitud no separa. Lo que hace es impedir que la caché prometa lo que no puede cumplir. Su valor está en el tráfico del cliente con un juez propio o con salida estructurada. No cambia la facturación: un acierto semántico sigue sin base `reference` y una sonda es una llamada normal.

---

## 1. La pregunta

¿Debe BV‑SALA sustituir el umbral global de la caché semántica por umbrales calibrados con una tasa de error acotada por el usuario, al estilo de vCache? ¿Qué se puede prometer y con qué evidencia? ¿Qué se construye hoy sin que nada pueda cobrar de más?

**Punto de partida (código de `main`):**

- Suelos fijos: similitud 0,72 con el embebedor léxico propio y 0,9 con uno del cliente; confianza 0,85 (`src/cache/semantic.ts`).
- Por debajo del embedding, una verja determinista: cifras y fechas, paridad de negación y un Jaccard ≥ 0,75 de palabras de contenido, turno a turno.
- Precisión publicada (#335) con el embebedor léxico: 98,3 % [91,0–99,7] en las tripletas de GPTCache y 90,3 % [88,0–92,6] en el stream de SemBenchmarkLmArena (`docs/SEMANTIC-CACHE-PRECISION.md`).
- Apagada por defecto en tráfico agéntico (#335), como aconseja LiteLLM [8].
- Un acierto semántico no tiene base `reference`, así que no entra en la comisión (README, «commission only on savings measured»).

## 2. Hallazgos

### 2.1 vCache, el estado del arte con garantía [1][2][3]

- **Método.** Para cada embedding guardado, un sigmoide `L(s; t, γ)` modela P(correcta | similitud s). t y γ se estiman por máxima verosimilitud con las observaciones de ese embedding. Con probabilidad τ(s) se explora: se llama al LLM y se compara su respuesta con la guardada para tener la etiqueta. τ se calcula para que P(respuesta correcta) ≥ 1 − δ [1, §4].
- **Qué acota δ.** El Teorema 4.1 dice: «Pr(vCache(x) = r(x) | D) ≥ (1 − δ)», bajo dos supuestos: que los prompts sean i.i.d. y que la familia sigmoide modele bien la verosimilitud de cada embedding [1]. Una exploración es una llamada al LLM y cuenta como correcta «by design» [1]. **Es una cota del error por petición, no de la precisión de lo reutilizado.** Con nuestro stream se ve la diferencia: la caché estática da un 1,4 % de error por petición consultada y, a la vez, un 9,7 % de erróneas entre sus reutilizaciones (229 de 2.359) [medido, E1]. Con la métrica de vCache, la misma caché parece siete veces mejor.
- **Lo que se implementa de verdad.** En los experimentos solo se usan intervalos de confianza para t, y para γ la estimación puntual: «In our experiments, we only use confidence intervals for t… We estimate and use the point estimate γ̂» [1, Apéndice C].
- **Etiquetas.** En SemCacheLMArena y SemCacheSearchQueries, la equivalencia de respuestas la decide un LLM como juez; en SemCacheClassification, la coincidencia exacta de texto [1, §6]. **No es la definición por clase (`ID_Set`) que usa nuestro banco.**
- **Resultados** [medido por los autores]: «up to 12.5× higher cache hit and 26× lower error rates» y, en SemCacheLMArena, «a cache hit rate of 57% while keeping the error rate below 0.5%» [1]. En SemCacheSearchQueries: «no static threshold below 1.0 can maintain a bounded error rate… the threshold of 0.99… yields an error rate of 1.7% after 150k samples» [1, Apéndice F.1].
- **Licencia.** El artículo es CC BY‑NC‑ND 4.0 en arXiv [1]. El código (`vcache-project/vCache`, `master` en `50694ee`, último push el 30‑jul‑2026, 80★) es **CC BY‑NC‑ND 3.0 Unported** [2]. No se puede usar ni adaptar en un producto comercial. Aquí no se copia nada: el método construido es otro (§4) y sale de estadística estándar [6][7]. Los datasets SemBenchmark son Apache‑2.0 según su ficha [3].

### 2.2 Literatura 2025‑2026

| Trabajo | Qué aporta aquí | Etiqueta |
|---|---|---|
| *Similarity Gates Approve Reversals* (Frias, 10‑ago‑2026) [4] | El coseno mide cuánto cambió la redacción, no si cambió el sentido. Un guardián de deriva en producción cazó 0 de 56 mutaciones que rompían el sentido, y aprobó «withhold the study drug» → «administer the study drug» con coseno 0,9608. La precisión equilibrada no pasó de 0,700 en 90 combinaciones (mediana 0,525). | [medido] |
| *Closing the Operational Gap in Semantic Caching* (Baral et al., 18‑jun / 1‑sep‑2026) [5] | Elegir modelo para caché semántica es un problema de umbral‑utilidad, no de ranking: los modelos con mejor PR‑AUC son a menudo los peores en operación. | [medido] |
| Krites, *Asynchronous Verified Semantic Caching* (Singh et al., 13‑feb / 12‑mar‑2026) [10] | Un juez LLM asíncrono verifica los vecinos que se quedan justo por debajo del umbral, sin tocar el camino crítico. Hasta 3,9× más respuestas curadas servidas. | [medido, simulación con trazas] |
| *Category‑Aware Semantic Caching* (Wang et al., 29‑oct‑2025) [11] | Umbrales, TTL y cuotas por categoría: el código se agrupa denso y la conversación disperso. | mezcla de [medido] y modelado |
| *Which Eviction Policy Should an LLM Cache Use?* (Kulkarni et al., 20/22‑ago‑2026) [12] | Aciertos brutos del 51–60 % que, ajustados por sustituibilidad de la respuesta, bajan al 1,1–2,2 %. | [medido] |
| *Risk‑Constrained Freshness‑Aware Semantic Caching* (Mansoor et al., 5‑jul‑2026) [13] | Presupuestos de error por nivel (ε = 0,10 / 0,20 / 0,35) para la frescura. | [medido] |
| *Learn then Test* (Angelopoulos et al., 2021/2022) [6] | Calibrar un umbral como un problema de contraste múltiple, con garantías de muestra finita; secuencia fija sin repartir α. | método |

La búsqueda en arXiv de «semantic cache» con «conformal / risk control / error rate guarantee» solo devuelve vCache como caché de respuestas de LLM con garantía estadística [14]. El hueco de una garantía sobre la **precisión** sigue abierto [inferido].

### 2.3 Competidores y herramientas

- **LiteLLM:** `similarity_threshold: 0.8` en la configuración de ejemplo, y «Semantic caching is designed for single-shot prompts. On multi-turn or agentic traffic it will replay stale responses.» [8]. Umbral global, sin calibración.
- **RedisVL** (guía oficial en `8bb2f69`, 23‑sep‑2026): «the right semantic similarity threshold is not a fixed quantity. Depending on the choice of embedding model, the properties of the input query, and even business use case -- the threshold might need to change.» Se ajusta a mano con `set_threshold` [9].
- **GPTCache:** con umbral 0,80, solo el 42,2 % de las reutilizaciones son correctas [medido por el proyecto; informe de competencia, ref. 90].
- **LangCache, Portkey, Kong, Azure APIM, Fastly:** caché semántica con umbral configurable. Sus cifras publicadas de acierto o ahorro son [marketing] (informe de competencia, §2.4).

**Conclusión de la §2 [inferido]:** nadie en el mercado publica, por petición, la cota de precisión bajo la que se sirvió una reutilización, ni certifica el umbral con el tráfico del cliente. vCache lo hace para el error por petición, en investigación y con licencia no comercial.

### 2.4 Medición propia (sin llamar a ningún modelo, datos públicos fijados)

**E1: stream de SemBenchmarkLmArena, embebedor léxico.** Primeros 20.000 prompts de la revisión `c6f3622`, por la capa completa (`createSavingsLayer`), con el proveedor falso y el juez del dataset (misma clase). Hay 16.316 consultas; el resto lo aparta la política.

*Las etiquetas.* La calibración ve 3.276 candidatas. Esta es su tasa de erróneas por tramo de puntuación:

| Puntuación | Candidatas | Erróneas | Erróneas acumuladas desde arriba |
|---|---:|---:|---:|
| 1,00 | 955 | 97 | 10,2 % |
| 0,95–1,00 | 196 | 28 | 10,9 % |
| 0,90–0,95 | 717 | 73 | 10,6 % |
| 0,85–0,90 | 670 | 55 | 10,0 % |
| 0,80–0,85 | 436 | 42 | 9,9 % |
| 0,75–0,80 | 224 | 25 | 10,0 % |
| 0,70–0,75 | 78 | 6 | 10,0 % |

**La tasa de erróneas es plana: la puntuación no separa lo bueno de lo malo.** Incluso a puntuación 1,00 hay un 10,2 % de «erróneas» (97 de 955). De esas 97, **70 tienen el prompt guardado idéntico, carácter a carácter, al consultado** (y esas 70 son todas las de texto idéntico entre las 326 erróneas del stream): el dataset pone el mismo texto en dos clases [medido, E1, `ruidoDeEtiqueta`]. Las 27 restantes solo difieren en mayúsculas, puntuación u orden. Revisamos a mano 8 de ellas, elegidas al azar con semilla fija (sin publicar el texto), y las 8 eran la misma pregunta. Son preguntas populares de LM‑Arena («strawberry», «9.11 o 9.9»…) que el dataset asigna a clases distintas porque salen de prompts base distintos. Con esta definición de «correcta», el suelo de ruido ronda el 10 % y ningún umbral lo baja [medido; que las 27 sean también ruido es inferido de la muestra].

*Los brazos* (auditoría 5 %, semilla fija, confianza 95 %):

| Brazo | Reutilizaciones | Precisión [IC 95 %, bootstrap por clase] | Erróneas | Suelo | Primera reutilización (consulta n.º) |
|---|---:|---|---:|---|---:|
| Estática (la que se envía) | 2.359 | 90,3 % [88,0–92,6] | 229 | 0,85 fijo | — |
| Calibrada δ = 15 % | 710 | 91,7 % [89,2–94,1] | 59 | 0,721 | 13.121 |
| Calibrada δ = 15 %, sin suelos por registro | 717 | 91,2 % [88,6–93,5] | 63 | 0,721 | 13.121 |
| Calibrada δ = 12 %, 10 %, 5 %, 2 % | 0 | — | 0 | ninguno | nunca |

- Con δ = 15 % la cota se cumple: 8,3 % de erróneas realizadas ≤ 15 %. La certificación descansa en 1.269 etiquetas retenidas por encima del suelo, 136 de ellas erróneas. Sondas: 2.538 durante la calibración, 32 auditorías y 7 por suelo de registro.
- Con δ ≤ 12 % no certifica nunca, y **no sirve nada**. Es lo correcto: fuera de línea, con las 3.276 etiquetas a la vez, δ = 12 % sí certifica 0,721 (1.633 retenidas, 172 erróneas: 10,5 %). En línea no llega porque la mitad de las etiquetas se retiene y α se reparte entre miradas.
- Suelos por registro: −7 reutilizaciones y −4 erróneas. Es una diferencia dentro del ruido. Se mantienen porque solo pueden quitar reutilizaciones.

**E2: el mismo stream con e5‑large‑v2** (vectores precomputados del dataset, suelo de similitud 0,9 por defecto). 3.384 candidatas: 10,6 % de erróneas a puntuación 1,00, 9,4 % entre 0,95 y 1,00 y 19 % entre 0,90 y 0,95 (11 de 57). **Tampoco separa.** Las mismas 70 erróneas con texto idéntico aparecen aquí (de 333 erróneas en total). Fuera de línea certifica 0,905 para δ = 12–15 % y nada por debajo de δ = 10 % [medido].

*Hallazgo lateral.* e5 aporta 3.384 candidatas frente a 3.276 del léxico: un 3 % más. **La verja determinista, y no el embebedor, es la que limita el recall** [medido con el suelo de similitud por defecto, 0,9; una tirada ad hoc no versionada con suelo 0,5 dio las mismas 3.384]. Cambiar de embebedor apenas mueve cuántas reformulaciones llegan a ser candidatas. Es otra línea de trabajo (§6).

**E1b: tripletas de GPTCache, brazo `arena`.** Solo 82 casos tienen una candidata que pase la política, la verja y el suelo de similitud (14 en `calibration` y 68 en `test`; 78 de los 82 reutilizables). Con 14 no se puede calibrar en `calibration` y comprobar en `test`, y la calibración lo dice (`floor: null`). Con las 82 a la vez, δ = 15 % certifica 0,788 (40 retenidas, 2 erróneas) y δ ≤ 12 % no certifica nada.

**E3: simulación con verdad conocida** (`pnpm cache-semantica:simulacion`). Puntuaciones uniformes en [0,6; 1] y P(errónea | s) = 0,5 / (1 + e^{40(s − 0,85)}), decreciente. 300 tiradas por configuración y 20.000 etiquetas por tirada.

| δ | α | Tiradas con alguna violación, en línea | Etiquetas hasta la 1.ª certificación (p50 / p90) | Suelo final p50 (óptimo verdadero) | Fuera de línea: certifica / viola |
|---|---|---:|---|---|---|
| 5 % | 10 % | 0 / 300 | 2.820 / 4.229 | 0,873 (0,857) | 285 / 1 |
| 5 % | 5 % | 0 / 300 | 3.537 / 5.306 | 0,872 (0,857) | 280 / 0 |
| 2 % | 5 % | 0 / 300 | 13.302 / 19.953 (34 tiradas no certifican) | 0,921 (0,892) | 288 / 0 |

La garantía se cumple con holgura: el método es conservador, con un suelo final unas 15–30 milésimas por encima del óptimo. Lo que cuesta son etiquetas.

## 3. Opciones

| Opción | A favor | En contra |
|---|---|---|
| **A.** Dejar el umbral global | Cero trabajo | 0,85 no significa lo mismo con otro embebedor [5][9], y el cliente no tiene cómo saber qué precisión le da |
| **B.** vCache tal cual | Más aciertos publicados (12,5×) [1] | Código NC‑ND [2]. Acota el error por petición, no la precisión. Paramétrico (sigmoide por embedding) y, en la práctica, sin intervalo para γ [1]. Necesita juez LLM para texto libre |
| **C.** Solo calibración fuera de línea (una función) | Simple y exacta | El cliente tiene que traer las etiquetas, y el suelo no se re‑examina |
| **D.** Calibración en línea con garantía sobre la precisión, más la función fuera de línea y suelos por registro que solo restan | Garantía de muestra finita sobre lo que el cliente lee (precisión). No paramétrica. Etiquetas gratis (las candidatas no servidas van al proveedor igualmente). La cota va en el libro de calidad | Arranque en frío largo. Sin juez propio, el texto libre no certifica. El estado vive en memoria |
| **E.** Juez LLM asíncrono (Krites) [10] | Etiqueta texto libre | Cuesta dinero fuera de los libros. Mejor como juez que el cliente enchufa en D |

## 4. Decisión y porqué

**D, opt‑in y apagada por defecto.** Tres razones:

1. **La garantía es sobre lo que se publica.** El producto dice «Precision is the number to read». La cota tiene que ser sobre la precisión, no sobre el error por petición, que se diluye con el tráfico sin candidata. Publicamos el suelo.
2. **No paramétrica y exacta.** Un test binomial exacto (equivalente a Clopper‑Pearson [7]) sobre una mitad retenida que el candidato no ha visto: la afirmación es sobre la población, no sobre la muestra. La secuencia fija [6] permite probar una escalera de candidatos sin repartir α. Las miradas en línea gastan α_k = 6α/(π²(k+1)²), que suma α: la confianza vale para toda la vida de la caché. Supuestos, escritos en el código: tráfico intercambiable, y que una respuesta guardada no es más probable que esté mal a más puntuación.
3. **Nada puede cobrar de más.** Una sonda es una llamada normal al proveedor. Un acierto semántico, calibrado o no, sigue con base `estimated` y sin comisión. Lo comprueba el test «la base del dinero de un acierto calibrado es la de uno sin calibrar».

**Por qué no B:** no se puede usar su código [2]. Además, su δ premia las exploraciones (con la métrica de vCache, nuestra caché estática ya cumpliría δ = 2 %: da un 1,4 % por petición [E1]). Y la parte «por embedding» que da los 12,5× (bajar el umbral de un registro concreto) exige un modelo paramétrico compartido. Con una garantía sobre la precisión, cada registro necesitaría del orden de ⌈ln α / ln(1 − δ)⌉ etiquetas propias (149 con δ = 2 % y α = 5 %). **Por embedding solo se construye en la dirección segura:** un registro juzgado erróneo a una puntuación ya no se sirve a esa puntuación ni por debajo.

## 5. Qué se construye hoy

- **`src/cache/calibracion.ts`** (interno): la cola binomial en escala logarítmica, la rejilla fija de 1.001 umbrales, el histograma, la escalera de candidatos (α, α/4, α/16, α/64, α/256), la secuencia fija, el reparto de α y el estado en línea con miradas en progresión ×1,5.
- **`src/cache/calibration.ts`** (público): `calibrateSemanticFloor(observaciones, { maxErrorRate, confidence })`, el juez por defecto `sameAnswer` (datos estructurados iguales, sin importar el orden de las claves, o texto igual salvo espacios) y los tipos `SemanticCalibrationOptions`, `SemanticCalibrationStatus`, `AnswerJudge` y `CalibrationObservation`.
- **`InMemorySemanticCache`:**
  - opción `calibration` (`maxErrorRate`, `confidence` = 0,95, `judge`, `auditRate` = 0,05, `perRecordFloors` = true, `random`);
  - `lookup()` devuelve el acierto o la sonda (`calibrating`, `below_floor`, `record_floor`, `audit`);
  - `observe()` etiqueta y no rechaza nunca;
  - `calibrationStatus()` y `settled()`;
  - segmentos separados para lo agéntico y lo de un turno.

  Sin `calibration`, `find()` hace exactamente lo de siempre, y el pipeline no toca ese camino.
- **Pipeline:** etiqueta en la etapa 12, sin `await`, solo lo que la caché guardaría: una respuesta cortada, que incumple su contrato o que dio otro modelo no sirve de etiqueta. Las trazas dicen por qué no se sirvió (`semantic-cache` / `miss` con `calibration`) y si hubo etiqueta (`semantic-calibration`).
- **Libro de calidad (#335):** `cacheMatch.calibration = { maxErrorRate, confidence, floor, heldOutAtFloor, wrongHeldOutAtFloor, labeled, segment }`. Solo números y un enum, y se copia en el seguidor coalescido.
- **Banco:** `pnpm cache-semantica:calibrada` (brazos, tabla por tramos, calibración fuera de línea y tripletas) y `pnpm cache-semantica:simulacion`. Arreglado de paso: `--embebedor dataset:*` no corría nunca, porque los vectores del parquet vienen como texto JSON y solo se aceptaban arrays.
- **README:** un párrafo, «Calibrated reuse (opt-in)», sin ninguna cifra medida.
- **Tests** (32 nuevos): la estadística, la garantía por Monte Carlo fuera y dentro de línea (α = 10 %, 300 tiradas), la caché, la capa, el vocabulario cerrado del libro, el conteo del ruido de etiqueta y la alineación etiqueta‑puntuación del banco. Este último guarda un fallo que tuvo la primera versión del banco en esta misma rama: el juez corre dentro de la etapa 12, antes de que exista la traza, y aquella versión casaba cada veredicto con la puntuación de la candidata anterior. No llegó a ningún commit, pero fue lo que se usó en la primera inspección manual, que se rehízo.

## 6. Qué queda

1. **Persistir el estado de calibración.** Hoy vive en memoria, así que cada reinicio vuelve a calibrar y el arranque en frío se paga otra vez. Hace falta exportar e importar el histograma, que ocupa 2 × 2 × 1.001 enteros por segmento.
2. **Un juez LLM asíncrono de serie** (Krites [10]). Su coste tendría que declararse en un libro aparte, nunca restado de un ahorro. Hoy el cliente puede pasar el suyo.
3. **Medir donde la similitud sí separa.** SemBenchmarkClassification [15] (la correctitud es coincidencia exacta, la misma definición que `sameAnswer`) necesita antes una decisión legal: sus fuentes (CommonsenseQA, Ecommerce Categorization, Amazon Instant Video Reviews) no traen licencia en la ficha. Es el mismo criterio que con ORCAS.
4. **El recall lo limita la verja, no el embebedor** (E2). Una verja que no dependa de compartir palabras sin abrir la puerta a las inversiones de sentido [4] es otra línea.
5. **Bajar el umbral por registro** (el origen de los 12,5× de vCache) con un modelo compartido y garantía sobre la precisión: sin diseño aún.
6. **Deriva.** La garantía supone tráfico intercambiable. Las auditorías siguen etiquetando por encima del suelo, pero no hay aún una alarma formal de cambio de distribución.
7. **No se publica ninguna cifra nueva en la web ni en `docs/SEMANTIC-CACHE-PRECISION.md`.** Las de este informe son diagnóstico interno.

## 7. Riesgos

- **Un juez que no es el que el cliente cree.** Con `sameAnswer` sobre texto libre casi nada es «idéntico», así que no certifica y no sirve nada. Es seguro, pero puede confundir. Mitigación: el README y el JSDoc lo dicen, y la traza y `calibrationStatus()` muestran que está calibrando.
- **La garantía es tan buena como el juez y la intercambiabilidad.** Si las etiquetas tienen ruido, o si el tráfico cambia, la cota habla de otra cosa. E1 lo enseña: con el juez por clase, el «10 % de erróneas» es en buena parte ruido de etiqueta.
- **El juez del cliente con un LLM cuesta dinero** que la capa no ve. Queda escrito en `AnswerJudge`.
- **Un `find()` directo no etiqueta**: con calibración y sin `lookup`/`observe`, la caché no certifica nunca. Queda escrito en el JSDoc de `find()`.
- **Ataques de colisión de claves** (arXiv 2601.23088, en el listado de [14]): la calibración no los aborda. Los filtros duros de tenant y principal siguen antes de puntuar.

## 8. Cómo se medirá el efecto

- **Por petición, en el cliente:** `report.qualityLedger.cacheMatch.calibration`, con el suelo, las retenidas y las erróneas que lo sostienen. Y `calibrationStatus()`: etiquetas, próxima prueba y mínimo para certificar.
- **En cada versión:**
  - `pnpm cache-semantica:simulacion`: 0 tiradas con violación, o por debajo de α·N con margen.
  - `pnpm cache-semantica:calibrada`: en los brazos que certifican, la precisión realizada debe ser ≥ 1 − δ.
- **Señal de producto:** entre las sondas `audit` (reutilizaciones que pasaban el suelo y se mandaron al proveedor), la tasa de erróneas tiene que quedar ≤ δ. Si la supera de forma sostenida, la siguiente prueba deja de certificar ese suelo.
- **Evidencia de este informe** (sin texto de ningún dataset; solo ids de revisión, conteos y cotas; todo medido en el commit `1d58bad` con el árbol limpio; tras cada uno de los dos rebases sobre `main` se volvió a medir y las cifras salieron idénticas):
  - **E1:** `benchmarks/evidencia/cache-semantica-calibrada-2026-09-27.json` (sha256 `f8aac0551bacd3b762e1e3e84abadc61872458986f16a3181fd4fddf14108f0a`)
  - **E2:** `benchmarks/evidencia/cache-semantica-calibrada-e5-2026-09-27.json` (sha256 `f9bc39f6a850ea7e3c812df8e3554659f409a2b64e64f790540a98812b1eabae`)
  - **E3:** `benchmarks/evidencia/cache-semantica-simulacion-2026-09-27.json` (sha256 `0429e174f16649d69e7976dfda1659796fc741aa7b96f8b8967bdda83a66243e`)
- **Para reproducirlo:** `pnpm cache-semantica --descargar && pnpm cache-semantica:calibrada --n 20000 && pnpm cache-semantica:calibrada --n 20000 --solo-etiquetas --embebedor dataset:emb_e5_large_v2 && pnpm cache-semantica:simulacion`.

---

## Fuentes (consultadas el 27‑sep‑2026)

1. Schroeder et al., *vCache: Verified Semantic Prompt Caching*, arXiv 2502.03771 v5 (21‑feb‑2026), ICLR 2026. https://arxiv.org/abs/2502.03771 · HTML: https://arxiv.org/html/2502.03771v5 [medido por los autores]
2. `vcache-project/vCache`, LICENSE en `master` (`50694eebf0c8`): «Attribution-NonCommercial-NoDerivs 3.0 Unported». https://github.com/vcache-project/vCache/blob/master/LICENSE
3. Ficha de vCache/SemBenchmarkLmArena (Apache‑2.0; 3.500 prompts base con 1 a 23 variantes escritas por GPT‑4.1‑nano; columnas `emb_*` precomputadas). https://huggingface.co/datasets/vCache/SemBenchmarkLmArena
4. Frias, *Similarity Gates Approve Reversals: A Validity Audit of Embedding-Cosine Thresholds in Agent Systems*, arXiv 2608.10216 (10‑ago‑2026). https://arxiv.org/abs/2608.10216 [medido]
5. Baral et al., *Closing the Operational Gap in Semantic Caching*, arXiv 2606.19719 (18‑jun‑2026; revisión 1‑sep‑2026). https://arxiv.org/abs/2606.19719 [medido]
6. Angelopoulos, Bates, Candès, Jordan y Lei, *Learn then Test: Calibrating Predictive Algorithms to Achieve Risk Control*, arXiv 2110.01052 (3‑oct‑2021; revisión 29‑sep‑2022). https://arxiv.org/abs/2110.01052
7. Clopper y Pearson, *The use of confidence or fiducial limits illustrated in the case of the binomial*, Biometrika 26(4):404–413 (1934). https://doi.org/10.1093/biomet/26.4.404
8. LiteLLM, *Semantic caching*. https://docs.litellm.ai/docs/proxy/caching_semantic
9. RedisVL, guía `03_llmcache.ipynb` en `8bb2f69e6a6d` (23‑sep‑2026). https://github.com/redis/redis-vl-python/blob/8bb2f69e6a6dcd8183eb95e0c02a3b0172da133c/docs/user_guide/03_llmcache.ipynb
10. Singh et al., *Asynchronous Verified Semantic Caching for Tiered LLM Architectures* (Krites), arXiv 2602.13165 (13‑feb‑2026; revisión 12‑mar‑2026). https://arxiv.org/abs/2602.13165 [medido, simulación con trazas]
11. Wang et al., *Category-Aware Semantic Caching for Heterogeneous LLM Workloads*, arXiv 2510.26835 (29‑oct‑2025). https://arxiv.org/abs/2510.26835
12. Kulkarni, Harkare y Suresh Babu, *Which Eviction Policy Should an LLM Cache Use?*, arXiv 2608.20280 (20‑ago‑2026; revisión 22‑ago‑2026). https://arxiv.org/abs/2608.20280 [medido]
13. Mansoor, Ahmad y Yoon, *Risk-Constrained Freshness-Aware Semantic Caching for Open-Web Retrieval-Augmented LLMs*, arXiv 2607.04281 (5‑jul‑2026). https://arxiv.org/abs/2607.04281 [medido]
14. arXiv API: búsquedas «semantic cache / semantic caching» por fecha (60 resultados) y «cache AND (conformal OR error rate guarantee OR risk control) AND LLM». https://export.arxiv.org/api/query
15. Ficha de vCache/SemBenchmarkClassification (Apache‑2.0 en la ficha; fuentes: CommonsenseQA, Ecommerce Categorization, Amazon Instant Video Review). https://huggingface.co/datasets/vCache/SemBenchmarkClassification
16. Informe de competencia del 26‑sep‑2026 (`docs/COMPETENCIA-2026-09-26.md`), §2.4, §4.1 y ref. 90 (GPTCache `reuse_compatibility`).

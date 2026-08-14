# El camino al 50–75 %

Plan para llevar el ahorro medido de ~20 % a ≥50 %. Integra dos investigaciones
independientes: la auditoría del código (14 agentes + 3 refutadores adversariales
sobre `main@af172da`) y el dictamen técnico del CTO.

Sustituye a `ROADMAP-ALGORITMOS.md` en todo lo que se contradiga: ese documento
declara cifras que ya no son ciertas y da por hecho trabajo que no está enchufado.

---

## 1. Veredicto

```
Presupuesto integrado:  55,5 %  central
Banda:                  22,6 % – 73,6 %  según el tráfico del cliente
```

La auditoría sola daba 49,5 %. El dictamen del CTO fija 50–60 % de baseline y
65–75 % con alta repetición. **Las dos convergen**, que es la mejor señal
disponible de que el número es real.

La condición no cambia: **el 50 % se cualifica por tráfico, no se anuncia por
defecto.** Generación creativa larga tiene techo del 22,6 %.

### Las dos aritméticas, reconciliadas

El dictamen cuenta **tokens**; la auditoría cuenta **dinero**. Con el ratio real
de precio (salida ≈ 4× entrada), sus escenarios se convierten así:

| Escenario del dictamen | En tokens | En dinero |
|---|---:|---:|
| «defendible» (25 % llamadas · −45 % entrada · −35 % salida) | 57,25 % | **55,00 %** |
| «avanzado» (40 % · −55 % · −45 %) | 71,80 % | **70,00 %** |
| «>75 %» (45 % · −58 % · −45 %) | 75,47 % | **73,32 %** |

No hay contradicción entre los dos modelos: miden lo mismo con distinta unidad.

Y su escenario es **robusto a la forma de la factura** — con nuestra mezcla
medida (46,4/53,6) da 54,7 %, y con el sustrato extremo del 13-08 (3,8/96,2) da
51,5 %. La razón es que ataca los dos ejes. Un plan que solo ataque la entrada
depende de la forma de la factura; uno que ataque los dos, no.

---

## 2. El hallazgo que reordena el proyecto

La medición del 13-08 —A/B pareado contra el contador del proveedor, la más
fuerte que tenemos— corrió sobre `gpt-4o-mini` con preguntas de ~16 tokens. En
ese sustrato:

- **La cascada de modelos vale 0 por aritmética.** `gpt-4o-mini` es el peldaño
  más bajo. El único escalón por debajo del catálogo tiene `r = 0,667`, y el
  ahorro máximo de una cascada es `1 − r − P`: negativo antes de empezar.
- **La caché de prefijo vale 0.** 16 tokens no alcanzan ningún mínimo de tramo.
- **El batch vale 0.** No hay nada diferible en tráfico interactivo.
- **La salida es el ~96 % de la factura**, y ahí no tocamos nada.

**El −20,1 % que salió no es el techo del producto: es el techo de ese banco.**

Segundo dato del mismo día: de las 15 llamadas evitadas, **la caché exacta
aportó cero** — 9 fueron del singleflight y 6 de los resolvers deterministas.
Concurrencia, no repetición. Son mecanismos distintos que capturan poblaciones
de tráfico distintas, y presupuestar una caché compartida extrapolando desde ese
ancla es un error.

### La forma de la factura no es una constante

| Fuente | Entrada | Salida | Implicación |
|---|---:|---:|---|
| `ROADMAP-ALGORITMOS.md:14` | 36,3 % | 63,7 % | Cifra declarada — desfasada |
| `benchmarks/out/ab-live.json` recomputado | 46,4 % | 53,6 % | Lo que dice el artefacto real |
| Sustrato del 13-08 | 3,8 % | 96,2 % | Toda palanca de entrada es irrelevante |
| RAG / agente con herramientas | ~88 % | ~12 % | La caché de prefijo lo decide casi todo |

---

## 3. «Sin perder información» son dos garantías

Esta separación, que viene del dictamen, es la espina dorsal del plan.

| | **Lossless / reversible** | **Task-preserving** |
|---|---|---|
| Qué promete | El original se reconstruye **exactamente** | Mismo **resultado verificable**, no mismo texto |
| Cómo se prueba | Round-trip + hash. Por construcción | Golden set, sombra, por función e idioma |
| Cubre | Torneo de serializadores, codebook de salida, dedup, caché de prefijo, batch, paginación de contexto | Knapsack de evidencia, poda semántica, memoria resumida, cascada de modelos |
| Garantía | **Demostrable.** Aquí se puede decir «sin pérdida» sin matices | **No garantizable matemáticamente** para un prompt arbitrario |

**Consecuencia operativa: las palancas lossless se despliegan; las
task-preserving se demuestran primero.** Ese reparto decide el calendario —
las lossless suman ~35 puntos sin que ningún juez tenga nada que evaluar.

El estado de calidad deja de ser un booleano:

```
quality_status = exact | task_equivalent | bounded_degradation
               | insufficient_evidence | rejected | not_verified
```

Y una regla que va en el código, no en un documento: **nunca mostrar «sin
pérdida» cuando solo se ha medido similitud coseno, BLEU, ROUGE o evaluación por
otro LLM.** Esas métricas ocultan la desaparición de una cifra, una negación o
una excepción — justo los campos que importan en documentos jurídicos y
financieros.

---

## 4. La salida no se recorta: se re-codifica

La palanca obvia sobre el 54-64 % de la factura —bajar `max_output_tokens`—
está **medida como neto negativo** (−2,8 % en ese libro). Un techo no es una
instrucción: solo ahorra *truncando*, y un truncado es una llamada entera pagada
que no sirve.

La salida del muro no es que el modelo genere menos, sino que **lo que genere
ocupe menos tokens sin perder un bit**:

```jsonc
// Lo que el modelo genera hoy
{"decision":"human_review","confidence":0.87,
 "evidence":["E17:4","E22:1"],"explanation":"..."}

// Lo que el modelo genera con codebook
{"s":"H","c":87,"e":["E17:4","E22:1"]}

// Lo que la aplicación entrega, idéntico al primero
{"status":"human_review","confidence":0.87, ...}
```

Es la misma lógica de Shannon que ya aplicamos a la entrada, aplicada al otro
eje. Y es **lossless verificable**: la expansión del codebook es determinista y
se comprueba con round-trip, igual que el torneo de serializadores. Esquiva
entera la objeción de calidad, porque no hay nada que un juez pueda notar.

Mecanismo completo: enums cortos, IDs en vez de nombres repetidos, sin campos
nulos ni *defaults*, JSON Patch en vez de regenerar el documento, y ninguna
explicación en prosa cuando el consumidor es una máquina.

---

## 5. Estado real del código

Seis cosas rotas o desconectadas, todas verificadas con `fichero:línea`.

1. **El libro de «tokens eliminados» está muerto.** `SavingsLedger.eliminate()`
   no tiene ningún llamante en `src/`: solo `test/tokenizer.test.ts:47,:74`. Así
   que `report.tokens.eliminatedInput` es **0 en toda petición** y el metering
   envía 0 al panel — mientras el README anuncia `eliminated_tokens` como uno de
   los cuatro libros.

2. **La verja económica de la compresión es código huérfano.**
   `src/economics/cache-tier.ts:124` (`decidirCompresion`) solo lo referencia su
   propio test. Ni lo importa el pipeline ni lo exporta `src/index.ts`.

3. **La caché de prefijo del proveedor es inexpresable.** El adaptador lee
   `prompt_tokens_details.cached_tokens` (`openai-compatible.ts:329`), pero no
   existe `cache_control` en el repo ni hay adaptador Anthropic — donde la
   lectura cacheada cuesta el 10 %.

4. **La evidencia de retrieval va detrás de la pregunta.** El repo midió
   (`pipeline.ts:1526-1544`) que poner los datos delante baja la salida de 403 a
   193 tokens y los truncados de 4/8 a 0/8. Se aplicó a un solo bloque: la
   evidencia (`:581`) y el aviso de límites (`:615`) siguen entrando con
   `messages.push`. Ningún test fija la posición.

5. **La caché exacta no puede acertar bajo concurrencia ni en serverless.** Se
   lee en `:423` y se escribe en `:1008`, después de que responda el proveedor,
   con un `Map` por proceso (`defaults.ts:35`). Es el `exact: 0` medido.

6. **No existe enrutado de modelos.** `ExecutionRouter` clasifica *recuperación*
   (`router.ts:20-26`). `request.model` viaja intacto (`pipeline.ts:739,:921,:1194`).

### Tres piezas del dictamen que ya están construidas

| Recomendación | Estado | Nota |
|---|---|---|
| Torneo de serializadores con round-trip, no imponer TOON | **ya existe** | `format-selector.ts:75-142` descarta el candidato cuyo `decode` no sea deep-equal y cuenta con el tokenizer real |
| Outputs restringidos (XGrammar / llguidance / Outlines) | **zócalo sí, adaptador no** | `backends.ts:12,20` ya los nombra; `constraintBackends` es `[]` por defecto |
| Adaptive-RAG (no recuperar / simple / iterativo) | **ya existe** | `router.ts`. Falta enrutar *modelos*, que es otra palanca |

---

## 6. El presupuesto

Las palancas actúan **en cascada sobre lo que queda**, no en paralelo sobre la
factura entera. Una llamada evitada ya no paga ni entrada ni salida, así que
todo punto que otra palanca «gane» sobre esa llamada no existe.

Perfil de referencia, entrada 46,4 % (medida):

| Palanca | Puntos | Garantía | Estado hoy |
|---|---:|---|---|
| Llamadas evitadas (resolvers · singleflight · caché compartida) | +22,0 | lossless | Parcial: la caché exacta aporta 0 |
| Cascada de modelos con verificador determinista | +13,7 | task-preserving | No existe |
| Entrada: torneo · knapsack de evidencia · schema-on-demand | +10,4 | mixta | Torneo sí; knapsack y tools no |
| Salida re-codificada con codebook y JSON Patch | +6,2 | lossless | No existe |
| Caché de prefijo del proveedor | +5,3 | lossless | Inexpresable |
| Batch / Flex sobre tráfico declarado diferible | +2,1 | lossless | No existe |
| Holdout permanente del 3 % | −1,8 | — | No existe |
| Coste de la propia capa | −2,5 | — | Sin contabilizar |
| **Ahorro compuesto** | **55,5 %** | | Banda 22,6 % – 73,6 % |

### Quién llega y quién no

| Perfil de tráfico | Ahorro | Qué manda | |
|---|---:|---|---|
| Alta repetición + RAG / agentes con schemas | 73,6 % | Dedup + knapsack + prefijo | llega |
| Extracción documental estructurada | ~65 % | Verificador gratis + codebook + diferible | llega |
| Perfil de referencia (asistente con contrato) | 55,5 % | Reparto equilibrado | llega |
| Cliente ya en el modelo más barato | 47,2 % | Sin peldaño debajo, la cascada vale 0 | al filo |
| Sin repetición (cada pregunta es única) | 44,5 % | La línea mayor desaparece | no llega |
| Generación creativa larga | 22,6 % | Salida en prosa: no hay codebook posible | no llega |

---

## 7. Contabilidad: reutilizar cómputo no es eliminar tokens

Los once libros del dictamen no deben mezclarse. En particular: **el prefix
cache de vLLM y el KV reutilizado reducen prefill, GPU y latencia, pero el
prompt lógico sigue teniendo los mismos tokens.** Solo son dinero cuando el
proveedor factura la entrada cacheada más barata.

De ahí una decisión pendiente que cambia qué palancas pagan:

| Mundo A · API ajena | Mundo B · vLLM propio |
|---|---|
| El cliente paga a OpenAI/Anthropic. Entrada cacheada al 10–50 %, batch al 50 %, la cascada ahorra precio de lista. | Qwen sobre GPU propia. No existe «precio de entrada cacheada»: el prefix caching ahorra **segundos de GPU**. |
| Es lo que asume el SDK: `openai-compatible.ts` es el único adaptador y el catálogo tiene precios de lista. | Es el mundo del dictamen (OpenFGA, LiteLLM, vLLM, XGrammar, Langfuse). **Nada de eso está en este repo.** |

**Si son los dos, el informe necesita dos monedas.** Decidir antes de F5.

---

## 8. Fases

| | Fase | Puntos | Duración |
|---|---|---:|---|
| **F0** | Instrumentación y sustrato de medición | +0 (habilita todo) | 1-2 sem |
| **F1** | Reparar la contabilidad y las palancas mudas | +0 (honestidad) | 1 sem |
| **F2** | Lossless inmediato: orden del prompt + codebook de salida | +9 a +11 | 2 sem |
| **F3** | Herramientas: permisos → familias → top-k → schema-on-demand | +4 a +6 | 2 sem |
| **F4** | Deduplicación fuera de un proceso | +8 a +12 | 2 sem |
| **F5** | Prefijo estable y caché del proveedor | +5 | 3 sem |
| **F6** | Knapsack de evidencia con cobertura obligatoria | +5 a +8 | 3 sem |
| **F7** | Cascada de modelos, opt-in y por workload | +14 | 4-6 sem |
| **F8** | Memoria como estado + holdout permanente | +3 / −1,8 | 3 sem |

### F0 · Instrumentación y sustrato

Los once libros separados, tokens por componente, y escenarios nuevos donde las
palancas grandes puedan existir: modelo con peldaño debajo, prompts sobre el
mínimo de tramo, prefijo estable, mezcla declarada. Más el golden set en español
y catalán.

> **Aceptación:** el artefacto publica la forma de factura por escenario y al
> menos uno con `providerCachedInputTokens > 0` en el brazo naive.

### F1 · Reparar la contabilidad

Conectar `ledger.eliminate()` o retirar el libro del README y del panel; enchufar
`cache-tier.ts`; llamar a `shouldCompress()`. Añadir `quality_status`.

> **Aceptación:** un test falla si un campo publicado del informe no tiene
> productor en `src/`.

### F2 · Lossless inmediato

Aplicar el hallazgo del orden a los dos bloques que lo ignoran, y construir el
codebook de salida sobre el zócalo que ya existe en `backends.ts`. Las dos son
lossless: se despliegan sin golden set porque no hay nada que un juez evalúe.

> **Aceptación:** round-trip exacto del codebook sobre el 100 % de las
> respuestas + test de posición de bloques.

### F3 · Herramientas

El orden es innegociable y no por ahorro: **el filtro de permisos va antes que
la selección semántica.** Ahorro y seguridad comparten el mismo filtro, y el
catálogo completo no se expone nunca antes de autorizar.

> **Aceptación:** test negativo de aislamiento — una herramienta no autorizada
> no aparece ni como candidato semántico.

### F4 · Deduplicación

Almacén compartido, clave normalizada de verdad y clave versionada (tenant,
proyecto, permisos, corpus, índice, esquema, modelo, política). **Sin**
pre-registrar la clave antes de llamar: eso reabre dos fallos ya cerrados
—cachear un turno de herramientas y cachear una respuesta que incumple contrato.

> **Aceptación:** dos instancias donde la segunda acierta lo que escribió la
> primera + un turno con `toolCalls` nunca entra en caché.

### F5 · Prefijo estable

Montaje segmentado (prefijo estático / estado / cola), orden determinista de
herramientas, `cache_control` y adaptador Anthropic. Con `cache_salt` por tenant:
sin él hay fuga por *timing*. Verja: por debajo de ~22 % de acierto, marcar la
caché **pierde** dinero por la prima de escritura.

> **Aceptación:** `cached_tokens` del propio proveedor > 0 en el brazo
> optimizado. Medición directa, no estimación.

### F6 · Knapsack de evidencia

Primera palanca *task-preserving*: exige golden set. Selección bajo presupuesto
con relevancia, novedad, cobertura y contradicción. Campos que no se pueden
eliminar nunca: importes, fechas, identificadores, negaciones, excepciones,
obligaciones y verbos modales, condiciones, referencias cruzadas, citas.

> **Aceptación:** 100 % de conservación de campos críticos en el golden set,
> citas válidas y accesibles, sin degradación por idioma ni tipo documental.

### F7 · Cascada de modelos

La palanca mayor y la más peligrosa. Opt-in y por workload: **nunca cambiar el
modelo de un cliente en silencio.** Verificador **determinista** —con juez LLM
barato `Pmax = 0,5 − 2r` y con juez fuerte el coste supera 1 siempre—, P(escalar)
medida en sombra antes de gatear nada, auto-apagado económico por bucket. La
clave de caché tiene que guardar el modelo **servido**, no el pedido.

Tabla de go/no-go, `Pmax = 0,5 − r` para 50 % sobre ese tráfico:

| Par | `r` | P(escalar) máx | Equilibrio (`1 − r`) |
|---|---:|---:|---:|
| `gpt-4o` → `gpt-4o-mini` | 0,060 | 44,0 % | 94,0 % |
| `gpt-4.1` → `gpt-4.1-nano` | 0,050 | 45,0 % | 95,0 % |
| `gpt-4.1` → `gpt-4.1-mini` | 0,200 | 30,0 % | 80,0 % |
| `claude-opus-4` → `claude-haiku-4-5` | 0,067 | 43,3 % | 93,3 % |
| `claude-sonnet-4` → `claude-haiku-4-5` | 0,333 | 16,7 % | 66,7 % |
| `gpt-4o-mini` → `gpt-4.1-nano` | 0,667 | **imposible** | 33,3 % |
| `claude-haiku-4-5` → `claude-3-5-haiku` | 0,800 | **imposible** | 20,0 % |

> **Aceptación:** 30 días en sombra con P(escalar) por bucket bajo el `Pmax` del
> par y juez ciego sin regresión.

### F8 · Memoria y holdout

Estado contractual, delta reciente y archivo episódico recuperable, con
procedencia y versión por hecho. Y el 3 % en passthrough: hoy el baseline de
producción es modelado (`accounting.ts:216-232`, `basis` pasa a `"estimated"`
justo cuando la capa quita algo), así que el panel nunca podrá enseñar un 55 %
**medido** sin un brazo A real.

> **Aceptación:** el panel publica la cota inferior del intervalo, no el punto.

---

## 9. Herramientas

Dictamen del CTO; la columna derecha es el contraste con este repo.

| Herramienta | Para qué | Decisión | Nota |
|---|---|---|---|
| TOON | Serialización compacta | adoptar | Ya integrado como *candidato*, nunca por defecto |
| XGrammar + vLLM | Outputs restringidos | adoptar | El zócalo existe en `backends.ts`; falta el adaptador |
| LiteLLM + Redis | Caché exacta | adoptar | Resuelve el `Map` por proceso del hallazgo 5 |
| mcp-filter | Allowlist de herramientas | adoptar | Perfiles estáticos, antes del filtro semántico |
| vLLM Prefix Caching | Reutilización de KV | adoptar | Solo mundo B · libro aparte: no reduce tokens facturados |
| PCToolkit | Banco de compresores | adoptar | Como banco, no como dependencia |
| LLMLingua-2 · Headroom · Leanctx | Compresión semántica | PoC en sombra | Solo prosa recuperada y salidas de herramientas |
| RouteLLM · LLMRouterBench | Enrutado entre modelos | PoC · router propio | Entrenar local: no mandar documentos fuera |
| Portkey MCP Tool Filter | Selección semántica de tools | PoC | Con embeddings locales multilingües (es/ca) |
| lossless-claw · hermes-lcm | Memoria jerárquica | copiar arquitectura | No las dependencias |
| XProvence / BERGEN | Pruning RAG multilingüe | solo benchmark | Licencia CC BY-NC-SA |
| 500xCompressor · ICAE | Compresión extrema | descartar | Degradación incompatible con «sin pérdida» |
| GPTCache | Caché semántica | referencia | Construir sobre pgvector/Redis |
| LMCache | KV multinivel | aplazar | Medir primero el prefix caching nativo |

---

## 10. Promesa comercial: tres escalones

| Escalón | Condición | Garantía |
|---|---|---|
| **≥55 % verificado** | Repetición diferida ≥32 % **y** peldaño de modelo por debajo **y** ≥45 % de entrada en prefijo estable **y** consumo de salida por máquina | Arbitrada por el holdout, con recalificación si la mezcla se mueve >10 puntos |
| **≥30 % estándar** | Por defecto: tráfico mixto, cliente ya en modelo barato, RAG sin repetición | Lo que sabemos sostener con lo medido |
| **Diagnóstico** | Generación creativa larga, agentes multivuelta con escritura | Sin porcentaje prometido |

La ficha de cualificación tiene que emitir **dos curvas separadas**:
*concurrencia* (peticiones idénticas solapadas — las captura el singleflight) y
*repetición diferida* (misma pregunta horas después — la captura la caché
compartida). Un cliente puede tener mucha de la primera y nada de la segunda.

**Si un prospecto no llega, se le dice en la reunión, no en la renovación.**

---

## 11. Riesgos que no se cierran solos

- **Caché por inquilino = fuga entre usuarios.** El dictamen exige aislamiento
  por tenant, proyecto, permisos, corpus, modelo y política. El código no lo
  cumple: `policy.ts:174` comprueba que *exista* un principal, no que la clave lo
  *use*. Cualquier trabajo para subir aciertos exige cambiar la política antes.
- **Los falsos válidos de la cascada son invisibles.** El verificador
  determinista mide la forma, no el significado (`validate.ts:9-12` lo dice en su
  propio docstring). Una respuesta barata con JSON impecable y contenido
  equivocado baja P(escalar), sube el ahorro y no dispara ningún apagado.
- **Publicar la cota inferior aprieta el titular.** Un central de 55,5 % con
  banda ancha no permite afirmar 55 % hasta estrechar el intervalo.
- **El ancla de la línea mayor mezcla dos mecanismos.** Ver §2.
- **La caché semántica con umbral estático no funciona igual para todas las
  consultas.** La guarda determinista (Jaccard ≥ 0,75) la limita a
  casi-duplicados por diseño; relajarla sin umbrales adaptativos convierte un
  ahorro en un fallo de calidad.

---

## 12. Lo que no se hace, y por qué

- **Un único compresor aplicado indiscriminadamente.** Es la conclusión central
  del dictamen y coincide con lo medido: la arquitectura correcta es una
  composición por tipología de llamada.
- **Compresión neuronal en el camino caliente.** Cargar un modelo por seat
  contradice el objetivo de COGS.
- **Self-consistency con varias respuestas.** Multiplica tokens salvo en
  escalado excepcional.
- **Prometer un porcentaje universal**, o **precalentar cachés para el titular.**
  Si el número en frío es bajo, la salida es declarar la mezcla honesta y medir
  esa.

# Roadmap de algoritmos — de 13% a un múltiplo

Basado en el funcional v0.1 (`~/Documents/BiVelio_Savings_Layer_v0.1_Funcional_Exhaustivo.pdf`)
y en lo que el banco A/B ha medido de verdad contra proveedor real.

Cada línea lleva: qué se implementa, dónde, cuánto dinero se espera, y **cómo se
demuestra**. Sin una forma de medirlo, una palanca no entra en este plan.

---

## El dato que ordena todo lo demás

```
NUESTRA propia factura:   entrada 36,3%   ·   salida 63,7%
```

Toda la capa actual —comprimir, eliminar contexto, seleccionar herramientas—
**solo toca la entrada**. Llevando la entrada a CERO, que es imposible, el techo
sería 48,5%. De ahí ya hemos cobrado 13.

Y sobre el 63,7% restante no hacemos nada: contando solo las llamadas que se
ejecutaron, nuestro brazo emite **91 tokens más** de salida que el naive.

Solo tres palancas tocan ese 63,7%: **no llamar**, **llamar a algo más barato**, o
**generar menos**. Ninguna de las tres está terminada.

---

## Fase 1 — Dejar de perder lo que ya ganamos (semanas 1-2)

### 1.1 · A9 Output Shaper — el 63,7% de la factura

**Es la mayor de todas y hoy mide −4,9%**, o sea que la palanca actual perjudica.

El funcional da la fórmula exacta:

```
ceiling = min(provider_limit,
              max(contract_min, p95(valid_output_tokens) + safety_margin))
```

Con dos reglas que ya sabemos que importan:

- **Excluir de la estimación las salidas truncadas o inválidas.** Si se cuentan,
  el techo se calibra sobre basura.
- **Si sube la tasa de `finish_reason=length`, elevar el techo o desactivarse.**
  Esto conecta con el arreglo de truncado que ya está en el código.

Mecanismos concretos, por orden de riesgo:

| | qué | riesgo |
|---|---|---|
| a | `max_output_tokens` derivado del p95 observado por workload | bajo |
| b | *field projection*: pedir solo los campos que el llamante consume | bajo |
| c | perfil de verbosidad por workload (no «sé breve» genérico) | medio |
| d | `stop` sequences seguras y *early stop* al completar el esquema | medio |
| e | delta output en agentes: no repetir lo ya dicho | medio |

**Dónde:** `src/pipeline/pipeline.ts` (plan de salida) + un `src/economics/output-budget.ts`
que aprenda el p95 por contrato, igual que ya se aprende `constraintMemory`.

**Cómo se demuestra:** escenario nuevo `output-heavy` donde el naive responde en
prosa larga y el nuestro con contrato + techo. Juez ciego obligatorio: aquí es
donde de verdad se puede degradar la respuesta, y hay que verlo.

**Dinero esperado:** es el único sitio donde queda margen grande sin tocar el
modelo. Si se recorta un 20% de salida sin que el juez note diferencia, son
~12,7 puntos de titular. **No lo prometo hasta medirlo.**

### 1.2 · A4 Provider Prompt Cache Optimizer — dinero que ya está en la mesa

Medido: el naive recibe **512 tokens cacheados por petición**; nosotros, **cero**,
en las 210 llamadas. Nuestra compresión nos saca del tramo (780 < 1024).

Ya hecho: `src/economics/cache-tier.ts` decide comprimir por dinero y no por
ratio de tokens, contando mínimo de tramo, multiplicador de lectura y prima de
escritura.

Falta la otra mitad, que es la que ahorra de verdad — **segmentar el payload**:

```
[STATIC PREFIX]              instrucciones, esquemas de herramientas, ejemplos, política
[MUTABLE APPEND-ONLY STATE]  historial, resultados de herramientas
[QUERY-SPECIFIC TAIL]        retrieval específico, mensaje actual del usuario
```

Con sus invariantes: historial *append-only*, orden de herramientas determinista
por `tool_id` (no por iteración de un mapa), y **nunca** insertar timestamp o id
de petición en el prefijo.

**Dónde:** `src/pipeline/pipeline.ts`, en el montaje de mensajes. Hoy metemos el
aviso de restricciones *después* del contenido variable, que es el peor sitio.

**Cómo se demuestra:** el propio `usage.prompt_tokens_details.cached_tokens` del
proveedor. Es medición directa, no estimación.

**Dinero esperado:** llevar nuestros aciertos de 0% a lo que ya logra el naive
(42%) recupera los ~17 puntos que hoy regalamos en el escenario de la tabla.

### 1.3 · Cerrar el fallo de validez de la tabla

12 fallos de 210, todos en un escenario, y es **lo único** que bloquea
`proven: true`. El naive cumple 39/40 con el mismo tope y contrato; nosotros
28/40. La diferencia que queda es nuestra compresión a TOON.

**Cómo se demuestra:** volcar los payloads inválidos y clasificar. Días, no
semanas, y convierte el 13,2% en publicable.

---

## Fase 2 — Las palancas que multiplican (semanas 3-6)

### 2.1 · A8 Model / Provider / Service-Tier Routing

**La única palanca que multiplica la factura ENTERA, salida incluida.**

Y hay un hecho de mercado que la hace inusualmente limpia: la escalera de precios
de OpenAI es **proporcional en los dos ejes**. gpt-5 → gpt-5-mini es 0,20× en
entrada *y* 0,20× en salida. Eso significa que **el ahorro por enrutado no depende
de la forma del prompt** — es la única del catálogo de la que se puede decir eso.

La escalera del funcional:

```
resolver determinista → caché exacta → caché semántica segura
→ modelo local especializado → modelo barato → modelo medio
→ modelo frontera → revisión humana
```

Empezar por **políticas transparentes por workload** (P0 del funcional), no por un
predictor entrenado:

```yaml
workload: invoice_field_extraction
quality_floor: 0.985
candidates:
  - model: provider/fast-model
    verifier: deterministic_schema
  - model: provider/strong-model
fallback_on: [schema_invalid, confidence_below, required_field_missing]
```

Y contar el coste real de la cascada, que no es gratis:

```
E[cost] = cost(cheap) + P(escalate)·cost(strong) + verifier_cost + retry_latency_penalty
```

Si `P(escalate)` es alto, la cascada se **desactiva sola**. Eso es lo que separa
esto de «mandar todo al modelo barato y cruzar los dedos».

**Cómo se demuestra:** escenario con dos modelos reales y verificador
determinista. El A/B pareado mide coste y el juez mide si la respuesta aguanta.

**Dinero esperado:** con una tasa de escalado del 30% entre modelos separados por
5×, el ahorro teórico ronda el 55% en ese tráfico. **Hay que medirlo antes de
decirlo en ningún sitio.**

### 2.2 · A3 Semantic Cache de tres zonas

Hoy está **rota por dos motivos independientes**, los dos verificados:

1. **No existe ninguna implementación de `EmbeddingFn`.** La palanca no está
   enchufada.
2. La cadena que compara lleva el rol pegado al contenido
   (`` `${role}:${normalizeText(content)}` ``) y `normalizeText` no quita
   puntuación. Resultado: **0 de 8** pares de paráfrasis realistas aciertan. Una
   interrogación de más tumba el acierto. Y hay un test verde que prueba una
   cadena que el pipeline nunca produce.

Sobre eso, las tres zonas del funcional — que es lo que lo hace vendible y no
peligroso:

| zona | condición | acción |
|---|---|---|
| segura | `P(correcto)_LCB ≥ quality_floor` y restricciones duras iguales | servir |
| gris | similitud alta pero incertidumbre no admisible | verificar o ruta normal |
| rechazo | *hard mismatch* | fallo |

Con **precisión por encima de tasa de acierto**: un acierto que responde otra
pregunta no es ahorro, es un fallo de calidad.

**Dinero esperado:** cada 10 puntos de acierto sobre el tráfico que se ejecuta
valen ~8,5 puntos de titular.

---

## Fase 3 — Diferenciación (semanas 7+)

- **A11 Batch/Flex**: ~50% de descuento en trabajo asíncrono. Solo aplica a carga
  diferible; en una capa síncrona hay que detectarla y recomendarla, no forzarla.
- **A12 Multi-agent Economic Planner**: la jerarquía de menor coste
  (`sin agente → resolver → agente único → agente + herramientas → par con
  verificador → equipo`) y el *State Delta Protocol*, donde los agentes comparten
  deltas y no el transcript entero.
- **A13 Policy Learning**: `DRAFT → SIMULATED → SHADOW → CANARY → PROMOTED`, con
  holdout permanente y *kill switch*.

---

## Lo que NO se hace, y por qué

- **Compresión neuronal (L3) en el camino caliente.** Cargar un modelo por seat
  para comprimir contradice el objetivo de COGS de 0,65 €/seat, y el propio
  funcional la deja en P2.
- **Prometer un porcentaje universal.** Las cifras de 40-95% de la literatura
  dependen de repetición, datasets y *cache warmness* de otros. Sirven para
  formular hipótesis, no para afirmar nada nuestro.
- **Amañar el banco calentando cachés.** Si el titular en frío es bajo, la salida
  es decir cuál es la mezcla de tráfico honesta y medir ESA, no precalentar.

---

## Qué se publica y cuándo

Hoy tenemos **+13,2% [5,7%, 20,2%]**, p = 5,5e-8, 210 ensayos. Es honesto y es
defendible. Sale `proven: false` solo por la calidad del escenario de la tabla
(1.3), que son días de trabajo.

Orden recomendado: **1.3 → publicar → 1.1 y 1.2 → republicar → fase 2**.

La alternativa es publicar hoy con el aviso de `proven: false`. La verja lo
permite y no sería deshonesto. Pero el número está a punto de cambiar.

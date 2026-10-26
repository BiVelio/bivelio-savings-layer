# Especificación: unidad «calidad-cache» (recomendación n.º 10)

Rama `feat/libro-de-calidad` · worktree `/Users/fisagol/bsl-calidad-cache`, creado desde `origin/main` (`f157462`). Esta especificación se escribió en solo lectura, sobre un `git archive origin/main` en el scratchpad. El worktree todavía no existe: lo crea el implementador con los comandos de las reglas duras. Para el porqué me he apoyado en el informe de competencia (§2.4, §3, §4.1, §8 n.º 10, fuentes [31] [89] [90]) y en las fuentes primarias de §10, consultadas el 2026-09-27.

---

## 0. Punto de partida (verificado en `origin/main`)

**Lo que ya existe**
- `report.qualityStatus` (`exact | task_equivalent | not_verified | bounded_degradation | rejected`) sale de `estadoDeCalidad()` (`src/pipeline/pipeline.ts` ~4337), dentro de `buildReport()`.
- También existen `report.constraints.structurallyValid`, `report.cache.{result, confidence, ageMs}`, `report.modelCascade` y `calls.retries`.
- Casi todo lo demás que se decide sobre la calidad vive **solo en `traces`**: rescate de JSON envuelto, reparación intentada u omitida y su motivo, truncado por `finish_reason: "length"`, y la similitud del acierto semántico.
- El wire de metering (`src/metering/emitter.ts` `toWire`) **ya lleva `cacheResult`**, y la lista blanca del ingest (`apps/web/lib/metering/usage.ts:33`) admite `miss|exact|semantic|singleflight|deterministic`. Exacta y semántica ya se distinguen en el servidor.
- Nada más de calidad viaja, y así seguirá (comentario en `emitter.ts:354`: servidor primero).
- La caché semántica es triple opt-in: `savings.semanticCache` por petición, `createSavingsLayer({ semanticCache })` y licencia `semantic_cache`. Hoy la política (`src/policy/policy.ts`) solo la veta en estos casos: herramientas de escritura, frescura, personalización, muestreo estocástico y `day`.

**Hallazgos del diseñador (con evidencia)**
- **H1 · defecto confirmado.** El filtro duro de la caché semántica no incluye `toolsetHash`, `temperature` ni `seed`.
  - Sin embargo, el JSDoc de `SemanticRecord` afirma que «the set is identical to the one the exact cache keys on».
  - Evidencia: `src/cache/semantic.ts`, el cuerpo de `find()`, frente a `src/canonicalization/keys.ts` `buildExactKey` (`tools: c.toolsetHash`, `temperature`, `seed`).
  - Consecuencia: con herramientas declaradas de solo lectura, se puede servir una respuesta generada con otro catálogo.
- **H2 · suelo efectivo.** Con el embebedor propio y sin verificador, el suelo efectivo es **0,85**, no `UMBRAL_LOCAL = 0,72`.
  - Motivo: `find()` compara `min(similarity, verifierScore)` con `acceptThreshold ?? 0.85`, y `verifierScore = similarity` cuando no hay `verify`.
  - Confirmado midiendo: los resultados con los valores por defecto coinciden exactamente con el barrido a suelo 0,85 (78/122 en ambos).
  - Esta unidad **no** lo cambia (decisión D21).
- **H3.** `report.quality.semanticScore` está declarado y nadie lo rellena.
- **H4.** `semanticCache: "safe-only"` está declarado, no está documentado y se comporta igual que `true`.
- **H5 · matiz frente a [31].** El fallo que describe LiteLLM («every turn matches the previous turn's cached entry») queda **bloqueado estructuralmente** aquí: `keyTokensMatch` exige el mismo número de turnos y los mismos roles.
  - El riesgo que queda es otro: **entre ejecuciones o sesiones**, con historias de la misma longitud que difieren en un resultado de herramienta (Jaccard ≥ 0,75 por turno, sin números distintos), y sumado a H1.
- **H6 · licencias.**
  - [89] **SemBenchmarkLmArena**: tarjeta HF apache‑2.0. Los prompts vienen de LM‑Arena, con licencia **CC‑BY‑4.0**.
  - [89] **SemBenchmarkSearchQueries**: tarjeta apache‑2.0, pero deriva de **ORCAS**, cuyos términos dicen «non‑commercial research purposes only».
  - [90] Las 1.536 tripletas de GPTCache (repo MIT) se reparten así: 512 del brazo `arena` y **1.024 derivadas de ORCAS** (`search_llama`, `search_gpt`).
  - Sus etiquetas están **asistidas por modelo**: 1.298 `first_model_review`, 232 `second_model_adjudication` y 6 `manual_scope_override`.
  - Corrección al informe: la «NC‑ND» de vCache es la licencia del **paper** en arXiv, no la de los datasets.
- **H7 · medición preliminar del diseñador.** Es **interna y no publicable**. El documento publicado sale solo del artefacto del harness.
  - Scripts desechables en el scratchpad `/private/tmp/claude-501/-Users-fisagol-bivelio-savings-layer/faec183e-fcb1-462c-ab1a-cab054013371/scratchpad/`: `capa-arena.mts`, `medir-gptcache.mts`, `barrido.mts`, `stream-arena.mts` y `hp/bajar-arena.mjs`.
  - Datos en `…/scratchpad/data/`. Los sha256 de `cases.jsonl` y `labels.jsonl` coinciden con el `manifest.json` del proyecto.
  - Resultados:

| Medición | Configuración | Precisión (Wilson 95 %) | Recall |
|---|---|---|---|
| Tripletas GPTCache, brazo `arena` (n=512, 2 inciertas excluidas), **capa completa** | valores por defecto, embebedor léxico, verja, política | 98,3 % [91,0–99,7] (58/59) | 13,6 % [10,6–17,1] (58/428) |
| Mismo brazo, evaluador JEV del proyecto, recalculado con el mismo puntuador a partir de su `baseline_jev_070.jsonl` | el suyo (LLM) | 100 % [98,9–100] (355/355) | 82,9 % [79,1–86,2] |
| Las 1.536, a nivel de componentes, **incluye ORCAS: NO publicar** | por defecto | 63,9 % [55,1–71,9] (78/122) | 15,4 % |
| Brazos `search_llama` / `search_gpt` (**ORCAS: NO publicar**) | por defecto | 13,0 % (3/23) / 4,3 % (1/23) | — |
| Stream SemBenchmarkLmArena, primeros 20.000 prompts en orden del dataset, componentes + política, `maxRecords` sin tope (no es el valor por defecto) | por defecto | 90,8 % [89,8–91,7] (Wilson aproximado; no hay independencia) | 23,6 % frente a lo alcanzable |

- Notas sobre esas cifras:
  - En las 1.536, 40 de los 44 falsos positivos llevan la categoría `incomplete_format`, que es un defecto de la respuesta cacheada y no de la pregunta.
  - En el stream, la tasa de acierto fue del 21,5 % y la tasa de error del 1,98 %.
  - Parte de los «errores» del stream son prompts **idénticos** asignados a clases distintas (ruido de etiqueta).
- Autoverificación del puntuador: recalculado desde sus ficheros, el baseline JEV da exactamente **364/365 y 364/505**, las cifras que publica el proyecto.
- Lectura: en `arena`, la verja determinista mantiene la precisión alta, pero con recall bajo (es un embebedor léxico). En consultas de búsqueda cortas el valor por defecto no es preciso, lo que justifica el opt‑in y la decisión (c).

---

## 1. Decisiones y su porqué

**(a) Libro de calidad**
- **D1. Campo `report.qualityLedger?: QualityLedger`, con forma fija y bloques opcionales** (no un array de eventos).
  - Sigue la convención de `deferred?` y `modelCascade?`: un bloque aparece solo si la comprobación aplica, y su ausencia significa «no aplica o desconocido».
  - Se tipa de forma discriminada y se prueba fácilmente.
  - Se llama «ledger» porque así lo llama la recomendación («libro de calidad»). El JSDoc dice que no contiene dinero.
- **D2. Ni dinero ni tokens.** Ninguna cifra sumable a los cuatro libros ni a `cost`: los conteos (`calls.retries`) ya viven en el lado del dinero.
  - Un test recorre las claves y falla si alguna encaja con `/cost|price|usd|saving|token|basis/i`.
- **D3. No viaja.** El wire no cambia. `cacheResult` ya distingue exacta y semántica en el servidor; la similitud y el resto se quedan en el proceso.
  - Un test comprueba que el cuerpo del POST ⊆ `CAMPOS_DEL_REGISTRO_DE_USO`.
- **D4. `qualityStatus` sigue siendo el veredicto; el libro es la evidencia.** Hay invariantes de coherencia entre ambos, con tests (§5).
- **D5. Construcción pura y centralizada.**
  - Un módulo interno nuevo, `src/pipeline/libro-de-calidad.ts` (no reexportado, así que no entra en el `.d.ts`), expone `libroDeCalidad(...)`.
  - Se llama **solo** desde `buildReport()` y, para el seguidor, desde `asCoalescedFollower()`.
  - Los hechos nuevos llegan en **un** parámetro opcional añadido al final de `finish()` y `buildReport()`.
  - No se tocan `TraceCollector` (público) ni `SavingsLedger` (dinero).
- **D6. Sin contenido.** Ni rutas ni mensajes de error, ni texto: solo enums, booleanos, similitudes y umbrales. Así se puede exportar a observabilidad sin riesgo; los errores detallados siguen en `traces`.
- **D7. Seguidor coalescido.**
  - `source: "coalesced"` más `sharedFrom` (el `source` del líder).
  - Los demás bloques se heredan y describen la respuesta compartida: nada se volvió a ejecutar.
  - Mismo criterio que la herencia de `qualityStatus` (`pipeline.ts` ~3912).
- **D8. Se rellena `quality.semanticScore`** (H3) con la misma similitud en los aciertos semánticos.

**(c) Caché semántica en tráfico agéntico**
- **D9. Definición determinista de «agéntico».** La petición declara `tools` (aunque sean de lectura), **o** lleva mensajes `role:"tool"` o `assistant.toolCalls`, **o** tiene **más de un turno de usuario**.
  - «Largo» no tiene fuente numérica. Se adopta el criterio de [31], «designed for single‑shot prompts», en vez de inventar un umbral.
  - Queda documentado como dial: si alguien quiere un umbral de turnos, que salga de medir.
- **D10. Por defecto, apagada en tráfico agéntico.** Se activa por petición con `savings.semanticCache: "include-agentic"`.
  - Los vetos de seguridad (herramientas de escritura, frescura, personalización, estocástico, `day`) **no** se pueden levantar.
- **D11. La decisión vive en la política**, que es la fuente única para la lectura (etapa 4) y la escritura (etapa 12).
  - `evaluatePolicy` lee `c.original?.savings?.semanticCache`.
  - Se añade `Policy.isAgentic`. Así no hace falta acordarse de tocar dos sitios.
- **D12. Se corrige H1 en la misma unidad**, porque es requisito del opt‑in: `toolsetHash`, `temperature` y `seed` pasan a ser filtros duros de `SemanticRecord`. Con esto, la identidad coincide con la de la clave exacta, salvo el texto.
- **D13. La elisión no hereda el veto agéntico.** `allowElision` queda como está: la elisión existe precisamente para tráfico agéntico. Lo fija un test.
- **D14. No es silencioso.** Queda la razón en `policy.reasons`, una traza en la etapa 4 y **un aviso único** (`avisar`, silenciable) cuando se pide `semanticCache: true` sobre tráfico agéntico con la caché configurada. La caché exacta no cambia.

**(b) Medición**
- **D15. Se mide lo que se envía** (embebedor léxico, suelos por defecto, verja, política) **a través de la capa completa** (`createSavingsLayer` + proveedor falso), no con una reimplementación.
  - El conductor de componentes queda como diagnóstico.
  - La capa exige que la política deje pasar **las dos** peticiones: ahí está la diferencia entre 58/59 y 59/60.
- **D16. Conjuntos.** Por defecto, solo el brazo limpio: tripletas `arena` (512) más el stream de SemBenchmarkLmArena.
  - Todo lo derivado de ORCAS queda fuera salvo con `--incluir-orcas`, y el publicador se niega a publicarlo (decisión legal del dueño).
- **D17. Intervalos de confianza.**
  - Wilson al 95 % en las tripletas: casos independientes, cada uno aislado con su propio `tenantId`.
  - En el stream, bootstrap por **clase** (`ID_Set`) sobre los resultados por consulta (B=2000, semilla fija, percentiles), porque los aciertos dependen del estado de la caché.
- **D18. No se ajustan umbrales en esta unidad.** Se publican el suelo efectivo y los dos parámetros. Si se añade un barrido, se ajusta en `split=calibration` y se reporta en `split=test`.
- **D19. Autoverificación del puntuador.** Con `--verificar-puntuador` se recalculan las cifras del proyecto a partir de sus ficheros y debe salir exactamente 364/365 y 364/505.
  - Solo se leen uids, etiquetas y decisiones, nunca texto.
- **D20. La evidencia no lleva texto** (solo uids o ids, decisión y similitud), para no redistribuir datos.
- **D21. El documento se genera desde el artefacto con una verja.** Se niega si el artefacto es `dry-run`, si el commit está sucio, si faltan revisión o sha256 de alguna fuente, o si tiene origen no comercial.
  - Titular: el **suelo del IC de la precisión**, en línea con «se publica el suelo».
- **D22. No se cambia el suelo por defecto** (H2): cambiarlo mueve a la vez la precisión y el recall de todos los clientes. Se publica el efectivo y la decisión queda para una unidad posterior.

---

## 2. API pública (inglés, `src/contracts/types.ts`)

JSDoc solo en inglés, sin tildes (el trinquete tiene TECHO = 81) y sin nombres de terceros.

```ts
/** Where the answer you received came from on this request. */
export type AnswerSource =
  | "provider"        // your provider generated it for this request
  | "exact_cache"     // replay of the answer already produced for this very request
  | "semantic_cache"  // reuse of the answer to a reworded version of this request
  | "coalesced"       // shared with an identical request that was running at the same time
  | "deterministic"   // computed locally, no model involved
  | "fail_open";      // direct provider call after an internal error; nothing was optimized

/** The output-contract check on the answer that was served. */
export interface QualitySchemaCheck {
  /** `passed`/`failed`: validated against `response.schema`. `not_applicable`: the model asked to run tools, so there is no final answer yet. */
  outcome: "passed" | "failed" | "not_applicable";
  /** Whether generation was also constrained to the schema. The answer is validated either way. */
  decodeTimeConstraint: boolean;
  /** Validation errors in the served answer. 0 when it passed. */
  errorCount: number;
  /** The model wrapped valid JSON in prose or a code fence; it was extracted locally instead of paying for a repair. */
  unwrapped?: true;
}

export interface QualityRepairCheck {
  /** `repaired`: one repair call, and its answer passed. `still_invalid`: it did not. `skipped`: no repair call was made. */
  outcome: "repaired" | "still_invalid" | "skipped";
  skipReason?:
    | "output_truncated"               // the answer hit the output limit; the same limit would cut it again
    | "schema_defect"                  // no answer can satisfy the schema (e.g. an invalid pattern)
    | "would_cost_more_than_no_layer"  // repairing would cost more than not using the layer at all
    | "decode_time_constraint";        // generation was already constrained; a retry would not change it
}

export interface QualityTruncationCheck {
  /** The provider stopped because it reached the output limit. A truncated answer is never cached. */
  truncated: boolean;
  /** The stop reason as the provider named it; absent when it reported none. */
  finishReason?: string;
  /** Whether you set the limit (`response.maxOutputTokens`). When false, a provider or adapter default applied. */
  capSetByCaller: boolean;
  /** The limit you set. Present only when `capSetByCaller`. */
  maxOutputTokens?: number;
}

export type QualityCacheMatch =
  | { kind: "exact"; ageMs?: number }
  | {
      kind: "semantic";
      ageMs?: number;
      /** Similarity between this request and the stored one. Not evidence of equivalence: see QualityStatus. */
      similarity: number;
      /** Similarity a candidate had to reach to be considered. */
      similarityFloor: number;
      /** Confidence the hit had to reach to be served; confidence is the lower of similarity and verifierScore. */
      acceptFloor: number;
      /** Your verifier's score, when you configured one. */
      verifierScore?: number;
      /** `built_in`: the lexical embedder shipped with the SDK. `custom`: yours. */
      embedder: "built_in" | "custom";
      /** The deterministic guard passed, turn by turn: figures and dates, negation parity, content overlap. */
      factGuard: "passed";
    };

export interface QualityCascadeCheck {
  mode: "shadow" | "on";
  gate: "none" | "structural" | "value-constrained";
  /**
   * `accepted`: a cheaper model answered and cleared the gate. `escalated`: the gate rejected it and the
   * model you asked for answered. `not_routed`: on, but this request was not routed (see modelCascade.reason).
   * `measured_only`: shadow mode; the model you asked for answered.
   */
  outcome: "accepted" | "escalated" | "not_routed" | "measured_only";
  /** Shadow sampling only: both answers disagreed on a hard value. A hint, never proof. */
  sampleDiverged?: boolean;
}

/**
 * What the layer checked on the answer it served, and what came of it.
 *
 * It holds no money and no token counts. It is never added to the four savings ledgers or to
 * `cost`, and it never leaves your process: usage reporting does not carry it. `qualityStatus`
 * is the one-word verdict; this is the evidence behind it. A block is present only when its check
 * applies to this request. An absent ledger means unknown (an older SDK, or a gateway report).
 */
export interface QualityLedger {
  source: AnswerSource;
  /** Only with `source: "coalesced"`: where the shared answer came from for the request it joined. */
  sharedFrom?: Exclude<AnswerSource, "coalesced">;
  schema?: QualitySchemaCheck;
  repair?: QualityRepairCheck;
  truncation?: QualityTruncationCheck;
  cacheMatch?: QualityCacheMatch;
  cascade?: QualityCascadeCheck;
}
```

- `SavingsReport` gana `qualityLedger?: QualityLedger;`, después de `qualityStatus`.
- `SavingsToggles.semanticCache?: boolean | "safe-only" | "include-agentic";`. Su JSDoc se reescribe en inglés:
  - `true`/`"safe-only"` (idénticos): solo peticiones single‑shot.
  - `"include-agentic"`: también las que declaran herramientas, llevan llamadas o resultados de herramientas o tienen más de un turno de usuario.
  - Por qué se excluye por defecto: en un bucle de agente, dos ejecuciones pueden diferir solo en un resultado de herramienta. La verja compara cifras, negaciones y solapamiento de palabras, pero no si una herramienta devolvió otra cosa con palabras. Medirlo en el tráfico propio antes de incluirlo.
  - Los vetos de escritura, frescura, personalización y estocástico siguen vigentes pase lo que pase.
- `Policy` (pública) gana `isAgentic: boolean`, con JSDoc en inglés equivalente.
- `SemanticRecord` gana `toolsetHash: string; temperature: number | null; seed: number | null`. JSDoc corregido: identidad = la de la clave exacta salvo el texto; la frescura queda cubierta por construcción, porque la semántica solo corre con `any`.
- `SemanticHit` gana `similarityFloor: number; acceptFloor: number; embedder: "built_in" | "custom"; verifierRan: boolean`.

**Reglas de construcción** (`libroDeCalidad`):

| Bloque | Presente cuando | Valor |
|---|---|---|
| `source` | siempre | `deterministic`/`exact_cache`/`semantic_cache` según `cacheResult`; `miss` da `provider`, salvo si viene de `failOpenDirect` (`fail_open`); el seguidor da `coalesced` + `sharedFrom` |
| `schema` | la petición trae `response.schema` | `structurallyValid === null` → `not_applicable`; `decodeTimeConstraint = backend !== "none"` (atajos y fail‑open: `false`); `errorCount` de la validación de lo servido; `unwrapped` si hubo `rescued-locally` |
| `repair` | camino del proveedor y la primera validación falló | un valor por cada rama existente de la etapa 11: `esquemaRoto` → `schema_defect`; `truncadoPorTope` → `output_truncated`; `saldriaCaro` → `would_cost_more_than_no_layer`; `backend !== "none"` → `decode_time_constraint`; reparado → `repaired`/`still_invalid` |
| `truncation` | un proveedor generó lo servido en **esta** petición (`provider`, `fail_open`; heredado en `coalesced`) | `truncated = finishReason === "length"` |
| `cacheMatch` | `exact_cache` o `semantic_cache` (heredado en `coalesced`) | exacta: `{kind, ageMs}`; semántica: desde `SemanticHit` |
| `cascade` | `report.modelCascade` presente | `shadow` → `measured_only` (+ `divergedOnSample`); `on`: `servedModel !== requestedModel` → `accepted`, si no `escalated` → `escalated`, si no → `not_routed`; `gate = verifier` |

---

## 3. Cambios por fichero

1. **`src/contracts/types.ts`**: todo lo de §2.
2. **`src/cache/semantic.ts`**
   - `SemanticRecord` con los tres campos nuevos; `store()` los rellena desde `CanonicalRequest` (`toolsetHash`, `temperature`, `seed`).
   - En `find()`, tres `continue` nuevos junto a los filtros duros existentes, antes de puntuar la similitud.
   - Un campo privado `embebedorPropio` (se guarda el `propio` del constructor).
   - `SemanticHit` añade `similarityFloor: this.similarityThreshold`, `acceptFloor: this.acceptThreshold`, `embedder` y `verifierRan: this.verify != null`.
   - El comentario interno en español explica que la clave exacta ya los tenía y la semántica no, sin relatos en el JSDoc: la verja de superficie prohíbe «faltaba» y similares en líneas `*` del `.d.ts`.
3. **`src/policy/policy.ts`**
   - Señales:
     ```ts
     const turnosDeUsuario = c.messages.filter(m => m.role === "user").length;
     const conHerramientas = (c.original?.tools?.length ?? 0) > 0;
     const conHistorialDeHerramientas = c.messages.some(m => m.role === "tool" || (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0));
     const isAgentic = conHerramientas || conHistorialDeHerramientas || turnosDeUsuario > 1;
     const incluyeAgentico = c.original?.savings?.semanticCache === "include-agentic";
     ```
   - `allowSemanticCache = …vetos actuales… && (!isAgentic || incluyeAgentico)`.
   - `reasons.push(...)` en inglés, en los dos sentidos: apagada por defecto, o admitida por `include-agentic`.
   - `allowElision` **no** cambia.
   - Comentario interno en español con la cita de [31] (URL y fecha), el matiz H5 y la nota «dial: umbral de turnos solo si sale de medir».
   - Se devuelve `isAgentic`.
4. **`src/pipeline/libro-de-calidad.ts`** (nuevo, interno)
   - `export interface HechosDeCalidad { origen?: "fail_open"; validacion?: { resultado: "passed"|"failed"; errores: number; desenvuelto: boolean }; reparacion?: QualityRepairCheck; final?: { finishReason?: string; topeDelLlamante?: number }; semantico?: SemanticHit; }`
   - `export function libroDeCalidad(a: { cacheResult; structurallyValid: boolean|null; backend: string; hayEsquema: boolean; ageMs?; cascada?: ModelCascadeReport; hechos?: HechosDeCalidad }): QualityLedger`
   - `export function libroDelSeguidor(lider?: QualityLedger): QualityLedger`, que conserva los bloques y fija `source: "coalesced"` y `sharedFrom: lider?.source ?? "provider"`.
   - Funciones puras, sin I/O.
5. **`src/pipeline/pipeline.ts`**
   - `generateOptimized`, tras `evaluatePolicy`: si `toggles.semanticCache && toggles.semanticCache !== "include-agentic" && policy.isAgentic && this.deps.semanticCache`, entonces `this.avisar("semantica-agentica-apagada", "[bv-sala] `savings.semanticCache` is on, but this request is agentic (…) so the semantic cache was neither consulted nor written. That is the default … set `savings.semanticCache: \"include-agentic\"` after measuring it on your own traffic.")`.
   - Etapa 4: si se pidió y `policy.isAgentic && !policy.allowSemanticCache`, `trace.record("semantic-cache", "skipped: agentic traffic (default); …")`. En el acierto se pasa `hechos: { semantico: hit }` a `finish`.
   - Etapa 11: rellenar `hechos.validacion` (`errores = validation.errors.length`, `desenvuelto` donde hoy se traza `rescued-locally`) y `hechos.reparacion` en cada rama (esquema roto, truncado, verja de dinero, reparado o no, `backend ≠ none`).
   - Etapa 12, llamada a `finish`: `hechos.final = { finishReason: response.finishReason, topeDelLlamante: request.response?.maxOutputTokens }` (el `response` final, tras reparación o escalada).
   - `finish()`: parámetro nuevo al final, `hechos?: HechosDeCalidad`. En los atajos con esquema se guarda el resultado completo de `validateAgainstSchema` para tener `errores`. Se pasa a `buildReport`.
   - `buildReport()`: parámetro nuevo; `qualityLedger: libroDeCalidad({...})`; `quality.semanticScore = hechos.semantico.similarity` en los aciertos semánticos.
   - `failOpenDirect()`: `hechos = { origen: "fail_open", validacion, final: { finishReason, topeDelLlamante } }`.
   - `asCoalescedFollower()`: `qualityLedger: libroDelSeguidor(leader.report.qualityLedger)`, explícito para que el spread no copie el `source` del líder.
   - Los sitios de escritura semántica no cambian: ya usan `policy.allowSemanticCache`.
6. **`src/metering/emitter.ts`**: sin cambios de código. Se amplía el comentario (español) de la línea ~354: tampoco viaja `qualityLedger`, por la misma regla de servidor primero.
7. **`benchmarks/stats.ts`**
   - `export function wilsonCI(k: number, n: number, alpha = 0.05): CI | null`, que devuelve `null` con `n = 0`.
   - `export function bootstrapProporcionPorGrupos(grupos: { num: number; den: number }[], opts): CI`: remuestrea grupos y calcula Σnum/Σden con `mulberry32`.
8. **`benchmarks/cache-semantica/`** (nuevo; comentarios en español, salida para el cliente en inglés)
   - `fuentes.ts`: fuentes fijadas (§10) con URL, revisión, sha256 u oid LFS, tamaño, licencia, fecha de consulta y marca `origenNoComercial` para ORCAS.
   - `datos.ts`, descarga y extracción a `benchmarks/out/cache-semantica/datos/` (ya ignorado por git):
     - GPTCache: `raw.githubusercontent.com/zilliztech/GPTCache/4838dc38dd4bf15c71a0f54624fe550f38925abc/examples/benchmark/reuse_compatibility/{cases,labels,baseline_jev_070}.jsonl` con verificación de sha256 (aborta si no coincide).
     - LmArena: lectura por rangos HTTP con `hyparquet` (`asyncBufferFromUrl` + `parquetReadObjects({ columns: ["id","prompt","ID_Set"] })`) de `huggingface.co/datasets/vCache/SemBenchmarkLmArena/resolve/c6f36229bef6a5f7936e5b9d982bd5766ef2f862/train.parquet`.
     - Se comprueban `byteLength === 6595558805` y `num_rows === 63796`, y se guarda el JSONL extraído junto con su sha256. Probado: son unos 2 s y unos 9 MB, SNAPPY nativo.
     - Opcional: `--embebedor dataset:emb_gte` lee una columna de vectores precomputados. Supone transferir aproximadamente 1 GB porque solo hay un row group.
   - `nucleo.ts`: conductores y puntuación.
     - **Conductor de tripletas (capa)**: una capa con `devUnlicensed`, `silenceWarnings`, `new InMemorySemanticCache()` por defecto y un proveedor falso. Para cada caso, `tenantId = uid`. Primer `generate` con `cached_request`, que devuelve `cached_answer`; segundo con `current_request`, que devuelve un centinela. En esa configuración sin calibración el resultado semántico siempre es `miss`; un acierto (`report.cache.result === "semantic"`) exige una calibración certificada. `savings: { semanticCache: true, exactCache: false, deterministicResolvers: false }`.
     - **Stream**: una capa y un tenant; prompts en el orden de la revisión fijada; el proveedor devuelve `class:<ID_Set>`. Sin calibración sigue habiendo escrituras y desalojos, pero ningún acierto. Con una calibración certificada, un acierto es correcto si la clase servida coincide con la de la consulta. Se reporta la tasa de acierto, la precisión, la tasa de error, el recall frente a lo alcanzable (la clase ya estaba en caché), los desalojos y los «desacuerdos sobre prompt idéntico».
     - `maxRecords` = el valor que se envía (5.000) salvo `--max-registros`.
     - Puntuador: `reuse` = positivo; `uncertain` fuera de los denominadores y reportado aparte; métricas por brazo, `split` y categoría de falso positivo (`reason_categories`).
     - **Conductor de componentes** como diagnóstico.
   - `arnes.ts` (CLI): `--seco`, `--descargar`, `--conjunto tripletas|lmarena|todos`, `--n <N>` (por defecto 20000; 0 = todo), `--incluir-orcas`, `--max-registros`, `--verificar-puntuador` y `--embebedor built_in|dataset:<col>`.
     - Escribe `benchmarks/out/cache-semantica/resultado.json` con `{ mode: "live"|"dry-run", generatedAt, commit, dirty, sdkVersion, config: { embedder, similarityFloor, acceptFloor, effectiveFloor, maxRecords, policy: true }, fuentes: [...], tripletas: {...}, lmarena: {...}, casos: [{ uid|id, decision, similarity? }] }`, sin ningún texto.
   - `fixture-seco.jsonl`: unos 12 casos **sintéticos propios** (paráfrasis, cambio de número, cambio de negación, par idéntico y un brazo ficticio `search_*` para probar el filtro ORCAS).
   - `publicar-verja.ts` (puro): `decidirPublicacion(artefacto) → { ok, blockers, warnings }`, con los bloqueos de D21.
   - `publicar.ts`: genera `docs/SEMANTIC-CACHE-PRECISION.md` desde la plantilla (§6) y copia el artefacto a `benchmarks/evidencia/cache-semantica-<AAAA-MM-DD>.json`. Admite `--dry-run` y `--permitir-origen-no-comercial` (solo tras la decisión legal).
9. **`package.json`**
   - scripts `"cache-semantica": "BVSALA_DEV_OPEN=1 tsx benchmarks/cache-semantica/arnes.ts"` y `"cache-semantica:publicar": "tsx benchmarks/cache-semantica/publicar.ts"`.
   - `devDependencies.hyparquet: "^1.31.2"`, y se actualiza `pnpm-lock.yaml`.
   - **No** se sube la versión.
10. **`test/superficie-publica-limpia.test.ts`**: se añaden `"vCache"`, `"SemBenchmark"`, `"ORCAS"` y `"hyparquet"` a la lista de terceros del `.d.ts`. Si el recuento de líneas con tildes baja, se baja `TECHO`.
11. **`benchmarks/scenarios.ts`**: una línea en `PALANCAS_SIN_ESCENARIO` que remite a `benchmarks/cache-semantica` para la **precisión**. El banco de ahorro sigue sin escenario semántico, y el motivo actual no cambia.
12. **No se tocan** `apps/web` (ni los mensajes ni la paridad de 12 idiomas), el wire, el ingest, la LICENSE ni el gateway: `gateway/medidor.ts` no emite el libro, que es opcional.

---

## 4. Dependencias

- **`hyparquet@^1.31.2`, devDependency.** Licencia MIT, cero dependencias, tipos incluidos (`types/index.d.ts`), ESM, unos 3,97 M descargas al mes; comprobado en npm el 2026-09-27.
- Justificación:
  - El parquet de LmArena pesa 6,6 GB en un solo row group. La lectura por rangos baja solo las tres columnas necesarias, con la revisión fijada.
  - La API `rows` de datasets‑server no permite fijar revisión ni elegir columnas.
  - Todas las columnas usadas son SNAPPY, así que no hace falta `hyparquet-compressors`.
- Ninguna dependencia de runtime: `sala-limpia-del-tarball` sigue válido.

---

## 5. Tests

**`test/libro-de-calidad.test.ts`** (nuevo): unitarios de `libroDeCalidad`/`libroDelSeguidor` e integración por la capa, con los proveedores falsos de `estado-de-calidad.test.ts`.
- Esquema válido: `schema.passed`, `errorCount 0`, `source provider`, `truncation.truncated false`.
- JSON envuelto en prosa: `unwrapped: true` y sin `repair`.
- Inválido, reparado y válido: `repair.repaired` y `calls.retries === 1`. Inválido, reparado e inválido: `still_invalid` y `qualityStatus rejected`.
- Una rama por cada `skipReason`: patrón inválido, `finish_reason: "length"` con tope, verja de dinero con `skipRepairAboveBaseline` y `constraintBackends` nativo.
- Truncado: `truncated: true`, `capSetByCaller` y `maxOutputTokens`; además, la repetición idéntica **no** acierta en la caché (el comportamiento actual se mantiene).
- Turno de herramientas: `schema.not_applicable`.
- Acierto exacto: `cacheMatch.kind exact` y `schema.decodeTimeConstraint false`. Resolver: `source deterministic`.
- Acierto semántico: `similarity === report.quality.semanticScore`, `similarity ≥ similarityFloor`, `min(similarity, verifierScore ?? similarity) === report.cache.confidence ≥ acceptFloor`, `factGuard "passed"`, `embedder` correcto con y sin `embed`.
- Cascada `on` aceptada, escalada y `shadow`: los tres `outcome`.
- Fail‑open: `source fail_open`.
- Seguidor: `source coalesced`, `sharedFrom` igual al del líder, bloques heredados.
- **Coherencia** en los reportes no seguidores:
  - `rejected ⇒ schema.outcome === "failed"`
  - `bounded_degradation ⇒ cascade.outcome === "accepted"`
  - `task_equivalent ⇔ source === "semantic_cache" || sharedFrom === "semantic_cache"`
  - `exact ⇒ source ∈ {exact_cache, deterministic}` (o `sharedFrom` en ese conjunto)
- **Sin dinero**: recorrido recursivo de claves contra `/cost|price|usd|saving|token|basis/i` en todas las formas.
- **Sin contenido**: ningún valor string del libro coincide con el texto del prompt ni de la respuesta.

**`test/estado-de-calidad.test.ts`**: al test «cada estado de QUALITY_STATUSES tiene un camino» se le añade la aserción de que cada informe trae `qualityLedger` coherente.

**`test/cache-semantica-agentica.test.ts`** (nuevo):
- Con `tools` de lectura y `semanticCache: true`: `policy.isAgentic`, `allowSemanticCache false` y razón presente; la reformulación da `miss`; `semanticCache.size === 0` (tampoco escribe).
- Lo mismo con un mensaje `role:"tool"`, con `assistant.toolCalls` y con dos turnos de usuario.
- Single‑shot (`system` + `user`): sin cambios (los tests semánticos existentes siguen en verde).
- `"include-agentic"`: la reformulación acierta; con el mismo texto y **otro catálogo** de herramientas, `miss` (H1); con `temperature` o `seed` distintos, `miss`.
- Herramienta de escritura con `"include-agentic"`: sigue apagada.
- `allowElision` idéntico con y sin tráfico agéntico.
- Aviso: una sola vez por proceso; nada con `silenceWarnings`; nada si la capa no tiene `semanticCache` (entonces sale el aviso ya existente `palanca-sin-cache-semantica`).
- `"safe-only"` se comporta igual que `true`.

**`test/metering-emitter.test.ts`**: añadir «el libro de calidad no viaja». Se registra un informe con `qualityLedger` completo y, tras el flush, cada clave del cuerpo ∈ `CAMPOS_DEL_REGISTRO_DE_USO` (alias `@/lib/metering/usage`) y no aparece `qualityLedger`.

**`test/stats.test.ts`**:
- `wilsonCI(5,10)` ≈ [0,2366; 0,7634].
- `wilsonCI(0,10)` ≈ [0; 0,2775].
- `wilsonCI(0,0) === null`.
- `bootstrapProporcionPorGrupos` es determinista con semilla y colapsa si todos los grupos tienen la misma proporción.

**`test/cache-semantica-arnes.test.ts`** (nuevo, sin red):
- El puntuador excluye `uncertain` y cuenta TP, FP y FN; reproduce un mini‑baseline sintético.
- El conductor usa la capa real: el par idéntico acierta y el par con un número distinto falla.
- El brazo `search_*` del fixture se filtra sin `--incluir-orcas`.
- El artefacto `--seco` trae `mode: "dry-run"`, los campos de procedencia y **ningún** texto del fixture.
- `decidirPublicacion` bloquea `dry-run`, `dirty`, fuentes sin revisión o sha256 y `origenNoComercial`, y acepta un artefacto `live` completo.

---

## 6. Documentación

- **JSDoc** (§2): es la documentación primaria del cambio (c) y del libro.
- **`README.md`**, sección «What you get on every request», tras la tabla de los cuatro libros. Solo prosa, sin bloque ```` ```ts ```` nuevo (`fragmento-instalacion` compila todos), sin cifras, sin «≥ N %» y sin la palabra con guion vetada.
  > **Quality, kept apart from money.** `report.qualityLedger` records how the answer you received earned its place: whether it came from your provider, a replay, or the answer to a reworded question (with its similarity score); whether it was checked against your output contract, repaired or cut off by the output limit; and what the model cascade decided. It holds no money, is never added to the four ledgers, and never leaves your process. Reusing answers to reworded questions is opt‑in, and by default it covers single‑shot requests only: requests that declare tools, carry tool calls or results, or hold more than one user turn are left out unless you set `savings.semanticCache: "include-agentic"`.
- **`docs/SEMANTIC-CACHE-PRECISION.md`** (inglés, **generado** por `pnpm cache-semantica:publicar`; nunca se copian a mano las cifras de H7). Secciones:
  1. What is measured: la configuración que se envía, con el suelo efectivo y los dos parámetros.
  2. Headline: el suelo al 95 % de la precisión, tripletas `arena`.
  3. Tabla A, tripletas `arena` (n, precisión y recall con Wilson, tasa de acierto, reutilizaciones erróneas, por split, categorías de falso positivo).
  4. Tabla B, stream de LmArena (N, tasa de acierto, precisión, tasa de error y recall frente a lo alcanzable, con IC por bootstrap de clases; desalojos; desacuerdos sobre prompt idéntico).
  5. Context: el evaluador del propio proyecto sobre los mismos casos, recalculado con el mismo puntuador y etiquetado como suyo y basado en LLM.
  6. What this means for you: la precisión es la cifra que importa; opt‑in; apagada en tráfico agéntico; verifícalo en tu tráfico.
  7. Limitations: etiquetas asistidas por modelo; embebedor léxico; la dependencia del stream; ruido de etiqueta; defectos del lado de la respuesta (`incomplete_format`); los brazos ORCAS no medidos.
  8. Data & licenses (§10).
  9. Reproduce (comandos).
- **`benchmarks/README.md`**: sección «Semantic cache precision (`pnpm cache-semantica`)» con el protocolo, los flags, la política de licencias y dónde queda la evidencia.
- Si no se puede ejecutar la medición (sin red), el documento **no** se genera: el PR deja el harness probado en seco y los comandos de §7.

---

## 7. Orden de trabajo, commits y verificación

Prerrequisito (reglas 0, 0b y 0c): `git status`, `git log origin/main..main` y `git reflog main` en la raíz compartida. Después:

```bash
git -C /Users/fisagol/bsl-comprador fetch -q origin && git -C /Users/fisagol/bsl-comprador worktree add -b feat/libro-de-calidad /Users/fisagol/bsl-calidad-cache origin/main
cd /Users/fisagol/bsl-calidad-cache && pnpm install --frozen-lockfile && pnpm install --frozen-lockfile --dir apps/web
pnpm -s build:all && git checkout -- apps/web/public/vendor/bv-sala.js
```

Commits: siempre `git commit -F <fichero> --only -- <rutas>`, en español y terminados en `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca `apps/web/public/vendor/bv-sala.js`.
1. `fix(cache): la caché semántica filtra por herramientas y muestreo, y se aparta del tráfico agéntico salvo que se pida` → `semantic.ts`, `policy.ts`, `types.ts` (toggle y `Policy`), `pipeline.ts` (aviso y traza), `test/cache-semantica-agentica.test.ts`.
2. `feat(informe): el libro de calidad — qué se comprobó en cada respuesta, sin dinero y sin salir del proceso` → `types.ts`, `libro-de-calidad.ts`, `pipeline.ts`, tests de §5, `emitter.ts` (comentario), `superficie-publica-limpia.test.ts`, README.
3. `feat(banco): precisión y recall de la caché semántica contra conjuntos públicos, con IC` → `benchmarks/cache-semantica/**`, `stats.ts`, tests, `package.json`, `pnpm-lock.yaml`, `benchmarks/README.md`, `scenarios.ts`.
4. Tras ejecutar en vivo: `docs(banco): la precisión medida de la caché semántica, con su suelo` → `docs/SEMANTIC-CACHE-PRECISION.md` y `benchmarks/evidencia/cache-semantica-<fecha>.json`.

Medición en vivo (sin llamadas a LLM ni secretos; solo descargas públicas):
```bash
pnpm cache-semantica --descargar
pnpm cache-semantica --verificar-puntuador      # debe dar 364/365 y 364/505
pnpm cache-semantica --conjunto todos --n 20000 # solo el brazo arena + stream de LmArena
pnpm cache-semantica:publicar --dry-run && pnpm cache-semantica:publicar
```

Verificación (todo en verde): `pnpm -s build:all && git checkout -- apps/web/public/vendor/bv-sala.js`; `pnpm -s run typecheck:all`; `pnpm --dir apps/web run typecheck`; `pnpm -s exec vitest run --reporter=dot`. No se toca `apps/web`, así que su build no hace falta.

Después: push de la rama y `gh pr create --base main`. **No** se fusiona.

---

## 8. Riesgos y cómo se cubren

- **Cambio de comportamiento:** quien ya tenía `semanticCache: true` con herramientas o varios turnos deja de acertar. Lo cubren el aviso único, la traza y la razón en `policy.reasons`, `"include-agentic"` y la nota de versión (paso del dueño).
- **Trinquete de tildes:** todo JSDoc nuevo va en inglés. Si baja el recuento, se baja `TECHO`.
- **Seguidores:** el spread de `informeDelLider` copiaría `qualityLedger` con el `source` del líder. Se sobrescribe explícitamente y un test lo fija.
- **Rendimiento del stream:** `find()` es lineal (O(N²) en total). Con N=20.000 fueron unos 26 s a nivel de componentes, y es aceptable fuera de CI. En CI solo corre `--seco`.

---

## 9. Pasos del dueño

Ninguno bloquea la unidad: todo lo anterior se implementa y se fusiona sin ellos.
1. Revisar el PR y fusionarlo con CI en verde.
2. En la nota de la próxima versión, declarar el cambio (c) y `"include-agentic"`. También el filtro nuevo de herramientas y muestreo, que puede bajar algún acierto semántico que antes cruzaba catálogos.
3. **Legal:** decidir si se pueden usar internamente o publicar los brazos derivados de ORCAS («non‑commercial research only»): 1.024 de las tripletas de GPTCache y SemBenchmarkSearchQueries. Sin decisión quedan fuera, y el publicador lo impone.
4. Opcional, en otra unidad: publicar la precisión en la web (12 idiomas, verjas de paridad) y un enlace desde el README cuando exista la página pública.
5. Opcional, en otra unidad: decidir el suelo por defecto (H2: efectivo 0,85 frente a los 0,72 documentados) con el split de calibración, y el brazo de embeddings precomputados (unos 1 GB).

---

## 10. Fuentes (consultadas el 2026-09-27)

- [31] LiteLLM, «Semantic caching»: https://docs.litellm.ai/docs/proxy/caching_semantic
  - Citas literales: «Semantic caching is designed for single-shot prompts. On multi-turn or agentic traffic it will replay stale responses.» · «The recommendation is to keep semantic caching for single-shot traffic and exclude agentic traffic.» · «Raising `similarity_threshold` does not reliably fix this».
- [89] vCache, arXiv 2502.03771 (ICLR 2026): https://arxiv.org/abs/2502.03771. El paper está bajo CC BY‑NC‑ND 4.0.
  - Datasets:
    - https://huggingface.co/datasets/vCache/SemBenchmarkLmArena: apache‑2.0, rev. `c6f36229bef6a5f7936e5b9d982bd5766ef2f862`, `train.parquet` de 6.595.558.805 bytes, oid LFS `ee562ac2d9395cedad16bfdcdd3caa6b17d04368646daa7c3253deac92746c1b`, 63.796 filas. Correcto si la respuesta recuperada pertenece a la misma clase (`ID_Set`), según su README.
    - https://huggingface.co/datasets/vCache/SemBenchmarkSearchQueries: tarjeta apache‑2.0, rev. `5159bff8ccf5d7c57dd82cbb24a76e2e5d24f1c0`, 150.000 filas, **derivado de ORCAS**.
- LM‑Arena, arena‑human‑preference‑100k: https://huggingface.co/datasets/lmarena-ai/arena-human-preference-100k. «User prompts are licensed under CC-BY-4.0, and model outputs are governed by the terms of use set by the respective model providers.»
- ORCAS / MS MARCO: https://microsoft.github.io/msmarco/ORCAS.html y https://microsoft.github.io/msmarco/. «non-commercial research purposes only».
- [90] GPTCache reuse_compatibility: https://github.com/zilliztech/GPTCache/tree/4838dc38dd4bf15c71a0f54624fe550f38925abc/examples/benchmark/reuse_compatibility. Licencia del repo MIT (https://github.com/zilliztech/GPTCache/blob/main/LICENSE).
  - `cases.jsonl` sha256 `97eedb5978f4f9a5558eee29a26a26ca269a839c2e3d9654cf31422525993627`.
  - `labels.jsonl` sha256 `797c0c8a69946f195c04629caa31a16aad1d1d23328cbb5ce823b726ff669e22`.
  - `baseline_jev_070.jsonl` sha256 `fd9c1e838d5468bfde986752ea1d40af3e01ec79a9599aa2fd9f4bd0ee5cb8bd`.
  - Etiquetas asistidas por modelo (`manifest.json`).
- hyparquet 1.31.2: https://www.npmjs.com/package/hyparquet (MIT, 0 dependencias).
- Internas:
  - `origin/main` `f157462`: `src/cache/semantic.ts`, `src/cache/embedder-local.ts`, `src/policy/policy.ts`, `src/canonicalization/keys.ts`, `src/pipeline/pipeline.ts` (etapas 4, 11 y 12, `buildReport`, `failOpenDirect`, `asCoalescedFollower`), `src/metering/emitter.ts`, `apps/web/lib/metering/usage.ts`, `test/superficie-publica-limpia.test.ts`, `apps/web/lib/readme-alineado.test.ts`, `test/fragmento-instalacion.test.ts`.
  - Informe: `origin/docs/bitacora-2026-09-26:docs/COMPETENCIA-2026-09-26.md` (§2.4, §3, §4.1, §8 n.º 10).
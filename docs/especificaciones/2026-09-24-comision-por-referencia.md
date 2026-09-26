# Frente 1 · Comisión honesta del SDK: especificación final del carril «medido por referencia» (basis `reference`)

He leído `/Users/fisagol/bsl-comprador` en el HEAD `ffa93eb`. Es `9b47c9a` (origin/main + PR #310) más dos commits que no tocan este frente: un comentario de `src/license/poller.ts` y el vendor `apps/web/public/vendor/bv-sala.js`. Todas las citas `fichero:línea` son de ese HEAD y las he comprobado en el código. Los agentes lo implementan sin hablar conmigo: donde esta especificación y un diseño anterior discrepen, manda esta.

---

## PORTADA

**El principio, en una frase publicable:**

> Solo cobramos comisión sobre dinero que el contador de tu proveedor ya midió. Puede ser el de tu propia petición. O, cuando te servimos una repetición sin llamar al proveedor, el de la petición idéntica byte a byte que sí se ejecutó, sin que la capa le quitara ni le añadiera nada, y que ya pagaste. Esa repetición la valoramos al precio más bajo que tu proveedor podía cobrarte por repetirla, así que lo facturable queda siempre por debajo de lo que te habría costado.

**Decisión.** Gana el Diseño 1 (medido por referencia) con los injertos de los jueces. Tres de ellos van más estrictos que lo que pidieron los jueces:
- La identidad es byte a byte, por huella SHA-256 de la petición. La colisión de clave normalizada ya no basta.
- La salida solo se acredita con `temperature === 0`. `seed` no cuenta.
- El testigo es una atadura criptográfica al texto y a la clave, no una tolerancia de tokens.

Los Diseños 2 y 3 quedan descartados como base de comisión:
- **Diseño 2.** Su baseline es un recuento local acotado por convenciones («same-contract», «same-cache-history»). En el régimen dominante (prefijo cacheado) publica «verified» positivo donde la capa pierde dinero. Además solo cubre gpt-4o/4.1 contra api.openai.com.
- **Diseño 3.** `N·d_low` es una inferencia que no ve las colas negativas raras, y por construcción cobra de más el 2,5 % de los períodos. Además le cobra al cliente la medición en su propia factura y ninguna línea de esa factura respalda la base extrapolada.

La idea útil del Diseño 3, el A/B muestreado, pasa al siguiente frente como informe de verificación opt-in, nunca como base.

**Lo que el dueño obtiene, sin edulcorar:**
- La comisión del SDK pasa de «idénticamente 0» a «> 0 en tráfico repetido idéntico, defendible petición a petición».
- Los libros 2 y 3 (eliminados y comprimidos, ≈ 99 % del dólar de ahorro del banco) siguen fuera, porque no existe contador del contrafactual.
- Sobre el banco publicado: 0 % del titular, porque los brazos arrancan en frío por diseño. Si el escenario «FAQ (repeat ask)» se corriera en caliente, sería el 1,35 % del dólar del banco.
- Por cada 10.000 $/mes de gasto ingenuo, según el perfil del cliente: de ≈ 0,5 € (agentes con muestreo por defecto) a ≈ 140 € (clasificación/FAQ determinista con repetición alta). Una mezcla API típica ronda los 12 €.

---

## 1 · Cómo se resuelve cada defecto fatal y cada injerto

| Origen | Defecto o injerto | Resolución en esta especificación |
|---|---|---|
| Juez 1, fatal 1 | La referencia de una poblada con tokens quitados no es un suelo: la capa alarga la salida y la ingenua repetida lee caché | La referencia **solo nace de una llamada poblada intacta** (§3.1, E2–E6): ningún libro 2/3, sin elisión, sin contenido añadido (±2 tokens de ruido de unión), sin codebook, sin sondeo de descubrimiento, sin esquema por prompt y con el modelo servido igual al pedido. Así el contador de la poblada ES el de la petición del cliente. Toda la entrada va a `cachedInputPer1k`, que es el mínimo que el proveedor cobra aunque la ingenua acierte en caché de prefijo. Salida: 0 salvo muestreo determinista. |
| Juez 1, fatal 2 · Juez 2, (a) | `maxOutputTokens` no está en la clave exacta | Salida acreditada = `floor(0,95 · min(outputTokens, maxOutputTokens del LECTOR))`. |
| Juez 1, fatal 3 | «idéntica» es tras normalización; «línea de factura» no es exacto | **Identidad byte a byte**: la referencia guarda `requestFingerprint = sha256(stableStringify({messages, structuredData, tools, schema}))` y el lector exige la misma huella. Si no coincide: `different-request` → `estimated`. Los textos públicos dicen «el contador que tu proveedor devolvió para la petición idéntica… está en el informe de esa petición y en el uso de tu proveedor de ese día», nunca «línea de tu factura». |
| Juez 2, (b) | Esquema por prompt y pista de límites en prompts cortos | E5 excluye `schema && backend !== "provider-native"`. E2 excluye la pista, la evidencia y cualquier contenido añadido. Se exige `cachedInputPer1k` documentado (catálogo o `costModels`), nunca el precio ilustrativo ni `defaultCostModel`. |
| Injerto J1/J2/J3 | Interruptor de servidor | `BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1` en `/api/metering/usage` reescribe `reference`→`estimated` antes de la RPC. Se suma a `COMISIONAR_REFERENCIA` (tarifa.ts). |
| Injerto J1/J2 | Aritmética publicada | `report.cache.reference` lleva `inputTokens`, `outputTokens`, `creditedInputTokens`, `creditedOutputTokens`, `cachedInputPer1k`, `outputPer1k`, `tierFactor`, `requestId` y `at`. Con eso `baselineEstimate` se recalcula exacto. |
| Injerto J1/J3 | CSV línea a línea | Tabla `reference_hits` (0029, RLS por org) con una fila por acierto; ruta `GET /api/org/reference-hits?periodo=`; enlace en el extracto. |
| Injerto J1/J3 | `parametros` autocontenidos | `Extracto.parametros.referencia = REGLA_REFERENCIA` (versión, cuota de salida, edad máxima, margen por mensaje), pintada en el extracto y sellada como `extractos.regla_referencia`. |
| Injerto J1 | Veto de calidad al leer | L6: el acierto exacto valida `hit.data` contra el esquema; el seguidor exige `structurallyValid !== false && qualityStatus !== "rejected"`. |
| Injerto J1 | Testigo contra `meta.reference` forjado o desalineado | L2: `sha256(texto servido) === textSha256` y, en acierto exacto, `cacheKey === exactKey`. Sustituye a la tolerancia ±10 %, que fallaría siempre con el heurístico de Anthropic (sesgo ×1,91, accounting.ts:90-93). |
| Injerto J2 | Tres PRs en orden y 202 real antes de npm | §10. |
| Injerto J2 | Rechazar si `ref.inputTokens > baselineInput_local` | **No se adopta** en esa forma: mezcla la regla del proveedor con la local (~311 tokens de protocolo, accounting.ts:320-331) y rechazaría casi todo. La huella byte a byte lo sustituye con ventaja. |
| Injerto J3 | Precio de lista por debajo del mínimo cacheable | **No se adopta** por defecto: exige mínimos por familia que cambian (1024/2048/4096; DeepSeek 64) y un error ahí cobra de más. Queda como regla v2, decisión del dueño (§14). |
| Injerto J3 | Reescribir README l.96-100 y l.264-267 y el aviso de create.ts:297-300 | Adoptado (§8). Hoy prometen que `gpt-tokenizer` vuelve `measured` lo quitado, y es falso. |
| Injerto J3 | Test de propiedad sobre el catálogo | Adoptado: `test/referencia-es-suelo.test.ts` (§9). |
| Injerto J3 | Parte G (gemela del gateway) en el mismo PR | **No**: dos de tres jueces más `gateway/coalescencia.ts:18-22` dicen que es decisión del dueño. Queda especificada en §11 como PR-G, bloqueado hasta su sí. |
| Injerto J2/J3 | Siguiente frente = A/B | Informe de verificación opt-in con pares exportables, fuera de la base (§14). |

---

## 2 · Hechos del código de los que depende el diseño

1. `src/tokenizer/accounting.ts:27`: `CostBasis = "measured" | "estimated" | "unmeasured" | "shadow"`. En :298 `ranCall = avoidedLlm === 0`; en :305 el basis inicial es `"estimated"` y una evitada no lo cambia nunca. En :344 `basis = removedInputLocal === 0 ? "measured" : "estimated"`. En :398-418 `cachedRate = cachedInputPer1k ?? inputPer1k`, tarifado igual en los dos lados. Todo `accounting.ts` se reexporta (`src/tokenizer/index.ts:4`), así que lo que se añada es superficie pública.
2. `src/pipeline/pipeline.ts:1043`: `baselineInput` es la cuenta LOCAL de `assembleBaselinePrompt` (mensajes + `JSON.stringify(structuredData)` + `textoDeHerramienta`). Esquema excluido (pipeline.ts:1779-1784).
3. Acierto exacto en pipeline.ts:1088-1105: `ledger.avoidCall(baselineInput, tokensFor(hit.text))` y precio `costModel = costModelFor(cascada.modeloServido)` (1031).
4. `src/canonicalization/keys.ts:43-70`: `buildExactKey` usa `c.normalizedText` (texto conversacional normalizado: NFKC, minúsculas, sin diacríticos ni puntuación de frase; canonicalize.ts:129-160, 234-237). `systemPromptHash` va crudo; `toolsetHash` hashea solo `{id, risk, parameters}` y **no** la descripción (canonicalize.ts:239-241). Lleva `temperature` y `seed`, **no** `maxOutputTokens`. `buildInflightKey` (107-157) sí lleva `maxOut`, `deferrable` y `toolDiscovery`.
5. `src/policy/policy.ts:141,192-197`: la caché exacta se apaga solo con `temperature > 0.3 && seed == null`, así que una petición **sin** `temperature` se cachea aunque el proveedor muestree a 1. En :239 el singleflight no mira el muestreo.
6. `src/cache/exact.ts:10-18`: `CachedAnswer.meta?: Record<string, unknown>` existe y nadie lo rellena. `InMemoryExactCache` copia con `structuredClone` (93-104).
7. `src/cache/singleflight.ts:21-42`: el seguidor recibe **el mismo objeto** `value` que el líder (misma `Promise`).
8. Escritura en caché: pipeline.ts:2583-2588 (`answer`), 2666-2667 (`cacheable = structurallyValid !== false && !pidioHerramientas && !vistaRecortada && !cortadaPorElTope`), 2690-2702 (`claveDeEscritura`, `exactCache.set`), 2711-2719 (semántica: el mismo `answer`, no escribe si `modeloServido !== request.model`).
9. Llamada primaria en pipeline.ts:1931. Escalada de cascada en 2004-2019 (el intento barato va a `cascadeAttempt`, solo en `actual`). En 2035-2036 `actualInput/Output +=` de la respuesta ya post-escalada. En 2091-2094 `sentInputLocal`; en 2102-2105 `removedInputLocal`; en 2112 se suma el sondeo. Reparación en 2516-2558: tras ella `response` ES la de la reparación y `textoServido = response.text`.
10. Los mensajes que inserta la capa van por `insertarAntesDeLaPregunta`: pista de límites (1399, solo si el contrato ya incumplió), datos estructurados (1418 y 1430) y evidencia (1441). La serialización acredita libro 3 con `ledger.compress(jsonTokens, chosenTokens)` (1413).
11. Seguidor: `asCoalescedFollower` (3414-3489) crea un ledger nuevo con `avoidCall` y hereda `traces` del líder (así que una traza del seguidor se pierde).
12. `requestId`: se genera en `buildReport`, pipeline.ts:3227, después de la escritura en caché.
13. Precio: `precioConocido` (costModels → catálogo) frente a `costModelFor` (añade `defaultCostModel` y el ilustrativo con aviso). `src/pricing/catalogo.ts:40-47`: gpt-4-turbo/gpt-4/gpt-3.5 **sin** `cachedInputPer1k`. 4o/4.1 al 50 %, gpt-5.x y Anthropic/Gemini al 10 %, Fable/Mythos 5.1 al 2,5 %.
14. `src/economics/tier-diferido.ts:79-93`: `FACTOR_POR_TIER_SERVIDO` (flex 0,5, batch 0,5, el resto 1). `veredictoDelTier` en 120-131.
15. Emisor, `src/metering/emitter.ts:313-375`: `basis` viaja (369). Un 4xx descarta el lote sin reintento (261-276); npm es inmutable.
16. Ingest, `apps/web/lib/metering/usage.ts`:
    - 44: `USAGE_BASIS` cerrado.
    - 56-61: `USAGE_ALLOWED_FIELDS`.
    - 22: `USAGE_ID_PATTERN`.
    - `recortarSuelo` y `TECHO_PRECIO_LECTURA_PER_1K = 0.002` (techo-precio-lectura.ts): «recorte, no rechazo».
    - `route.ts` hace parse → `sellarVersion` → RPC.
    - `packages/protocol/src/index.ts:288,299-313` es el espejo.
17. DB, `db/migrations/0025_dinero_de_la_elision_suelo.sql:143-352`: RPC entera. `medido := case when r->>'basis' = 'measured'` en 197; insert de usage_daily en 239-282; by_model en 285-308; sesiones en 310-338. 0026-0028 no tocan la RPC (grep). 0016 crea `extractos`; 0028 añade `es_exento`.
18. Extracto: `apps/web/lib/billing/extracto.ts:128-141` suma `measured_*`, la guarda del suelo de elisión está en 152-158 y `ahorroUsd` en 161. `cierre.ts:27-50,78-111`. En el cron `cierre-extractos/route.ts`: `FilaUso` en 39, SELECT explícito en 78, mapeo en 123-131 y upsert `ignoreDuplicates` en 184.
19. Panel:
    - `data.ts:334-389`: escalera `esColumnaInexistente`, `COLUMNAS_ELISION` en 344, lectura en 360, `UsageRollup` en 263.
    - `derive.ts`: `Verdict` en 90, `FilaUso` en 114, `deriveVerdict` en 272-306.
    - `VerdictHero.tsx:58-76`.
    - `extracto/page.tsx:150-163,197-224`.
    - `lib/billing/ritmo.ts:107-155` y `lib/billing/extracto-sombra.ts:48-75` también leen `measured_*`.
20. Verjas:
    - `tarifa-en-parametros.test.ts:30,52`: sin dígitos en `landing.calculadora`, `landing.formula` ni `dashboard.extracto`.
    - `parity.test.ts:109`: sin `€$£¥`, `EUR` ni `USD` en mensajes.
    - `claves-usadas.test.ts`.
    - `superficie-publica-limpia.test.ts:83-93,175`: nombres ingleses y trinquete de 81 líneas con acentos en `dist/index.d.ts`.
    - `readme-alineado.test.ts:39-55`.
    - `tarifa.test.ts:135-160`: prohíbe la palabra `inputPer1k` en código web.
    - `luz-verde.sh` área 4.
21. Banco (`apps/web/public/data/ab-live.json`): gpt-4o-mini, temperature 0 y seed 7 en los dos brazos (`honesty[1]`). «FAQ (repeat ask)» A 77/20 $2,355e-5, B 77/18,5 $2,265e-5. Brazos en frío (`honesty[2]`). `reconciliation.totalDelta` = $0,00943875.

---

## 3 · La clase facturable: reglas exactas

### 3.1 Escritura: cuándo nace una referencia

Una referencia (registro interno `RegistroDeReferencia` v1) nace en `expensivePath`, etapa 12, **solo si se cumplen todas**:

- **E1 · Usage.** El usage de la llamada primaria que sirvió (post-escalada, capturado en 2035) tiene `inputTokens` finito y > 0 y `outputTokens` finito y ≥ 0. Si no: `no-usage`.
- **E2 · Intacta.** `ledger.eliminatedInput === 0 && ledger.compressedInput === 0 && ledger.elididoLocal === 0 && Math.abs(sentLocalSinSondeo − baselineInput) <= 2`. `sentLocalSinSondeo` es el valor de `ledger.sentInputLocal` tras 2094 y antes de 2112. Si no: `layer-changed-request`.
  - Excluye el selector de herramientas, la serialización con ahorro, la compresión, la elisión, la pista de límites y la evidencia.
  - El ±2 absorbe el ruido de unión `"\n"` cuando los datos van en su propio mensaje.
- **E3 · Sin codebook.** `!codebook?.applied`. Si no: `codebook`.
- **E4 · Sin sondeo.** `descubrimiento.tokensLocalesDelSondeo === 0 && !descubrimiento.aplicado`. Si no: `tool-discovery`.
- **E5 · Contrato nativo.** `!schema || backendPlan.backend === "provider-native"`, leído tras la degradación de 2068-2078. Si no: `schema-in-prompt`.
- **E6 · Mismo modelo.** `modeloServido === request.model`: ni cascada que sirve el barato ni rebaja. Si no: `cheaper-model-served`.
- **E7 · Cacheable.** `cacheable === true`. Si no: `not-cacheable`.

Contenido del registro (formato v1, en `CachedAnswer.meta.reference` y en el mapa del líder):

```
{ v: 1,
  requestId,            // generado en etapa 12 (§4.2) y pasado a buildReport: = report.requestId de la poblada
  at: this.now(),
  model: request.model,
  inputTokens:  usoPrimario.inputTokens,                                     // SOLO la primaria (sin reparación, sin sondeo, sin intento barato)
  outputTokens: usoReparacion ? min(usoPrimario.outputTokens, usoReparacion.outputTokens) : usoPrimario.outputTokens,
  tierFactor?:  veredictoDelTier(usoPrimario.servedServiceTier) → factor, solo si conDescuento,
  layerMessages: messages.length − request.messages.length,                  // 0 o 1 (el mensaje de datos) bajo E2
  requestFingerprint: huellaDePeticion(request),
  textSha256: sha256(textoServido),
  cacheKey?: claveDeEscritura }                                              // SOLO en la copia que va a la caché exacta
```

La etapa 12 SIEMPRE registra una traza: `trace.record("reference", "written", {inputTokens, outputTokens, layerMessages})` o `trace.record("reference", "not-written", {reason})`, con la razón en ASCII inglés.

### 3.2 Lectura: cuándo una evitada se etiqueta `reference`

Se aplica en dos sitios:
- el **acierto exacto** (pipeline.ts:1088-1105), con el registro leído de `hit.meta`;
- el **seguidor de singleflight** (1149-1158), con el registro del líder tomado de un `WeakMap` privado indexado por el objeto resultado.

Las condiciones se evalúan en este orden y la primera que falla da el motivo, de tipo `ReferenceRejection`:

- **L0 · Presente.** Sin registro: `absent`. Mal formado: `malformed`. Bien formado significa: `v === 1`; `inputTokens` entero > 0; `outputTokens` entero ≥ 0; `at` finito; `tierFactor` ausente o en (0,1); `layerMessages` entero ≥ 0; `requestId`, `model`, `requestFingerprint` y `textSha256` como strings no vacíos.
- **L1 · Testigo** (`witness`): `sha256(texto a servir) === textSha256` y, en acierto exacto, `cacheKey === exactKey`.
- **L2 · Modelo** (`model-mismatch`): `registro.model === request.model && cascada.modeloServido === request.model`.
- **L3 · Edad** (`expired`): `−300_000 ≤ ahora − at ≤ REFERENCE_MAX_AGE_MS` (30 días; se toleran 5 min de desfase de reloj entre procesos).
- **L4 · Identidad** (`different-request`): `huellaDePeticion(request) === requestFingerprint`.
- **L5 · Calidad** (`quality`): en acierto exacto, `!schema || validateAgainstSchema(hit.data, schema).valid`; en seguidor, `leader.report.constraints.structurallyValid !== false && leader.report.qualityStatus !== "rejected"`.
- **L6 · Precio** (`no-cached-price`): `precio = precioConocido(request.model)`, nunca `defaultCostModel` ni el ilustrativo. `precio.cachedInputPer1k` finito con `0 < c ≤ precio.inputPer1k`, y `precio.outputPer1k` finito y ≥ 0.
- **L7 · Crédito** (`no-credit`): `creditedInputTokens > 0`.

Si falla: `ledger.avoidCall(baselineInput, tokensFor(texto))` como hoy (`estimated`) y `report.cache.referenceRejected = motivo`. Nunca se lanza nada y nunca se reclama de más.

### 3.3 Valoración

```
creditedInputTokens  = inputTokens − REFERENCE_MESSAGE_ALLOWANCE (8) · layerMessages
determinista         = request.temperature === 0
creditedOutputTokens = determinista ? floor(REFERENCE_OUTPUT_SHARE (0,95) · min(outputTokens, request.response?.maxOutputTokens ?? ∞)) : 0
tierFactor           = min(1, registro.tierFactor ?? 1, toggles.deferrable === true ? FACTOR_DIFERIDO_MINIMO (0,5) : 1)

baselineEstimate = tierFactor · ( creditedInputTokens/1000 · cachedInputPer1k + creditedOutputTokens/1000 · outputPer1k )
actual           = 0   (llamada evitada: actualInput = actualOutput = extraCostUsd = cacheWritePremiumUsd = 0)
netSavings       = 1
basis            = "reference"
report.tokens:     baselineInput = creditedInputTokens, baselineOutput = creditedOutputTokens,
                   actualInput = actualOutput = 0, providerCachedInput ausente
```

El precio se resuelve en el proceso que LEE y con el catálogo o los `costModels` vigentes, porque la factura contra la que se contrasta es la actual.

### 3.4 Por qué es un suelo

- **Entrada.**
  - Por E2–E6, la poblada envió la petición del cliente tal cual: el mismo modelo, el contrato nativo y el mismo contenido (±2 tokens locales). La única diferencia admitida es el mensaje de datos que inserta la capa, y ≤ 8 tokens de rol por mensaje la cubren.
  - Por L4 el lector envía exactamente los mismos bytes. El contador del proveedor para esos bytes es determinista, así que la ingenua habría facturado ≥ `inputTokens − 8·layerMessages` tokens de entrada.
  - El precio más bajo que cualquier proveedor del catálogo aplica a un token de entrada es `cachedInputPer1k`, incluso si la ingenua acierta entera en la caché de prefijo. Esto cierra el caso 459 frente a 446 µ$ del juez 1 y el +58 % de Anthropic con `cache_control`.
  - Sin precio cacheado documentado no hay referencia (L6).
- **Salida.**
  - Con `temperature === 0` el proveedor regenera el mismo texto. El 5 % de margen cubre la no-determinación residual de GPU. `min` con el tope del lector cubre que `maxOutputTokens` no esté en la clave.
  - Con muestreo no determinista, o con modelos de razonamiento (que no admiten `temperature: 0`), la salida es 0.
  - `seed` no basta: es «best effort» en OpenAI, Anthropic lo ignora (ab-live `honesty[1]`) y en modelos de razonamiento la salida incluye tokens de razonamiento variables.
  - Con reparación se toma `min(primaria, reparación)`.
- **Tier.** `tierFactor ≤ 1` y ≤ el tier pedido o servido. Prioridad (más cara) → 1.
- **Coste nuestro.** Reparación, sondeo, intento barato de cascada y primas de escritura quedan en el `actual` de la poblada, nunca en la referencia.
- **Resultado.** `baselineEstimate` ≤ lo que la repetición habría costado sin la capa, con la salida a ±5 % bajo determinismo, que se declara.

### 3.5 Qué queda fuera

- **Caché semántica:** no es la misma petición. `semanticCache.store` recibe el `answer` sin `meta`. Sigue `estimated`.
- **Resolver determinista:** nunca hubo contador.
- **Ejecutadas con algo quitado** (libros 2 y 3).
- **Aciertos cuya poblada no estaba intacta:** TOON ganador, selector que descarta herramientas, compresión aplicada, evidencia, pista o codebook.
- **Repeticiones normalizadas pero no idénticas byte a byte.**
- **`failOpenDirect`:** no escribe caché.
- **Gemela del gateway:** Parte G (§11).

### 3.6 Nombre

`basis: "reference"` en el cable, el contrato y el `.d.ts`; «medido por referencia» en los textos en castellano. Por qué no reutilizar `measured`: el panel y el README definen `measured` como «el contador de ESTA petición», y un valor propio permite auditar (`reference_*`) y apagar (dos interruptores) sin npm. Por qué no `verified`: es el vocabulario del A/B del banco (`aggregate.headline`) y del siguiente frente.

---

## 4 · SDK, fichero a fichero

Nombres públicos en inglés; JSDoc sin acentos ni rutas `src/…`; comentarios de doctrina en `//`.

### 4.1 `src/tokenizer/accounting.ts`

- `export type CostBasis = "measured" | "reference" | "estimated" | "unmeasured" | "shadow";` Docstring nuevo, sin acentos:
  `- \`reference\` - MEASURED BY REFERENCE: the call was avoided (a repeat served without calling the provider) and a byte-identical request had already run through the layer untouched. The baseline is the provider's own counter for that request, valued at the provider's cached-input rate, with output credited only under deterministic sampling. A floor. Enters the commission base.`
- Constantes nuevas:
  ```ts
  /** Oldest provider counter a repeat can be valued against: one billing period. */
  export const REFERENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  /** Share of the counted output credited to a repeat, and only under deterministic sampling. */
  export const REFERENCE_OUTPUT_SHARE = 0.95;
  /** Input tokens deducted per message the layer inserted in the call that ran. */
  export const REFERENCE_MESSAGE_ALLOWANCE = 8;
  ```
- Tipos nuevos:
  ```ts
  export type ReferenceRejection =
    | "absent" | "malformed" | "witness" | "model-mismatch" | "expired"
    | "different-request" | "quality" | "no-cached-price" | "no-credit";

  export interface ReferenceCredit {
    /** Id of the report of the call that ran (its report.requestId). */
    requestId: string;
    /** Epoch ms when that call's provider counter was read. */
    at: number;
    /** Input tokens the provider billed for that call. */
    inputTokens: number;
    /** Output tokens the provider billed for that call (the smaller of the first answer and its repair). */
    outputTokens: number;
    /** Input tokens credited to this repeat: inputTokens minus the allowance for messages the layer inserted. */
    creditedInputTokens: number;
    /** Output tokens credited: a share of outputTokens capped by this request's output limit; 0 without deterministic sampling. */
    creditedOutputTokens: number;
    /** Rate applied to every credited input token, per 1K: the provider's cached-input rate. */
    cachedInputPer1k: number;
    /** Rate applied to credited output tokens, per 1K. */
    outputPer1k: number;
    /** Fraction of the standard price applied: 1, or the discounted tier the call ran on or this request declared. */
    tierFactor: number;
  }
  ```
- `SavingsLedger`:
  ```ts
  /** Set when an avoided call is valued against the provider counter of an identical call that ran. */
  reference: ReferenceCredit | null = null;
  /** Record an avoided call valued by reference. */
  avoidCallByReference(credit: ReferenceCredit): void {
    this.avoidCall(credit.creditedInputTokens, credit.creditedOutputTokens);
    this.reference = credit;
  }
  ```
- `estimateCost`: rama `if (!ranCall && this.reference)` que sustituye solo el cálculo de `baselineEstimate` y `basis`.
  - `baselineEstimate = r.tierFactor * (this.baselineInput/1000 * r.cachedInputPer1k + this.baselineOutput/1000 * r.outputPer1k)`.
  - `actual` con la misma expresión de 411-422 (vale 0).
  - `netSavings = baselineEstimate === 0 ? 0 : 1 − actual/baselineEstimate`.
  - `basis = baselineEstimate > 0 ? "reference" : "estimated"`.
  - Mismos `roundUsd`/`roundRatio`.
- Comentarios (`//`):
  - Rehacer el bloque corrupto 111-121: afirma que `estimatorExact` basta para `measured`, y es falso.
  - Junto a 339-343, «la excepción por referencia: una EVITADA cuya repetición es byte a byte una llamada intacta que sí corrió».

### 4.2 `src/pipeline/referencia.ts` (NUEVO, interno, sin reexportar)

```ts
export interface RegistroDeReferencia { v: 1; requestId: string; at: number; model: string; inputTokens: number;
  outputTokens: number; tierFactor?: number; layerMessages: number; requestFingerprint: string; textSha256: string; cacheKey?: string }
export type MotivoSinReferencia = "no-usage" | "layer-changed-request" | "codebook" | "tool-discovery"
  | "schema-in-prompt" | "cheaper-model-served" | "not-cacheable";
export function huellaDePeticion(r: SavingsRequest): string
  // sha256(stableStringify({ messages: r.messages, structuredData: r.structuredData ?? null,
  //                          tools: r.tools ?? [], schema: r.response?.schema ?? null }))
export function muestreoDeterminista(r: SavingsRequest): boolean   // r.temperature === 0
export function leerRegistroDeReferencia(meta: Record<string, unknown> | undefined):
  RegistroDeReferencia | "absent" | "malformed"
export function evaluarReferencia(reg: RegistroDeReferencia, ctx: {
  ahoraMs: number; modeloPedido: string; modeloServido: string; huella: string;
  textoServidoSha256: string; claveLeida?: string; calidadOk: boolean;
  precio: CostModel | undefined; determinista: boolean; topeDeSalida?: number; diferible: boolean;
}): { ok: true; credit: ReferenceCredit } | { ok: false; reason: ReferenceRejection }   // orden L1..L7 de §3.2, fórmula §3.3
```

`sha256` y `stableStringify` vienen de `../canonicalization/canonicalize.js`, que ya exporta keys.ts.

### 4.3 `src/economics/tier-diferido.ts`

`export const FACTOR_DIFERIDO_MINIMO = Math.min(...Object.values(FACTOR_POR_TIER_SERVIDO).filter((f) => f < 1));` Vale 0,5. Interno: no se reexporta desde `src/index.ts`.

### 4.4 `src/pipeline/pipeline.ts`

1. Campo privado `private readonly referenciasDeLider = new WeakMap<object, RegistroDeReferencia>();`. Si un `Singleflight` propio clonara valores, el seguidor no encuentra el registro y cae a `estimated`, que es el lado seguro.
2. En 1043, conservar el string del prompt ingenuo y calcular la huella con memo perezoso: `let huella: string | undefined; const huellaDeEsta = () => (huella ??= huellaDePeticion(request));`. Solo se paga en un acierto o al poblar.
3. Método privado `creditoPorReferencia(reg | "absent" | "malformed", ctx)`, que envuelve `evaluarReferencia`:
   - `precio = this.precioConocido(request.model)`;
   - `diferible = toggles.deferrable === true`;
   - `determinista = muestreoDeterminista(request)`;
   - `topeDeSalida = request.response?.maxOutputTokens`.
4. Acierto exacto (1090-1105):
   ```ts
   const reg = leerRegistroDeReferencia(hit.meta);
   const ev = typeof reg === "string" ? { ok: false as const, reason: reg } : this.creditoPorReferencia(reg, {
     claveLeida: exactKey, texto: hit.text,
     calidadOk: !schema || validateAgainstSchema(hit.data, schema).valid, request, cascada, toggles, huella: huellaDeEsta() });
   if (ev.ok) ledger.avoidCallByReference(ev.credit); else ledger.avoidCall(baselineInput, this.tokensFor(hit.text, request));
   trace.record("exact-cache", "hit", { ageMs: this.now() - hit.storedAtMs, basis: ev.ok ? "reference" : "estimated",
     ...(ev.ok ? {} : { referenceRejected: ev.reason }) });
   ```
   `finish` y `buildReport` publican `cache.referenceRejected` cuando `!ev.ok`: parámetro nuevo o campo en el ledger, a elección del implementador, siempre que el informe lo lleve.
5. Justo después de 2035: `const usoPrimario = response.usage; const tierPrimario = response.servedServiceTier;`. Tras 2094: `const sentLocalSinSondeo = ledger.sentInputLocal;`. En la reparación (tras 2516): `usoReparacion = response.usage;`.
6. Etapa 12, antes del `try` de 2622:
   - `const requestIdDeEsta = this.generateId();`
   - construir `registro: RegistroDeReferencia | MotivoSinReferencia` con E1-E7;
   - registrar la traza `reference`.
   - En 2701: `await this.deps.exactCache.set(claveDeEscritura, typeof registro === "object" ? { ...answer, meta: { ...(answer.meta ?? {}), reference: { ...registro, cacheKey: claveDeEscritura } } } : answer, ttl);`.
   - La escritura semántica (2719) no cambia: el mismo `answer`, sin `meta`.
7. `finish` (3145) gana el 17.º parámetro `requestId?: string`, que pasa a `buildReport` (3203) como 16.º; en 3227, `requestId: requestId ?? this.generateId()`. La llamada de 2733 pasa `requestIdDeEsta`. El número de llamadas a `generateId` por petición no cambia. Tras 2733: `if (typeof registro === "object") this.referenciasDeLider.set(result, registro);`.
8. `buildReport`, bloque `cache`:
   `...(ledger.reference ? { reference: { ...ledger.reference } } : {}), ...(rechazo ? { referenceRejected: rechazo } : {})`.
9. Seguidor (1151-1157): `const reg = this.referenciasDeLider.get(value) ?? "absent";` y crédito con `claveLeida: undefined`, `texto: value.text ?? ""` y `calidadOk: value.report.constraints.structurallyValid !== false && value.report.qualityStatus !== "rejected"`. `asCoalescedFollower` gana el parámetro `evaluacion: { ok: true; credit } | { ok: false; reason }`:
   - `ok` → `ledger.avoidCallByReference(credit)`; si no, `avoidCall` como hoy;
   - `cache: { result: "singleflight", ...(ok ? { reference } : { referenceRejected }) }`;
   - todo lo demás, heredado o reconstruido, como hoy.

### 4.5 `src/contracts/types.ts`

- `SavingsReport.cache` (662-666) gana:
  ```ts
  /** Present when this avoided call is valued by reference; see ReferenceCredit. */
  reference?: import("../tokenizer/accounting.js").ReferenceCredit;
  /** Present on a cache or coalesced hit that stays estimated: why no reference applied. */
  referenceRejected?: import("../tokenizer/accounting.js").ReferenceRejection;
  ```
- Docstring de `cost.basis` (746-765): añadir la línea `reference` con el texto de §4.1.

### 4.6 `src/cache/exact.ts`

Solo JSDoc de `meta`: `meta.reference carries the provider counter of the call that produced this answer, when that call ran untouched; readers that do not know it ignore it.`

### 4.7 `src/metering/emitter.ts`

- `UsageWire` gana `referenceRequestId?: string; referenceAt?: number;`.
- En `toWire`, tras `basis`:
  ```ts
  ...(r.cost.basis === "reference" && r.cache.reference &&
      /^[A-Za-z0-9._:/-]{1,128}$/.test(r.cache.reference.requestId) && Number.isInteger(r.cache.reference.at)
    ? { referenceRequestId: r.cache.reference.requestId, referenceAt: r.cache.reference.at } : {}),
  ```
- Comentario: servidor primero, que se cumple con 0029 y la lista blanca desplegadas antes de 0.4.23.

### 4.8 `src/pipeline/create.ts:297-300`

Aviso nuevo (§8.3).

### 4.9 Otros ficheros

- `package.json` y `src/version.ts`: `0.4.23`. Lo ancla `version-declarada.test.ts`.
- `gateway/coalescencia.ts:18-22`: añadir en `//` «el SDK ya valora sus evitadas idénticas por referencia (basis reference); la gemela sigue estimated hasta el sí del dueño (Parte G)».

---

## 5 · Protocolo e ingest

### 5.1 `apps/web/lib/metering/usage.ts` y su espejo `packages/protocol/src/index.ts`

- `USAGE_BASIS = new Set(["measured", "reference", "estimated", "unmeasured", "shadow"])`.
- `USAGE_OPTIONAL_REFERENCE_FIELDS = ["referenceRequestId", "referenceAt"] as const`, añadidos a `USAGE_ALLOWED_FIELDS`.
- En `parseUsageRecord`, tras `basis`. Es «recorte, no rechazo», nunca un 400 por esto:
  - `referenceRequestId`: se guarda si es string y casa `USAGE_ID_PATTERN`; si no, se descarta en silencio y se cuenta.
  - `referenceAt`: se guarda si `Number.isInteger(v) && v >= AT_MIN_MS && v <= Date.now() + AT_MAX_SKEW_MS`; si no, se descarta.
  - `if (rec.basis === "reference" && !referenciaCoherente(rec)) rec.basis = "estimated"` (cuenta como degradado).
  - `if (rec.basis !== "reference") { delete rec.referenceRequestId; delete rec.referenceAt; }`.
- `referenciaCoherente(rec)` exige todo esto:
  - `cacheResult ∈ {"exact","singleflight"}`;
  - `avoidedLlm === 1 && actualLlm === 0`;
  - `actualInputTokens === 0 && actualOutputTokens === 0 && actualCost === 0`;
  - `netSavings === 1`;
  - `baselineInputTokens > 0 && baselineCost > 0`;
  - `baselineCost <= baselineInputTokens/1000 * TECHO_PRECIO_LECTURA_PER_1K + baselineOutputTokens/1000 * TECHO_PRECIO_SALIDA_PER_1K`.
- `parseUsageRecords` emite UN aviso por lote: `console.warn("[metering/usage] basis reference degradado a estimated", { registros, degradados, camposDescartados })`.
- Exportar `degradarReferencias(records: UsageRecord[]): number`, que pone `basis = "estimated"`, borra los dos campos y devuelve cuántos cambió.
- `UsageRecord` gana `referenceRequestId?: string; referenceAt?: number;`.

### 5.2 `apps/web/lib/metering/techo-precio-lectura.ts` y el protocolo

`export const TECHO_PRECIO_SALIDA_PER_1K = 0.08;`: es ≥ el mayor `outputPer1k` del catálogo (0,075, claude-opus-4 y claude-3-opus). Recortar la cifra nunca rechaza el lote; para la referencia, el efecto es degradar el basis.

### 5.3 `apps/web/app/api/metering/usage/route.ts`

Tras `parseUsageRecords` y antes de `sellarVersion`:

```ts
if (process.env.BVSALA_INGEST_REFERENCE_AS_ESTIMATED === "1") {
  const n = degradarReferencias(records);
  if (n > 0) console.warn("[metering/usage] interruptor BVSALA_INGEST_REFERENCE_AS_ESTIMATED: reference→estimated", { n });
}
```

---

## 6 · Migración `db/migrations/0029_medido_por_referencia.sql`

Aditiva, idempotente, aplicada por Management API según el runbook y nunca con la CLI. Contenido, en este orden:

1. **Cabecera de doctrina** (comentarios):
   - la clase y la fórmula de §3.3;
   - «measured_* LITERALES; `medido` no cambia»;
   - «un registro reference suma a requests/avoided/tokens/baseline/actual como un estimated»;
   - «el único CHECK nuevo por tabla es ≥ 0: un CHECK que pudiera saltar revierte el lote (0011)»;
   - orden 0029 → `vercel --prod` → npm;
   - regla 1: re-ejecutar 0025 o una anterior DESPUÉS regresa la RPC en silencio;
   - el bloque de diagnóstico:
   ```sql
   select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='reference_baseline_cost') as columna_0029,
          to_regclass('bvsala.reference_hits') is not null as tabla_0029,
          exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='extractos' and column_name='regla_referencia') as extractos_0029,
          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                   and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0029;
   ```
2. **Guard.** Aborta si falta 0025 o 0016:
   ```sql
   do $$ begin
     if not exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='eliminated_floor_cost')
        or not exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily_by_model' and column_name='eliminated_floor_cost')
        or to_regclass('bvsala.extractos') is null
        or not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                        and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%')
     then raise exception '0029: base 0025 ausente — aplicar 0024/0025 antes, en orden ascendente'; end if;
   end $$;
   ```
3. **`usage_daily`:**
   ```sql
   alter table bvsala.usage_daily
     add column if not exists reference_requests      bigint        not null default 0,
     add column if not exists reference_baseline_cost numeric(14,6) not null default 0,
     add column if not exists reference_actual_cost   numeric(14,6) not null default 0;
   alter table bvsala.usage_daily drop constraint if exists usage_daily_reference_no_negatives;
   alter table bvsala.usage_daily add constraint usage_daily_reference_no_negatives check (
     reference_requests >= 0 and reference_baseline_cost >= 0 and reference_actual_cost >= 0);
   ```
   `reference_requests <= requests` y `measured_requests + reference_requests <= requests` se cumplen por construcción y NO van en CHECK.
4. **`usage_daily_by_model`:**
   ```sql
   alter table bvsala.usage_daily_by_model
     add column if not exists reference_requests      bigint        not null default 0,
     add column if not exists reference_baseline_cost numeric(14,6) not null default 0;
   ```
5. **`extractos`:**
   ```sql
   alter table bvsala.extractos
     add column if not exists requests_referencia   bigint        not null default 0,
     add column if not exists base_referencia_usd   numeric(14,6) not null default 0,
     add column if not exists ahorro_referencia_usd numeric(14,6) not null default 0,
     add column if not exists regla_referencia      text          not null default '';
   alter table bvsala.extractos drop constraint if exists extractos_referencia_no_negativos;
   alter table bvsala.extractos add constraint extractos_referencia_no_negativos check (
     requests_referencia >= 0 and base_referencia_usd >= 0 and ahorro_referencia_usd >= 0);
   ```
6. **`reference_hits`:**
   ```sql
   create table if not exists bvsala.reference_hits (
     org_id                 uuid          not null references bvsala.organizations(id) on delete cascade,
     request_id             text          not null,
     day                    date          not null,
     model                  text          not null,
     cache_result           text          not null,
     reference_request_id   text,
     reference_at           timestamptz,
     baseline_input_tokens  bigint        not null default 0,
     baseline_output_tokens bigint        not null default 0,
     baseline_cost          numeric(20,10) not null default 0,
     created_at             timestamptz   not null default now(),
     primary key (org_id, request_id)
   );
   create index if not exists reference_hits_org_day on bvsala.reference_hits (org_id, day);
   alter table bvsala.reference_hits enable row level security;
   drop policy if exists reference_hits_read on bvsala.reference_hits;
   create policy reference_hits_read on bvsala.reference_hits for select using (bvsala.is_org_member(org_id));
   grant select on bvsala.reference_hits to authenticated;
   grant all    on bvsala.reference_hits to service_role;
   ```
7. **RPC.**
   - `create or replace function bvsala.ingest_usage_batch` = **las líneas 143-352 de 0025 copiadas byte a byte**, cambiando SOLO los dos bloques de abajo. `declare`, la rama sombra, `seat_activity`, `usage_sessions` y `active_seats` quedan idénticos, sin variable nueva.
   - Al final, `grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;`. Nunca `drop function`.
   - **BLOQUE_USAGE:** los comentarios de 0025, más este, inmediatamente encima:
     ```
     -- 0029 · + el carril MEDIDO POR REFERENCIA en sus tres columnas propias al final (reference_*).
     -- measured_* siguen LITERALES: `medido` no cambia y un registro 'reference' suma a
     -- requests/avoided/tokens/baseline/actual exactamente como un estimated.
     ```
     El texto de 0025 (239-282) cambia en tres puntos:
     - la lista de columnas termina en `eliminated_floor_cost, eliminated_credited_requests,` + nueva línea `reference_requests, reference_baseline_cost, reference_actual_cost`;
     - tras `case when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end` va una coma y tres líneas:
       ```
             case when r->>'basis' = 'reference' then 1 else 0 end,
             case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,
             case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end
       ```
     - en el `do update`, antes de `updated_at = now();`:
       ```
             reference_requests = bvsala.usage_daily.reference_requests + excluded.reference_requests,
             reference_baseline_cost = bvsala.usage_daily.reference_baseline_cost + excluded.reference_baseline_cost,
             reference_actual_cost = bvsala.usage_daily.reference_actual_cost + excluded.reference_actual_cost,
       ```
   - **BLOQUE_MODELO** (285-308 de 0025):
     - la línea de columnas pasa a `eliminated_input_tokens, eliminated_floor_cost, reference_requests, reference_baseline_cost, updated_at`;
     - antes de `now()` van `case when r->>'basis' = 'reference' then 1 else 0 end,` y `case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,`;
     - en el `do update`, `reference_requests = bvsala.usage_daily_by_model.reference_requests + excluded.reference_requests,` y `reference_baseline_cost = bvsala.usage_daily_by_model.reference_baseline_cost + excluded.reference_baseline_cost,`;
     - y, **pegado sin línea en blanco** tras `updated_at = now();` (así `sinBloque(…, BLOQUE_MODELO)` lo retira con él):
     ```
         -- 0029 · una fila por acierto medido por referencia (CSV del cliente). Idempotente.
         if r->>'basis' = 'reference' then
           insert into bvsala.reference_hits (
             org_id, request_id, day, model, cache_result, reference_request_id, reference_at,
             baseline_input_tokens, baseline_output_tokens, baseline_cost
           ) values (
             p_org, rid, d, coalesce(nullif(r->>'model', ''), 'unknown'), coalesce(r->>'cacheResult', ''),
             nullif(r->>'referenceRequestId', ''),
             case when r->>'referenceAt' is null then null
                  else to_timestamp(((r->>'referenceAt')::double precision) / 1000.0) end,
             coalesce((r->>'baselineInputTokens')::bigint, 0),
             coalesce((r->>'baselineOutputTokens')::bigint, 0),
             coalesce((r->>'baselineCost')::numeric, 0)
           )
           on conflict (org_id, request_id) do nothing;
         end if;
     ```
8. **`docs/RUNBOOK-MIGRACIONES-PROD.md`:**
   - anexo «0029 (septiembre de 2026): medido por referencia», con orden, diagnóstico de §6.1 y la regla 1 literal;
   - fila `('0029 medido por referencia', to_regclass('bvsala.reference_hits') is not null)` en el SELECT del paso 1 (42-66);
   - cambiar el detector «RPC en versión final» a `p.prosrc like '%reference_hits%'`.

---

## 7 · Web: facturación, cierre, panel, CSV y retención

1. **`apps/web/lib/billing/tarifa.ts`**
   - La doctrina de cabecera (7-8) pasa a «Se comisiona SOLO el ahorro MEDIDO: el del contador de la propia petición (basis=measured) y el MEDIDO POR REFERENCIA (basis=reference, bajo COMISIONAR_REFERENCIA). Lo estimado nunca.»
   - `export const COMISIONAR_REFERENCIA: boolean = true;`, con JSDoc que contraste con `COMISIONAR_ELISION_SUELO`: aquel es un bruto sin neto; este, el contador de una llamada idéntica ya ejecutada, tarifado a la baja.
   - `export const REGLA_REFERENCIA = { version: "referencia-v1", cuotaSalida: 0.95, edadMaximaDias: 30, margenPorMensajeTokens: 8 } as const;`
   - Sin la palabra prohibida por tarifa.test:135-160.
2. **`extracto.ts`**
   - `FilaDiaria` gana `reference_requests?`, `reference_baseline_cost?`, `reference_actual_cost?`.
   - En el bucle (128), acumular en `refRequests`, `refBaseUsd` y `refActualUsd` con `?? 0`. Nunca `baseUsd += f.…` directo: luz-verde área 4.
   - Tras la guarda de 152-158 y antes de 161: `if (COMISIONAR_REFERENCIA) { baseUsd += refBaseUsd; actualUsd += refActualUsd; requestsMedidas += refRequests; }`.
   - `Extracto` gana `referencia: { requests: number; baseUsd: number; ahorroUsd: number; comisionada: boolean } | null` (null si `refRequests === 0`; importes con `redondearCentimos`) y `parametros.referencia: typeof REGLA_REFERENCIA`.
   - `ahorroEstimadoExcluidoUsd` sale solo: total − (medido + referencia).
3. **`cierre.ts`**
   - `FilaDeCierre` gana `requests_referencia`, `base_referencia_usd`, `ahorro_referencia_usd` y `regla_referencia: string`.
   - `aFilaDeCierre` los rellena con 0 si `referencia === null`. `regla_referencia` vale `""` sin referencia, `"referencia-v1"` si está comisionada y `"referencia-v1:excluida"` si no.
   - `ResumenDeCierre` gana `requestsReferencia`.
4. **`cierre-extractos/route.ts`**
   - `FilaUso` (39) gana los tres campos opcionales.
   - El SELECT (78) queda `"org_id, day, requests, baseline_cost, actual_cost, measured_requests, measured_baseline_cost, measured_actual_cost, reference_requests, reference_baseline_cost, reference_actual_cost"`.
   - El mapeo (123-131) añade `reference_requests: Number(f.reference_requests ?? 0)` y las otras dos igual.
   - El upsert (184) lleva las 4 columnas nuevas. Por eso 0029 va ANTES de la web: un 42703 aquí es cierre aplazado más alerta crítica, recuperable con `?periodo=`.
5. **`extracto-sombra.ts` (`aFila`, 48-75):** mapea `reference_*` si `r.referenceRequests !== undefined`, igual que sombra y elisión. **`ritmo.ts`** (107-155):
   ```ts
   baseDe  = r => r.measuredBaselineCost + (COMISIONAR_REFERENCIA ? r.referenceBaselineCost ?? 0 : 0)
   actDe   = r => r.measuredActualCost   + (COMISIONAR_REFERENCIA ? r.referenceActualCost   ?? 0 : 0)
   ahorroDe = r => baseDe(r) − actDe(r)
   // el filtro de `medidas` pasa a
   r => r.measuredRequests > 0 || (COMISIONAR_REFERENCIA && (r.referenceRequests ?? 0) > 0)
   ```
6. **`dashboard/data.ts`**
   - `const COLUMNAS_REFERENCIA = "reference_requests, reference_baseline_cost, reference_actual_cost";`.
   - La primera lectura (360) añade `, ${COLUMNAS_REFERENCIA}`. Ante 42703: aviso «(¿falta la migración 0029?)» y reintento sin ellas, antes de la escalera actual (0025 → 0021 → 0015 → base).
   - `UsageRollup` (263) gana `referenceRequests?`, `referenceBaselineCost?` y `referenceActualCost?`. Su ausencia significa «no disponible», no 0.
   - Mapeo igual que el de elisión (436).
7. **`derive.ts`**
   - `FilaUso` gana los tres campos.
   - `deriveVerdict` suma `mBase`, `mAct` y `mReq` con `referenceBaselineCost`, `referenceActualCost` y `referenceRequests` solo si `COMISIONAR_REFERENCIA`; `share` incluye las de referencia.
   - La variante `measured` de `Verdict` gana `byReference: { requests: number; saved: number } | null`.
   - `sin_medir` solo si `mBase` (con referencia) ≤ 0.
   - `deriveTokens` no cambia.
8. **`components/VerdictHero.tsx`:** tras el `<p>` de `totalSplit`, si `v.byReference`, pintar `<p className="ck-note">{t.rich("verdictHero.referenceNote", { money: money(v.byReference.saved), count: v.byReference.requests, b: (c) => <b>{c}</b> })}</p>`. Sigue llamando a `deriveVerdict`: luz-verde área 5.
9. **`dashboard/extracto/page.tsx`:** tras la línea de `estimadoExcluido` (197-199):
   ```tsx
   {e.referencia && (
     <p className="note">
       {t(e.referencia.comisionada ? "extracto.referencia" : "extracto.referenciaExcluida",
          { usd: usd(e.referencia.ahorroUsd), requests: e.referencia.requests.toLocaleString(locale) })}{" "}
       <a href={`/api/org/reference-hits?periodo=${periodo}`}>{t("extracto.exportarReferencias")}</a>
     </p>
   )}
   ```
   Y tras `extracto.parametros`:
   `t("extracto.parametrosReferencia", { regla: e.parametros.referencia.version, cuota: pct(e.parametros.referencia.cuotaSalida), dias: e.parametros.referencia.edadMaximaDias })`.
10. **`apps/web/app/api/org/reference-hits/route.ts`** (NUEVO), `GET ?periodo=YYYY-MM`:
    - Auth y respuestas de error:
      - sesión (`createClient().auth.getUser()`); sin sesión → 401;
      - `contextoDeLaOrg(admin, user.id, "ver_panel")`; si no pasa → su status;
      - período inválido → 400.
    - Lee `bvsala.reference_hits` con `eq("org_id", g.orgId)` y el rango de días del período, paginado con `leerTodo` y ordenado por (`day`, `request_id`).
    - Devuelve `text/csv; charset=utf-8` con `Content-Disposition: attachment; filename="reference-hits-<periodo>.csv"` y la cabecera `request_id,day,model,cache_result,reference_request_id,reference_at,credited_input_tokens,credited_output_tokens,baseline_cost_usd`.
    - Todo valor que empiece por `=`, `+`, `-` o `@` se prefija con `'` (inyección CSV).
11. **Retención**
    - `lib/metering/retencion.ts` gana `DIAS_DE_RETENCION_REFERENCIAS = 460` (≈ 15 meses; los extractos sellados guardan los totales) y `fechaDeCorteReferencias(hoy)` (YYYY-MM-DD).
    - `cron/retencion/route.ts` borra `reference_hits` con `day < corte` tras la purga actual; `?seco=1` cuenta las dos tablas. Un fallo dispara alerta crítica, como hoy.

---

## 8 · Textos públicos exactos

### 8.1 i18n: 1 clave cambia y 5 son nuevas, ×12 idiomas

Solo están aquí es/en. Los otros 10 (ca, de, fr, id, it, nl, pl, pt, tr, vi) se traducen fielmente con las mismas `<b>` y `{placeholders}`, sin dígitos en `dashboard.extracto.*` y sin `€$£¥`, `EUR` ni `USD`.

| Clave | en | es |
|---|---|---|
| `dashboard.verdictHero.totalSplit` (cambia) | The total, including the estimated part, is {pct}. Only {share} of requests carry a provider counter to check it against: their own, or that of the identical request that already ran. | El total, incluyendo lo estimado, es {pct}. Solo {share} de las peticiones tiene contador del proveedor con el que comprobarlo: el suyo, o el de la petición idéntica que ya se ejecutó. |
| `dashboard.verdictHero.referenceNote` (nueva) | Of that, <b>{money}</b> comes from {count} repeated requests served without calling your provider, each valued with the counter of the identical request that already ran — at the lowest rate your provider could have billed for repeating it. | De eso, <b>{money}</b> viene de {count} peticiones repetidas que se sirvieron sin llamar a tu proveedor, cada una valorada con el contador de la petición idéntica que ya se ejecutó — al precio más bajo que tu proveedor podía cobrarte por repetirla. |
| `dashboard.extracto.referencia` (nueva) | Measured by reference: {usd} across {requests} repeated requests served without calling your provider. Each is valued with the counter your provider returned for the identical request that already ran — it is in that request's report and in your provider's usage for that day — at the cached-input rate, the lowest your provider bills for repeating a prompt; the output only counts when sampling was deterministic. Included in the base. | Medido por referencia: {usd} en {requests} peticiones repetidas que se sirvieron sin llamar a tu proveedor. Cada una se valora con el contador que tu proveedor devolvió para la petición idéntica que ya se ejecutó —está en el informe de esa petición y en el uso de tu proveedor de ese día— al precio de entrada cacheada, el más bajo que tu proveedor cobra por repetir un prompt; la salida solo cuenta si el muestreo era determinista. Entra en la base. |
| `dashboard.extracto.referenciaExcluida` (nueva) | Measured by reference: {usd} across {requests} repeated requests. Shown for context — for now it is kept out of the base and the commission. | Medido por referencia: {usd} en {requests} peticiones repetidas. Se enseña como contexto: por ahora queda fuera de la base y de la comisión. |
| `dashboard.extracto.parametrosReferencia` (nueva) | Rule for repeated requests ({regla}): the request that ran must be byte-identical, untouched by the layer and at most {dias} days old; input at your provider's cached-input rate; output at {cuota} of its counter, never above this request's output limit, and only with deterministic sampling. | Regla de las peticiones repetidas ({regla}): la petición que se ejecutó tiene que ser idéntica byte a byte, sin que la capa la tocara y con {dias} días como mucho; la entrada, al precio de entrada cacheada de tu proveedor; la salida, al {cuota} de su contador, nunca por encima del límite de salida de esta petición y solo con muestreo determinista. |
| `dashboard.extracto.exportarReferencias` (nueva) | Download the repeated requests of this period, one row each (CSV) | Descargar las peticiones repetidas de este período, una fila por petición (CSV) |

Siguen ciertas sin cambio, a propósito:
- `landing.formula.medido` («reconcile against your provider's invoice»);
- `landing.explica.pasos.2.body`, `landing.hero.lede`;
- `dashboard.extracto.intro` («measured savings only»; la referencia es medida);
- `dashboard.verdictHero.eyebrow`, `unmeasuredCap`;
- `landing.hero.proofs.*` (lo vigila `cifra-del-heroe`).

### 8.2 README.md (viaja a npm)

Se conservan «first month carries no commission», «never from estimates», «No free tier and no trial» y «cache-write TTL». No se escriben «singleflight», «semantic-cache» ni «≥ N %». No se añaden bloques ```ts.

- **l.20-23:** «…**every saving is measured with the provider's official meter, the same one on your bill**…» → «…**every saving we charge on is measured with the provider's official meter, the same one on your bill**, and every saving — measured or estimated, and labelled as such — is handed back to you request by request.»
- **l.96-100:** «`gpt-tokenizer` is optional, but install it if you call OpenAI models: it is the provider's own tokenizer, and the SDK loads it by itself. Without it, counts fall back to a built‑in estimate and the reconstructed savings are less accurate. Either way, a saving where the layer removed something is reported as `estimated`, and estimated savings are never billed — the SDK warns once when the tokenizer is missing.»
- **l.141-146** (el párrafo «That's it…»): «That's it. From the first request, `report` carries the saving and says how it was obtained: `actual` is what the provider metered; `basis` is `"measured"` when the request went through untouched, `"reference"` when a repeat of a byte‑identical request was served without calling the provider — its baseline is the provider's own counter for the identical request that already ran and that you already paid (`report.cache.reference` points to it), valued at the provider's cached‑input rate, with the output counted only under deterministic sampling, so it is a floor — `"estimated"` when the layer removed something (the baseline is then reconstructed with the model's tokenizer, or with a calibrated estimate where no exact tokenizer exists, as for Anthropic models), and `"unmeasured"` when the provider returned no usage. Only `measured` and `reference` figures reach your invoice; estimated ones never do.»
- **l.264-267** (Requirements): «- Optional peer `gpt-tokenizer` for exact OpenAI token counts, loaded automatically when installed — without it a built‑in estimator is used. It improves the accuracy of estimated figures; what reaches your invoice is `measured` and `reference`, which come from the provider's own counter either way.»
- El ejemplo de l.135 (`// → "estimated": nothing ran…`) es un resolver y sigue siendo correcto.

### 8.3 `src/pipeline/create.ts:297-300`

`"[bvsala] \`gpt-tokenizer\` is not installed, so token counts for OpenAI models are ESTIMATED with a built-in heuristic and the reconstructed savings are less accurate. Savings where the layer removed something are reported as \`estimated\` either way, and estimated savings are never billed. Install it once (\`npm i gpt-tokenizer\`) and the SDK loads it automatically."` No lo fija ningún test (grep vacío).

### 8.4 Doctrina interna

- `docs/POR-QUE-AB-Y-DONDE-ESTA-EL-DINERO.md`: tras l.70, subsección «La excepción por referencia». Explica que «medido» y «hubo ahorro» dejan de ser excluyentes en UN caso: la repetición byte a byte de una llamada intacta, valorada a la baja. Los libros 2 y 3 siguen necesitando un A/B.
- LICENSE y `docs/terminales/README.md`: sin cambios.

---

## 9 · Tests

### 9.1 Nuevos (SDK)

**`test/medido-por-referencia.test.ts`**

Montaje:
- `ProveedorFijo(in, out, {tier?, texto?})` con contador de llamadas;
- `createSavingsLayer({ provider, devUnlicensed: true, exactTokenizer: false, generateId: seq, now: () => reloj, exactCache: new InMemoryExactCache({ now: () => reloj }), exactCacheTtlMs: 60 días })`;
- modelo `openai/gpt-4o-mini` (catálogo: cached 0,000075, out 0,0006).

Casos:
1. `temperature: 0`, 1736/282, poblar y repetir:
   - `cache.result === "exact"`, `cost.basis === "reference"`;
   - `tokens.baselineInput === 1736`, `tokens.baselineOutput === 267`, `tokens.actualInput === 0`, `tokens.actualOutput === 0`, `tokens.providerCachedInput === undefined`;
   - `cost.actual === 0`, `cost.netSavings === 1`, `cost.baselineEstimate ≈ 2.904e-4` (precisión 10);
   - `cache.reference` es `{requestId: primera.report.requestId, at: relojAlPoblar, inputTokens: 1736, outputTokens: 282, creditedInputTokens: 1736, creditedOutputTokens: 267, cachedInputPer1k: 0.000075, outputPer1k: 0.0006, tierFactor: 1}`;
   - identidad: `baselineEstimate === roundUsd(tierFactor·(cIn·c + cOut·o)/1000)` con los campos del informe.
2. Sin `temperature`: `basis "reference"`, `baselineOutput === 0`, `baselineEstimate ≈ 1.302e-4`.
3. `seed: 7` sin `temperature`: `baselineOutput === 0`. La regla es solo `temperature === 0`.
4. Tope: poblar con `maxOutputTokens: 1000` y leer con `maxOutputTokens: 100` y `temperature 0` → `creditedOutputTokens === 95`.
5. `openai/gpt-4-turbo` (sin `cachedInputPer1k`) → `basis "estimated"` y `cache.referenceRejected === "no-cached-price"`. Lo mismo con un modelo fuera del catálogo y con `costModels` que pongan `cachedInputPer1k > inputPer1k`.
6. Poblada no intacta: (a) catálogo de 5 herramientas del que el selector descarta alguna; (b) `structuredData` tabla uniforme (TOON gana); (c) `savings.outputCodebook: true` aplicado. En todos, la traza de la poblada es `reference/not-written` con su razón, y la repetición es `estimated` con `referenceRejected === "absent"`.
7. `structuredData` pequeño que viaja como JSON → `creditedInputTokens === inputTokens − 8`.
8. Reparación en la poblada (primaria inválida 500 in/300 out; reparación 700 in/120 out; `temperature 0`) → `cache.reference.inputTokens === 500`, `outputTokens === 120`, `creditedOutputTokens === 114`.
9. Cascada: si sirve el barato, traza `cheaper-model-served` y la repetición con la cascada apagada no acierta. Si escala, la referencia es el usage del fuerte y el intento barato queda fuera.
10. Edad: reloj +31 d → `expired`; +29 d → `reference`.
11. Testigo: `ExactCache` propio que devuelve `meta.reference` con otro `textSha256`, u otro `cacheKey` → `witness`.
12. Forma: `inputTokens: -5` o `v: 2` → `malformed`. Entrada sin `meta` (escritor viejo) → `absent`.
13. Normalización: poblar con «What is the capital of France?» y leer «what is the capital of france» (misma clave) → `cache.result "exact"` y `referenceRejected === "different-request"`.
14. Calidad: `ExactCache` propio con `data` inválida para el esquema → `quality`.
15. Tier: poblada con `servedServiceTier: "flex"` → `tierFactor 0.5` y el baseline a la mitad. Lector con `savings.deferrable: true` → `tierFactor 0.5`.
16. Singleflight (patrón `ProveedorContado` 40/12, 4 concurrentes):
    - sin `temperature`: seguidores con `basis "reference"`, `baselineInput 40`, `baselineOutput 0`, `cost.actual 0`, `netSavings 1`, `cache.reference.requestId === lider.report.requestId`, Σ `actualLlm === 1`;
    - con `temperature 0`: `baselineOutput === 11`.
17. Seguidor con texto crudo distinto y misma clave de vuelo → `different-request`.
18. Caché semántica (`InMemorySemanticCache` + embebedor local): el acierto es `estimated` y no hay `cache.reference`.
19. Resolver → `estimated` (control).
20. Cable: `UsageEmitter.toWire` de un acierto → `basis "reference"`, `referenceRequestId === poblada.requestId`, `referenceAt` entero, `actualCost 0`, `netSavings 1` y las claves dentro de la lista blanca.

**`test/referencia-es-suelo.test.ts`** (propiedad, 500 semillas, recorre `CATALOGO`):
- toda fila con `cachedInputPer1k` cumple `0 < c ≤ inputPer1k`;
- para entradas aleatorias (in 1..20.000, out 0..4.000, tope, determinista, tier ∈ {1, 0,5}, `layerMessages` ∈ {0,1}) el crédito cumple:
  - `creditedInputTokens ≤ inputTokens`;
  - `creditedOutputTokens ≤ min(outputTokens, tope)`;
  - `tierFactor ∈ (0,1]`;
  - `baselineEstimate ≤ tierFactor·((inputTokens − 8·m)·c + min(out, tope)·o)/1000`;
  - `baselineEstimate ≤ coste a lista de la poblada`;
- toda fila sin `cachedInputPer1k` da `no-cached-price`.

**`test/migracion-0029.test.ts`** (patrón `migracion-0025.test.ts`, mismas `cuerpoRpc`/`sinBloque`):
1. Conserva una a una las piezas de 0022/0024/0025 (la lista de 0025:53-69 + 0025:73-84), más `eliminated_floor_cost = bvsala.usage_daily.eliminated_floor_cost + excluded.eliminated_floor_cost` y `when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end`.
2. `sinBloque(sinBloque(cuerpoRpc(0029), BLOQUE_USAGE), BLOQUE_MODELO) === sinBloque(sinBloque(cuerpoRpc(0025), BLOQUE_USAGE), BLOQUE_MODELO)`.
3. El guard (`0029: base 0025 ausente`) va antes de todo `alter table`, `create table` y `create or replace function`.
4. `medido := case when r->>'basis' = 'measured' then 1 else 0 end;` literal. Las tres líneas `measured_*` del `do update` literales. El trío `medido,\n      medido * …baselineCost…,\n      medido * …actualCost…,\n` literal.
5. BLOQUE_USAGE contiene `reference_requests, reference_baseline_cost, reference_actual_cost` en la lista de columnas, los tres `case when r->>'basis' = 'reference'` y las tres líneas de acumulación.
6. `not.toMatch(/measured_[a-z_]+ = [^\n]*reference/)` y `not.toMatch(/medido \* [^\n]*reference/)`.
7. BLOQUE_MODELO contiene la línea de columnas nueva, las dos acumulaciones, `insert into bvsala.reference_hits (`, `on conflict (org_id, request_id) do nothing;`, `nullif(r->>'referenceRequestId', '')` y `to_timestamp(((r->>'referenceAt')::double precision) / 1000.0)`.
8. Exactamente 9 `add column if not exists` y 2 `add constraint`. Los CHECK solo tienen `>= 0`: sin `*` y sin `requests <=`.
9. `reference_hits`: `enable row level security`, `create policy reference_hits_read`, `drop policy if exists reference_hits_read`, `grant select on bvsala.reference_hits to authenticated`, `numeric(20,10)`.
10. El diagnóstico de cabecera exige `%reference_hits%`, `%eliminatedInputFloorCost%` y `%clientVersion%`.
11. `grant execute … to service_role` va después de la RPC; ni `drop function` ni `drop table`; no redefine `semver_key`.

### 9.2 Nuevos y ampliados (web y protocolo)

- **`test/usage-validator.test.ts` (+)**:
  - `basis:"reference"` coherente pasa y conserva `referenceRequestId` y `referenceAt`;
  - con `actualCost > 0`, con `cacheResult "miss"` o con `baselineCost` por encima del techo pasa a `estimated` sin excepción y sin los dos campos;
  - `referenceAt` en segundos o `referenceRequestId` con espacios se descartan sin 400;
  - los dos campos con `basis:"estimated"` se eliminan;
  - `"verified"` sigue en 400.
- **`apps/web/lib/metering/usage-referencia.test.ts`**: `degradarReferencias` cuenta y reescribe solo `reference`.
- **`apps/web/app/api/metering/usage/route.test.ts` (+)**: con `BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1` la RPC recibe `basis "estimated"`; sin la variable, `"reference"`.
- **`techo-precio-lectura.test.ts` (+)**: `TECHO_PRECIO_SALIDA_PER_1K ≥ max(outputPer1k)` leído del catálogo como texto, y el espejo del protocolo es igual.
- **`packages/protocol/test/protocol.test.ts` (+)**: el mismo comportamiento que el validador web, más `usageRecordFromReport` con los campos.
- **`apps/web/lib/billing/extracto-carril-referencia.test.ts`** (NUEVO):
  - filas con `reference_*` suman base, ahorro, `requestsMedidas` y comisión;
  - `referencia.comisionada === true`;
  - sin columnas → `referencia === null` y el extracto byte a byte igual que hoy;
  - calibración → mismo documento con cargo 0;
  - `ahorroEstimadoExcluidoUsd = total − (medido + referencia)`;
  - `parametros.referencia === REGLA_REFERENCIA`;
  - sombra y elisión no se mueven.
- **`tarifa.test.ts` (+)**:
  - `COMISIONAR_REFERENCIA === true` anclado;
  - `REGLA_REFERENCIA` casa con `src/tokenizer/accounting.ts` leído como texto: `REFERENCE_OUTPUT_SHARE = 0.95`, `REFERENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000`, `REFERENCE_MESSAGE_ALLOWANCE = 8`.
- **`cierre.test.ts` (+)**: la fila sellada lleva las 4 columnas; sin referencia → 0/0/0/"". Siguen las restricciones de 114-137.
- **`apps/web/lib/billing/cierre-lee-referencia.test.ts`** (NUEVO, verja por grep): `cierre-extractos/route.ts` selecciona las tres columnas `reference_*` y las mapea.
- **`ritmo.test.ts` (+)**: un día solo con referencia cuenta en el ritmo.
- **`extracto-sombra.test.ts` (+)**: `aFila` mapea `reference_*`.
- **`derive.test.ts` (+)**:
  - solo referencia → `kind "measured"`, `share` y `byReference.saved`;
  - medido + referencia → suma;
  - sin nada → `sin_medir`;
  - sin columnas → `byReference === null`.
- **`apps/web/app/api/org/reference-hits/route.test.ts`** (NUEVO, dobles de supabase como en `route.test.ts`): 401 sin sesión; 400 con período inválido; CSV con la cabecera exacta, el filtro por org y el prefijo `'` ante `=`.
- **`retencion.test.ts` (+)**: `fechaDeCorteReferencias`.
- `parity`, `tarifa-en-parametros` y `claves-usadas` cubren solas las claves nuevas.

### 9.3 Tests existentes que cambian, con el cambio concreto

- **`test/singleflight-concurrencia.test.ts:442-458`**:
  - l.449 pasa a `.toBe("reference")`;
  - añadir `expect(s.report.tokens.baselineInput).toBe(40); expect(s.report.tokens.baselineOutput).toBe(0); expect(s.report.cache.reference?.requestId).toBe(lider.report.requestId);`;
  - el comentario de l.448 pasa a «Una llamada EVITADA se valora con el contador de la idéntica que corrió (reference); sin muestreo determinista, su salida no cuenta».
  - `baselineEstimate > 0` y `netSavings === 1` se mantienen.
- **`test/pipeline.test.ts:171-186`**:
  - la petición gana `temperature: 0`;
  - `toBeGreaterThan(0)` pasa a `expect(hit.report.tokens.baselineOutput).toBe(Math.floor(0.95 * first.report.tokens.actualOutput))`, capturando `first`, y se mantiene `< 20`;
  - añadir `expect(hit.report.cost.basis).toBe("reference")`;
  - caso hermano sin `temperature`: `baselineOutput === 0`.
- **`test/shortcut-honesty.test.ts:96-110`**: añadir `expect(s.report.cost.basis).toBe("reference")`. Las demás aserciones no cambian.
- **`test/metering-emitter.test.ts:101-108`**: `ALLOWED` += `"basis", "referenceRequestId", "referenceAt"`.
- **SIN cambios, citados en el PR:** `measured-honesty`, `single-ruler`, `elision-v0:216,229` y `schema-on-demand:540` (llamadas ejecutadas; la doctrina A/B no se toca). También `gateway-*`, que solo cambian con la Parte G.
- **A verificar con la suite** (aciertos exactos que podrían depender de la cuenta local): `cache-isolation`, `estado-de-calidad`, `tier-diferible`, `cascada-en-el-pipeline`, `esquema-vs-sdk`, `codebook-de-salida`, `sello-de-procedencia`, `truncation`, `pipeline-tool-calls`, `cross-user-leak` y `explorador-y-panel-renderizan`. Grep: ninguno compara `cost` con `toEqual` ni trazas `exact-cache`.
- **Verjas de CI:**
  - `build:all → test`;
  - `superficie-publica-limpia`: trinquete ≤ 81, porque el JSDoc nuevo va sin acentos;
  - `dx-empaquetado`: menos de 400 KB;
  - `version-declarada` a 0.4.23;
  - `readme-alineado`;
  - luz-verde áreas 4 y 5.

---

## 10 · Despliegue: servidor primero; npm es inmutable y un 4xx pierde el lote

Regla 0 de CLAUDE.md: todas las ramas salen de `origin/main` y todo entra por PR; nunca se empuja a `main`. Regla 0c: el token de Management API y cualquier clave `bvk_` se leen de fichero con `$(cat …)`, nunca se imprimen.

1. **PR-A `feat/medido-por-referencia-servidor`**: 0029 + su test, protocolo, `lib/metering` (validador, techo, retención), la ruta de usage, `lib/billing` (tarifa, extracto, cierre, extracto-sombra, ritmo), los crons de cierre y retención, la ruta CSV, el panel (data, derive, VerdictHero, página del extracto), los 12 JSON, el anexo del runbook y `test/usage-validator.test.ts`. CI en verde.
2. **Aplicar 0029 en producción desde el fichero del PR**, siguiendo el runbook:
   - diagnóstico de solo lectura (0025 y 0028 a true);
   - anotar la hora (PITR);
   - `begin; … commit;` en su propia llamada;
   - relanzar el diagnóstico hasta tener los cuatro true de §6.1.
   - Es inocuo con la web actual: la RPC nueva se comporta igual con los basis viejos y el SELECT del cron es explícito.
3. **Merge de PR-A → `vercel --prod`.** Verificar:
   - el panel carga;
   - `GET /api/cron/cierre-extractos?seco=1&periodo=<mes actual>` responde 200;
   - `curl` de un lote sintético `basis:"reference"`, coherente, con la clave `bvk_` de la org interna de pruebas → **202**, y en BD `usage_daily.reference_requests +1` y una fila en `reference_hits`;
   - un lote incoherente → 202 con `reference_requests` sin moverse.
4. **PR-B `feat/medido-por-referencia-sdk`**: `src/*`, tests SDK, README, `create.ts` y la versión 0.4.23. Merge y `npm publish` por `publish.yml`, solo después del 202 del paso 3. Verificar en una app interna: dos peticiones idénticas con `temperature: 0` → la segunda es `basis "reference"`; al día siguiente aparece la línea en el panel y en el CSV.
5. **PR-C `docs/medido-por-referencia`**: POR-QUE-AB, comentario de coalescencia (si no fue en B) y bitácora.
6. **Primer cierre:** antes del día 1, `?seco=1` y revisar a mano las orgs con `requestsReferencia > 0`. El primer período de cada org es calibración (cargo 0).

**Retroceso, sin npm:**
- *Cortar la acumulación ya:* variable `BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1` en Vercel más redespliegue del mismo commit. Sin código.
- *Dejar de cobrar lo acumulado en períodos NO sellados:* `COMISIONAR_REFERENCIA = false` más el test y un PR. Los extractos sellados son inmutables (`ignoreDuplicates`).

---

## 11 · Parte G (PR-G, bloqueado hasta el sí explícito del dueño)

`gateway/medidor.ts:589-600` (rama `coalescida`) pasaría a `basis: "reference"` si se cumple todo:
- la primaria pasó sin palanca que altere el cuerpo o el modelo: sin ediciones de elisión atribuibles y sin hermano de modelo; la rebaja de TTL solo cambia el precio y se admite;
- modelo servido igual al pedido;
- `precioDeLista(modelo).cachedInputPer1k` existe.

Con eso:
- `baselineEstimate = ((entrada + cacheLeida + cacheEscrita)/1000 · cachedInputPer1k + (temperature===0 en el JSON del cuerpo ? floor(0,95·salida) : 0)/1000 · outputPer1k)`, sin primas;
- `actual 0` y `netSavings 1`;
- en el cable, `referenceRequestId` y `referenceAt` de la primaria.

La identidad byte a byte ya la garantiza la clave de coalescencia (cuerpo más cabeceras identificativas). Tests que cambian: `gateway-coalescencia.test.ts:160,219` y `gateway-medidor.test.ts:504` pasan a `"reference"` con baseline = suelo. `BVSALA_GATEWAY_COALESCE` sigue apagado por defecto.

Aviso al dueño: sin la Parte G, el seguidor del SDK y la gemela del gateway quedan en clases distintas. Además, los terminales mandan temperature 1, así que su salida valdría 0.

---

## 12 · Ingresos: razonamiento y cifras

**Fórmula.** `comisión_ref ≈ t · Σ_aciertos φ_h · C_h`, donde:
- `t` es el tramo marginal (10 % hasta 1.000 €, luego 8/6/4);
- `C_h` es el coste ingenuo de la petición;
- `φ_h` es el suelo sobre el ingenuo.

A escala de cliente: `≈ t · ρ_eff · φ · S_naive · FX`, con `ρ_eff` = fracción del gasto ingenuo que son repeticiones idénticas byte a byte dentro del TTL (24 h por defecto) o ráfagas coalescidas, cuya poblada estaba intacta y con precio cacheado documentado. Las palancas que optimizan la primera llamada (TOON, selector, compresión) la sacan de `ρ_eff`: una repetición de una llamada optimizada no tiene contador ingenuo. Es el precio honesto de la regla.

**φ por acierto** (calculado con el catálogo del 2026-09-06):

| Modelo | 77/20 det. | 400/60 det. | 1000/150 det. | 1000/150 no det. | 8000/500 det. |
|---|---|---|---|---|---|
| gpt-4o-mini / gpt-4o | 72,9 % | 66,9 % | 66,8 % | 31,2 % | 59,0 % |
| gpt-4.1 (-mini) | 60,7 % | 51,2 % | 51,1 % | 15,6 % | 39,0 % |
| gpt-5 | 67,4 %* | 56,4 %* | 56,2 %* | 4,5 % | 38,3 %* |
| claude-sonnet/haiku-4-5 | 58,0 % | 46,4 % | 46,3 % | 5,7 % | 30,2 % |
| gemini-2.5-flash | 68,1 % | 57,2 % | 57,0 % | 4,4 % | 39,1 % |

\* gpt-5.x no admite `temperature: 0`, así que en la práctica siempre es «no det.».

**Banco publicado** (gpt-4o-mini, temperature 0, seed 7):
- **0 % del titular**: los brazos corren en frío por diseño, y el valor de la caché vive en `amortization` con break-even K = 1.
- Si «FAQ (repeat ask)» se corriera en caliente: poblada 77/18,5 → suelo `77·0,075e-6 + 17·0,6e-6 = 1,5975e-5 $` (67,8 % del ingenuo 2,355e-5). 8 aciertos = 1,278e-4 $ = **1,35 % del dólar del banco** (9,439e-3).
- El otro 98,6 % (libros 2 y 3 y el resolver) sigue fuera.

**Arquetipos por 10.000 $/mes de gasto ingenuo** (FX_SOMBRA 0,9 €/$):

| Arquetipo | Base por referencia | Comisión |
|---|---|---|
| A · Clasificación/FAQ determinista, gpt-4o-mini, 400/60, ρ_eff 25 % | 10.000·0,25·0,669 = 1.672 $ → 1.505 € | 100 + 505·0,08 ≈ **140 €/mes** |
| B · Asistente FAQ con muestreo por defecto, gpt-4o, 1000/150, ρ_eff 10 % | 312 $ → 281 € | ≈ **28 €** |
| C · Mezcla API gpt-4.1, 30 % de aciertos deterministas, ρ_eff 5 % (φ ≈ 0,263) | 131 $ → 118 € | ≈ **12 €** |
| D · Agentes/chat Claude Sonnet con muestreo por defecto, ρ_eff 1 % | 5,7 $ | ≈ **0,5 €** |
| E · gpt-5.x, ρ_eff 5 % | 22,5 $ | ≈ **2 €** |

- Referencia de escala: 1 M de aciertos FAQ al mes en gpt-4o-mini ≈ 17,2 $ de base, unos 1,5 € de comisión.
- Para comparar: 10 asientos son 40 €/mes.
- Las cifras quedan por debajo del ≈ 50 € que estimó el juez 3 porque las reglas son más estrictas: salida solo con `temperature 0`, identidad byte a byte y poblada intacta.

**Qué comunicar**, en la bitácora y no en la portada: «el SDK comisiona el tráfico repetido idéntico con el contador de la petición que sí corrió; para chat y agentes casi nada, para FAQ, clasificación y reintentos deterministas una parte real de su ahorro». No se puede vender como «el SDK ya genera comisión». El siguiente frente es el que puede tocar el ≈ 99 % restante (§14).

---

## 13 · Riesgos residuales

1. **Expectativas.** La base es pequeña, salvo en tráfico repetido determinista.
2. **Tarjeta de precios.** Se valora con el catálogo, o con `costModels` si el cliente los declara. Un cliente con descuento negociado que no los declare ve la base, y la comisión, en proporción a la lista. Es el mismo supuesto sistémico que `measured` hoy. Lo mitiga que el extracto publica la versión del catálogo y la regla.
3. **Determinismo residual.** `temperature 0` no es bit a bit exacto en OpenAI ni en Anthropic. El margen del 5 % cubre la variación habitual; una salida muy larga con más de un 5 % de variación puede sobrerreclamar puntualmente, aunque la media es cero. El único ajuste es `REFERENCE_OUTPUT_SHARE`, que exige npm; el interruptor de servidor es todo o nada.
4. **Repetición inducida.** «Lo repito porque sale gratis» es una objeción de contrafactual. Las peticiones las genera la app del cliente, no la capa, y el cliente puede desactivar la caché con `savings.exactCache: false`.
5. **Orden de despliegue.**
   - Un SDK que emite `reference` contra una web sin la lista blanca recibe 400 y pierde el lote.
   - La web sin 0029 da 42703 en el cierre: cierre aplazado más alerta.
   - Re-ejecutar 0025 tras 0029 regresa la RPC en silencio (lo detecta la fila del runbook).
6. **Inmutabilidad del sellado.** Un error descubierto tras el día 1 no se corrige en la fila sellada. Lo mitigan la calibración, `?seco=1` y los dos interruptores.
7. **Superficie.** Ampliar la unión `CostBasis` rompe un `switch` exhaustivo en clientes TypeScript estrictos. Hay que anotarlo en las notas de versión de 0.4.23.
8. **Asientos.** `seat_activity` no recibe dinero de referencia, porque la RPC no toca ese bloque. El dinero medido por asiento lo infraestima; queda documentado.
9. **Texto del titular.** `share` y `totalSplit` amplían «contador con el que comprobarlo» a «el suyo o el de la idéntica», ×12 idiomas. Si el dueño no lo acepta, `byReference` se pinta aparte y fuera de `share`, cambiando `deriveVerdict`.
10. **Cachés compartidas entre versiones.**
    - Escritor viejo → sin `meta` → `absent` (seguro).
    - Lector viejo → ignora `meta` (seguro).
    - Un backend propio que forje `meta` solo infla SU comisión, y lo acotan el testigo, el techo del servidor y la coherencia.
11. **Coste en caliente.** Un SHA-256 de la petición entera al poblar una intacta y en cada acierto. Es despreciable frente a una llamada de red.
12. **Parte G pendiente.** Hasta el sí del dueño, SDK y gateway valoran distinto la misma clase.

---

## 14 · Descartes y siguiente frente

- **Diseño 2 como base.** Su baseline es un recuento local más convenciones. Si la ingenua cachea su prefijo, publica ahorro positivo donde la capa pierde. Las constantes del Cookbook son aproximadas y el proveedor añade ~311 tokens de protocolo. Solo cubre una familia de OpenAI.
- **Diseño 3 como base.** Ver la portada. Además, un registro `verified` que llegara a una RPC vieja duplicaría peticiones y dinero, en vez de degradar a `estimated`.
- **Reutilizar `measured`.** No deja auditar ni apagar y cambia en silencio la definición pública.
- **Precio de lista bajo el mínimo cacheable.** Posible regla v2 (+≈40 % por acierto en prompts cortos) con una tabla de mínimos por familia versionada en el catálogo y su propio veredicto adversario. Decisión del dueño.
- **Referencia de solo entrada para pobladas optimizadas.** Las que tienen libros 2/3 y cuya entrada es ≤ la ingenua. No la ha revisado ningún juez y depende de la regla local con tokenizadores heurísticos. Queda para revisión propia.
- **Siguiente frente.** A/B muestreado opt-in sobre el tráfico del cliente, como **informe de verificación** con pares exportables (idea del Diseño 3), fuera de la base. Solo con un n mínimo mucho mayor y un estimador robusto a colas negativas podría el dueño decidir, aparte, si algún día entra en la comisión.
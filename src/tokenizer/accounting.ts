/**
 * The four-ledger savings accounting.
 *
 * These ledgers are kept strictly separate on purpose: each answers a different
 * question, and summing them would double-count.
 * The ledger is a pure accumulator: the pipeline records events into it, and it
 * produces the numbers that populate the SavingsReport. It never guesses — every
 * increment is driven by an explicit pipeline decision.
 */
/**
 * Where the baseline being compared against comes from.
 *
 * - `measured`   — reconstructed from this request's provider counter. Real money.
 * - `estimated`  — the call was AVOIDED: it never ran, so there is no provider
 *                  counter and the baseline comes from the local estimator. Still
 *                  the best figure available, but not measured.
 * - `unmeasured` — the provider reported no usage. Nothing is claimed.
 * - `shadow`     — HYPOTHETICAL: what would have happened with a lever turned on
 *                  (the shadow lane). Never enters the commission base, never
 *                  added to measured or to any total; shadow reports are built
 *                  separately and `estimateCost` must never produce this value.
 *
 * Summing `measured` and `estimated` into a single "money saved" figure is
 * exactly what a verify-don't-trust product cannot do — and adding `shadow` to
 * either would be making the savings up.
 */
export type CostBasis = "measured" | "estimated" | "unmeasured" | "shadow";

export interface CostModel {
  /** Cost per 1K input tokens, in the caller's currency unit. */
  inputPer1k: number;
  /** Cost per 1K output tokens. */
  outputPer1k: number;
  /** Optional discounted rate for provider-cached (prefix) input tokens. */
  cachedInputPer1k?: number;
}

export class SavingsLedger {
  // Ledger 1: avoided calls.
  avoidedLlm = 0;
  baselineLlm = 1;
  actualLlm = 0;
  baselineRetrieval = 0;
  actualRetrieval = 0;
  baselineTools = 0;
  actualTools = 0;
  retries = 0;

  // Token ledgers.
  baselineInput = 0;
  actualInput = 0;
  eliminatedInput = 0; // Ledger 2
  compressedInput = 0; // Ledger 3
  baselineOutput = 0;
  actualOutput = 0;
  eliminatedOutput = 0;
  providerCachedInput = 0; // Ledger 4

  // COMENTARIOS EN `//` Y NO JSDOC, a propósito: `SavingsLedger` es superficie
  // PÚBLICA y todo JSDoc de aquí viaja al `.d.ts` que se publica en npm. El
  // porqué es para quien lee ESTE fichero, no para el autocompletado del
  // cliente; `test/superficie-publica-limpia.test.ts` es el trinquete que lo
  // vigila. Misma convención que `canonicalization/guardas-de-texto.ts`.
  //
  // El recuento entero de escrituras ya está en `actualInput` a tarifa normal
  // (1x); lo que falta es el SUPLEMENTO —Anthropic las factura a 1,25x, o sea
  // +0,25x—, y es un coste que la capa PROVOCA al marcar `cache_control`. El
  // camino ingenuo nunca marcó, así que no puede estar en el baseline: va solo a
  // `actual`, como `extraCostUsd`. Sin esto, una petición marcada en frío
  // publicaba `netSavings 0` con `basis:"measured"` mientras la factura real
  // subía ~12,5 %.
  //
  // Y SE GUARDA EN DÓLARES, NO EN TOKENS, que es la diferencia que importa.
  // `estimateCost` recibe UN SOLO `CostModel` —el del modelo que acabó
  // contestando—, así que guardar tokens y tarifarlos allí los cobraría al precio
  // equivocado en cuanto la cascada escala: la marca la puso la llamada BARATA
  // (el código no marca la escalada, a propósito), pero el precio que llega a
  // `estimateCost` es el del FUERTE. Medido al provocarlo con barato 0,001 y
  // fuerte 0,015: la prima salía 15x. Misma doctrina que este fichero ya declara
  // para `cascadeAttempt`: tarifar donde se conoce el precio correcto.

  /** Tokens the provider billed as prefix-cache writes. */
  cacheWriteInputTokens = 0;
  /** The premium on those writes, already priced in USD. Adds to `actual` only. */
  cacheWritePremiumUsd = 0;

  // --- Regla de una sola regla (single ruler) -------------------------------
  // `baselineInput` se contaba con el estimador LOCAL y `actualInput` con el
  // contador del PROVEEDOR, y estimateCost dividía uno entre otro. Son dos reglas
  // de medir distintas, así que el sesgo del estimador se convertía en "ahorro":
  // medido con o200k_base sobre los escenarios del propio benchmark, x1,91 de
  // media (47,6% fabricado), y en JSON hasta x2,20. Encima el sesgo CRUZA el 1
  // (x0,83 en prompts cortos), así que no se puede corregir con un factor global.
  //
  // La salida no es afinar el estimador: es no comparar niveles de reglas
  // distintas. Así que el baseline se reconstruye sobre la regla del proveedor:
  //
  //     baselineInput = actualInput + k · (tokens quitados, medidos en local)
  //     k = actualInput / sentInputLocal      (calibración de ESTA petición)
  //
  // Con cero optimización, `quitados` es 0 y baseline == actual: 0% de ahorro
  // por construcción, sin depender de qué tokenizador tenga registrado nadie.
  //
  // DÓNDE FALLA ESTO, y por qué `basis` importa.
  // La versión anterior de este comentario afirmaba que el sesgo del estimador
  // "se cancela en la resta". Se cancela solo si los dos textos tienen la misma
  // densidad de símbolos, y justo el caso que más ahorra —cambiar JSON por un
  // formato tabular— rompe esa condición. `k` se calibra sobre el prompt ENVIADO
  // y se aplica a texto QUITADO que estaba en otro formato:
  //
  //   Medido en el escenario de la tabla (50 filas): el estimador cuenta 2182
  //   tokens del JSON (40% de sus caracteres son símbolos, y cobra cada símbolo
  //   La constante se calibra contra el contador del proveedor, no contra el
  //   estimador local: sin eso el baseline se infla y el ahorro publicado con él.
  //   −49,6%. Un positivo FABRICADO, y encima etiquetado "measured".
  //
  // Por eso `basis` solo puede ser "measured" cuando la conversión es de fiar:
  // o no hubo nada que convertir (`removedInputLocal == 0`), o el estimador
  // cuenta con la misma regla que factura el proveedor (`estimatorExact`).
  // Con el heurístico y algo quitado, la cifra es "estimated" — sigue siendo la
  // mejor disponible, pero no se cobra como comprobable contra la factura.

  /** Cuenta LOCAL del prompt que de verdad se envió al proveedor. */
  sentInputLocal = 0;
  /** Tokens que la capa quitó de ese prompt, en cuenta LOCAL. */
  removedInputLocal = 0;
  /**
   * ¿El estimador que produjo las dos cifras anteriores cuenta con la regla del
   * proveedor? Lo fija el pipeline al resolver el tokenizador del modelo.
   * Defaults to NO: exactness is claimed only once it has been verified.
   */
  estimatorExact = false;
  /** Salida del reintento de reparación. Es coste NUESTRO, nunca del baseline. */
  repairOutput = 0;
  /**
   * INPUT of the repair retry. Mirrors `repairOutput`.
   *
   * Both are OUR cost, never the customer's, so both are subtracted from the
   * reconstructed baseline. The baseline is what the naive path would have
   * cost; work the layer does to fix its own output has no place in it.
   */
  repairInput = 0;
  /**
   * INPUT of the schema-on-demand discovery probe. Held apart exactly like
   * {@link repairInput}, and for the same reason.
   *
   * The layer ADDS this call; the naive path would never make it. Letting its
   * tokens into the reconstructed baseline would make the probe pay for itself,
   * and a request that cost MORE than going without the layer would publish a
   * positive saving. It still counts in full towards `actualInput` — that is
   * money genuinely spent — it just cannot inflate what that is compared against.
   */
  discoveryInput = 0;
  /** OUTPUT of the discovery probe. Our cost, kept out of the baseline. */
  discoveryOutput = 0;

  // --- La cascada de modelos: dinero, no tokens ------------------------------
  //
  // Cuando la cascada escala (o cuando el modo sombra toma una muestra) hay UNA
  // llamada más, y la paga OTRO MODELO a OTRO PRECIO. Eso rompe el supuesto de
  // todo lo de arriba: `estimateCost` recibe UN `CostModel` y tarifa con él tanto
  // el baseline como lo real, así que meter los tokens del intento barato en
  // `actualInput`/`actualOutput` los tarifaría al precio del modelo FUERTE — que
  // no es lo que costaron, y en el sentido de cobrar de más.
  //
  // Así que de esa llamada entra el DINERO, ya tarifado con su propio precio, y
  // no los tokens. Los tokens no se pierden: quien los lee es el pipeline, y los
  // publica en `report.modelCascade.cascadeInputTokens/cascadeOutputTokens`, que
  // es donde se pueden leer junto al modelo que los facturó. ESE LECTOR TIENE QUE
  // EXISTIR: sin él, `cost.actual` lleva el dinero de unos tokens que no aparecen
  // en ninguna cuenta del informe, y la identidad con la que el cliente cuadra la
  // factura se rompe sin dejar rastro que lo explique.
  //
  // Y entra SOLO en `actual`, nunca en el baseline, exactamente como
  // `repairInput`/`discoveryInput`: es una llamada que pone la capa, no el
  // cliente. Si entrara en el baseline, la medición se pagaría a sí misma y una
  // petición que costó MÁS se publicaría con ahorro positivo.
  /**
   * Already-priced cost of a call the model cascade made to a cheaper model
   * whose answer was NOT served. Added to `actual`, never to the baseline.
   */
  extraCostUsd = 0;
  /** Input tokens of that call. Published by the pipeline, not priced here. */
  cascadeInput = 0;
  /** Output tokens of that call. Published by the pipeline, not priced here. */
  cascadeOutput = 0;

  /**
   * Record a call to the cheap model that did not produce the served answer:
   * the one discarded on an escalation, or a shadow-mode sample.
   *
   * The caller raises `actualLlm`, because the call happened and the report owes
   * the reader that count.
   */
  cascadeAttempt(
    usage: { inputTokens: number; outputTokens: number },
    cheapPrice: CostModel,
  ): void {
    this.cascadeInput += Math.max(0, usage.inputTokens);
    this.cascadeOutput += Math.max(0, usage.outputTokens);
    this.extraCostUsd +=
      (Math.max(0, usage.inputTokens) / 1000) * cheapPrice.inputPer1k +
      (Math.max(0, usage.outputTokens) / 1000) * cheapPrice.outputPer1k;
  }
  // El suplemento se tarifa con el precio del modelo QUE MARCÓ, que es el único
  // que lo conoce — ver el bloque de arriba. Va a `actual` y nunca al baseline.
  /** Record the premium for `tokens` of cache write billed at `multiplicador`x. */
  cacheWritePremium(tokens: number, multiplicador: number, precioDelQueMarco: CostModel): void {
    const t = Math.max(0, tokens);
    this.cacheWriteInputTokens += t;
    this.cacheWritePremiumUsd +=
      (t / 1000) * precioDelQueMarco.inputPer1k * Math.max(0, multiplicador - 1);
  }

  /**
   * Lo que de verdad hizo la compresión, para publicarlo en
   * `SavingsReport.compression`. El campo estaba declarado en el contrato y no lo
   * rellenaba nadie: salía `undefined` aunque la compresión hubiera corrido, y
   * `fidelityPassed` se calculaba sin llegar nunca al informe.
   */
  compressionReport:
    | { originalTokens: number; compressedTokens: number; protectedSpans: number; fidelityPassed: boolean }
    | undefined = undefined;

  /** Ledger 2: tokens removed because they were not needed. */
  eliminate(tokens: number): void {
    this.eliminatedInput += Math.max(0, tokens);
  }

  /** Ledger 3: delta between an original encoding and a cheaper one. */
  compress(originalTokens: number, compressedTokens: number): void {
    this.compressedInput += Math.max(0, originalTokens - compressedTokens);
  }

  /** Ledger 4: tokens still present but billed/processed as provider-cached. */
  providerCached(tokens: number): void {
    this.providerCachedInput += Math.max(0, tokens);
  }

  /** Record that a whole primary LLM call was avoided (cache / resolver hit). */
  avoidCall(baselineInput: number, baselineOutput: number): void {
    this.avoidedLlm += 1;
    this.actualLlm = 0;
    this.baselineInput = baselineInput;
    this.baselineOutput = baselineOutput;
    // NO se suma a eliminatedInput/eliminatedOutput. Los cuatro libros son
    // DISJUNTOS —el README lo promete literalmente: "summing them would lie to
    // you, so the report never does"— y una llamada evitada pertenece al libro 1
    // (avoided_calls). Apuntarla también en el 2 (eliminated_tokens) contaba el
    // mismo ahorro dos veces, y el panel enseña los cuatro en fila, así que
    // quien los lea los suma con la vista. El coste no cambia: estimateCost usa
    // baselineInput, no eliminatedInput.
  }

  /**
   * Baseline de salida publicable.
   *
   * En una llamada EVITADA es el de la respuesta que se habría generado. En una
   * que se EJECUTÓ es la salida medida menos la de la reparación — nunca el techo
   * `maxOutputTokens ?? 256`. estimateCost ya lo hacía por dentro, pero el
   * informe publicaba el techo crudo, y el proyector público lo convertía en
   * dólares: se anunciaba un ahorro de salida que nunca existió.
   */
  get publishedBaselineOutput(): number {
    return this.avoidedLlm === 0
      ? Math.max(0, this.actualOutput - this.repairOutput - this.discoveryOutput)
      : this.baselineOutput;
  }

  estimateCost(model: CostModel): {
    baselineEstimate: number;
    actual: number;
    netSavings: number;
    basis: CostBasis;
  } {
    // Honesty rule (do not credit phantom output savings): a call that actually
    // RAN still generates its answer — the layer does not shrink a ran call's
    // output — so its honest baseline output equals the measured actual output.
    // Output-token savings are credited ONLY on AVOIDED calls, whose whole
    // generation was skipped. Booking (maxOutputTokens ?? 256) − actualOutput as
    // a saving on a ran call manufactures tokens that were never generated and
    // systematically overclaims. The true effect of output caps can only be
    // proven by an A/B measurement (see benchmarks/ab-live.ts), never asserted
    // per-request from a ceiling constant.
    const ranCall = this.avoidedLlm === 0;

    // --- Regla de una sola regla ---------------------------------------------
    // En una llamada que SÍ se ejecutó existe la medición del proveedor, así que
    // el baseline se reconstruye sobre su regla en vez de compararse contra la
    // del estimador local. Es idempotente: siempre se recalcula desde
    // actualInput, nunca desde sí mismo.
    let basis: CostBasis = "estimated";
    if (ranCall) {
      if (this.actualInput > 0 && this.sentInputLocal > 0) {
        const k = this.actualInput / this.sentInputLocal;
        // `actualInput` acumula las DOS llamadas cuando hubo reparación, y esa
        // segunda es coste NUESTRO: si entra en el baseline, el reintento se paga
        // a sí mismo y una pérdida se publica como ahorro. Se descuenta igual que
        // ya se hacía con la salida (`baselineOutputHonesto`). Lo mismo vale para
        // el sondeo de descubrimiento: otra llamada que pone la capa, no el
        // cliente, y que por tanto no pertenece a aquello contra lo que se compara.
        const entradaDelCliente = Math.max(
          0,
          this.actualInput - this.repairInput - this.discoveryInput,
        );
        this.baselineInput = entradaDelCliente + Math.round(k * this.removedInputLocal);
        // Un baseline RECONSTRUIDO nunca es "measured", por bueno que sea el
        // tokenizador. Medido contra el proveedor real, con o200k_base exacto y
        // el escenario de la tabla:
        //
        //   quitado de verdad (exacto)     432
        //   lo que este cálculo acredita   616     ← k = 1042/731 = 1,426
        //
        // k no vale 1 aunque las dos reglas coincidan, porque `actualInput`
        // incluye ~311 tokens de PROTOCOLO que el conteo local del texto no ve:
        // el bloque `response_format`, los marcadores de rol, la plantilla de
        // chat. O sea que k mezcla un sobrecoste ADITIVO con una diferencia
        // MULTIPLICATIVA, y al multiplicar acredita tokens que nadie quitó.
        //
        // Y sumarlo sin k tampoco arregla: `actualInput` carga sobrecoste que la
        // petición naive nunca habría pagado (el bloque de esquema lo mete la
        // capa), así que el baseline seguiría contando contra el cliente algo que
        // no era suyo. El sobrecoste de protocolo del naive no se puede conocer
        // sin enviarlo.
        //
        // La conclusión honesta: el ÚNICO baseline medido de una llamada que se
        // ejecutó es uno que se haya ejecutado también — un A/B. Aquí solo cabe
        // estimar. Se sigue publicando, porque es la mejor cifra disponible y
        // ahora es mucho mejor (el libro de compresión pasó de 1306 a 432 con el
        // tokenizador exacto), pero no se cobra como comprobable contra factura.
        basis = this.removedInputLocal === 0 ? "measured" : "estimated";
      } else if (this.actualInput > 0) {
        // Hay medición del proveedor pero no lectura local con la que calibrar:
        // no se puede convertir, así que no se reclama nada.
        this.baselineInput = this.actualInput;
        basis = "measured";
      } else {
        // El proveedor no reportó uso. Un 0 medido frente a un baseline modelado
        // daría ~100% de ahorro: eso no se publica jamás.
        this.baselineInput = 0;
        basis = "unmeasured";
      }
    }

    // Salida: una llamada que se ejecutó genera su respuesta igual, la capa no
    // la encoge, así que su baseline honesto es la salida medida. PERO sin
    // contar la salida del reintento de reparación: ese reintento es coste
    // NUESTRO. Sumarla al baseline (via actualOutput) la escondía, y una pérdida
    // se reportaba unas cuatro veces menor de lo que fue.
    const baselineOutputHonesto = ranCall
      ? Math.max(0, this.actualOutput - this.repairOutput - this.discoveryOutput)
      : this.baselineOutput;

    // Precio de entrada. Los tokens que el proveedor sirvió de su caché de
    // prefijo se tarifan a la tarifa cacheada EN LOS DOS LADOS: ese descuento es
    // del proveedor, no de BV-SALA, y sin la capa se habría aplicado igual.
    // Tarifándolo solo en el lado "actual", una petición en la que la capa no
    // hiciera absolutamente nada reportaba ahorro. El recuento sigue publicado
    // como libro 4, que es su sitio: contarlo, sin cobrárselo.
    //
    // REVISADO cuando la capa empezó a PROVOCAR el acierto (marca `cache_control`
    // explícito contra Anthropic), que es justo el caso que esta regla parecía
    // castigar. Se mantiene, y por cuatro razones que no se cancelan:
    //
    //  1. AQUÍ NO HAY BASELINE MEDIDO. En una llamada que se ejecutó, el
    //     baseline se RECONSTRUYE desde `actualInput`; nadie ejecutó la variante
    //     sin marcar. Acreditar el descuento sería cobrar un contrafactual que
    //     no se corrió — exactamente lo que la nota larga de arriba concluye que
    //     no se puede hacer.
    //  2. ESTE CÓDIGO NO SABE DE QUÉ PROVEEDOR VIENE. Con OpenAI la caché es
    //     AUTOMÁTICA: el descuento le llega al cliente use o no use la capa. Una
    //     regla que acredite la lectura cacheada sobreacreditaría en cada
    //     petición contra OpenAI.
    //  3. NO SE PUEDE SABER SI EL CLIENTE YA LA MARCABA. Un cliente que ya ponía
    //     sus `cache_control` vería cómo le facturamos como ahorro nuestro un
    //     descuento que ya tenía.
    //  4. SÓLO ENTRARÍA LA MITAD BUENA. El acierto se paga con una PRIMA de
    //     escritura (1,25x, `cacheWriteInputTokens`). Acreditar la lectura sin
    //     cargar la escritura es la asimetría que ya fabricó ahorro una vez.
    //
    // El instrumento honesto para esa afirmación existe y tiene nombre: el A/B
    // de `benchmarks/ab-live.ts`, donde los DOS brazos se ejecutan y se miden.
    // Ahí sí se puede demostrar que el acierto lo provocó la capa. Aquí no, y
    // por eso aquí se cuenta y no se cobra.
    const cachedRate = model.cachedInputPer1k ?? model.inputPer1k;
    const cached = Math.min(this.providerCachedInput, this.actualInput);
    const precioEntrada = (facturable: number): number =>
      (Math.max(0, facturable - cached) / 1000) * model.inputPer1k +
      (cached / 1000) * cachedRate;

    const baselineEstimate =
      precioEntrada(this.baselineInput) + (baselineOutputHonesto / 1000) * model.outputPer1k;
    // `extraCostUsd` SOLO aquí, y ésa es toda la asimetría: el intento con el
    // modelo barato es dinero que el cliente pagó de verdad, así que tiene que
    // estar en `actual`; y es una llamada que puso la capa, así que no puede
    // estar en aquello contra lo que se compara. Una petición que escaló sale con
    // ahorro NEGATIVO, que es exactamente lo que le pasó a su factura.
    const actual =
      precioEntrada(this.actualInput) +
      (this.actualOutput / 1000) * model.outputPer1k +
      this.extraCostUsd +
      // Ya viene en dólares, tarifada con el precio del modelo que marcó — ver
      // `cacheWritePremiumUsd`. Con multiplicador 1 (OpenAI, proveedor
      // desconocido) el término es 0 y no toca nada.
      this.cacheWritePremiumUsd;

    const netSavings =
      baselineEstimate === 0 ? 0 : 1 - actual / baselineEstimate;

    return {
      baselineEstimate: roundUsd(baselineEstimate),
      actual: roundUsd(actual),
      netSavings: roundRatio(netSavings),
      basis,
    };
  }
}

/**
 * Redondeo de importes en dólares.
 *
 * Era a 1e-6 (microdólares) para los tres valores. Con gpt-4o-mini un token de
 * entrada cuesta ~1,5e-7 $, así que una petición corta cuesta menos que el
 * propio cuanto de redondeo: $0,00000195 se convertía en $0,000002 (+2,6%) y
 * cualquier coste por debajo de 5e-7 caía a CERO. Como cada petición se
 * redondea por separado y luego se SUMAN en usage_daily, el error no se
 * compensa: se acumula.
 *
 * 1e-10 mantiene el propósito original —quitar la basura binaria del tipo
 * 0.30000000000000004— sin tirar precisión que sí vale dinero.
 */
function roundUsd(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/** netSavings es una proporción (0..1): seis decimales sobran. */
function roundRatio(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

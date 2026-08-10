/**
 * The four-ledger savings accounting.
 *
 * These ledgers are kept strictly separate on purpose (see contracts/types.ts).
 * The ledger is a pure accumulator: the pipeline records events into it, and it
 * produces the numbers that populate the SavingsReport. It never guesses — every
 * increment is driven by an explicit pipeline decision.
 */
/**
 * De dónde sale el baseline con el que se compara el coste.
 *
 * - `measured`   — reconstruido desde el contador del proveedor. Es dinero.
 * - `estimated`  — llamada EVITADA: nunca se ejecutó, así que no hay contador
 *                  del proveedor y el baseline es del estimador local. Sigue
 *                  siendo la mejor cifra disponible, pero no está medida.
 * - `unmeasured` — el proveedor no reportó uso. No se reclama nada.
 *
 * Sumar `measured` y `estimated` en una misma cifra de "dinero ahorrado" es
 * exactamente lo que un producto verify-don't-trust no puede hacer.
 */
export type CostBasis = "measured" | "estimated" | "unmeasured";

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
  //   suelto a token entero) y 877 del TOON (16%). k sale 0,901 cuando la k
  //   correcta para el texto quitado era 0,538. Baseline publicado 4319 contra
  //   1174 reales: 3,68x, o sea +47,4% de ahorro donde el proveedor midió
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
   * Por defecto NO: asumir exactitud sin comprobarla es el fallo que esto cierra.
   */
  estimatorExact = false;
  /** Salida del reintento de reparación. Es coste NUESTRO, nunca del baseline. */
  repairOutput = 0;
  /**
   * ENTRADA del reintento de reparación. Simétrico de `repairOutput`, y faltaba.
   *
   * El baseline de una llamada ejecutada se reconstruye desde `actualInput`, y
   * `actualInput` ya acumula las DOS llamadas (pipeline.ts:623). Sin descontar la
   * del reintento, el baseline se inflaba con un coste que es NUESTRO, no del
   * cliente: una petición que costó el doble que el camino naive se publicaba con
   * ahorro POSITIVO. Medido: netSavings = -0,2857 cuando la verdad era -100 %, y
   * con `structuredData` llegaba a +36,4 % — y encima con `basis: 'measured'`,
   * que es justo lo que el panel presenta como contrastable con la factura.
   *
   * Para la salida ya existía la corrección (`baselineOutputHonesto`); para la
   * entrada no había nada.
   */
  repairInput = 0;
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
      ? Math.max(0, this.actualOutput - this.repairOutput)
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
        // ya se hacía con la salida (`baselineOutputHonesto`).
        const entradaDelCliente = Math.max(0, this.actualInput - this.repairInput);
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
      ? Math.max(0, this.actualOutput - this.repairOutput)
      : this.baselineOutput;

    // Precio de entrada. Los tokens que el proveedor sirvió de su caché de
    // prefijo se tarifan a la tarifa cacheada EN LOS DOS LADOS: ese descuento es
    // del proveedor, no de BV-SALA, y sin la capa se habría aplicado igual.
    // Tarifándolo solo en el lado "actual", una petición en la que la capa no
    // hiciera absolutamente nada reportaba ahorro. El recuento sigue publicado
    // como libro 4, que es su sitio: contarlo, sin cobrárselo.
    const cachedRate = model.cachedInputPer1k ?? model.inputPer1k;
    const cached = Math.min(this.providerCachedInput, this.actualInput);
    const precioEntrada = (facturable: number): number =>
      (Math.max(0, facturable - cached) / 1000) * model.inputPer1k +
      (cached / 1000) * cachedRate;

    const baselineEstimate =
      precioEntrada(this.baselineInput) + (baselineOutputHonesto / 1000) * model.outputPer1k;
    const actual =
      precioEntrada(this.actualInput) + (this.actualOutput / 1000) * model.outputPer1k;

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

/**
 * La verja entre `benchmarks/out/ab-live.json` y lo que la web publica.
 *
 * El artefacto que hoy sirve la landing tiene `mode: "MOCK"`. Llegó ahí por una
 * copia a mano, y nada lo impidió. Ese es el fallo que este módulo cierra: quien
 * publica una cifra de ahorro tiene que pasar por unas comprobaciones que NO
 * dependen de que alguien se acuerde.
 *
 * Es una función pura a propósito — la parte que decide se puede probar sin
 * tocar el disco ni la red.
 */

export interface CI {
  point: number;
  lower: number;
  upper: number;
}

/** El subconjunto del artefacto del que depende la decisión. */
export interface ArtifactShape {
  mode?: unknown;
  model?: unknown;
  modelStable?: unknown;
  /** Sello de procedencia que escribe `pnpm ab`: fecha, commit del árbol y
   *  número de ensayos. `trials` es el lazo que ata el JSON con su CSV — el
   *  publicador se niega si no cuadran. Opcionales porque un artefacto anterior
   *  al sello no los trae y debe poder republicarse. */
  generatedAt?: unknown;
  commit?: unknown;
  trials?: unknown;
  /** Qué SDK midió la tirada. `asShipped: true` = el paquete tal como se
   *  instala desde npm, sin el compresor del banco. Opcional en el TIPO porque
   *  un artefacto anterior al sello no lo trae; la verja no publica un LIVE sin él. */
  sdk?: { version?: unknown; asShipped?: unknown };
  reconciliation?: { reconciled?: unknown; residual?: unknown };
  aggregate?: {
    savings?: Partial<CI>;
    proven?: unknown;
    qualityPassRate?: unknown;
  };
  /** Frente a B1 (integración razonable) y frente a B2 (nativo bien configurado). */
  aggregateB1?: { savings?: Partial<CI> };
  aggregateB2?: { savings?: Partial<CI> };
  /** Los suelos del IC frente a cada brazo de control, y el menor. */
  floors?: { vsB0?: unknown; vsB1?: unknown; vsB2?: unknown; min?: unknown; minAgainst?: unknown };
  native?: { degradedByTransport?: unknown; honored?: { promptCacheMode?: unknown } };
  transport?: { kind?: unknown; endpointHost?: unknown };
  cost?: { aborted?: unknown };
  scenarioSet?: { size?: unknown };
  scenariosNotApplicable?: unknown;
  pricing?: { listPriceKnown?: unknown; cacheWrites?: { premium?: unknown; metered?: unknown } };
  scenarios?: unknown;
}

export interface Decision {
  ok: boolean;
  /** Por qué NO se publica. Vacío cuando `ok`. */
  blockers: string[];
  /** Se publica, pero el que lo lea tiene que saberlo. */
  warnings: string[];
}

export interface GuardOptions {
  /** Publicar un artefacto MOCK a propósito (por ejemplo, para restaurar). */
  allowMock?: boolean;
}

const esNumero = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** `openai/gpt-4o-mini` → `openai-gpt-4o-mini`, para nombrar ficheros (y encontrarlos al publicar). */
export function babosaDeModelo(modelo: string): string {
  return modelo.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * ¿Es un host de loopback o de red privada? La web publica mediciones contra un
 * PROVEEDOR; una tirada contra un servidor local (vLLM, un proxy de pruebas) se
 * puede correr y leer, pero no es lo que la landing afirma.
 */
function hostPrivado(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  // IPv6: única local (fc00::/7) y de enlace (fe80::/10).
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** El suelo menor de los presentes y contra qué brazo. */
function menorSuelo(f: { vsB0?: unknown; vsB1?: unknown; vsB2?: unknown }): number | undefined {
  const xs = [f.vsB0, f.vsB1, f.vsB2].filter(esNumero);
  return xs.length ? Math.min(...xs) : undefined;
}

/**
 * ¿Se puede publicar `incoming` encima de `current`?
 *
 * @param current  El artefacto ya publicado, o `null` si no hay ninguno.
 * @param incoming El recién generado.
 */
export function decidePublish(
  current: ArtifactShape | null,
  incoming: ArtifactShape,
  opts: GuardOptions = {},
): Decision {
  const blockers: string[] = [];
  const warnings: string[] = [];

  const modo = incoming.mode;
  const esLive = modo === "LIVE";

  // ── 1. Nunca DEGRADAR. Si lo publicado está medido contra un proveedor real,
  // una tirada MOCK no lo puede sustituir — ni con `--allow-mock`. Volver atrás
  // sin darse cuenta es exactamente cómo se pierde una cifra defendible.
  if (current?.mode === "LIVE" && !esLive) {
    blockers.push(
      `lo publicado es LIVE y lo entrante es ${String(modo)}: degradar una medición real no se permite por ninguna vía`,
    );
  }

  // ── 2. MOCK solo con intención explícita.
  if (!esLive && !opts.allowMock) {
    blockers.push(
      `mode = ${String(modo)}: un artefacto que no está medido contra un proveedor real no se publica ` +
        `(usa --allow-mock si de verdad es lo que quieres)`,
    );
  }

  // ── 2b. El titular solo puede salir del SDK que el cliente instala, TAMBIÉN en
  // MOCK. El del 2026-09-12 (≥ 23,2 %) se midió con el compresor del banco, que
  // el paquete de npm no trae: un escenario caro ahorraba un 15 % que ningún
  // cliente puede ahorrar. Desde que asShipped es el modo por defecto de
  // `pnpm ab`, no hay tirada legítima para la web que no lo lleve.
  //
  // Y SIN SELLO TAMPOCO. Hasta que `ab-live.ts` empezó a sellar `sdk`, medía
  // CON el compresor por defecto: un artefacto que no declara qué SDK midió es,
  // casi seguro, uno de esos. Solo `asShipped: true`, dicho por el propio
  // banco, pasa.
  if (incoming.sdk?.asShipped === false) {
    blockers.push(
      "la tirada se midió con el compresor del banco, que el paquete de npm NO trae (sdk.asShipped = false): " +
        "el titular prometería una palanca que el cliente no tiene. Vuelve a medir con `pnpm ab` (asShipped es el " +
        "modo por defecto; BVSALA_AB_CON_COMPRESOR=1 es solo para investigar la palanca)",
    );
  } else if (incoming.sdk?.asShipped !== true) {
    blockers.push(
      "el artefacto no declara que midió el SDK tal como se instala (falta sdk.asShipped: true): es anterior al " +
        "sello, y hasta entonces el banco medía CON el compresor del banco, que npm no trae. Vuelve a medir con " +
        "`pnpm ab` (asShipped es el modo por defecto)",
    );
  }

  // ── 2c. Un precio que no es de lista no es una cifra defendible frente a la factura.
  if (incoming.pricing?.listPriceKnown === false) {
    blockers.push(
      "pricing.listPriceKnown = false: el modelo no tiene fila en el catálogo de precios del SDK y sus dólares son " +
        "ilustrativos. Añade la fila y vuelve a medir",
    );
  }

  // ── 2d. B2 no puede ser lo que dice ser por este transporte.
  if (incoming.native?.degradedByTransport === true) {
    blockers.push(
      "native.degradedByTransport = true: un modelo de Claude por un endpoint con el protocolo de OpenAI no puede " +
        "llevar ni cache_control ni output_config.effort, así que B2 no es «nativo bien configurado». Declara el " +
        "endpoint nativo de Anthropic y vuelve a medir",
    );
  }
  if (incoming.native?.honored?.promptCacheMode === false) {
    blockers.push(
      "native.honored.promptCacheMode = false: B2 pidió el modo de caché explícito sin breakpoint y aun así el " +
        "proveedor escribió caché. El endpoint no reenvía `prompt_cache_options` (¿la pasarela?): mide por el " +
        "endpoint directo (BVSALA_DEMO_OPENAI_BASE_URL) y comprueba antes con `pnpm ab:sonda`",
    );
  }

  // ── 2e. Una tirada cortada por el presupuesto no es una tirada.
  if (incoming.cost?.aborted !== undefined && incoming.cost?.aborted !== null && incoming.cost?.aborted !== false) {
    blockers.push("cost.aborted: la tirada se cortó por el presupuesto y le faltan escenarios o repeticiones");
  }

  // ── 2f. Ninguna fila roja se cae en silencio: cada escenario del conjunto está
  // medido o declarado no aplicable, con su motivo.
  const escenarios = Array.isArray(incoming.scenarios) ? incoming.scenarios.length : 0;
  const noAplican = Array.isArray(incoming.scenariosNotApplicable) ? incoming.scenariosNotApplicable.length : 0;
  if (incoming.scenarioSet !== undefined) {
    if (incoming.scenarioSet.size !== escenarios + noAplican) {
      blockers.push(
        `scenarioSet.size = ${String(incoming.scenarioSet.size)} y el artefacto trae ${escenarios} escenarios medidos + ` +
          `${noAplican} no aplicables: falta alguna fila, y quitar una fila roja es elegir la cifra`,
      );
    }
  } else if (esLive) {
    blockers.push("el artefacto no declara scenarioSet: no se puede comprobar que no falte ninguna fila");
  }

  // ── 2g. Los suelos cuadran con sus agregados, y el menor es el menor.
  const f = incoming.floors;
  if (f !== undefined) {
    const pares: [unknown, Partial<CI> | undefined, string][] = [
      [f.vsB0, incoming.aggregate?.savings, "vsB0 ↔ aggregate"],
      [f.vsB1, incoming.aggregateB1?.savings, "vsB1 ↔ aggregateB1"],
      [f.vsB2, incoming.aggregateB2?.savings, "vsB2 ↔ aggregateB2"],
    ];
    for (const [suelo, agregado, nombre] of pares) {
      const lower = agregado?.lower;
      if (suelo === undefined || suelo === null) {
        if (esNumero(lower)) blockers.push(`floors: falta ${nombre.split(" ")[0]} y el agregado sí existe (${nombre})`);
        continue;
      }
      if (!esNumero(suelo) || suelo !== lower) {
        blockers.push(`floors: ${nombre} no cuadran (${String(suelo)} frente a ${String(lower)})`);
      }
    }
    const menor = menorSuelo(f);
    if (menor === undefined || f.min !== menor) {
      blockers.push(`floors.min = ${String(f.min)} y el menor de los suelos es ${String(menor)}`);
    }
  } else if (esLive) {
    blockers.push("el artefacto no trae floors: cualquier cifra tiene que caber bajo el menor de los suelos");
  }

  // ── 3. Integridad interna. Estas las calcula el propio benchmark; si alguna
  // falla, la tirada no vale aunque el porcentaje sea bonito.
  if (esLive) {
    if (incoming.modelStable === false) {
      blockers.push("los dos brazos no hablaron con el mismo modelo: el A/B pareado no es comparable");
    }
    if (incoming.reconciliation?.reconciled === false) {
      blockers.push(
        `los libros no cuadran (residual ${String(incoming.reconciliation?.residual)}): ` +
          `las partidas dejan de particionar el total, o sea, hay doble conteo`,
      );
    }
    if (!Array.isArray(incoming.scenarios) || incoming.scenarios.length === 0) {
      blockers.push("el artefacto no trae escenarios");
    }
    // ── 3b. Sin B2 no hay comparación contra lo que el proveedor da gratis
    // (informe de competencia, §8 rec. 3).
    const b2 = incoming.aggregateB2?.savings;
    if (!b2 || !esNumero(b2.point) || !esNumero(b2.lower) || !esNumero(b2.upper)) {
      blockers.push(
        "sin un intervalo numérico en aggregateB2 no hay comparación contra lo que el proveedor da gratis (brazo B2, " +
          "«nativo bien configurado»): una tirada con BVSALA_AB_B2=0 es de investigación",
      );
    }
    // ── 3c. Las escrituras de caché con prima tienen que salir del contador.
    const primas = incoming.pricing?.cacheWrites;
    if (esNumero(primas?.premium) && (primas!.premium as number) > 1 && primas?.metered !== true) {
      blockers.push(
        `pricing.cacheWrites: el modelo paga la escritura de caché a ${String(primas!.premium)}x y el proveedor no ` +
          "informó del contador en todas las llamadas (metered ≠ true): el coste no se puede defender frente a la factura",
      );
    }
    // ── 3d. La web publica mediciones contra un proveedor.
    const host = incoming.transport?.endpointHost;
    if (typeof host !== "string" || host.trim() === "") {
      blockers.push("transport.endpointHost falta: no se sabe contra qué proveedor se midió");
    } else {
      const privados = host.split(",").map((h) => h.trim()).filter((h) => h && hostPrivado(h));
      if (privados.length > 0) {
        blockers.push(
          `transport.endpointHost = ${host}: loopback o red privada. La web publica mediciones contra un proveedor, ` +
            "no contra un servidor local",
        );
      }
    }
  }

  // ── 4. Cordura del número. Un ahorro fuera de (−∞, 1] o un intervalo dado la
  // vuelta significan que el cálculo se rompió, no que ahorremos muchísimo.
  const s = incoming.aggregate?.savings;
  if (!s || !esNumero(s.point) || !esNumero(s.lower) || !esNumero(s.upper)) {
    blockers.push("el agregado no trae un intervalo de confianza numérico");
  } else {
    if (s.lower > s.upper) blockers.push(`intervalo invertido: [${s.lower}, ${s.upper}]`);
    if (s.point > 1 || s.upper > 1) blockers.push(`ahorro > 100% (point ${s.point}, upper ${s.upper}): imposible, es un bug`);
    if (s.point < s.lower || s.point > s.upper) {
      blockers.push(`el punto ${s.point} cae fuera de su propio intervalo [${s.lower}, ${s.upper}]`);
    }
  }

  // ── 5. Avisos: se publica, pero no como victoria.
  if (esLive && incoming.aggregate?.proven === false) {
    warnings.push(
      "proven = false: la cota inferior no despega de 0, la calidad regresó o el modelo cambió. " +
        "Es honesto publicarlo, pero la landing NO puede presentarlo como ahorro demostrado.",
    );
  }
  if (esLive && esNumero(incoming.aggregate?.qualityPassRate) && (incoming.aggregate.qualityPassRate as number) < 1) {
    warnings.push(
      `calidad ${((incoming.aggregate.qualityPassRate as number) * 100).toFixed(1)}%: alguna respuesta no pasó la verja`,
    );
  }
  if (esLive && !incoming.model) {
    warnings.push("el artefacto no fija `model`: la cifra no se puede atribuir a un modelo concreto");
  }
  // El umbral y su porqué son del informe (docs/COMPETENCIA-2026-09-26.md §8
  // rec. 3): por debajo del 5 % frente a la base más fuerte, el mensaje tiene
  // que girar hacia la contabilidad. Es una decisión de negocio, no un bloqueo.
  if (esLive && esNumero(incoming.floors?.min) && (incoming.floors!.min as number) < 0.05) {
    warnings.push(
      `floors.min = ${((incoming.floors!.min as number) * 100).toFixed(1)}% (frente a ${String(incoming.floors?.minAgainst)}): ` +
        "informe §8 rec. 3 — si el suelo frente a B2 queda por debajo del 5 %, reescribir el mensaje hacia la contabilidad",
    );
  }
  if (!esLive && opts.allowMock) {
    warnings.push("publicando un artefacto MOCK a petición explícita: NO es una afirmación de ahorro");
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

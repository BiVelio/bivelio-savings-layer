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
  reconciliation?: { reconciled?: unknown; residual?: unknown };
  aggregate?: {
    savings?: Partial<CI>;
    proven?: unknown;
    qualityPassRate?: unknown;
  };
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

  // ── 3. Integridad interna. Estas tres las calcula el propio benchmark; si
  // alguna falla, la tirada no vale aunque el porcentaje sea bonito.
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
  if (!esLive && opts.allowMock) {
    warnings.push("publicando un artefacto MOCK a petición explícita: NO es una afirmación de ahorro");
  }

  return { ok: blockers.length === 0, blockers, warnings };
}

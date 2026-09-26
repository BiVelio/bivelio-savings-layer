/**
 * EL VERIFICADOR DE FORMATO — la parte PURA, sin React ni alias `@/`.
 *
 * Vive aparte del componente por dos razones: lo importa un test de la raíz
 * (`test/verificador-de-formato.test.ts`, que lo compila el `tsc` raíz con
 * `noUnusedLocals`, `verbatimModuleSyntax` y `noUncheckedIndexedAccess`), y la
 * regla que decide qué cifra se enseña tiene que poder probarse sin navegador.
 *
 * LA REGLA, en el lado seguro (principio de la casa: se publica el suelo, nunca
 * la cifra halagüeña):
 *
 *   · Solo hay cifra con el tokenizador EXACTO del modelo (o200k_base para
 *     gpt-4o-mini). El heurístico sirve para ORDENAR formatos, no para restar
 *     tokens entre formatos distintos (src/tokenizer/estimator.ts): con él la
 *     portada enseñaba 45–51 % donde lo real es 17–27 %. Sin exacto, ni cifra
 *     ni barras: `approximate`.
 *   · La base es SOLO el JSON compacto. El código anterior caía al MÁXIMO de
 *     los candidatos cuando faltaba, y eso infla: sin `json-compact` no hay
 *     comparación (`not-comparable`).
 *   · El porcentaje se redondea HACIA ABAJO (555 → 461 es un 16 %, no un 17 %).
 *   · La muestra por defecto es la de MENOR efecto (pedidos, ~16 %): no se abre
 *     con la halagüeña.
 *
 * Las muestras van en inglés porque el visitante las ve en el textarea.
 */

export type SampleKey = "orders" | "tickets" | "users";

/** Orden de los chips. La primera es la de menor efecto, a propósito. */
export const SAMPLE_ORDER: readonly SampleKey[] = ["orders", "tickets", "users"];

/** La muestra con la que abre el verificador: la de MENOR efecto medido. */
export const DEFAULT_SAMPLE: SampleKey = "orders";

/** El modelo contra el que se cuenta. Tiene que casar con {@link VERIFIER_TOKENIZER}. */
export const VERIFIER_MODEL = "openai/gpt-4o-mini";

/** La codificación BPE que usa {@link VERIFIER_MODEL}. */
export const VERIFIER_TOKENIZER = "o200k_base";

/** Tope de lo que se tokeniza en el navegador: por encima, se pide una muestra menor. */
export const MAX_PAYLOAD_CHARS = 200_000;

export const VERIFIER_SAMPLES: Readonly<Record<SampleKey, unknown>> = {
  orders: {
    orders: Array.from({ length: 18 }, (_, i) => ({
      order: `ORD-2026-0${140 + i}`,
      customer: `customer_${i + 1}`,
      items: (i % 4) + 1,
      total: Number((19.9 + i * 7.35).toFixed(2)),
      status: ["paid", "shipped", "delivered"][i % 3],
    })),
  },
  tickets: {
    tickets: Array.from({ length: 16 }, (_, i) => ({
      id: `TCK-${3300 + i}`,
      subject: `Can't access my account (${i + 1})`,
      priority: ["low", "medium", "high"][i % 3],
      status: i % 2 ? "open" : "resolved",
      agent: `agent_${(i % 5) + 1}`,
    })),
  },
  users: {
    users: Array.from({ length: 24 }, (_, i) => ({
      id: 1000 + i,
      name: `user_${i}`,
      role: i % 3 ? "member" : "admin",
      active: i % 4 !== 0,
    })),
  },
};

/** Lo que el verificador necesita del `FormatChoice` del SDK (tipado aquí para no depender de él). */
export interface FormatChoiceLike {
  chosen: string;
  candidateTokens: Readonly<Partial<Record<string, number>>>;
}

/** Lo que el verificador necesita del `FormatSelector` del SDK. */
export interface SelectorLike {
  choose(payload: unknown, opts: { model: string }): FormatChoiceLike;
}

export type FormatVerdict =
  /** El SDK enviaría menos tokens. `percentFloor` es un entero, redondeado hacia abajo. */
  | { kind: "fewer"; baselineTokens: number; chosenTokens: number; percentFloor: number }
  /** Ningún formato mejora al JSON compacto: se enviaría tal cual. */
  | { kind: "optimal"; baselineTokens: number }
  /** El recuento no es exacto: ni cifra ni barras. */
  | { kind: "approximate" }
  /** Sin base de JSON compacto (o sin recuento del elegido): no hay comparación honesta. */
  | { kind: "not-comparable" };

const esRecuento = (n: number | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;

/**
 * Decide qué se enseña para una elección del selector. `exact` dice si el
 * recuento salió del tokenizador exacto del modelo; si no, jamás hay cifra.
 */
export function verdictFor(choice: FormatChoiceLike, exact: boolean): FormatVerdict {
  if (!exact) return { kind: "approximate" };
  const baselineTokens = choice.candidateTokens["json-compact"];
  // Solo el JSON compacto es base: nada de caer al máximo de los candidatos.
  if (!esRecuento(baselineTokens) || baselineTokens === 0) return { kind: "not-comparable" };
  if (choice.chosen === "json-compact") return { kind: "optimal", baselineTokens };
  const chosenTokens = choice.candidateTokens[choice.chosen];
  // Un elegido sin recuento, o que no baja de la base, no es un ahorro que se
  // pueda enseñar: el selector nunca lo hace, y si lo hiciera no se inventa.
  if (!esRecuento(chosenTokens) || chosenTokens >= baselineTokens) return { kind: "not-comparable" };
  // Numerador y denominador enteros: el cociente exacto, y floor hacia el suelo.
  const percentFloor = Math.floor((100 * (baselineTokens - chosenTokens)) / baselineTokens);
  return { kind: "fewer", baselineTokens, chosenTokens, percentFloor };
}

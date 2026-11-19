import type { CanonicalRequest } from "../canonicalization/canonicalize.js";

/**
 * Deterministic resolvers.
 *
 * The cheapest LLM call is the one that never happens because the answer can be
 * *computed* locally. Arithmetic, unit conversions, deterministic string
 * transforms, lookups in a local table — none of these need a model. A resolver
 * inspects the canonical request and either produces an answer or declines.
 * The first resolver to produce a result wins; the pipeline then skips the
 * entire provider path.
 */
export interface ResolverResult {
  text: string;
  data?: unknown;
  /** Which resolver produced this, for the trace. */
  resolver: string;
}

export interface DeterministicResolver {
  readonly name: string;
  try(c: CanonicalRequest): ResolverResult | null;
}

export class ResolverRegistry {
  private readonly resolvers: DeterministicResolver[] = [];

  register(resolver: DeterministicResolver): this {
    this.resolvers.push(resolver);
    return this;
  }

  try(c: CanonicalRequest): ResolverResult | null {
    for (const resolver of this.resolvers) {
      try {
        const result = resolver.try(c);
        if (result) return result;
      } catch {
        // A misbehaving resolver must never break the request; skip it.
      }
    }
    return null;
  }

  get size(): number {
    return this.resolvers.length;
  }
}

/**
 * Safe arithmetic resolver: answers "what is 2 + 2 * 3" style questions using a
 * tiny, dependency-free shunting-yard evaluator over +, -, *, /, %, parens and
 * decimals. It never uses eval, and declines anything it does not fully parse.
 *
 * It answers only when the WHOLE request is that one question: a single user
 * turn, no system prompt, no earlier turns, no tools and no structured data.
 * Anything else can change what the right answer is ("answer in JSON", "from
 * now on + means times"), and only the model sees it.
 */
export const arithmeticResolver: DeterministicResolver = {
  name: "arithmetic",
  try(c) {
    const expr = expresionDeLaPeticion(c);
    if (expr === null || !esCuentaInequivoca(expr)) return null;
    const value = evaluar(expr, true);
    if (value === null || !Number.isFinite(value)) return null;
    const rendered = trimNumber(value);
    return { text: rendered, data: { value }, resolver: "arithmetic" };
  },
};

// LA PREGUNTA ENTERA, O NADA (auditoría del 2026-11-19, N2). La regex no
// estaba anclada por delante y no exigía operador, así que «In HTTP, what is
// 404?» devolvía "404" y «What is 12/05/2026?» una división, sin llamar al
// modelo. Y se miraba el texto de TODA la conversación sin mirar qué más
// llevaba la petición: con un system «responde solo JSON», con un turno
// anterior que redefinía «+» o con una calculadora declarada como herramienta,
// seguía contestando la cuenta por su lado.
//
// La expresión suelta («2+2», sin pregunta) no se contesta: nunca se contestó
// —el rol que precede a cada turno lo impedía— y no se abre un atajo nuevo aquí.
const PREGUNTA = /^(?:what\s+is|calculate|compute|how\s+much\s+is|cuanto\s+es)\s+([0-9+\-*/%.()\s]+)$/;

function expresionDeLaPeticion(c: CanonicalRequest): string | null {
  // Un único turno, de usuario. Ni system, ni historial, ni resultados de
  // herramienta: `normalizedText` lleva un turno por línea con su rol delante.
  if (c.messages.length !== 1 || c.messages[0]!.role !== "user") return null;
  if ((c.original.tools ?? []).length > 0) return null;
  if (c.original.structuredData !== undefined) return null;
  if (!c.normalizedText.startsWith("user:")) return null;
  const m = PREGUNTA.exec(c.normalizedText.slice("user:".length).trim());
  return m ? m[1]!.trim() : null;
}

/**
 * ¿Es una cuenta y solo una cuenta? Cada regla descarta algo que se escribe con
 * los mismos caracteres y NO lo es. Declinar cuesta una llamada; contestar una
 * fecha como si fuera una división es una respuesta equivocada sin aviso.
 */
function esCuentaInequivoca(expr: string): boolean {
  // Sin operador entre dos operandos no hay nada que calcular: «404», «3.14».
  if (!/[0-9)]\s*[+\-*/%]\s*[0-9(]/.test(expr)) return false;
  // «-» o «/» PEGADOS entre cifras: fechas (12/05/2026, 2026-11-22), teléfonos
  // (555-1234, 9-1-1), «24/7», rangos. Una resta o una división se escriben
  // aquí con espacios: «10 / 3».
  if (/\d[-/]\d/.test(expr)) return false;
  // «%» es módulo en código y porcentaje en la calle («100 - 20%», «10 % 3»).
  if (expr.includes("%")) return false;
  for (const numero of expr.match(/[0-9.]+/g) ?? []) {
    // «2.500» son dos y medio o dos mil quinientos según quién lo escriba.
    if (/^\d{1,3}(?:\.\d{3})+$/.test(numero)) return false;
    // «5.», «1.2.3» y «.5» no son un número de los que evalúa esto.
    if (!/^\d+(?:\.\d+)?$/.test(numero)) return false;
    // «08»: ¿octal, un código, una hora? No se adivina.
    if (/^0\d/.test(numero)) return false;
    // Más cifras de las que un double guarda exactas: 9007199254740993 se
    // leería como …992 y la suma saldría mal sin que nada lo diga.
    if (numero.replace(".", "").replace(/^0+/, "").length > 15) return false;
  }
  return true;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e9) / 1e9);
}

/** Shunting-yard evaluation of a numeric expression. Returns null on any parse issue. */
export function evalArithmetic(expr: string): number | null {
  return evaluar(expr, false);
}

// `exacto`: además, null en cuanto un paso se sale del rango de enteros que un
// double representa sin pérdida (lo usa el resolver; `evalArithmetic` no).
function evaluar(expr: string, exacto: boolean): number | null {
  const tokens = expr.match(/\d+\.?\d*|[+\-*/%()]/g);
  if (!tokens || tokens.join("") !== expr.replace(/\s+/g, "")) return null;

  const output: number[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };

  const push = (n: number): boolean => {
    if (exacto && !(Math.abs(n) <= Number.MAX_SAFE_INTEGER)) return false;
    output.push(n);
    return true;
  };

  const apply = (op: string): boolean => {
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) return false;
    switch (op) {
      case "+": return push(a + b);
      case "-": return push(a - b);
      case "*": return push(a * b);
      case "/": if (b === 0) return false; return push(a / b);
      case "%": if (b === 0) return false; return push(a % b);
      default: return false;
    }
  };

  let expectValue = true;
  for (const token of tokens) {
    if (/^\d/.test(token)) {
      // Dos valores seguidos («2 3», «2(3+1)») no son una cuenta escrita entera.
      if (exacto && !expectValue) return null;
      if (!push(Number(token))) return null;
      expectValue = false;
    } else if (token === "(") {
      if (exacto && !expectValue) return null;
      ops.push(token);
      expectValue = true;
    } else if (token === ")") {
      while (ops.length && ops[ops.length - 1] !== "(") {
        if (!apply(ops.pop()!)) return null;
      }
      if (ops.pop() !== "(") return null;
      expectValue = false;
    } else {
      // Reject unary/consecutive operators for safety and simplicity.
      if (expectValue) return null;
      while (
        ops.length &&
        ops[ops.length - 1] !== "(" &&
        prec[ops[ops.length - 1]!]! >= prec[token]!
      ) {
        if (!apply(ops.pop()!)) return null;
      }
      ops.push(token);
      expectValue = true;
    }
  }
  while (ops.length) {
    const op = ops.pop()!;
    if (op === "(") return null;
    if (!apply(op)) return null;
  }
  return output.length === 1 ? output[0]! : null;
}

/** A registry seeded with the built-in safe resolvers. */
export function createDefaultResolvers(): ResolverRegistry {
  return new ResolverRegistry().register(arithmeticResolver);
}

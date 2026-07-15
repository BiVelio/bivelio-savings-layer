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
 */
export const arithmeticResolver: DeterministicResolver = {
  name: "arithmetic",
  try(c) {
    const m = c.normalizedText.match(
      /(?:what\s+is|calculate|compute|how\s+much\s+is|cu[aá]nto\s+es)\s+([0-9+\-*/%.()\s]+)\??$/i,
    );
    const expr = (m?.[1] ?? extractBareExpression(c.normalizedText))?.trim();
    if (!expr) return null;
    const value = evalArithmetic(expr);
    if (value === null || !Number.isFinite(value)) return null;
    const rendered = trimNumber(value);
    return { text: rendered, data: { value }, resolver: "arithmetic" };
  },
};

function extractBareExpression(text: string): string | null {
  // Only treat the whole message as an expression when it is nothing but math.
  return /^[0-9+\-*/%.()\s]+$/.test(text.trim()) && /[+\-*/%]/.test(text)
    ? text.trim()
    : null;
}

function trimNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e9) / 1e9);
}

/** Shunting-yard evaluation of a numeric expression. Returns null on any parse issue. */
export function evalArithmetic(expr: string): number | null {
  const tokens = expr.match(/\d+\.?\d*|[+\-*/%()]/g);
  if (!tokens || tokens.join("") !== expr.replace(/\s+/g, "")) return null;

  const output: number[] = [];
  const ops: string[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "%": 2 };

  const apply = (op: string): boolean => {
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) return false;
    switch (op) {
      case "+": output.push(a + b); return true;
      case "-": output.push(a - b); return true;
      case "*": output.push(a * b); return true;
      case "/": if (b === 0) return false; output.push(a / b); return true;
      case "%": if (b === 0) return false; output.push(a % b); return true;
      default: return false;
    }
  };

  let expectValue = true;
  for (const token of tokens) {
    if (/^\d/.test(token)) {
      output.push(Number(token));
      expectValue = false;
    } else if (token === "(") {
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

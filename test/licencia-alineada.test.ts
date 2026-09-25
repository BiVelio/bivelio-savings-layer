import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * LA LICENSE DICE LO QUE HACE EL CÓDIGO — y no promete ni un campo menos.
 *
 * Hasta el 2026-09-25 la §5 decía que a BiVelio solo llegaban «usage counts and
 * cost metadata». No era verdad: el registro de uso lleva también el id del
 * modelo, el id de la petición, un asiento derivado por HMAC, los ids de sesión y
 * de subagente del gateway, el `basis` y la versión del cliente en una cabecera.
 * Nada de eso es contenido, pero una licencia que enumera de menos es una
 * licencia que un cliente puede sacar en una auditoría de privacidad.
 *
 * La verja: cada campo que el emisor pone en el cable (`UsageWire` en
 * src/metering/emitter.ts) y cada campo que la ingesta admite (lista blanca de
 * apps/web/lib/metering/usage.ts) tiene que tener su línea en la §5. Un campo
 * nuevo sin línea rompe aquí, en CI, antes de que viaje a npm. Y como la §5
 * afirma que la ingesta rechaza cualquier campo que no esté en la lista, la
 * lista blanca entera —no solo lo que el emisor manda hoy— entra en el mapa:
 * el orden servidor-primero sigue valiendo, pero obliga a pasar por aquí.
 */

const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
const plano = (t: string) => t.replace(/\s+/g, " ");

const licencia = leer("../LICENSE");
const readme = leer("../README.md");
const emisor = leer("../src/metering/emitter.ts");
const ingesta = leer("../apps/web/lib/metering/usage.ts");

/** El texto de una sección de la LICENSE, desde su número hasta el siguiente. */
function seccion(n: number): string {
  const inicio = licencia.search(new RegExp(`^${n}\\. `, "m"));
  if (inicio < 0) throw new Error(`la LICENSE no tiene sección ${n}`);
  const resto = licencia.slice(inicio + 1);
  const fin = resto.search(new RegExp(`^${n + 1}\\. `, "m"));
  return fin < 0 ? licencia.slice(inicio) : licencia.slice(inicio, inicio + 1 + fin);
}

/** Los campos de `UsageWire`, leídos del fuente del emisor. */
function camposDelCable(): string[] {
  const inicio = emisor.indexOf("interface UsageWire {");
  if (inicio < 0) throw new Error("no se encontró `interface UsageWire` en el emisor");
  const cuerpo = emisor.slice(inicio, emisor.indexOf("\n}\n", inicio));
  return [...cuerpo.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]!);
}

/** La lista blanca de la ingesta: las constantes que componen USAGE_ALLOWED_FIELDS. */
function camposDeLaIngesta(): string[] {
  const campos: string[] = [];
  for (const nombre of [
    "USAGE_ID_FIELDS",
    "USAGE_NUMBER_FIELDS",
    "USAGE_OPTIONAL_MONEY_FIELDS",
    "USAGE_OPTIONAL_REFERENCE_FIELDS",
  ]) {
    const m = new RegExp(`const ${nombre} = \\[([\\s\\S]*?)\\] as const`).exec(ingesta);
    if (!m?.[1]) throw new Error(`no se encontró ${nombre} en la ingesta`);
    campos.push(...[...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]!));
  }
  const conjunto = /const USAGE_ALLOWED_FIELDS = new Set<string>\(\[([\s\S]*?)\]\);/.exec(ingesta);
  if (!conjunto?.[1]) throw new Error("no se encontró USAGE_ALLOWED_FIELDS en la ingesta");
  campos.push(...[...conjunto[1].matchAll(/"(\w+)"/g)].map((x) => x[1]!));
  return campos;
}

/**
 * Cada campo del cable → la frase de la §5 que lo cubre. Si añades un campo al
 * emisor o a la lista blanca, añade aquí su frase Y escríbela en la LICENSE (y
 * pásala por revisión legal): este mapa no es la fuente, es el recordatorio.
 */
const FRASE_DE_LA_LICENCIA: Record<string, string> = {
  orgId: "an organization hint",
  seatId: "a seat identifier",
  ci: "a flag marking CI or ephemeral runners",
  requestId: "a request identifier generated on your side",
  model: "the model identifier as named in the request",
  at: "and a timestamp",
  avoidedLlm: "LLM calls executed and avoided",
  actualLlm: "LLM calls executed and avoided",
  baselineInputTokens: "input and output tokens before and after the Software's optimizations",
  actualInputTokens: "input and output tokens before and after the Software's optimizations",
  baselineOutputTokens: "input and output tokens before and after the Software's optimizations",
  actualOutputTokens: "input and output tokens before and after the Software's optimizations",
  eliminatedInputTokens: "including tokens removed",
  compressedInputTokens: "compressed",
  providerCachedInputTokens: "read from the provider's cache",
  cacheResult: "the cache outcome",
  baselineCost: "baseline cost",
  actualCost: "actual cost",
  netSavings: "the net-saving ratio",
  basis: "the basis of the figures (measured, reference, estimated, shadow, or unmeasured)",
  eliminatedInputFloorCost: "input tokens your provider reported as cleared from context",
  referenceRequestId: "the identifier and timestamp of the earlier request",
  referenceAt: "the identifier and timestamp of the earlier request",
  sessionId: "the session and sub-agent identifiers",
  agentId: "the session and sub-agent identifiers",
};

describe("la LICENSE §5 enumera exactamente lo que viaja a BiVelio", () => {
  const s5 = plano(seccion(5));

  it("el lector del cable y el de la lista blanca funcionan (si no, esta verja no protege nada)", () => {
    expect(camposDelCable().length).toBeGreaterThan(20);
    expect(camposDeLaIngesta().length).toBeGreaterThan(20);
  });

  it("todo lo que el emisor pone en el cable lo admite la ingesta", () => {
    const admitidos = new Set(camposDeLaIngesta());
    expect(camposDelCable().filter((c) => !admitidos.has(c))).toEqual([]);
  });

  it("⛔ ningún campo del cable ni de la lista blanca queda sin su línea en la §5", () => {
    const todos = [...new Set([...camposDelCable(), ...camposDeLaIngesta()])];
    const sinFrase = todos.filter((c) => FRASE_DE_LA_LICENCIA[c] === undefined);
    expect(sinFrase, "campo nuevo en el cable: añádelo a la LICENSE §5 y a este mapa").toEqual([]);
    const sinLinea = todos.filter((c) => !s5.includes(FRASE_DE_LA_LICENCIA[c]!));
    expect(sinLinea, "la LICENSE §5 perdió la línea de estos campos").toEqual([]);
  });

  it("la §5 nombra la cabecera de versión, el asiento por HMAC y lo que NUNCA sale", () => {
    // La única cabecera extra del lote (x-bvsala-version); su conjunto exacto lo
    // fija test/metering-emitter.test.ts.
    expect(s5).toContain("surface and version");
    expect(s5).toMatch(/HMAC-SHA-256/);
    expect(s5).toMatch(/underlying values are never sent/);
    for (const nunca of ["prompts", "completions", "tool arguments and results", "API keys", "OAuth tokens"]) {
      expect(s5).toContain(nunca);
    }
    expect(s5).toMatch(/rejects any record that carries a field not listed above/);
  });

  it("⛔ la §5 ya no dice que solo viajan «counts and cost metadata»", () => {
    expect(plano(licencia)).not.toMatch(/only usage counts and cost metadata/);
  });
});

describe("la LICENSE nombra la comisión sin copiar cifras", () => {
  const s6 = plano(seccion(6));

  it("la §6 es la de tarifas y dice cuota por asiento, comisión solo sobre lo medido, calibración y exención", () => {
    expect(s6).toMatch(/^6\. FEES\./);
    expect(s6).toMatch(/per seat, payable whether or not the Software produces any saving/);
    expect(s6).toMatch(/charged only on measured savings/);
    expect(s6).toMatch(/estimates, reconstructs, or simulates never carry commission/);
    expect(s6).toMatch(/calibration period .* carries no commission/);
    expect(s6).toMatch(/full-discount promotional code/);
  });

  it("⛔ la §6 no copia tipos, tramos, precios ni monedas que cambian (viven en tarifa.ts y en la web)", () => {
    const cuerpo = s6.replace(/^6\. /, "");
    expect(cuerpo).not.toMatch(/\d/);
    expect(cuerpo).not.toMatch(/[€$%]|\bEUR\b|\bUSD\b/);
  });

  it("la numeración es seguida y la supervivencia cubre hasta la última sección", () => {
    const numeros = [...licencia.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
    expect(numeros).toEqual(numeros.map((_, i) => i + 1));
    const ultima = numeros[numeros.length - 1];
    expect(plano(licencia)).toContain(`Sections 2 through ${ultima} survive termination`);
  });
});

describe("el README que viaja a npm promete lo que se cobra", () => {
  it("⛔ no dice «we only earn when you save»: la cuota por asiento se paga siempre", () => {
    expect(readme).not.toMatch(/only earn when you save/i);
    expect(readme).toMatch(/seat fee is paid whether or not you save/);
  });

  it("⛔ no dice que los prompts «no salen de tu infraestructura»: salen hacia tu proveedor, no hacia BiVelio", () => {
    expect(readme).not.toMatch(/never leave your infrastructure/i);
    expect(readme).toMatch(/never reach BiVelio/);
  });

  it("remite a la LICENSE para la lista de campos y para las tarifas", () => {
    expect(readme).toMatch(/LICENSE\]\(\.\/LICENSE\) §5/);
    expect(readme).toMatch(/LICENSE\]\(\.\/LICENSE\) §6/);
  });
});

describe("las guías de terminales (también viajan a npm) no prometen de menos lo que viaja", () => {
  it("⛔ ni «solo cuentas y coste» ni cabeceras de sesión «sin consumirlas»", () => {
    expect(leer("../docs/terminales/README.md")).not.toMatch(/solo\s+cuentas\s+y\s+coste/);
    expect(leer("../docs/terminales/README.md")).toMatch(/LICENSE\s+§5/);
    expect(leer("../docs/terminales/claude-code.md")).not.toMatch(/sin\s+consumirlas/);
  });

  it("⛔ el SDK no menciona un free tier que no existe", () => {
    expect(leer("../src/pipeline/pipeline.ts")).not.toMatch(/\(free tier\)/);
  });
});

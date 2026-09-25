import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
const contabilidad = leer("../src/tokenizer/accounting.ts");
const tarifa = leer("../apps/web/lib/billing/tarifa.ts");

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
  // El que CONTESTÓ: con la cascada del SDK o el hermano del gateway, el
  // informe nombra al servido (pipeline.ts, construirInforme en medidor.ts).
  model: "the identifier of the model that served the request",
  at: "and the time of the request",
  avoidedLlm: "LLM calls executed and avoided",
  actualLlm: "LLM calls executed and avoided",
  baselineInputTokens: "input and output tokens before and after the Software's optimizations",
  actualInputTokens: "input and output tokens before and after the Software's optimizations",
  baselineOutputTokens: "input and output tokens before and after the Software's optimizations",
  actualOutputTokens: "input and output tokens before and after the Software's optimizations",
  eliminatedInputTokens: "including tokens removed, compressed, or read from the provider's cache",
  compressedInputTokens: "including tokens removed, compressed, or read from the provider's cache",
  providerCachedInputTokens: "including tokens removed, compressed, or read from the provider's cache",
  cacheResult: "and the cache outcome",
  baselineCost: "baseline cost, actual cost, the net-saving ratio",
  actualCost: "baseline cost, actual cost, the net-saving ratio",
  netSavings: "baseline cost, actual cost, the net-saving ratio",
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

/** Las etiquetas de `basis` que existen: el tipo `CostBasis` del SDK, leído del fuente. */
function etiquetasDeBasis(): string[] {
  const m = /export type CostBasis = ([^;]+);/.exec(contabilidad);
  if (!m?.[1]) throw new Error("no se encontró `CostBasis` en src/tokenizer/accounting.ts");
  return [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]!);
}

describe("la LICENSE nombra la comisión sin copiar cifras", () => {
  const s6 = plano(seccion(6));
  const s5 = plano(seccion(5));

  it("la §6 es la de tarifas y dice cuota por asiento y comisión solo sobre lo medido", () => {
    expect(s6).toMatch(/^6\. FEES\./);
    expect(s6).toMatch(/per seat, payable whether or not the Software produces any saving/);
    expect(s6).toMatch(/charged only on measured savings/);
    expect(s6).toMatch(/A period with no measured savings carries no commission/);
  });

  it("⛔ lo que se comisiona y lo que no va por la ETIQUETA del registro, y las etiquetas son las del SDK", () => {
    // «reconstruido» era ambiguo: el d.ts publicado llama «reconstructed» al
    // propio `measured`. La exclusión va atada a las etiquetas que el código
    // pone, no a verbos que el contrato no define.
    expect(s6).not.toMatch(/reconstruct|simulat/i);
    const comisionables = ["measured", "reference"];
    const nunca = etiquetasDeBasis().filter((b) => !comisionables.includes(b));
    expect(etiquetasDeBasis()).toEqual(expect.arrayContaining(comisionables));
    expect(nunca.length).toBeGreaterThan(0);
    expect(s6).toMatch(/savings whose basis is labelled "measured" or "reference"/);
    const frase = /Savings labelled ((?:"\w+"(?:, | or |, or ))+"\w+") never carry commission/.exec(s6);
    expect(frase, "la §6 perdió la frase de lo que nunca se comisiona").not.toBeNull();
    const excluidas = [...frase![1]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!);
    expect(excluidas.sort()).toEqual([...nunca].sort());
    // La §5 enumera todas las etiquetas, también las comisionables.
    for (const b of etiquetasDeBasis()) expect(s5).toContain(b);
    // Y la tarifa no comisiona más de lo que la §6 dice: solo medido y referencia.
    expect(tarifa).toMatch(/Se comisiona SOLO el ahorro MEDIDO/);
  });

  it("⛔ el precio con el que se valora lo medido es el que aplicó el Software (costModels, si no el catálogo)", () => {
    // pipeline.ts: precioDelCliente(model) ?? precioDeLista(model). Y el cierre
    // sella SIEMPRE la versión de catálogo del servidor, no la del registro:
    // la §6 no puede remitir a «la versión que dice tu extracto».
    expect(s6).toMatch(/valued at the per-token prices the Software applied to that request/);
    expect(s6).toMatch(/cost model you configure, where you configure one, and otherwise your provider's list prices/);
    expect(s6).not.toMatch(/catalogue version stated on your statement/);
    expect(leer("../src/pipeline/pipeline.ts")).toContain("return this.precioDelCliente(model) ?? precioDeLista(model);");
  });

  it("⛔ la suscripción de tarifa plana: solo la que el código reconoce, y sin ahorro acreditado", () => {
    expect(s6).toMatch(
      /Traffic the Software identifies as a flat-rate provider subscription \(a Claude or ChatGPT subscription used through the local gateway\) is metered but credited no measured saving/,
    );
    expect(s6).not.toMatch(/no per-token provider invoice \(such as a flat-rate provider subscription\)/);
    expect(leer("../gateway/medidor.ts")).toContain("const acreditable = !coalescida && !subscription;");
  });

  it("⛔ la calibración se define como la calcula el cierre, no remite a «tu primer mes» de la web", () => {
    expect(s6).toMatch(
      /The first calendar month \(UTC\) in which your organization reports any usage is a calibration period, however little of that month remains, and carries no commission/,
    );
    expect(s6).not.toMatch(/calibration period defined in the Published Pricing/);
    // Si el dueño cambia la regla (p. ej. a «primer mes completo»), esto rompe
    // y obliga a reescribir la §6 con revisión legal.
    expect(leer("../apps/web/lib/billing/cierre.ts")).toContain("esCalibracion: org.primerPeriodoConUso >= periodo,");
  });

  it("⛔ la exención por cupón es la del webhook: 100 % «para siempre» y hasta el primer pago", () => {
    expect(s6).toMatch(/while your account is exempt from it/);
    expect(s6).toMatch(
      /until a payment is made on the account, if its subscription was activated with a promotional code that waives the subscription fee in full for its entire term/,
    );
    expect(s6).not.toMatch(/full-discount promotional code/);
    const webhook = leer("../apps/web/app/api/stripe/webhook/route.ts");
    expect(webhook).toContain('const paraSiempre = cupon?.duration === "forever" && cupon.percent_off === 100;');
    // El pago de verdad levanta la exención, en el checkout y en invoice.paid.
    expect(webhook.match(/update\(\{ comision_exenta: false, exencion_nota: null \}\)/g)?.length).toBe(2);
    // El cierre lee la marca al cerrar: «a period that BiVelio closes while…».
    expect(leer("../apps/web/lib/billing/cierre.ts")).toContain("esExento: org.comisionExenta === true,");
  });

  it("⛔ el suelo de la elisión no se comisiona: encenderlo obliga a reescribir la §6", () => {
    expect(tarifa, "COMISIONAR_ELISION_SUELO=true cobra algo que la LICENSE §6 no nombra").toMatch(
      /export const COMISIONAR_ELISION_SUELO: boolean = false;/,
    );
  });

  it("⛔ la §6 no copia tipos, tramos, precios ni monedas que cambian (viven en tarifa.ts y en la web)", () => {
    // Las remisiones a otra sección («Section 5(b)(iv)») no son cifras.
    const cuerpo = s6.replace(/^6\. /, "").replace(/Section \d+(\([a-z]+\))*/g, "Section");
    expect(cuerpo).not.toMatch(/\d/);
    expect(cuerpo).not.toMatch(/[€$%]|\bEUR\b|\bUSD\b/);
  });

  it("la numeración es seguida y la supervivencia cubre hasta la última sección", () => {
    const numeros = [...licencia.matchAll(/^(\d+)\. [A-Z]/gm)].map((m) => Number(m[1]));
    expect(numeros).toEqual(numeros.map((_, i) => i + 1));
    const ultima = numeros[numeros.length - 1];
    expect(plano(licencia)).toContain(`Sections 2 through ${ultima} survive termination`);
  });

  it("la §3 no exige asientos «pagados»: la §1 admite suscripciones sin coste", () => {
    expect(plano(seccion(3))).not.toMatch(/seats than you have paid for/);
    expect(plano(seccion(3))).toMatch(/more seats than your subscription covers/);
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

/** Todos los .ts de un directorio (recursivo), sin tests. */
function fuentes(dir: string): string[] {
  const raiz = fileURLToPath(new URL(`../${dir}/`, import.meta.url));
  const out: string[] = [];
  const andar = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const ruta = join(d, e.name);
      if (e.isDirectory()) andar(ruta);
      else if (/\.(ts|md)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(ruta);
    }
  };
  andar(raiz);
  return out;
}

describe("⛔ nada de lo que viaja en el tarball vuelve a «solo cuentas y coste»", () => {
  // src/ y gateway/ se compilan a dist/ (el `bvsala --help` salía de
  // gateway/bin.ts con «Your prompts never leave your machine — only counts and
  // cost»); docs/terminales, skills, README y LICENSE van tal cual. Las frases
  // retiradas prometían de menos lo que llega a BiVelio (§5) o decían que los
  // prompts no salen, cuando salen hacia el proveedor.
  const RETIRADAS = [
    /only counts and cost/i,
    /never leave your (machine|infrastructure)/i,
    /prompts never leave/i,
    /solo (suben )?(cuentas|conteos) y coste/i,
    /no salen de (tu|la) máquina/i,
  ];

  it("el barrido encuentra lo que tiene que barrer", () => {
    expect(fuentes("src").length).toBeGreaterThan(20);
    expect(fuentes("gateway").some((f) => f.endsWith("bin.ts"))).toBe(true);
  });

  it("ningún fuente, guía ni skill publicado lleva una frase retirada", () => {
    const ficheros = [...fuentes("src"), ...fuentes("gateway"), ...fuentes("docs/terminales"), ...fuentes("skills")];
    const culpables: string[] = [];
    for (const f of ficheros) {
      const texto = plano(readFileSync(f, "utf8").replace(/^\s*(\/\/|\*)\s?/gm, ""));
      for (const r of RETIRADAS) if (r.test(texto)) culpables.push(`${f}: ${r}`);
    }
    for (const [nombre, texto] of [["README.md", readme], ["LICENSE", licencia]] as const) {
      for (const r of RETIRADAS) if (r.test(plano(texto))) culpables.push(`${nombre}: ${r}`);
    }
    expect(culpables).toEqual([]);
  });

  it("la ayuda del gateway dice a quién NO llegan los prompts y remite a la §5", () => {
    const bin = plano(leer("../gateway/bin.ts"));
    expect(bin).toMatch(/Your prompts, completions and provider keys never reach BiVelio/);
    expect(bin).toMatch(/LICENSE §5 lists every field/);
  });
});

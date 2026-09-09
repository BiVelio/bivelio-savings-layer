import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { ajustarDiales, conBetaDeElision, describirEstadoDeElision, dialesSonNuestros, fusionarDiales, triggerDelCliente } from "../gateway/palanca.js";
import { precioDeLista } from "../src/pricing/catalogo.js";
import { CanalDeEntitlements } from "../gateway/entitlements.js";
import {
  BETA_CONTEXT_MANAGEMENT,
  DIAL_TRIGGER_INPUT_TOKENS,
  DIAL_KEEP_TOOL_USES,
  DIAL_CLEAR_AT_LEAST_INPUT_TOKENS,
  TRIGGER_POR_DEFECTO_DE_LA_API,
} from "../gateway/diales.js";

/**
 * S4a · la palanca de diales, de punta a punta contra servidores FALSOS
 * locales. Las verjas que importan:
 *
 *  1. APAGADA POR DEFECTO: sin bandera, el cuerpo viaja byte a byte (la
 *     hermana del test de passthrough de gateway-servidor.test.ts).
 *  2. Doble opt-in: bandera local + feature en la licencia. Falta cualquiera
 *     de los dos → intacto.
 *  3. FAIL-CLOSED: plataforma caída o respondiendo raro → intacto.
 *  4. Encendida: el upstream recibe context_management con NUESTROS diales y
 *     la beta añadida SIN pisar las betas existentes del cliente.
 *  5. Cuerpo comprimido → intacto (S4a no recomprime).
 */

const CUERPO = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hola" }],
  context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }, // la de fábrica del cliente
});

const RESPUESTA_JSON = JSON.stringify({
  id: "msg_1",
  type: "message",
  usage: { input_tokens: 10, output_tokens: 2 },
});

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

interface Recibida {
  path: string;
  headers: Record<string, unknown>;
  body: string;
}

function arrancarUpstreamFalso(recibidas: Recibida[]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(RESPUESTA_JSON);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/** Upstream que, además del usage, declara un borrado del proveedor (forma sondeada en vivo, stream:false). */
function arrancarUpstreamConBorrado(
  recibidas: Recibida[],
  clearedInputTokens: number,
  opciones: { inputTokens?: number; edits?: unknown[] } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          usage: { input_tokens: opciones.inputTokens ?? 10, output_tokens: 2 },
          context_management: {
            applied_edits: opciones.edits ?? [
              { type: "clear_tool_uses_20250919", cleared_input_tokens: clearedInputTokens, cleared_tool_uses: 2 },
            ],
          },
        }),
      );
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Plataforma falsa: ingesta (202, y captura los lotes si se pide) + entitlements con las features indicadas. */
function arrancarPlataformaFalsa(opciones: { features?: string[]; estado?: number; lotes?: unknown[][] }): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.url === "/api/org/entitlements") {
        if (opciones.estado !== undefined && opciones.estado !== 200) {
          res.writeHead(opciones.estado, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "boom" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features: opciones.features ?? [], refreshAfterSeconds: 300 }));
        return;
      }
      if (opciones.lotes && chunks.length > 0) {
        opciones.lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ ingested: 0 }));
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

async function pedir(puerto: number, cuerpo: string | Buffer, cabeceras: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${puerto}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cabeceras },
    body: cuerpo,
  });
}

async function gatewayCon(opciones: {
  upstream: number;
  plataforma?: number;
  elision?: boolean;
  /** 2026-09-09 · los diales tienen bandera propia y nacen apagados. */
  dialesElision?: boolean;
  clave?: string;
}): Promise<GatewayArrancado> {
  const g = await arrancarGateway({
    puerto: 0,
    upstream: `http://127.0.0.1:${opciones.upstream}`,
    ...(opciones.clave !== undefined ? { serviceAccountKey: opciones.clave } : {}),
    ...(opciones.plataforma !== undefined
      ? { meteringUrl: `http://127.0.0.1:${opciones.plataforma}/api/metering/usage` }
      : {}),
    ...(opciones.elision !== undefined ? { elision: opciones.elision } : {}),
    ...(opciones.dialesElision !== undefined ? { dialesElision: opciones.dialesElision } : {}),
    log: () => {},
  });
  recursos.push(g);
  return g;
}

/** El canal refresca en el arranque; los tests esperan a que asiente. */
async function esperarCanal(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

const NUESTRO_EDIT = {
  type: "clear_tool_uses_20250919",
  trigger: { type: "input_tokens", value: DIAL_TRIGGER_INPUT_TOKENS },
  keep: { type: "tool_uses", value: DIAL_KEEP_TOOL_USES },
  clear_at_least: { type: "input_tokens", value: DIAL_CLEAR_AT_LEAST_INPUT_TOKENS },
};

describe("ajustarDiales — pura y con la duda hacia el passthrough", () => {
  it("sustituye el clear_tool_uses del cliente por nuestros diales", () => {
    const salida = ajustarDiales(Buffer.from(CUERPO));
    expect(salida).not.toBeNull();
    const json = JSON.parse(salida!.cuerpo.toString("utf8"));
    expect(json.context_management).toEqual({ edits: [NUESTRO_EDIT] });
    // El contenido del cliente no se toca (superficie mínima).
    expect(json.model).toBe("claude-sonnet-4-5");
    expect(json.messages).toEqual([{ role: "user", content: "hola" }]);
    expect(json.max_tokens).toBe(64);
  });

  it("CONSERVA el clear_thinking del cliente, en posición 0 (lo que Claude Code manda de fábrica)", () => {
    // Corpus 09-2026 (claude-cli ≥ 2.1.252): {edits:[{type:"clear_thinking_20251015",keep:"all"}]}.
    // Pisarlo cambiaría el thinking retenido (y la caché) en los modelos cuyo
    // default no es «todo»; la API exige clear_thinking en primera posición.
    const cuerpo = JSON.stringify({
      ...JSON.parse(CUERPO),
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    });
    const json = JSON.parse(ajustarDiales(Buffer.from(cuerpo))!.cuerpo.toString("utf8"));
    expect(json.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }, NUESTRO_EDIT],
    });
  });

  it("sin context_management → solo el nuestro", () => {
    const { context_management: _fuera, ...sinCm } = JSON.parse(CUERPO);
    const json = JSON.parse(ajustarDiales(Buffer.from(JSON.stringify(sinCm)))!.cuerpo.toString("utf8"));
    expect(json.context_management).toEqual({ edits: [NUESTRO_EDIT] });
  });

  it("fusionarDiales: estrategias desconocidas y claves ajenas se conservan; idempotente", () => {
    const cliente = {
      edits: [
        { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 100_000 } },
        { type: "estrategia_futura_2027", foo: 1 },
        { type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 2 } },
        { type: "clear_tool_uses_20250919" },
      ],
      otra_clave: true,
    };
    const una = fusionarDiales(cliente);
    expect(una).toEqual({
      otra_clave: true,
      edits: [
        { type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 2 } },
        { type: "estrategia_futura_2027", foo: 1 },
        NUESTRO_EDIT,
      ],
    });
    expect(fusionarDiales(una)).toEqual(una);
    // Formas raras → solo el nuestro, jamás throw.
    expect(fusionarDiales(null)).toEqual({ edits: [NUESTRO_EDIT] });
    expect(fusionarDiales("basura")).toEqual({ edits: [NUESTRO_EDIT] });
    expect(fusionarDiales({ edits: "no" })).toEqual({ edits: [NUESTRO_EDIT] });
    expect(fusionarDiales({ edits: [null, 3, "x"] })).toEqual({ edits: [NUESTRO_EDIT] });
  });

  it("es determinista: mismo cuerpo, mismo ajuste byte a byte", () => {
    const a = ajustarDiales(Buffer.from(CUERPO));
    const b = ajustarDiales(Buffer.from(CUERPO));
    expect(a!.cuerpo.equals(b!.cuerpo)).toBe(true);
    expect(a!.nuestros).toBe(b!.nuestros);
  });

  it("cuerpo comprimido → null (no se construye recompresión en S4a)", () => {
    expect(ajustarDiales(gzipSync(Buffer.from(CUERPO)), "gzip")).toBeNull();
  });

  it("no-JSON o sin forma de /v1/messages → null", () => {
    expect(ajustarDiales(Buffer.from("esto no es json"))).toBeNull();
    expect(ajustarDiales(Buffer.from('{"model":"x"}'))).toBeNull();
    expect(ajustarDiales(Buffer.from('{"messages":[]}'))).toBeNull();
    expect(ajustarDiales(Buffer.from("[1,2,3]"))).toBeNull();
  });
});

/**
 * B2 · LA REGLA DEL DELTA (plan S4 § 2.4): el borrado del proveedor se
 * acredita SOLO en las peticiones donde nuestros diales cambian algo. Si el
 * cliente ya mandaba exactamente nuestro edit, ese ahorro es suyo.
 */
describe("dialesSonNuestros — la regla del delta (B2)", () => {
  it("sin context_management, o con el clear_tool_uses de fábrica → nuestros", () => {
    expect(dialesSonNuestros(undefined)).toBe(true);
    expect(dialesSonNuestros(null)).toBe(true);
    expect(dialesSonNuestros({})).toBe(true);
    expect(dialesSonNuestros({ edits: [] })).toBe(true);
    expect(dialesSonNuestros({ edits: [{ type: "clear_tool_uses_20250919" }] })).toBe(true);
    expect(dialesSonNuestros({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] })).toBe(true);
  });

  it("⛔ con EXACTAMENTE nuestro edit → del cliente (aunque las claves vengan en otro orden)", () => {
    expect(dialesSonNuestros({ edits: [NUESTRO_EDIT] })).toBe(false);
    expect(dialesSonNuestros({ edits: [{ type: "clear_thinking_20251015", keep: "all" }, NUESTRO_EDIT] })).toBe(false);
    const desordenado = {
      clear_at_least: { value: DIAL_CLEAR_AT_LEAST_INPUT_TOKENS, type: "input_tokens" },
      keep: { value: DIAL_KEEP_TOOL_USES, type: "tool_uses" },
      trigger: { value: DIAL_TRIGGER_INPUT_TOKENS, type: "input_tokens" },
      type: "clear_tool_uses_20250919",
    };
    expect(dialesSonNuestros({ edits: [desordenado] })).toBe(false);
  });

  it("un dial distinto en cualquier valor, o dos edits de tool_uses → nuestros", () => {
    expect(dialesSonNuestros({ edits: [{ ...NUESTRO_EDIT, keep: { type: "tool_uses", value: DIAL_KEEP_TOOL_USES + 1 } }] })).toBe(true);
    expect(dialesSonNuestros({ edits: [NUESTRO_EDIT, { type: "clear_tool_uses_20250919" }] })).toBe(true);
  });

  it("triggerDelCliente: null sin clear_tool_uses; el de la API (100K) si no lo declara; el suyo si lo declara; el menor si hay varios", () => {
    expect(triggerDelCliente(undefined)).toBeNull();
    expect(triggerDelCliente({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] })).toBeNull();
    expect(triggerDelCliente({ edits: [{ type: "clear_tool_uses_20250919" }] })).toBe(TRIGGER_POR_DEFECTO_DE_LA_API);
    expect(triggerDelCliente({ edits: [NUESTRO_EDIT] })).toBe(DIAL_TRIGGER_INPUT_TOKENS);
    expect(triggerDelCliente({ edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 20_000 } }] })).toBe(20_000);
    expect(
      triggerDelCliente({
        edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 20_000 } }, { type: "clear_tool_uses_20250919" }],
      }),
    ).toBe(20_000);
    // Formas raras → el de la API (ante la duda, no acreditar de más).
    expect(triggerDelCliente({ edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: "mil" } }] })).toBe(
      TRIGGER_POR_DEFECTO_DE_LA_API,
    );
    expect(triggerDelCliente({ edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "otro", value: 5 } }] })).toBe(
      TRIGGER_POR_DEFECTO_DE_LA_API,
    );
    expect(ajustarDiales(Buffer.from(CUERPO))!.triggerDelCliente).toBe(TRIGGER_POR_DEFECTO_DE_LA_API);
  });

  it("ajustarDiales lo declara en la salida, y el cuerpo ajustado es el mismo en ambos casos", () => {
    const deFabrica = ajustarDiales(Buffer.from(CUERPO))!;
    expect(deFabrica.nuestros).toBe(true);
    const yaNuestro = ajustarDiales(
      Buffer.from(JSON.stringify({ ...JSON.parse(CUERPO), context_management: { edits: [NUESTRO_EDIT] } })),
    )!;
    expect(yaNuestro.nuestros).toBe(false);
    expect(JSON.parse(yaNuestro.cuerpo.toString("utf8")).context_management).toEqual({ edits: [NUESTRO_EDIT] });
    expect(JSON.parse(deFabrica.cuerpo.toString("utf8")).context_management).toEqual({ edits: [NUESTRO_EDIT] });
  });
});

/**
 * B2 de punta a punta: el proveedor declara un borrado, y lo que llega a la
 * ingesta es el CONTEO siempre y el SUELO solo cuando el borrado es nuestro —
 * a precio de LECTURA de caché, nunca de entrada.
 */
describe("el suelo de la elisión, de punta a punta (B2)", () => {
  const TOKENS_BORRADOS = 28_543;
  const precio = precioDeLista("claude-sonnet-4-5")!;

  it("el precio de lectura de caché del modelo del test es 10× más barato que el de entrada (si no, el test no distingue)", () => {
    expect(precio.cachedInputPer1k).toBeGreaterThan(0);
    expect(precio.cachedInputPer1k!).toBeLessThan(precio.inputPer1k / 5);
  });

  it("ENCENDIDA y borrado del proveedor → eliminatedInputTokens = conteo y eliminatedInputFloorCost = tokens × precio de LECTURA", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamConBorrado(recibidas, TOKENS_BORRADOS);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = lotes.flat()[0] as Record<string, unknown>;
    expect(reg["basis"]).toBe("measured");
    expect(reg["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    const suelo = reg["eliminatedInputFloorCost"] as number;
    expect(suelo).toBeCloseTo((TOKENS_BORRADOS / 1_000) * precio.cachedInputPer1k!, 12);
    // Y jamás a precio de entrada: la cifra falsa sería 10× esta.
    expect(suelo).toBeLessThan((TOKENS_BORRADOS / 1_000) * precio.inputPer1k / 5);
    // El suelo es carril PROPIO: el dinero medido no se mueve.
    expect(reg["baselineCost"]).toBe(reg["actualCost"]);
    expect(reg["netSavings"]).toBe(0);
  });

  it("⛔ el cliente YA mandaba nuestros diales → el conteo viaja, el suelo NO (ese ahorro es suyo)", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamConBorrado(recibidas, TOKENS_BORRADOS);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    await pedir(g.puerto, JSON.stringify({ ...JSON.parse(CUERPO), context_management: { edits: [NUESTRO_EDIT] } }));
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = lotes.flat()[0] as Record<string, unknown>;
    expect(reg["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    expect("eliminatedInputFloorCost" in reg).toBe(false);
  });

  it("⛔ palanca APAGADA y el proveedor borra igual (diales del cliente) → conteo sí, suelo no", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamConBorrado(recibidas, TOKENS_BORRADOS);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: false });
    await esperarCanal();

    await pedir(g.puerto, CUERPO);
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = lotes.flat()[0] as Record<string, unknown>;
    expect(recibidas[0]!.body).toBe(CUERPO);
    expect(reg["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    expect("eliminatedInputFloorCost" in reg).toBe(false);
  });

  it("⛔ el de FÁBRICA del cliente habría disparado (prompt original ≥ 100K) → conteo sí, suelo NO (ese ahorro era suyo)", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    // Entrada medida 80K + 28,5K borrados = 108,5K ≥ trigger de la API (100K).
    const upstream = await arrancarUpstreamConBorrado(recibidas, TOKENS_BORRADOS, { inputTokens: 80_000 });
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    await pedir(g.puerto, CUERPO); // CUERPO lleva el clear_tool_uses de fábrica (sin trigger)
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = lotes.flat()[0] as Record<string, unknown>;
    expect(reg["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    expect("eliminatedInputFloorCost" in reg).toBe(false);
  });

  it("⛔ el cliente traía un trigger PROPIO más bajo que el prompt → conteo sí, suelo NO", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamConBorrado(recibidas, TOKENS_BORRADOS); // 10 + 28,5K ≥ 20K
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    await pedir(
      g.puerto,
      JSON.stringify({
        ...JSON.parse(CUERPO),
        context_management: { edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 20_000 } }] },
      }),
    );
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = lotes.flat()[0] as Record<string, unknown>;
    expect(reg["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    expect("eliminatedInputFloorCost" in reg).toBe(false);
  });

  it("⛔ el proveedor borró solo THINKING (config del cliente) → conteo sí, suelo NO; mixto → suelo SOLO de los tool_uses", async () => {
    for (const [edits, tokensNuestros] of [
      [[{ type: "clear_thinking_20251015", cleared_input_tokens: 40_000 }], 0],
      [
        [
          { type: "clear_thinking_20251015", cleared_input_tokens: 40_000 },
          { type: "clear_tool_uses_20250919", cleared_input_tokens: 8_000, cleared_tool_uses: 2 },
        ],
        8_000,
      ],
    ] as [unknown[], number][]) {
      const recibidas: Recibida[] = [];
      const lotes: unknown[][] = [];
      const upstream = await arrancarUpstreamConBorrado(recibidas, 0, { edits });
      const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
      const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
      await esperarCanal();

      const { context_management: _fuera, ...sinCm } = JSON.parse(CUERPO);
      await pedir(g.puerto, JSON.stringify(sinCm)); // sin diales del cliente: los nuestros, atribuibles
      await g.cerrar();
      await esperar(() => lotes.length > 0);

      const reg = lotes.flat()[0] as Record<string, unknown>;
      expect(reg["eliminatedInputTokens"]).toBe(40_000 + tokensNuestros);
      if (tokensNuestros === 0) expect("eliminatedInputFloorCost" in reg).toBe(false);
      else expect(reg["eliminatedInputFloorCost"]).toBeCloseTo((tokensNuestros / 1_000) * precio.cachedInputPer1k!, 12);
    }
  });

  it("sin borrado del proveedor, el campo no existe en el wire (el de siempre)", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    await pedir(g.puerto, CUERPO);
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const reg = lotes.flat()[0] as Record<string, unknown>;
    expect(reg["eliminatedInputTokens"]).toBe(0);
    expect("eliminatedInputFloorCost" in reg).toBe(false);
  });
});

describe("describirEstadoDeElision — el brazo dicho al arrancar", () => {
  it("la bandera abre el CANAL, no los diales: el cartel ya no dice ARMADA por tener canal (2026-09-09)", () => {
    // El cartel mentía cada mañana: decía «ARMADA … brazo PALANCA» cuando lo
    // único abierto era el canal de entitlements. Ahora nombra las dos cosas
    // por separado, porque de ese canal cuelga la rebaja de TTL (la que gana)
    // y los diales (la que pierde) tienen bandera propia.
    expect(describirEstadoDeElision("1", true).linea).toMatch(/canal S4a: ABIERTO \(BVSALA_GATEWAY_ELISION=1\)/);
    expect(describirEstadoDeElision(undefined, true).linea).toMatch(/canal S4a: ABIERTO por defecto/);
    expect(describirEstadoDeElision("0", true).linea).toMatch(/canal S4a: CERRADO.*sin rebaja de TTL y sin diales/);
    // Y jamás vuelve a anunciar la elisión como armada solo por tener canal.
    expect(describirEstadoDeElision("1", true).linea).toContain("diales de elisión APAGADOS");
    expect(describirEstadoDeElision("1", true).aviso).toBe(false);
  });

  it("los diales armados a mano SE ANUNCIAN y levantan aviso", () => {
    const armados = describirEstadoDeElision("1", true, true);
    expect(armados.linea).toMatch(/DIALES DE ELISIÓN ARMADOS A MANO/);
    expect(armados.linea).toContain("R=4,05");
    expect(armados.aviso).toBe(true);
  });

  it("⛔ sin clave el canal NO se abre y, si la bandera decía =1, es un AVISO (la intención no se cumple)", () => {
    const conBandera = describirEstadoDeElision("1", false);
    expect(conBandera.linea).toMatch(/canal S4a: NO SE ABRE.*falta BIVELIO_SERVICE_KEY.*ni rebaja de TTL ni diales/);
    expect(conBandera.aviso).toBe(true);
    const sinBandera = describirEstadoDeElision(undefined, false);
    expect(sinBandera.linea).toMatch(/canal S4a: NO SE ABRE.*ni rebaja de TTL ni diales$/);
    expect(sinBandera.aviso).toBe(false);
  });
});

describe("conBetaDeElision — añade sin pisar", () => {
  it("sin cabecera previa → solo la nuestra", () => {
    expect(conBetaDeElision(undefined)).toBe(BETA_CONTEXT_MANAGEMENT);
    expect(conBetaDeElision("")).toBe(BETA_CONTEXT_MANAGEMENT);
  });
  it("conserva las betas del cliente (oauth y extended-cache-ttl tarifan)", () => {
    const previa = "oauth-2025-04-20,extended-cache-ttl-2025-04-11";
    expect(conBetaDeElision(previa)).toBe(`${previa},${BETA_CONTEXT_MANAGEMENT}`);
  });
  it("idempotente si ya está", () => {
    const previa = `oauth-2025-04-20, ${BETA_CONTEXT_MANAGEMENT}`;
    expect(conBetaDeElision(previa)).toBe(previa);
  });
});

describe("la palanca de punta a punta", () => {
  it("🔑 apagar B NO apaga A: sin diales, la REBAJA DE TTL sigue ocurriendo (2026-09-09)", async () => {
    // La mitad que de verdad importa del cambio. Hasta hoy una sola bandera
    // armaba las dos palancas, así que apagar la que pierde apagaba la que
    // gana. Este test lo ancla: con el canal abierto, ambos entitlements en la
    // licencia y `dialesElision` SIN poner, el upstream tiene que recibir el
    // TTL rebajado a 5m y CERO context_management.
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({
      features: ["context_elision", "cache_ttl_tuning"],
    });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test" }); // sin dialesElision
    await esperarCanal();

    const cuerpo = JSON.stringify({
      model: "claude-fable-5-1",
      messages: [{ role: "user", content: "hola" }],
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
    });
    const res = await pedir(g.puerto, cuerpo, { "anthropic-beta": "oauth-2025-04-20" });
    expect(res.status).toBe(200);
    const json = JSON.parse(recibidas[0]!.body);
    // A SIGUE VIVA: el 1h del cliente viaja rebajado a 5m.
    expect(json.system[0].cache_control.ttl).toBe("5m");
    // B ESTÁ MUERTA: ni diales ni beta añadida.
    expect(json.context_management).toBeUndefined();
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("APAGADA por defecto aunque la licencia traiga context_elision (2026-09-09)", async () => {
    // El default se INVIERTE. Hasta hoy los diales se armaban solos con el
    // entitlement; medida la palanca en pérdida por tres vías independientes
    // (simulador honesto +49 % de coste, carril sombra en producción, y
    // R = 4,05 frente a R* = 0,0127 en fable-5-1), ahora hacen falta CUATRO
    // interruptores y el cuarto se pone a mano: `dialesElision`.
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test" }); // sin dialesElision
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO, { "anthropic-beta": "oauth-2025-04-20" });
    expect(res.status).toBe(200);
    // El cuerpo viaja INTACTO: ni context_management ni beta añadida.
    expect(recibidas[0]!.body).toBe(CUERPO);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("APAGADA con el freno explícito (elision:false, desde BVSALA_GATEWAY_ELISION=0): passthrough aunque haya entitlement", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: false });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO, { "anthropic-beta": "oauth-2025-04-20" });
    expect(res.status).toBe(200);
    expect(recibidas[0]!.body).toBe(CUERPO);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("bandera local SIN feature en la licencia → intacto (medio opt-in no basta)", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["semantic_cache"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    await pedir(g.puerto, CUERPO);
    expect(recibidas[0]!.body).toBe(CUERPO);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("FAIL-CLOSED: plataforma caída → intacto y el tráfico fluye", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ estado: 500 });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    expect(recibidas[0]!.body).toBe(CUERPO);
  });

  it("ENCENDIDA (triple opt-in: canal + entitlement + dialesElision): el upstream recibe nuestros diales y la beta fusionada", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO, { "anthropic-beta": "oauth-2025-04-20" });
    expect(res.status).toBe(200);
    const json = JSON.parse(recibidas[0]!.body);
    expect(json.context_management.edits[0].trigger.value).toBe(DIAL_TRIGGER_INPUT_TOKENS);
    expect(json.messages).toEqual([{ role: "user", content: "hola" }]);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe(`oauth-2025-04-20,${BETA_CONTEXT_MANAGEMENT}`);
    // La respuesta al cliente sigue siendo la del upstream, intacta.
    expect(await res.json()).toEqual(JSON.parse(RESPUESTA_JSON));
  });

  it("ENCENDIDA pero cuerpo comprimido → intacto (passthrough ante la duda)", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, dialesElision: true });
    await esperarCanal();

    const comprimido = gzipSync(Buffer.from(CUERPO));
    await pedir(g.puerto, comprimido, { "content-encoding": "gzip" });
    expect(Buffer.from(recibidas[0]!.body, "utf8").length).toBeGreaterThan(0);
    expect(recibidas[0]!.headers["content-encoding"]).toBe("gzip");
    expect(recibidas[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("sin clave de servicio la palanca ni se arma (no hay org que consultar)", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const g = await gatewayCon({ upstream, elision: true }); // sin clave
    await pedir(g.puerto, CUERPO);
    expect(recibidas[0]!.body).toBe(CUERPO);
  });
});

describe("CanalDeEntitlements — fail-closed de verdad", () => {
  it("respuesta con forma inesperada → set vacío", async () => {
    const canal = new CanalDeEntitlements({
      url: "http://127.0.0.1:1/api/org/entitlements",
      serviceAccountKey: "bvk_x",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ features: "no-es-array" }), { status: 200 })) as typeof fetch,
    });
    await canal.refrescar();
    expect(canal.tiene("context_elision")).toBe(false);
  });

  it("una retirada del feature se aplica en el siguiente refresco", async () => {
    let features = ["context_elision"];
    const canal = new CanalDeEntitlements({
      url: "http://127.0.0.1:1/api/org/entitlements",
      serviceAccountKey: "bvk_x",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ features, refreshAfterSeconds: 300 }), { status: 200 })) as typeof fetch,
    });
    await canal.refrescar();
    expect(canal.tiene("context_elision")).toBe(true);
    features = [];
    await canal.refrescar();
    expect(canal.tiene("context_elision")).toBe(false);
  });
});

describe("captura de la elisión aplicada — la forma sondeada en vivo (04-09)", async () => {
  const { ObservadorSse, elisionDeJson, elisionDeContextManagement } = await import("../gateway/medidor.js");

  it("SSE: los applied_edits viajan en message_delta y el observador los captura", () => {
    const obs = new ObservadorSse();
    obs.observar(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":43250,"output_tokens":2}}}\n\n',
    );
    expect(obs.elision()).toBeNull(); // en message_start va a null (sondeado)
    obs.observar(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":43250,"output_tokens":35},"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_input_tokens":28543,"cleared_tool_uses":2}]}}\n\n',
    );
    expect(obs.elision()).toEqual({ borrados: 1, tokensLimpiados: 28543, tokensLimpiadosToolUses: 28543 });
    expect(obs.usage()?.input_tokens).toBe(43250);
  });

  it("JSON (stream:false): el bloque top-level", () => {
    const cuerpo = JSON.stringify({
      id: "msg_1",
      usage: { input_tokens: 43250, output_tokens: 47 },
      context_management: { applied_edits: [{ type: "clear_tool_uses_20250919", cleared_input_tokens: 28543, cleared_tool_uses: 2 }] },
    });
    expect(elisionDeJson(cuerpo)).toEqual({ borrados: 1, tokensLimpiados: 28543, tokensLimpiadosToolUses: 28543 });
    expect(elisionDeJson('{"usage":{"input_tokens":1}}')).toBeNull();
    expect(elisionDeJson("no-json")).toBeNull();
  });

  it("formas raras → null, jamás throw", () => {
    expect(elisionDeContextManagement(null)).toBeNull();
    expect(elisionDeContextManagement({ applied_edits: [] })).toBeNull();
    expect(elisionDeContextManagement({ applied_edits: "x" })).toBeNull();
    expect(elisionDeContextManagement({ applied_edits: [{ cleared_input_tokens: "mil" }] })).toEqual({
      borrados: 1,
      tokensLimpiados: 0,
      tokensLimpiadosToolUses: 0,
    });
  });

  it("B2 · el thinking borrado se CUENTA en el total pero no en tokensLimpiadosToolUses (es config del cliente)", () => {
    const mixto = elisionDeContextManagement({
      applied_edits: [
        { type: "clear_thinking_20251015", cleared_input_tokens: 40_000 },
        { type: "clear_tool_uses_20250919", cleared_input_tokens: 8_000, cleared_tool_uses: 2 },
      ],
    });
    expect(mixto).toEqual({ borrados: 2, tokensLimpiados: 48_000, tokensLimpiadosToolUses: 8_000 });
    const soloThinking = elisionDeContextManagement({
      applied_edits: [{ type: "clear_thinking_20251015", cleared_input_tokens: 40_000 }],
    });
    expect(soloThinking).toEqual({ borrados: 1, tokensLimpiados: 40_000, tokensLimpiadosToolUses: 0 });
  });
});

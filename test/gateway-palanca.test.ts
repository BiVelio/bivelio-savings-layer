import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { ajustarDiales, conBetaDeElision, describirEstadoDeElision, fusionarDiales } from "../gateway/palanca.js";
import { CanalDeEntitlements } from "../gateway/entitlements.js";
import {
  BETA_CONTEXT_MANAGEMENT,
  DIAL_TRIGGER_INPUT_TOKENS,
  DIAL_KEEP_TOOL_USES,
  DIAL_CLEAR_AT_LEAST_INPUT_TOKENS,
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

// `claude-fable-5` y no otro: es el único modelo con medición POSITIVA en
// src/pricing/aptitud-de-elision.ts, así que la verja de aptitud lo deja
// pasar y estos casos siguen probando LA PALANCA. Con un modelo sin medir
// probarían la verja, que tiene sus propios tests.
const CUERPO = JSON.stringify({
  model: "claude-fable-5",
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

/** Plataforma falsa: ingesta (202) + entitlements con las features indicadas. */
function arrancarPlataformaFalsa(opciones: { features?: string[]; estado?: number }): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
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
    const json = JSON.parse(salida!.toString("utf8"));
    expect(json.context_management).toEqual({ edits: [NUESTRO_EDIT] });
    // El contenido del cliente no se toca (superficie mínima).
    expect(json.model).toBe("claude-fable-5");
    expect(json.messages).toEqual([{ role: "user", content: "hola" }]);
    expect(json.max_tokens).toBe(64);
  });

  it("LA VERJA DE APTITUD: con la verja cerrada devuelve null y el cuerpo viaja intacto", () => {
    // Un modelo sin medición no se elide (doctrina de la duda). El contrato de
    // la función ya era «null = passthrough», así que la verja no añade un
    // camino de error nuevo: reutiliza el que existía.
    const cerrada = ajustarDiales(Buffer.from(CUERPO, "utf8"), undefined, () => ({
      aplicar: false,
      motivo: "sin-medicion" as const,
    }));
    expect(cerrada).toBeNull();

    // Y con la verja abierta se comporta exactamente igual que sin verja.
    const abierta = ajustarDiales(Buffer.from(CUERPO, "utf8"), undefined, () => ({
      aplicar: true,
      motivo: "aplica" as const,
    }));
    expect(abierta).not.toBeNull();
    expect(abierta!.toString("utf8")).toBe(ajustarDiales(Buffer.from(CUERPO, "utf8"))!.toString("utf8"));
  });

  it("CONSERVA el clear_thinking del cliente, en posición 0 (lo que Claude Code manda de fábrica)", () => {
    // Corpus 09-2026 (claude-cli ≥ 2.1.252): {edits:[{type:"clear_thinking_20251015",keep:"all"}]}.
    // Pisarlo cambiaría el thinking retenido (y la caché) en los modelos cuyo
    // default no es «todo»; la API exige clear_thinking en primera posición.
    const cuerpo = JSON.stringify({
      ...JSON.parse(CUERPO),
      context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    });
    const json = JSON.parse(ajustarDiales(Buffer.from(cuerpo))!.toString("utf8"));
    expect(json.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }, NUESTRO_EDIT],
    });
  });

  it("sin context_management → solo el nuestro", () => {
    const { context_management: _fuera, ...sinCm } = JSON.parse(CUERPO);
    const json = JSON.parse(ajustarDiales(Buffer.from(JSON.stringify(sinCm)))!.toString("utf8"));
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
    expect(a!.equals(b!)).toBe(true);
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

describe("describirEstadoDeElision — el brazo dicho al arrancar", () => {
  it("con clave: =1 y sin bandera son PALANCA; =0 es CONTROL", () => {
    expect(describirEstadoDeElision("1", true).linea).toMatch(/ARMADA \(BVSALA_GATEWAY_ELISION=1\).*brazo PALANCA/);
    expect(describirEstadoDeElision(undefined, true).linea).toMatch(/ARMADA por defecto.*brazo PALANCA/);
    expect(describirEstadoDeElision("0", true).linea).toMatch(/APAGADA.*brazo CONTROL/);
    expect(describirEstadoDeElision("1", true).aviso).toBe(false);
  });

  it("⛔ sin clave la palanca NO se arma y, si la bandera decía =1, es un AVISO (la intención no se cumple)", () => {
    const conBandera = describirEstadoDeElision("1", false);
    expect(conBandera.linea).toMatch(/NO SE ARMA.*falta BIVELIO_SERVICE_KEY.*brazo CONTROL AUNQUE la bandera diga =1/);
    expect(conBandera.aviso).toBe(true);
    const sinBandera = describirEstadoDeElision(undefined, false);
    expect(sinBandera.linea).toMatch(/NO SE ARMA.*brazo CONTROL$/);
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
  it("ARMADA por defecto (sin pasar elision) cuando la licencia trae context_elision", async () => {
    // El nuevo default es opt-out: sin bandera, con clave de servicio y el feature en
    // la licencia, S4a se arma sola. El gate real es el entitlement, no una bandera.
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test" }); // sin elision → default-on
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO, { "anthropic-beta": "oauth-2025-04-20" });
    expect(res.status).toBe(200);
    const json = JSON.parse(recibidas[0]!.body);
    expect(json.context_management.edits[0].trigger.value).toBe(DIAL_TRIGGER_INPUT_TOKENS);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBe(`oauth-2025-04-20,${BETA_CONTEXT_MANAGEMENT}`);
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
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true });
    await esperarCanal();

    await pedir(g.puerto, CUERPO);
    expect(recibidas[0]!.body).toBe(CUERPO);
    expect(recibidas[0]!.headers["anthropic-beta"]).toBeUndefined();
  });

  it("FAIL-CLOSED: plataforma caída → intacto y el tráfico fluye", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ estado: 500 });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    expect(recibidas[0]!.body).toBe(CUERPO);
  });

  it("ENCENDIDA (doble opt-in): el upstream recibe nuestros diales y la beta fusionada", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true });
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
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true });
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
    expect(obs.elision()).toEqual({ borrados: 1, tokensLimpiados: 28543 });
    expect(obs.usage()?.input_tokens).toBe(43250);
  });

  it("JSON (stream:false): el bloque top-level", () => {
    const cuerpo = JSON.stringify({
      id: "msg_1",
      usage: { input_tokens: 43250, output_tokens: 47 },
      context_management: { applied_edits: [{ type: "clear_tool_uses_20250919", cleared_input_tokens: 28543, cleared_tool_uses: 2 }] },
    });
    expect(elisionDeJson(cuerpo)).toEqual({ borrados: 1, tokensLimpiados: 28543 });
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
    });
  });
});

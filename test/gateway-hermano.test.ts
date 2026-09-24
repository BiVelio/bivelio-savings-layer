import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { testLicense } from "./helpers/test-license.js";
import {
  HERMANOS,
  describirEstadoDeHermano,
  esHermanoMasBarato,
  hermanoDe,
  reescribirModelo,
} from "../gateway/hermano.js";
import { ahorroDeHermano, costeDeTokens, costeMedido, informeMedido } from "../gateway/medidor.js";
import { claveDeCatalogo, precioDeLista } from "../src/pricing/catalogo.js";
import { PRIMA_ESCRITURA_CACHE, PRIMA_ESCRITURA_CACHE_1H, primaDeEscritura } from "../src/pricing/primas.js";

/**
 * Palanca C · el MODELO HERMANO (fable-5 → fable-5-1), de punta a punta.
 *
 * Las verjas que importan:
 *  1. La VERJA DE PRECIOS lee el catálogo, nunca cifras tecleadas: si Anthropic
 *     cambia la tarifa de 5.1 y alguien actualiza catalogo.ts, este fichero
 *     ROMPE en CI y obliga a revalidar el par antes de seguir cobrándolo.
 *  2. La reescritura toca SOLO `model` y solo el alias exacto; ids con fecha
 *     (pin del cliente), con prefijo de proveedor, con `[1m]` o desconocidos
 *     viajan intactos; idempotente sobre el hermano. `tool_choice` forzado
 *     (any/tool, 400 en 5.1) también pasa intacto.
 *  2b. Un 400 del upstream tras la reescritura se REINTENTA una vez con el
 *     cuerpo y las cabeceras originales, y se mide lo que viajó.
 *  3. APAGADA por defecto y doble opt-in (bandera local + feature en la
 *     licencia); fail-closed por el mismo canal que S4a y A.
 *  4. Contabilidad: baseline al precio del SOLICITADO, actual al SERVIDO,
 *     basis `measured`, y cero ahorro fuera de la lectura de caché.
 *  5. count_tokens se reescribe (el cliente estima contra lo que va a
 *     responder) pero NO se mide.
 */

const SOLICITADO = "claude-fable-5";
const SERVIDO = "claude-fable-5-1";

const PETICION = {
  model: SOLICITADO,
  max_tokens: 64,
  system: [{ type: "text", text: "sé breve", cache_control: { type: "ephemeral", ttl: "1h" } }],
  messages: [{ role: "user", content: "hola" }],
  tools: [{ name: "leer", input_schema: { type: "object" } }],
  metadata: { user_id: "u1" },
  context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
};
const cuerpoDe = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

describe("la verja de precios del par (contra el catálogo, nunca tecleada)", () => {
  it("fable-5 y fable-5-1 comparten entrada, salida y prima; solo la lectura de caché es más barata", () => {
    const a = precioDeLista(SOLICITADO)!;
    const b = precioDeLista(SERVIDO)!;
    expect(a.inputPer1k).toBe(b.inputPer1k);
    expect(a.outputPer1k).toBe(b.outputPer1k);
    expect(primaDeEscritura(SOLICITADO)).toBe(primaDeEscritura(SERVIDO));
    expect(b.cachedInputPer1k!).toBeLessThan(a.cachedInputPer1k!);
    expect(esHermanoMasBarato(SOLICITADO, SERVIDO)).toBe(true);
  });

  it("cada par del mapa pasa la verja (si el catálogo cambia, esto rompe a propósito)", () => {
    for (const [solicitado, servido] of Object.entries(HERMANOS)) {
      expect(claveDeCatalogo(solicitado)).toBe(solicitado);
      expect(claveDeCatalogo(servido)).toBe(servido);
      expect(esHermanoMasBarato(solicitado, servido)).toBe(true);
    }
  });

  it("no acepta un par con precio base distinto ni uno desconocido", () => {
    expect(esHermanoMasBarato("claude-opus-4-8", SERVIDO)).toBe(false);
    expect(esHermanoMasBarato(SOLICITADO, "modelo-inventado")).toBe(false);
    expect(esHermanoMasBarato(SERVIDO, SOLICITADO)).toBe(false); // al revés sería más caro
  });
});

describe("hermanoDe — por clave de catálogo, con la duda hacia el passthrough", () => {
  it("fable-5 → fable-5-1; la instantánea con fecha es un pin del cliente y NO se toca", () => {
    expect(hermanoDe(SOLICITADO)).toEqual({ solicitado: SOLICITADO, servido: SERVIDO });
    expect(hermanoDe("claude-fable-5-20260401")).toBeNull();
  });

  it("es idempotente: el hermano y sus instantáneas no se tocan", () => {
    expect(hermanoDe(SERVIDO)).toBeNull();
    expect(hermanoDe("claude-fable-5-1-20260901")).toBeNull();
  });

  it("el prefijo de proveedor NO mapea: la reescritura lo perdería y el upstream vería otro id", () => {
    expect(hermanoDe("anthropic/claude-fable-5")).toBeNull();
  });

  it("ids con [1m], otros modelos y vacíos → null", () => {
    expect(hermanoDe("claude-fable-5[1m]")).toBeNull();
    expect(hermanoDe("claude-opus-4-8")).toBeNull();
    expect(hermanoDe("claude-sonnet-4-5")).toBeNull();
    expect(hermanoDe("")).toBeNull();
  });
});

describe("reescribirModelo — solo `model`, determinista", () => {
  it("sustituye model y deja el resto del JSON idéntico", () => {
    const r = reescribirModelo(cuerpoDe(PETICION));
    expect(r).not.toBeNull();
    expect(r!.cambio).toEqual({ solicitado: SOLICITADO, servido: SERVIDO });
    const json = JSON.parse(r!.cuerpo.toString("utf8"));
    expect(json.model).toBe(SERVIDO);
    const { model: _a, ...restoSalida } = json;
    const { model: _b, ...restoEntrada } = PETICION;
    expect(restoSalida).toEqual(restoEntrada);
  });

  it("es determinista: dos cuerpos byte-iguales dan salidas byte-iguales (la coalescencia lo exige)", () => {
    const a = reescribirModelo(cuerpoDe(PETICION))!.cuerpo;
    const b = reescribirModelo(cuerpoDe(PETICION))!.cuerpo;
    expect(a.equals(b)).toBe(true);
  });

  it("null ante comprimido, JSON roto, forma ajena o modelo sin hermano", () => {
    expect(reescribirModelo(gzipSync(cuerpoDe(PETICION)), "gzip")).toBeNull();
    expect(reescribirModelo(Buffer.from("{no", "utf8"))).toBeNull();
    expect(reescribirModelo(cuerpoDe({ model: SOLICITADO }))).toBeNull();
    expect(reescribirModelo(cuerpoDe({ ...PETICION, model: "claude-opus-4-8" }))).toBeNull();
    expect(reescribirModelo(cuerpoDe({ ...PETICION, model: SERVIDO }))).toBeNull();
    expect(reescribirModelo(cuerpoDe({ ...PETICION, model: "claude-fable-5[1m]" }))).toBeNull();
  });

  it("null si la petición fuerza herramienta (`tool_choice` any/tool: 5.1 devuelve 400 donde 5 respondía)", () => {
    for (const tc of [{ type: "any" }, { type: "tool", name: "leer" }]) {
      expect(reescribirModelo(cuerpoDe({ ...PETICION, tool_choice: tc }))).toBeNull();
    }
    for (const tc of [{ type: "auto" }, { type: "none" }]) {
      expect(reescribirModelo(cuerpoDe({ ...PETICION, tool_choice: tc }))).not.toBeNull();
    }
  });

  it("null si la petición trae la beta de contexto 1M (sin validar en mano, no se toca)", () => {
    expect(reescribirModelo(cuerpoDe(PETICION), undefined, { betas: "context-1m-2025-08-07" })).toBeNull();
    expect(reescribirModelo(cuerpoDe(PETICION), undefined, { betas: "oauth-2025-04-20, context-1m-2025-08-07" })).toBeNull();
    expect(reescribirModelo(cuerpoDe(PETICION), undefined, { betas: "oauth-2025-04-20,claude-code-20250219" })).not.toBeNull();
  });
});

describe("contabilidad — baseline al solicitado, actual al servido, basis measured", () => {
  const N = 200_000;
  const lecturaSolicitado = precioDeLista(SOLICITADO)!.cachedInputPer1k!;
  const lecturaServido = precioDeLista(SERVIDO)!.cachedInputPer1k!;
  type Coste = { cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string } };

  it("con solo lectura de caché: ahorro = N/1000 × (lectura solicitado − lectura servido), del catálogo", () => {
    const medido = costeMedido(SERVIDO, { cache_read_input_tokens: N })!;
    const cambio = { solicitado: SOLICITADO, servido: SERVIDO };
    const esperado = (N / 1_000) * (lecturaSolicitado - lecturaServido);
    expect(ahorroDeHermano(cambio, medido)).toBeCloseTo(esperado, 12);
    const inf = informeMedido("req-c1", SERVIDO, medido, undefined, null, null, cambio) as unknown as Coste;
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.actual).toBeCloseTo(medido.costeUsd, 12);
    expect(inf.cost.baselineEstimate - inf.cost.actual).toBeCloseTo(esperado, 12);
    expect(inf.cost.netSavings).toBeCloseTo(esperado / inf.cost.baselineEstimate, 12);
    expect(inf.cost.netSavings).toBeGreaterThan(-100);
    expect(inf.cost.netSavings).toBeLessThanOrEqual(1);
    // Con la aritmética del catálogo de hoy es exactamente 0,00075/1K: lo
    // comprobamos por la vía del catálogo, no tecleando la cifra.
    expect(inf.cost.baselineEstimate).toBeCloseTo(costeDeTokens(precioDeLista(SOLICITADO)!, medido.tokens, SOLICITADO), 12);
  });

  it("sin lectura de caché (entrada, salida y escrituras 5m/1h) el ahorro es 0 EXACTO", () => {
    const medido = costeMedido(SERVIDO, {
      input_tokens: 5_000,
      output_tokens: 1_000,
      cache_creation_input_tokens: 40_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 30_000 },
    })!;
    expect(ahorroDeHermano({ solicitado: SOLICITADO, servido: SERVIDO }, medido)).toBe(0);
    const inf = informeMedido("req-c2", SERVIDO, medido, undefined, null, null, {
      solicitado: SOLICITADO,
      servido: SERVIDO,
    }) as unknown as Coste;
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
    expect(inf.cost.netSavings).toBe(0);
  });

  it("tráfico de SUSCRIPCIÓN con C aplicada: baseline == actual (sin factura por tokens no se acredita)", () => {
    const medido = costeMedido(SERVIDO, { cache_read_input_tokens: N })!;
    const cambio = { solicitado: SOLICITADO, servido: SERVIDO };
    expect(ahorroDeHermano(cambio, medido)).toBeGreaterThan(0); // habría ahorro que acreditar…
    const inf = informeMedido("r", SERVIDO, medido, undefined, null, null, cambio, true) as unknown as Coste;
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual); // …y no se acredita
    expect(inf.cost.netSavings).toBe(0);
    expect(inf.cost.basis).toBe("measured");
  });

  it("sin hermano, el resto de peticiones no cambia: baseline == actual y netSavings 0", () => {
    const medido = costeMedido(SOLICITADO, { input_tokens: 100, cache_read_input_tokens: N, output_tokens: 10 })!;
    const inf = informeMedido("req-c3", SOLICITADO, medido) as unknown as Coste;
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
    expect(inf.cost.netSavings).toBe(0);
  });

  it("composición A+C: baseline = actual + sobrecoste evitado + ahorro del hermano", () => {
    const escrita5m = 100_000;
    const medido = costeMedido(SERVIDO, {
      cache_read_input_tokens: N,
      cache_creation_input_tokens: escrita5m,
      cache_creation: { ephemeral_5m_input_tokens: escrita5m, ephemeral_1h_input_tokens: 0 },
    })!;
    const inf = informeMedido(
      "req-c4",
      SERVIDO,
      medido,
      undefined,
      null,
      { rebajadas: 2, yaEran5m: 0 },
      { solicitado: SOLICITADO, servido: SERVIDO },
    ) as unknown as Coste;
    const sobrecoste = (escrita5m / 1_000) * medido.precio.inputPer1k * (PRIMA_ESCRITURA_CACHE_1H - PRIMA_ESCRITURA_CACHE);
    const hermano = (N / 1_000) * (lecturaSolicitado - lecturaServido);
    expect(inf.cost.baselineEstimate - inf.cost.actual).toBeCloseTo(sobrecoste + hermano, 12);
    expect(inf.cost.basis).toBe("measured");
  });

  it("regresión del refactor: costeDeTokens reproduce costeMedido byte a byte para un usage completo", () => {
    const uso = {
      input_tokens: 1_234,
      output_tokens: 567,
      cache_read_input_tokens: 89_012,
      cache_creation_input_tokens: 34_567,
      cache_creation: { ephemeral_5m_input_tokens: 4_567, ephemeral_1h_input_tokens: 30_000 },
    };
    for (const m of [SOLICITADO, SERVIDO, "claude-opus-4-8", "claude-sonnet-4-5"]) {
      const medido = costeMedido(m, uso)!;
      expect(costeDeTokens(medido.precio, medido.tokens, m)).toBe(medido.costeUsd);
    }
  });
});

describe("describirEstadoDeHermano — la palanca dicha en voz alta al arrancar", () => {
  it("apagada sin bandera; avisa si hay bandera pero no clave o el canal está cerrado; armada con todo", () => {
    expect(describirEstadoDeHermano(undefined, true, true)).toMatchObject({ aviso: false });
    expect(describirEstadoDeHermano(undefined, true, true).linea).toContain("OFF");
    expect(describirEstadoDeHermano("0", true, true).linea).toContain("OFF");
    expect(describirEstadoDeHermano("1", false, true)).toMatchObject({ aviso: true });
    expect(describirEstadoDeHermano("1", true, false)).toMatchObject({ aviso: true });
    const armada = describirEstadoDeHermano("1", true, true);
    expect(armada.aviso).toBe(false);
    expect(armada.linea).toContain("ARMED");
    expect(armada.linea).toContain(`${SOLICITADO}→${SERVIDO}`);
    expect(armada.linea).toContain("sibling_model_routing");
  });
});

// ── E2E contra servidores falsos ────────────────────────────────────────────

const N_LECTURA = 150_000;
const SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"model":"${SERVIDO}","usage":{"input_tokens":100,"cache_read_input_tokens":${N_LECTURA},"output_tokens":1}}}\n\n`,
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"cache_read_input_tokens":${N_LECTURA},"output_tokens":42}}\n\n`,
  "event: message_stop\ndata: {}\n\n",
].join("");

/** El mismo SSE, pero declarando el modelo SOLICITADO (lo que sirve el reintento). */
const SSE_SOLICITADO = SSE.replaceAll(SERVIDO, SOLICITADO);

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

/** Upstream SSE con usage de lectura de caché; count_tokens responde JSON. */
function arrancarUpstreamFalso(recibidas: Recibida[]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: 12 }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/**
 * Upstream que devuelve 400 a CUALQUIER petición que pida el modelo servido
 * (fable-5-1) y 200 al resto: la forma de un rechazo causado por la propia
 * reescritura (thinking firmado por otro modelo, `tool_choice` forzado…).
 */
function arrancarUpstreamQueRechazaAlHermano(recibidas: Recibida[]): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString("utf8");
      recibidas.push({ path: req.url ?? "", headers: { ...req.headers }, body });
      let model = "";
      try {
        model = (JSON.parse(body) as { model?: string }).model ?? "";
      } catch {
        /* cuerpo no JSON: se trata como aceptable */
      }
      if (model === SERVIDO) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "unsupported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_SOLICITADO);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

function arrancarPlataformaFalsa(opciones: { features?: string[]; lotes?: unknown[][] }): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.url === "/api/org/entitlements") {
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

async function esperar(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando la condición");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function gatewayCon(opciones: {
  upstream: number;
  plataforma?: number;
  elision?: boolean;
  modeloHermano?: boolean;
  dialesElision?: boolean;
  clave?: string;
}): Promise<GatewayArrancado> {
  const g = await arrancarGateway({
    license: testLicense(),
    puerto: 0,
    upstream: `http://127.0.0.1:${opciones.upstream}`,
    ...(opciones.clave !== undefined ? { serviceAccountKey: opciones.clave } : {}),
    ...(opciones.plataforma !== undefined
      ? { meteringUrl: `http://127.0.0.1:${opciones.plataforma}/api/metering/usage` }
      : {}),
    ...(opciones.elision !== undefined ? { elision: opciones.elision } : {}),
    ...(opciones.modeloHermano !== undefined ? { modeloHermano: opciones.modeloHermano } : {}),
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

async function pedir(puerto: number, cuerpo: string | Buffer, ruta = "/v1/messages", cabeceras: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${puerto}${ruta}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...cabeceras },
    body: cuerpo,
  });
}

const CUERPO = JSON.stringify(PETICION);

describe("palanca C de punta a punta", () => {
  it("ENCENDIDA (bandera + feature): el upstream recibe fable-5-1 en /v1/messages y en count_tokens, resto intacto", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    const texto = await res.text();
    // La respuesta del proveedor llega intacta: dice fable-5-1 y el gateway no la toca.
    expect(texto).toContain(`"model":"${SERVIDO}"`);

    const resCount = await pedir(g.puerto, CUERPO, "/v1/messages/count_tokens");
    expect(resCount.status).toBe(200);

    expect(recibidas).toHaveLength(2);
    for (const r of recibidas) {
      const json = JSON.parse(r.body);
      expect(json.model).toBe(SERVIDO);
      const { model: _a, ...resto } = json;
      const { model: _b, ...original } = PETICION;
      expect(resto).toEqual(original);
    }
    expect(recibidas[1]!.path).toBe("/v1/messages/count_tokens");
  });

  it("APAGADA por defecto: sin la opción, el cuerpo viaja byte a byte", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true });
    await esperarCanal();
    await pedir(g.puerto, CUERPO);
    expect(recibidas[0]!.body).toBe(CUERPO);
  });

  it("FAIL-CLOSED: con la opción pero sin el feature en la licencia, intacto", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    // Solo context_elision: sin `dialesElision` no reescribe nada. Con
    // cache_ttl_tuning la palanca A rebajaría el TTL del prefijo nuevo y el
    // cuerpo dejaría de ser byte-igual por A, no por C — que es lo que se prueba.
    const plataforma = await arrancarPlataformaFalsa({ features: ["context_elision"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();
    await pedir(g.puerto, CUERPO);
    expect(recibidas[0]!.body).toBe(CUERPO);
    expect(JSON.parse(recibidas[0]!.body).model).toBe(SOLICITADO);
  });

  it("BVSALA_GATEWAY_ELISION=0 (palancas desarmadas) apaga también C", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: false, modeloHermano: true });
    await esperarCanal();
    await pedir(g.puerto, CUERPO);
    expect(recibidas[0]!.body).toBe(CUERPO);
  });

  it("ENCENDIDA pero el modelo no mapea (ya es 5.1, [1m], otro modelo) o el cuerpo va comprimido → intacto", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();

    const variantes = [
      JSON.stringify({ ...PETICION, model: SERVIDO }),
      JSON.stringify({ ...PETICION, model: "claude-fable-5[1m]" }),
      JSON.stringify({ ...PETICION, model: "claude-opus-4-8" }),
    ];
    for (const v of variantes) await pedir(g.puerto, v);
    const comprimido = gzipSync(Buffer.from(CUERPO));
    await pedir(g.puerto, comprimido, "/v1/messages", { "content-encoding": "gzip" });
    // Y con la beta de contexto 1M: no se toca hasta validarla en mano.
    await pedir(g.puerto, CUERPO, "/v1/messages", { "anthropic-beta": "context-1m-2025-08-07" });

    expect(recibidas.map((r) => r.body)).toEqual([...variantes, comprimido.toString("utf8"), CUERPO]);
  });

  it("MEDIDA: el lote lleva el modelo servido, baseline > actual por exactamente la lectura de caché, basis measured", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    await res.text();
    // count_tokens reescrito pero NO medido: no debe aparecer en el lote.
    await (await pedir(g.puerto, CUERPO, "/v1/messages/count_tokens")).text();
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros).toHaveLength(1);
    const reg = registros[0]!;
    expect(reg["model"]).toBe(SERVIDO);
    expect(reg["basis"]).toBe("measured");
    const esperado = costeMedido(SERVIDO, { input_tokens: 100, cache_read_input_tokens: N_LECTURA, output_tokens: 42 })!;
    expect(reg["actualCost"]).toBeCloseTo(esperado.costeUsd, 12);
    const lecturaSolicitado = precioDeLista(SOLICITADO)!.cachedInputPer1k!;
    const lecturaServido = precioDeLista(SERVIDO)!.cachedInputPer1k!;
    const ahorro = (N_LECTURA / 1_000) * (lecturaSolicitado - lecturaServido);
    expect((reg["baselineCost"] as number) - (reg["actualCost"] as number)).toBeCloseTo(ahorro, 12);
    expect(reg["netSavings"]).toBeCloseTo(ahorro / (reg["baselineCost"] as number), 12);
    expect(reg["netSavings"] as number).toBeGreaterThan(0);
    expect(reg["netSavings"] as number).toBeLessThanOrEqual(1);
  });

  it("MEDIDA en SUSCRIPCIÓN (anthropic-beta oauth-*): C se aplica, el lote lleva el servido y NO acredita ahorro", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO, "/v1/messages", { "anthropic-beta": "oauth-2025-04-20" });
    expect(res.status).toBe(200);
    await res.text();
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    // La palanca SÍ se aplica (valor contra topes)…
    expect(JSON.parse(recibidas[0]!.body).model).toBe(SERVIDO);
    // …pero sin factura por tokens el dinero no se acredita: baseline == actual.
    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros).toHaveLength(1);
    const reg = registros[0]!;
    expect(reg["model"]).toBe(SERVIDO);
    expect(reg["basis"]).toBe("measured");
    expect(reg["baselineCost"]).toBe(reg["actualCost"]);
    expect(reg["netSavings"]).toBe(0);
  });

  it("encadenada con los diales de S4a: el cuerpo saliente lleva las dos cosas", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamFalso(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing", "context_elision"] });
    const g = await gatewayCon({
      upstream,
      plataforma,
      clave: "bvk_test",
      elision: true,
      dialesElision: true,
      modeloHermano: true,
    });
    await esperarCanal();
    const conTools = JSON.stringify({
      ...PETICION,
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    });
    await pedir(g.puerto, conTools);
    const json = JSON.parse(recibidas[0]!.body);
    expect(json.model).toBe(SERVIDO);
    expect(json.context_management.edits.some((e: { trigger?: unknown }) => e.trigger !== undefined)).toBe(true);
  });

  it("REINTENTO INTACTO: un 400 tras la reescritura reenvía el cuerpo original y el cliente ve el 200", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamQueRechazaAlHermano(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();

    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    await res.text();

    // Dos viajes: el reescrito (400) y el original (200). Sin C el cliente
    // habría tenido el segundo directamente; con C paga un viaje, no un fallo.
    expect(recibidas).toHaveLength(2);
    expect(JSON.parse(recibidas[0]!.body).model).toBe(SERVIDO);
    expect(recibidas[1]!.body).toBe(CUERPO);
    expect(JSON.parse(recibidas[1]!.body).model).toBe(SOLICITADO);
  });

  it("REINTENTO INTACTO: lo que se mide es lo que viajó — modelo solicitado y CERO ahorro de C", async () => {
    const recibidas: Recibida[] = [];
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamQueRechazaAlHermano(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"], lotes });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true, modeloHermano: true });
    await esperarCanal();
    await (await pedir(g.puerto, CUERPO)).text();
    await g.cerrar();
    await esperar(() => lotes.length > 0);

    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros).toHaveLength(1);
    // El upstream sirvió con el modelo SOLICITADO: cobrar el ahorro de C aquí
    // sería inventarse dinero sobre una petición que C no llegó a servir.
    expect(registros[0]!["baselineCost"]).toBe(registros[0]!["actualCost"]);
    expect(registros[0]!["netSavings"]).toBe(0);
  });

  it("un 400 SIN palanca C no se reintenta: el cliente ve su propio 400, un solo viaje", async () => {
    const recibidas: Recibida[] = [];
    const upstream = await arrancarUpstreamQueRechazaAlHermano(recibidas);
    const plataforma = await arrancarPlataformaFalsa({ features: ["sibling_model_routing"] });
    const g = await gatewayCon({ upstream, plataforma, clave: "bvk_test", elision: true });
    await esperarCanal();
    // Sin C el cuerpo va con fable-5 y este upstream falso solo rechaza a 5.1,
    // así que responde 200 al primer viaje: lo que se prueba es que NO hay dos.
    const res = await pedir(g.puerto, CUERPO);
    expect(res.status).toBe(200);
    await res.text();
    expect(recibidas).toHaveLength(1);
  });
});

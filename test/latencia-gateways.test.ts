import { createServer, request as peticionHttp, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import {
  BETAS_DE_FIDELIDAD,
  compararCabeceras,
  compararCuerpos,
  compararSseMensajes,
  cuerpoDeChat,
  cuerpoDeFidelidad,
  cuerpoDeFidelidadAnthropic,
  diferenciasProfundas,
  ENTRADA_DE_FIDELIDAD,
  esLoopback,
  extremosRemotos,
  icMediana,
  ordenesMultibrazo,
  percentil,
  percentiles,
  resumir,
  USO_DE_FIDELIDAD_ANTHROPIC,
  usoDeSse,
  type Ronda,
} from "../benchmarks/latencia-gateways/nucleo.js";
import { arrancarUpstreamFalso, type UpstreamFalso } from "../benchmarks/latencia-gateways/upstream-falso.js";
import {
  CABECERAS_DE_MENSAJES,
  medirCargaVarios,
  medirEscenarioMultibrazo,
  medirFidelidad,
  medirFidelidadMensajes,
  MENSAJES_BVSALA,
  objetivosDeTerceros,
  type ResultadoDeFidelidadMensajes,
} from "../benchmarks/latencia-gateways/arnes.js";
import { testLicense } from "./helpers/test-license.js";

/**
 * EL BANCO DE LATENCIA DE GATEWAYS (benchmarks/latencia-gateways/) — lo que el
 * informe de inteligencia competitiva del 2026-09-27 cita como «medido». Si la
 * estadística, el upstream falso o la prueba de fidelidad se equivocan, las
 * tablas del informe mienten; esto lo ata.
 *
 * Ninguna petición sale de 127.0.0.1.
 */

let recursos: (UpstreamFalso | GatewayArrancado | Server)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

describe("núcleo: percentiles e intervalos", () => {
  it("percentil de tipo 7 (el de R y NumPy): interpola entre rangos", () => {
    expect(percentil([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentil([1, 2, 3, 4], 0)).toBe(1);
    expect(percentil([1, 2, 3, 4], 1)).toBe(4);
    expect(percentil([10], 0.99)).toBe(10);
    expect(Number.isNaN(percentil([], 0.5))).toBe(true);
    const p = percentiles([5, 1, 4, 2, 3]);
    expect(p).toMatchObject({ n: 5, p50: 3, max: 5 });
  });

  it("IC de la mediana: reproducible con la misma semilla y degenerado en una muestra constante", () => {
    const xs = Array.from({ length: 200 }, (_, i) => (i % 7) * 0.1 + 1);
    const a = icMediana(xs, { semilla: 42 });
    const b = icMediana(xs, { semilla: 42 });
    expect(a).toEqual(b);
    expect(a.inferior).toBeLessThanOrEqual(a.punto);
    expect(a.superior).toBeGreaterThanOrEqual(a.punto);
    expect(icMediana(new Array(50).fill(0.3))).toEqual({ punto: 0.3, inferior: 0.3, superior: 0.3 });
  });

  it("el orden de cada ronda es una permutación de todos los brazos, determinista y sin sesgo de posición", () => {
    const ordenes = ordenesMultibrazo(3000, 4, 7);
    for (const o of ordenes) expect([...o].sort()).toEqual([0, 1, 2, 3]);
    expect(ordenesMultibrazo(3000, 4, 7)).toEqual(ordenes);
    // El directo (0) sale primero ~1/4 de las rondas: ningún brazo se queda con
    // la posición buena por construcción.
    const primeroDirecto = ordenes.filter((o) => o[0] === 0).length / ordenes.length;
    expect(primeroDirecto).toBeGreaterThan(0.2);
    expect(primeroDirecto).toBeLessThan(0.3);
  });

  it("resumir: un gateway que añade 1 ms exacto da sobrecoste 1 con IC [1, 1]", () => {
    const rondas: Ronda[] = Array.from({ length: 100 }, (_, i) => {
      const base = 2 + (i % 5) * 0.5;
      return {
        directo: { primerByteMs: base, totalMs: base + 3 },
        gateway: { primerByteMs: base + 1, totalMs: base + 4 },
        primero: i % 2 ? "directo" : "gateway",
      };
    });
    const r = resumir(rondas, 3);
    expect(r.sobrecoste.totalMs.punto).toBeCloseTo(1, 10);
    expect(r.sobrecoste.totalMs.inferior).toBeCloseTo(1, 10);
    expect(r.sobrecoste.totalMs.superior).toBeCloseTo(1, 10);
    expect(r.sobrecoste.primerByteMs.punto).toBeCloseTo(1, 10);
    expect(r.orden).toEqual({ directoPrimero: 50, gatewayPrimero: 50 });
  });
});

describe("núcleo: los cuerpos", () => {
  it("cuerpoDeChat: JSON válido del tamaño pedido, determinista, y el stream pide el usage", () => {
    for (const bytes of [1_024, 200_000]) {
      const c = cuerpoDeChat({ bytes, modelo: "gpt-4o-mini", stream: false });
      expect(c.length).toBe(bytes);
      expect(cuerpoDeChat({ bytes, modelo: "gpt-4o-mini", stream: false })).toBe(c);
      expect(JSON.parse(c).model).toBe("gpt-4o-mini");
    }
    const s = JSON.parse(cuerpoDeChat({ bytes: 1_024, modelo: "m", stream: true }));
    expect(s.stream).toBe(true);
    expect(s.stream_options).toEqual({ include_usage: true });
  });

  it("el cuerpo de fidelidad lleva los campos que cambian la factura", () => {
    const c = JSON.parse(cuerpoDeFidelidad("gpt-5-mini"));
    expect(c).toMatchObject({ model: "gpt-5-mini", service_tier: "flex", prompt_cache_key: "banco-fidelidad", store: false, parallel_tool_calls: false });
    expect(c.tools).toHaveLength(1);
    expect(c.temperature).toBeUndefined();
  });

  it("compararCuerpos distingue bytes, orden de claves, claves perdidas, añadidas y cambiadas", () => {
    const a = JSON.stringify({ model: "a", x: 1, y: { z: [1, 2] }, k: "v" });
    expect(compararCuerpos(a, a)).toEqual({ identicoEnBytes: true, mismoJson: true, perdidas: [], anadidas: [], cambiadas: [] });
    const reordenado = JSON.stringify({ k: "v", y: { z: [1, 2] }, x: 1, model: "a" });
    expect(compararCuerpos(a, reordenado)).toMatchObject({ identicoEnBytes: false, mismoJson: true });
    const tocado = JSON.stringify({ model: "openai/a", x: 2, y: { z: [1, 2] }, nueva: null });
    expect(compararCuerpos(a, tocado, ["model"])).toEqual({
      identicoEnBytes: false,
      mismoJson: false,
      perdidas: ["k"],
      anadidas: ["nueva"],
      cambiadas: ["x"],
    });
    // Un cuerpo que no es JSON solo se compara en bytes.
    expect(compararCuerpos("no json", "no json")).toMatchObject({ identicoEnBytes: true, mismoJson: true });
  });
});

describe("núcleo: la fidelidad en el dialecto de Anthropic (E1)", () => {
  it("el cuerpo de Mensajes lleva lo que cambia la factura de Claude, en las formas oficiales", () => {
    const c = JSON.parse(cuerpoDeFidelidadAnthropic("claude-opus-5-5"));
    expect(c.model).toBe("claude-opus-5-5");
    expect(c.stream).toBeUndefined();
    // TTL de 1 h en system, en una herramienta y en el último turno del usuario.
    expect(c.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(c.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(c.messages[2].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Búsqueda de herramientas: la herramienta, una diferida SIN cache_control y el tool_reference.
    expect(c.tools[0].type).toBe("tool_search_tool_regex_20251119");
    expect(c.tools[2]).toMatchObject({ name: "lookup_order", defer_loading: true });
    expect(c.tools[2].cache_control).toBeUndefined();
    expect(c.messages[1].content[1].content.tool_references).toEqual([{ type: "tool_reference", tool_name: "lookup_order" }]);
    // Herramientas en línea: un mensaje system a mitad de conversación, por definición y por referencia.
    expect(c.messages[3].role).toBe("system");
    expect(c.messages[3].content.map((b: { tool: { type: string } }) => b.tool.type)).toEqual(["tool_definition", "tool_reference"]);
    expect(JSON.parse(cuerpoDeFidelidadAnthropic("m", { stream: true })).stream).toBe(true);
    expect(BETAS_DE_FIDELIDAD.split(",")).toContain("inline-tools-2026-09-15");
    expect(CABECERAS_DE_MENSAJES["anthropic-beta"]).toBe(BETAS_DE_FIDELIDAD);
  });

  it("diferenciasProfundas dice QUÉ ruta se perdió dentro del cuerpo, no solo la clave de primer nivel", () => {
    const a = JSON.parse(cuerpoDeFidelidadAnthropic("claude-haiku-4-5"));
    const b = structuredClone(a);
    delete b.system[0].cache_control.ttl;
    b.tools.pop();
    b.model = "otro";
    b.metadata = { user_id: "x" };
    expect(diferenciasProfundas(a, b, ["model"])).toEqual({
      perdidas: ["system[0].cache_control.ttl", "tools[2]"],
      anadidas: ["metadata"],
      cambiadas: [],
    });
    expect(diferenciasProfundas(a, a)).toEqual({ perdidas: [], anadidas: [], cambiadas: [] });
    expect(diferenciasProfundas({ x: 1 }, { x: "1" }).cambiadas).toEqual(["x"]);
  });

  it("compararCabeceras: perdidas y cambiadas, sin distinguir mayúsculas en lo enviado", () => {
    const enviadas = { "Anthropic-Version": "2023-06-01", "anthropic-beta": "a,b" };
    expect(compararCabeceras(enviadas, { "anthropic-version": "2023-06-01", "anthropic-beta": "a,b" })).toEqual({ perdidas: [], cambiadas: [] });
    expect(compararCabeceras(enviadas, { "anthropic-version": "2023-06-01" })).toEqual({ perdidas: ["anthropic-beta"], cambiadas: [] });
    expect(compararCabeceras(enviadas, { "anthropic-version": "2023-06-01", "anthropic-beta": "a" })).toEqual({ perdidas: [], cambiadas: ["anthropic-beta"] });
  });

  it("compararSseMensajes: eventos y usage fusionado (message_start ∪ message_delta), con el desglose de 1 h", () => {
    const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
    const directa =
      ev("message_start", { type: "message_start", message: { usage: { input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 9 }, output_tokens: 1 } } }) +
      ev("message_delta", { type: "message_delta", usage: { output_tokens: 7 } }) +
      ev("message_stop", { type: "message_stop" });
    expect(usoDeSse(directa)).toEqual({ input_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 9 }, output_tokens: 7 });
    expect(compararSseMensajes(directa, directa)).toMatchObject({ identicoEnBytes: true, mismosEventos: true, uso: { perdidas: [], anadidas: [], cambiadas: [] } });
    const sinDesglose = directa.replace(',"cache_creation":{"ephemeral_1h_input_tokens":9}', "");
    const c = compararSseMensajes(directa, sinDesglose.replace(ev("message_stop", { type: "message_stop" }), ""));
    expect(c.mismosEventos).toBe(false);
    expect(c.eventosGateway).toEqual(["message_start", "message_delta"]);
    expect(c.uso.perdidas).toEqual(["cache_creation.ephemeral_1h_input_tokens"]);
  });
});

describe("núcleo: los extremos remotos de lsof", () => {
  it("se queda con los remotos no locales y descarta loopback y sockets escuchando", () => {
    const salida = [
      "p123",
      "f10",
      "n127.0.0.1:52000->127.0.0.1:9911",
      "f11",
      "n*:4000",
      "f12",
      "n192.168.1.20:52001->185.199.108.133:443",
      "f13",
      "n[::1]:52002->[::1]:8080",
      "f14",
      "n[2606:4700::6810:84e5]:52003->[2606:4700::6810:84e5]:443",
      "f15",
      "n192.168.1.20:52004->185.199.108.133:443",
    ].join("\n");
    expect(extremosRemotos(salida)).toEqual([
      { host: "185.199.108.133", puerto: 443 },
      { host: "[2606:4700::6810:84e5]", puerto: 443 },
    ]);
    expect(esLoopback("127.0.0.53")).toBe(true);
    expect(esLoopback("[::1]")).toBe(true);
    expect(esLoopback("10.0.0.1")).toBe(false);
  });
});

interface RespuestaDeChat {
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

describe("el upstream falso", () => {
  const post = (puerto: number, ruta: string, cuerpo: unknown) =>
    fetch(`http://127.0.0.1:${puerto}${ruta}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) });

  it("Chat Completions sin stream: el modelo de la petición y un usage ≈ bytes/4", async () => {
    const u = await arrancarUpstreamFalso();
    recursos.push(u);
    const cuerpo = { model: "gpt-4o-mini", messages: [{ role: "user", content: "x".repeat(400) }] };
    const r = (await (await post(u.puerto, "/v1/chat/completions", cuerpo)).json()) as RespuestaDeChat;
    expect(r.model).toBe("gpt-4o-mini");
    expect(r.usage.prompt_tokens).toBe(Math.round(JSON.stringify(cuerpo).length / 4));
    expect(r.usage.completion_tokens).toBe(12);
    expect(u.recuento()).toMatchObject({ chat: 1 });
  });

  it("Chat Completions en stream: el usage llega en el último trozo solo si se pidió, y termina en [DONE]", async () => {
    const u = await arrancarUpstreamFalso({ trozos: 3, entreTrozosMs: 0 });
    recursos.push(u);
    const con = await (await post(u.puerto, "/v1/chat/completions", { model: "m", stream: true, stream_options: { include_usage: true }, messages: [] })).text();
    const sin = await (await post(u.puerto, "/v1/chat/completions", { model: "m", stream: true, messages: [] })).text();
    expect(con.trim().endsWith("data: [DONE]")).toBe(true);
    expect(con).toContain('"choices":[],"usage"');
    expect(sin).not.toContain('"usage"');
    expect(u.recuento()).toMatchObject({ "chat-stream": 2 });
  });

  it("Messages en stream: message_start con el usage de entrada y message_delta con la salida", async () => {
    const u = await arrancarUpstreamFalso({ trozos: 2, entreTrozosMs: 0 });
    recursos.push(u);
    const sse = await (await post(u.puerto, "/v1/messages", { model: "claude-haiku-4-5", stream: true, messages: [] })).text();
    expect(sse.startsWith("event: message_start")).toBe(true);
    expect(sse).toContain('"output_tokens":12');
    expect(sse.trim().endsWith('{"type":"message_stop"}')).toBe(true);
  });

  it("Mensajes con la marca de fidelidad: usage fijo con la escritura de 1 h, una tool_use, y el espejo de cabeceras", async () => {
    const u = await arrancarUpstreamFalso({ trozos: 2, entreTrozosMs: 0 });
    recursos.push(u);
    const cabeceras = { "content-type": "application/json", ...CABECERAS_DE_MENSAJES };
    const json = (await (await fetch(`http://127.0.0.1:${u.puerto}/v1/messages`, { method: "POST", headers: cabeceras, body: cuerpoDeFidelidadAnthropic("claude-haiku-4-5") })).json()) as {
      usage: unknown;
      content: { type: string }[];
      stop_reason: string;
    };
    expect(json.usage).toEqual(USO_DE_FIDELIDAD_ANTHROPIC);
    expect(json.content[0]!.type).toBe("tool_use");
    expect(json.stop_reason).toBe("tool_use");
    const recibidas = (await (await fetch(`http://127.0.0.1:${u.puerto}/banco/ultimas-cabeceras`)).json()) as Record<string, string>;
    expect(recibidas["anthropic-beta"]).toBe(BETAS_DE_FIDELIDAD);
    expect(recibidas["anthropic-version"]).toBe("2023-06-01");
    const sse = await (await fetch(`http://127.0.0.1:${u.puerto}/v1/messages`, { method: "POST", headers: cabeceras, body: cuerpoDeFidelidadAnthropic("claude-haiku-4-5", { stream: true }) })).text();
    expect(usoDeSse(sse)).toEqual(USO_DE_FIDELIDAD_ANTHROPIC);
    expect(sse).toContain('"type":"input_json_delta"');
  });

  it("la prueba de fidelidad recibe un usage fijo y el espejo devuelve los bytes recibidos", async () => {
    const u = await arrancarUpstreamFalso();
    recursos.push(u);
    const cuerpo = cuerpoDeFidelidad("gpt-5-mini");
    const r = (await (await fetch(`http://127.0.0.1:${u.puerto}/v1/chat/completions`, { method: "POST", body: cuerpo })).json()) as RespuestaDeChat;
    expect(r.usage.prompt_tokens).toBe(ENTRADA_DE_FIDELIDAD);
    expect(await (await fetch(`http://127.0.0.1:${u.puerto}/banco/ultima-peticion`)).text()).toBe(cuerpo);
  });
});

describe("el arnés contra el gateway de BV-SALA (en proceso)", () => {
  async function montar(): Promise<{ u: UpstreamFalso; g: GatewayArrancado }> {
    const u = await arrancarUpstreamFalso({ trozos: 2, entreTrozosMs: 0 });
    recursos.push(u);
    const g = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${u.puerto}`, license: testLicense(), log: () => {}, warn: () => {} });
    recursos.push(g);
    return { u, g };
  }

  it("mide rondas multibrazo: cada ronda pasa una vez por cada brazo y el directo se comparte", async () => {
    const { u, g } = await montar();
    const g2 = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${u.puerto}`, license: testLicense(), log: () => {}, warn: () => {} });
    recursos.push(g2);
    const cuerpo = cuerpoDeChat({ bytes: 1_024, modelo: "gpt-4o-mini", stream: true });
    const destino = (puerto: number) => ({ url: new URL(`http://127.0.0.1:${puerto}/v1/chat/completions`), cabeceras: {}, cuerpo });
    const porGateway = await medirEscenarioMultibrazo({
      directo: destino(u.puerto),
      gateways: [
        { nombre: "uno", destino: destino(g.puerto) },
        { nombre: "dos", destino: destino(g2.puerto) },
      ],
      rondas: 10,
      calentamiento: 2,
    });
    expect(Object.keys(porGateway).sort()).toEqual(["dos", "uno"]);
    expect(porGateway.uno).toHaveLength(10);
    // 3 brazos × (10 rondas + 2 de calentamiento), todos contra el mismo upstream.
    expect(u.recuento()["chat-stream"]).toBe(3 * (10 + 2));
    // El directo de la ronda i es el MISMO para los dos gateways.
    for (let i = 0; i < 10; i++) expect(porGateway.uno![i]!.directo).toEqual(porGateway.dos![i]!.directo);
    const r = resumir(porGateway.uno!);
    expect(Number.isFinite(r.sobrecoste.totalMs.punto)).toBe(true);
    for (const x of porGateway.uno!) expect(x.gateway.primerByteMs).toBeLessThanOrEqual(x.gateway.totalMs);
  });

  it("fidelidad: sin palancas, el gateway de BV-SALA entrega los bytes intactos en los dos sentidos", async () => {
    const { u, g } = await montar();
    for (const m of ["gpt-4o-mini", "gpt-5-mini"]) {
      const f = await medirFidelidad(
        { nombre: "bvsala", base: `http://127.0.0.1:${g.puerto}`, rutaChat: "/v1/chat/completions", modelo: m, cabeceras: {} },
        `http://127.0.0.1:${u.puerto}`,
        m,
      );
      expect(f.peticion).toEqual({ identicoEnBytes: true, mismoJson: true, perdidas: [], anadidas: [], cambiadas: [] });
      expect(f.respuesta.identicoEnBytes).toBe(true);
    }
  });

  it("E1 · fidelidad en Mensajes: sin palancas, el gateway de BV-SALA entrega intactos cuerpo, anthropic-beta y respuesta (JSON y SSE)", async () => {
    const { u, g } = await montar();
    for (const m of ["claude-haiku-4-5", "claude-opus-5-5"]) {
      for (const stream of [false, true]) {
        const f = await medirFidelidadMensajes({ nombre: "bvsala", base: `http://127.0.0.1:${g.puerto}`, mensajes: MENSAJES_BVSALA }, `http://127.0.0.1:${u.puerto}`, m, stream);
        const donde = `${m} · ${stream ? "sse" : "json"}`;
        expect(f.peticion, donde).toEqual({ identicoEnBytes: true, mismoJson: true, perdidas: [], anadidas: [], cambiadas: [] });
        expect(f.peticionRutas, donde).toEqual({ perdidas: [], anadidas: [], cambiadas: [] });
        expect(f.cabeceras, donde).toEqual({ perdidas: [], cambiadas: [] });
        expect(f.betaRecibida, donde).toBe(BETAS_DE_FIDELIDAD);
        expect(f.roles.recibidos, donde).toEqual(["user", "assistant", "user", "system"]);
        expect(f.respuesta.identicoEnBytes, donde).toBe(true);
        expect(f.uso, donde).toEqual({ perdidas: [], anadidas: [], cambiadas: [] });
      }
    }
  });

  it("E1 · control: un proxy que quita el ttl y la beta SÍ se ve (la prueba tiene dientes)", async () => {
    const u = await arrancarUpstreamFalso({ trozos: 2, entreTrozosMs: 0 });
    recursos.push(u);
    // Un «gateway» mínimo que hace lo que haría uno descuidado: reserializa el
    // cuerpo sin el `ttl` de system y sin la herramienta diferida, y no reenvía
    // `anthropic-beta`. La respuesta sí la devuelve tal cual.
    const proxy = createServer(async (req, res) => {
      const trozos: Buffer[] = [];
      for await (const t of req) trozos.push(t as Buffer);
      const c = JSON.parse(Buffer.concat(trozos).toString("utf8"));
      delete c.system[0].cache_control.ttl;
      c.tools = c.tools.filter((t: { defer_loading?: boolean }) => !t.defer_loading);
      const cuerpo = JSON.stringify(c);
      const { "anthropic-beta": _beta, host: _host, "content-length": _cl, ...resto } = req.headers;
      const salida = peticionHttp(
        { host: "127.0.0.1", port: u.puerto, path: req.url, method: "POST", headers: { ...resto, "content-length": Buffer.byteLength(cuerpo) } },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      salida.end(cuerpo);
    });
    recursos.push(proxy);
    const puerto = await new Promise<number>((r) => proxy.listen(0, "127.0.0.1", () => r((proxy.address() as { port: number }).port)));
    const f: ResultadoDeFidelidadMensajes = await medirFidelidadMensajes(
      { nombre: "descuidado", base: `http://127.0.0.1:${puerto}`, mensajes: MENSAJES_BVSALA },
      `http://127.0.0.1:${u.puerto}`,
      "claude-haiku-4-5",
      false,
    );
    expect(f.peticion.identicoEnBytes).toBe(false);
    expect(f.peticionRutas.perdidas).toEqual(["system[0].cache_control.ttl", "tools[2]"]);
    expect(f.cabeceras.perdidas).toEqual(["anthropic-beta"]);
    expect(f.betaRecibida).toBeNull();
    expect(f.roles.recibidos).toEqual(f.roles.enviados);
    // La respuesta la devolvió intacta: la prueba separa los dos sentidos.
    expect(f.respuesta.identicoEnBytes).toBe(true);
  });

  it("carga: bloques alternos sin errores y RPS positivo en cada brazo", async () => {
    const { u, g } = await montar();
    const cuerpo = cuerpoDeChat({ bytes: 1_024, modelo: "gpt-4o-mini", stream: false });
    const c = await medirCargaVarios({
      brazos: [
        { nombre: "directo", destino: { url: new URL(`http://127.0.0.1:${u.puerto}/v1/chat/completions`), cabeceras: {}, cuerpo } },
        { nombre: "bvsala", destino: { url: new URL(`http://127.0.0.1:${g.puerto}/v1/chat/completions`), cabeceras: {}, cuerpo } },
      ],
      concurrencia: 4,
      peticionesPorBrazo: 40,
    });
    expect(c.directo!.peticiones).toBe(40);
    expect(c.directo!.errores + c.bvsala!.errores).toBe(0);
    expect(c.bvsala!.rps).toBeGreaterThan(0);
    expect(c.bvsala!.total.n).toBe(40);
  });
});

describe("los objetivos de terceros", () => {
  it("apuntan al upstream falso y a loopback, con el modelo que espera cada configuración", () => {
    const o = objetivosDeTerceros(9911, "gpt-5-mini");
    expect(Object.keys(o).sort()).toEqual(["bifrost", "helicone", "litellm", "portkey"]);
    for (const x of Object.values(o)) expect(new URL(x.base).hostname).toBe("127.0.0.1");
    expect(o.litellm!.modelo).toBe("bench-gpt-5-mini");
    expect(o.bifrost!.modelo).toBe("openai/gpt-5-mini");
    expect(o.portkey!.cabeceras["x-portkey-custom-host"]).toBe("http://127.0.0.1:9911/v1");
    // E1 · la ruta de Mensajes de cada uno (Helicone no entra: su catálogo acaba en 2025).
    expect(o.litellm!.mensajes).toMatchObject({ ruta: "/v1/messages" });
    expect(o.litellm!.mensajes!.modelo("claude-haiku-4-5")).toBe("bench-claude-haiku-4-5");
    expect(o.bifrost!.mensajes).toMatchObject({ ruta: "/anthropic/v1/messages" });
    expect(o.portkey!.mensajes!.cabeceras).toMatchObject({ "x-portkey-provider": "anthropic", "x-portkey-custom-host": "http://127.0.0.1:9911/v1" });
    expect(o.helicone!.mensajes).toBeUndefined();
    for (const x of Object.values(o)) for (const v of Object.values(x.mensajes?.cabeceras ?? {})) expect(v).not.toMatch(/sk-|bvk_|sbp_/);
    // Ninguna cabecera lleva nada con forma de clave real.
    for (const x of Object.values(o)) for (const v of Object.values(x.cabeceras)) expect(v).not.toMatch(/sk-|bvk_|sbp_/);
  });
});

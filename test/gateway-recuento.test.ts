import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { RecuentoDeMedicion, dolares, fraseDeDinero, resumenDeMedicion, type CosteDeInforme } from "../gateway/recuento.js";
import { costeMedido, informeMedido, informeCoalescido } from "../gateway/medidor.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import { testLicense } from "./helpers/test-license.js";
import { cajaLimpia, exigirBinCompilado, lanzar } from "./helpers/bvsala-proceso.js";

/**
 * EL RECUENTO DE LO MEDIDO — lo que el envoltorio imprime al salir, porque su
 * log por petición va callado (docs/investigacion/2026-09-27/agentes-de-codigo.md).
 *
 * Dos mitades: la línea (pura) y el recuento que lleva el gateway contra un
 * upstream FALSO en 127.0.0.1 (nada sale de la máquina). Lo que se fija:
 *   · lo medido se cuenta con el contador del proveedor, y nada se estima;
 *   · cada «not metered» de la API se cuenta con su motivo;
 *   · la telemetría y las sondas que un terminal manda por el base URL no
 *     cuentan como «no medido», y un error del proveedor tampoco (no factura);
 *   · 1.2.4 · la línea dice el DINERO: el gasto a precio de lista y el ahorro,
 *     cada base por separado, sumados de los mismos informes que van al panel
 *     — y si no hubo ahorro, por qué. Sin tocar nada del tráfico.
 */

/** Un coste inventado, sin palanca: baseline == actual. */
const SIN_AHORRO: CosteDeInforme = { actual: 0.25, netSavingsUsd: 0, basis: "measured" };
const costeDe = (informe: unknown): CosteDeInforme => (informe as { cost: CosteDeInforme }).cost;

describe("resumenDeMedicion — la línea de salida", () => {
  it("nada pasó por el gateway: lo dice, y dice dónde mirar", () => {
    const l = resumenDeMedicion(new RecuentoDeMedicion().estado(), "copilot");
    expect(l).toContain("[bvsala copilot] metering in this run: no inference request went through the gateway");
    expect(l).toContain("docs/terminales/");
  });

  it("todo medido: la cuenta, el gasto a precio de lista, por qué no hubo ahorro y dónde está el detalle", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    r.medida(SIN_AHORRO);
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).toBe(
      "[bvsala claude] metering in this run: 2 request(s) metered with the provider's usage · spent $0.5000 at list price · " +
        // e2e del 22-11: con --upstream deepseek la rebaja SÍ se acredita (api.deepseek.com es un origen
        // oficial): el texto lo dice, en vez de afirmar «solo en la API oficial de Anthropic».
        "saved $0.00: nothing was credited (cache TTL tuning is credited only on API-key /v1/messages traffic that " +
        "asks for the 1-hour cache and goes to the provider's own API - Anthropic's, or DeepSeek's Anthropic-compatible " +
        "one with --upstream deepseek; an opt-in lever or a proxy upstream can change a request without a credited " +
        "saving; the gateway's levers act on /v1/messages (the Anthropic protocol) only; see `bvsala --help`). " +
        "Per-request detail: run it again with BVSALA_GATEWAY_LOG=1 (one line per request, on stderr).",
    );
  });

  it("⛔ en modo solo-observar el $0 lo explica ESE modo, no la regla de la rebaja de TTL (verificación final 1.2.4)", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    const l = resumenDeMedicion(r.estado(), "claude", { soloObservar: true });
    expect(l).toContain(
      "saved $0.00: observe-only mode (BVSALA_GATEWAY_OBSERVE_ONLY=1) applies no lever; what they would have saved is " +
        "in the per-request `measure (shadow)` lines, never counted as a saving",
    );
    expect(l).not.toContain("cache TTL tuning is credited only");
    // Sin el modo, el motivo de siempre.
    expect(resumenDeMedicion(r.estado(), "claude")).toContain("cache TTL tuning is credited only");
  });

  it("⛔ con BVSALA_GATEWAY_ELISION=0 el $0 lo explica el freno, no la regla de la rebaja de TTL (e2e del 22-11)", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    const l = resumenDeMedicion(r.estado(), "gateway", { palancasApagadas: true, logVisible: true });
    expect(l).toContain("saved $0.00: every gateway lever is off (BVSALA_GATEWAY_ELISION=0); unset it to let the levers act");
    expect(l).not.toContain("cache TTL tuning is credited only");
    // Un ahorro que sí hubo (una réplica por referencia) se dice igual: el freno no lo tapa.
    r.replica({ actual: 0, netSavingsUsd: 0.05, basis: "reference" });
    const conReplica = resumenDeMedicion(r.estado(), "gateway", { palancasApagadas: true });
    expect(conReplica).toContain("$0.0500 in duplicate calls avoided (by reference)");
    expect(conReplica).not.toContain("saved $0.00");
  });

  it("⛔ el texto del $0 dice la verdad sobre DeepSeek: la rebaja de TTL se acredita en su origen oficial (e2e del 22-11)", async () => {
    const { esUpstreamOficial, rutaReescrita } = await import("../gateway/upstream.js");
    // `--upstream deepseek` es un origen oficial y el cliente sigue mandando /v1/messages (la ruta que mira la palanca).
    expect(esUpstreamOficial("https://api.deepseek.com")).toBe(true);
    expect(rutaReescrita("https://api.deepseek.com", "/v1/messages")).toBe("/anthropic/v1/messages");
    // Con escrituras de caché en el usage, la rebaja acredita ahorro `measured` también en deepseek-flash.
    const medido = costeMedido("deepseek-flash", { input_tokens: 331, output_tokens: 10, cache_creation_input_tokens: 100_000 })!;
    const rebaja = { rebajadas: 1, yaEran5m: 0, herramientaDeServidor: false };
    const oficial = costeDe(informeMedido("d-1", "deepseek-flash", medido, undefined, null, rebaja, null, false, false));
    expect(oficial.basis).toBe("measured");
    expect(oficial.netSavingsUsd).toBeGreaterThan(0);
    // Detrás de un proxy (origen no oficial), nada.
    const proxy = costeDe(informeMedido("d-2", "deepseek-flash", medido, undefined, null, rebaja, null, false, true));
    expect(proxy.netSavingsUsd).toBe(0);
    // Y el motivo del $0 ya no afirma «solo Anthropic».
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    const l = resumenDeMedicion(r.estado(), "gateway");
    expect(l).toContain("Anthropic's, or DeepSeek's Anthropic-compatible one with --upstream deepseek");
    expect(l).not.toContain("only on Anthropic API-key traffic");
  });

  it("con el log a la vista (`bvsala gateway`, o BVSALA_GATEWAY_LOG=1) el detalle está arriba, no en otra ejecución", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    const l = resumenDeMedicion(r.estado(), "gateway", { logVisible: true });
    expect(l).toContain("Per-request detail: the log lines above.");
    expect(l).not.toContain("BVSALA_GATEWAY_LOG");
  });

  it("⛔ la rebaja de TTL que ahorró sale en dólares, con su base: el MISMO neto que lleva el informe", () => {
    // Un informe de verdad: 100.000 tokens escritos en caché, rebajados de 1 h a 5 min.
    const medido = costeMedido("claude-opus-5", { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 100_000 })!;
    const informe = informeMedido("r-1", "claude-opus-5", medido, undefined, null, { rebajadas: 2, yaEran5m: 0, herramientaDeServidor: false });
    const coste = costeDe(informe);
    expect(coste.netSavingsUsd).toBeGreaterThan(0);
    const r = new RecuentoDeMedicion();
    r.medida(coste);
    r.medida(coste);
    const e = r.estado();
    expect(e.dinero.gastoUsd).toBeCloseTo(2 * coste.actual, 12);
    expect(e.dinero.ahorroMedidoUsd).toBeCloseTo(2 * coste.netSavingsUsd, 12);
    const l = resumenDeMedicion(e, "claude");
    expect(l).toContain(`spent ${dolares(2 * coste.actual)} at list price · saved ${dolares(2 * coste.netSavingsUsd)} (measured)`);
    expect(l).not.toContain("saved $0.00");
  });

  it("⛔ solo suscripción: equivalente a precio de lista, y $0 de ahorro porque ahí solo se mide", () => {
    const medido = costeMedido("claude-opus-5", { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 100_000 })!;
    // Con suscripción la rebaja no acredita nada aunque se hubiera aplicado: baseline == actual.
    const informe = informeMedido("s-1", "claude-opus-5", medido, undefined, null, { rebajadas: 2, yaEran5m: 0, herramientaDeServidor: false }, null, true);
    const r = new RecuentoDeMedicion();
    r.medida(costeDe(informe), true);
    const e = r.estado();
    expect(e.dinero).toMatchObject({ ahorroMedidoUsd: 0, deSuscripcion: 1 });
    const l = resumenDeMedicion(e, "claude");
    expect(l).toContain(`spent ${dolares(medido.costeUsd)} at list-price equivalent (subscription traffic: there is no per-token invoice)`);
    expect(l).toContain("saved $0.00: no saving is credited on a subscription (there is no per-token invoice)");
    expect(l).not.toContain("cache TTL tuning only acts");
  });

  it("mezcla de suscripción y clave de API: lo dice, y el motivo del $0 es el de las palancas", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO, true);
    r.medida(SIN_AHORRO);
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).toContain("spent $0.5000 at list price (1 request(s) on a subscription count at list-price equivalent)");
    expect(l).toContain("saved $0.00: nothing was credited");
  });

  it("⛔ si las palancas salieron caras (la entrada de 5 min caducó en una pausa) no se llama ahorro, y dice cómo apagarla", () => {
    const r = new RecuentoDeMedicion();
    r.medida({ actual: 2, netSavingsUsd: 0.1, basis: "measured" });
    r.medida({ actual: 3, netSavingsUsd: -0.4, basis: "measured" });
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).toContain("spent $5.00 at list price · the levers cost $0.3000 more than they saved (measured");
    expect(l).toContain("BVSALA_GATEWAY_ELISION=0 turns cache TTL tuning off");
    expect(l).not.toMatch(/ saved \$/);
  });

  it("las bases no se suman: medido, por referencia y estimado van cada uno con su nombre", () => {
    const medido = costeMedido("claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 1000 })!;
    const r = new RecuentoDeMedicion();
    r.medida({ actual: 1, netSavingsUsd: 0.2, basis: "measured" });
    // Una gemela sin referencia: estimada con el contador de su primaria.
    const estimada = costeDe(informeCoalescido("g-1", "claude-sonnet-4-6", medido));
    expect(estimada.basis).toBe("estimated");
    r.replica(estimada);
    r.replica({ actual: 0, netSavingsUsd: 0.05, basis: "reference" });
    // El hipotético de la sombra no es dinero de la sesión.
    r.replica({ actual: 0, netSavingsUsd: 99, basis: "shadow" });
    const e = r.estado();
    expect(e.dinero.gastoUsd).toBe(1);
    expect(e.dinero.ahorroMedidoUsd).toBe(0.2);
    expect(e.dinero.ahorroPorReferenciaUsd).toBe(0.05);
    expect(e.dinero.ahorroEstimadoUsd).toBeCloseTo(medido.costeUsd, 12);
    const frase = fraseDeDinero(e);
    expect(frase).toContain("saved $0.2000 (measured)");
    expect(frase).toContain("$0.0500 in duplicate calls avoided (by reference)");
    expect(frase).toContain(`about ${dolares(medido.costeUsd)} in duplicate calls avoided (estimated, never added to the measured figure)`);
    expect(frase).not.toContain("99");
  });

  it("sin nada medido no hay cifra de dinero ni puntero al detalle", () => {
    const r = new RecuentoDeMedicion();
    r.recibida();
    r.noMedida("the provider reported no usage");
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).not.toMatch(/\$|spent|saved|Per-request detail/);
    expect(fraseDeDinero(r.estado())).toBe("");
  });

  it("dolares: céntimos desde 1 $, cuatro decimales desde 1 céntimo, seis por debajo, y el ruido de coma flotante es $0.00", () => {
    expect(dolares(12.3456)).toBe("$12.35");
    expect(dolares(0.01234)).toBe("$0.0123");
    expect(dolares(1e-9)).toBe("$0.00");
    expect(dolares(-0.5)).toBe("$0.5000");
    // e2e del 22-11: 0,000044 $ salía «$0.0000». Ahora con la precisión de la línea por petición.
    expect(dolares(0.000044)).toBe("$0.000044");
    expect(dolares(0.0003)).toBe("$0.000300");
    expect(dolares(0.009999)).toBe("$0.009999");
    expect(dolares(6e-7)).toBe("$0.000001");
    expect(dolares(-0.000022)).toBe("$0.000022");
  });

  it("⛔ un gasto pequeño no sale «$0.0000» en el resumen (e2e del 22-11)", () => {
    const r = new RecuentoDeMedicion();
    r.medida({ actual: 0.000022, netSavingsUsd: 0, basis: "measured" });
    r.medida({ actual: 0.000022, netSavingsUsd: 0, basis: "measured" });
    r.replica({ actual: 0, netSavingsUsd: 0.0000098, basis: "reference" });
    const l = resumenDeMedicion(r.estado(), "gateway");
    expect(l).toContain("spent $0.000044 at list price · $0.000010 in duplicate calls avoided (by reference)");
    expect(l).not.toContain("$0.0000 ");
  });

  it("parte sin medir: los motivos, de más a menos, y que nada se estima en su lugar", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    r.noMedida("the request did not ask for usage (stream_options.include_usage)");
    r.noMedida('model "x" has no list price in the catalog');
    r.noMedida("the request did not ask for usage (stream_options.include_usage)");
    const l = resumenDeMedicion(r.estado(), "aider");
    expect(l).toContain("1 request(s) metered");
    expect(l).toContain("spent $0.2500 at list price");
    expect(l).toContain("3 forwarded but NOT metered (nothing is estimated in their place)");
    expect(l).toMatch(/docs\/terminales\/README\.md\. Per-request detail: /);
    expect(l.indexOf("2 × the request did not ask for usage")).toBeLessThan(l.indexOf('1 × model "x"'));
  });

  it("las réplicas coalescidas van aparte: no se llaman «medidas»", () => {
    const r = new RecuentoDeMedicion();
    r.medida(SIN_AHORRO);
    r.replica({ actual: 0, netSavingsUsd: 0.25, basis: "estimated" });
    const l = resumenDeMedicion(r.estado(), "claude");
    expect(l).toContain("1 request(s) metered with the provider's usage · 1 duplicate(s) answered with a replica");
    const solo = new RecuentoDeMedicion();
    solo.replica({ actual: 0, netSavingsUsd: 0.25, basis: "estimated" });
    expect(resumenDeMedicion(solo.estado(), "claude")).not.toContain("no inference request");
  });

  it("los motivos distintos tienen tope: un id de modelo por petición no hace crecer la memoria sin fin", () => {
    const r = new RecuentoDeMedicion();
    for (let i = 0; i < 500; i++) r.noMedida(`model "m${i}" has no list price in the catalog`);
    const e = r.estado();
    expect(Object.keys(e.noMedidas).length).toBeLessThanOrEqual(51);
    expect(Object.values(e.noMedidas).reduce((s, n) => s + n, 0)).toBe(500);
    expect(e.noMedidas["other reasons"]).toBe(450);
  });
});

// ── El recuento dentro del gateway ─────────────────────────────────────────

let recursos: (Server | GatewayArrancado)[] = [];
let warn: MockInstance<(...args: unknown[]) => void>;
beforeEach(() => {
  reiniciarAvisos();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  warn.mockRestore();
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

function servidor(manejar: (path: string, cuerpo: string, res: ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      manejar(req.url ?? "", Buffer.concat(chunks).toString("utf8"), res);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

const sse = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

async function montar() {
  const upstream = await servidor((path, cuerpo, res) => {
    if (path === "/v1/messages") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ id: "m", type: "message", model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 2 } }),
      );
      return;
    }
    if (path === "/v1/chat/completions") {
      // Como OpenAI: el chunk de uso solo si la petición lo pidió.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ choices: [{ index: 0, delta: { content: "hola" } }] }));
      if (cuerpo.includes('"include_usage":true')) res.write(sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
      res.end("data: [DONE]\n\n");
      return;
    }
    if (path === "/v1/error") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const ingesta = await servidor((path, _cuerpo, res) => {
    res.writeHead(path.startsWith("/api/org/entitlements") ? 200 : 202, { "content-type": "application/json" });
    res.end(path.startsWith("/api/org/entitlements") ? '{"features":[]}' : '{"ingested":1}');
  });
  const gw = await arrancarGateway({
    license: testLicense(),
    puerto: 0,
    upstream: `http://127.0.0.1:${upstream}`,
    serviceAccountKey: "bvk_test",
    meteringUrl: `http://127.0.0.1:${ingesta}`,
    seatId: "t",
    log: () => {},
    avisosDeNoMedido: false,
  });
  recursos.push(gw);
  const pedir = (path: string, cuerpo: unknown) =>
    fetch(`http://127.0.0.1:${gw.puerto}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    }).then((r) => r.text());
  return { gw, pedir };
}

const SIN_DINERO = { gastoUsd: 0, ahorroMedidoUsd: 0, ahorroPorReferenciaUsd: 0, ahorroEstimadoUsd: 0, deSuscripcion: 0 };

describe("el gateway lleva el recuento de lo medido y lo que no", () => {
  it("⛔ 1.2.4 · el recuento suma el dinero de los informes: el gasto es el de los contadores del proveedor, a precio de lista", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/messages", { model: "claude-sonnet-4-6", max_tokens: 5, messages: [] });
    await pedir("/v1/messages", { model: "claude-sonnet-4-6", max_tokens: 5, messages: [] });
    await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [], stream: true, stream_options: { include_usage: true } });
    const esperado =
      2 * costeMedido("claude-sonnet-4-6", { input_tokens: 10, output_tokens: 2 })!.costeUsd +
      costeMedido("gpt-4o-mini", { input_tokens: 5, output_tokens: 1 })!.costeUsd;
    expect(esperado).toBeGreaterThan(0);
    const e = gw.medicion();
    expect(e.medidas).toBe(3);
    expect(e.dinero.gastoUsd).toBeCloseTo(esperado, 12);
    // El upstream es un servidor local, no el API del proveedor: se mide y no se acredita nada.
    expect(e.dinero).toMatchObject({ ahorroMedidoUsd: 0, ahorroPorReferenciaUsd: 0, ahorroEstimadoUsd: 0, deSuscripcion: 0 });
    const l = resumenDeMedicion(e, "claude");
    expect(l).toContain(`3 request(s) metered with the provider's usage · spent ${dolares(esperado)} at list price · saved $0.00: nothing was credited`);
  });

  it("⛔ 1.2.4 · el tráfico de suscripción (beta oauth-*) se cuenta como tal y el resumen dice que ahí solo se mide", async () => {
    const { gw } = await montar();
    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [] }),
    }).then((r) => r.text());
    const e = gw.medicion();
    expect(e.medidas).toBe(1);
    expect(e.dinero.deSuscripcion).toBe(1);
    expect(e.dinero.gastoUsd).toBeGreaterThan(0);
    const l = resumenDeMedicion(e, "claude");
    expect(l).toContain("at list-price equivalent (subscription traffic: there is no per-token invoice)");
    expect(l).toContain("saved $0.00: no saving is credited on a subscription (there is no per-token invoice)");
  });
  it("cuenta lo medido y cada «not metered» de la API con su motivo", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/messages", { model: "claude-sonnet-4-6", max_tokens: 5, messages: [] });
    await pedir("/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    });
    await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [], stream: true });
    await pedir("/v1/messages", { model: "modelo-sin-precio-xyz", max_tokens: 5, messages: [] });

    const e = gw.medicion();
    expect(e.medidas).toBe(2);
    expect(e.noMedidas).toEqual({
      "the request did not ask for usage (stream_options.include_usage)": 1,
      'model "modelo-sin-precio-xyz" has no list price in the catalog': 1,
    });
  });

  it("la telemetría fuera de /v1/ y los errores del proveedor no cuentan como «no medido»", async () => {
    const { gw, pedir } = await montar();
    await pedir("/api/event_logging/batch", { events: [] });
    await pedir("/v1/error", { model: "claude-sonnet-4-6" });
    expect(gw.medicion()).toEqual({ recibidas: 0, sinContador: 0, medidas: 0, replicas: 0, noMedidas: {}, dinero: SIN_DINERO });
    expect(resumenDeMedicion(gw.medicion(), "claude")).toContain("no inference request went through the gateway");
  });

  it("⛔ una petición de inferencia que el proveedor rechaza SÍ pasó por el gateway: el resumen no dice «ninguna»", async () => {
    // El upstream responde 401 a /v1/messages: no hay usage que medir ni
    // motivo de «no medido» (un error no factura), pero la petición pasó.
    const upstream = await servidor((_path, _cuerpo, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    });
    const gw = await arrancarGateway({ puerto: 0, upstream: `http://127.0.0.1:${upstream}`, log: () => {}, avisosDeNoMedido: false });
    recursos.push(gw);
    for (let i = 0; i < 2; i++) {
      await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) }).then((r) => r.text());
    }
    const e = gw.medicion();
    expect(e).toEqual({ recibidas: 2, sinContador: 2, medidas: 0, replicas: 0, noMedidas: {}, dinero: SIN_DINERO });
    // Nada se midió: ni una cifra de dinero.
    expect(resumenDeMedicion(e, "claude")).not.toMatch(/\$|spent|saved/);
    const l = resumenDeMedicion(e, "claude");
    expect(l).not.toContain("no inference request went through");
    expect(l).toContain("2 inference request(s) went through the gateway");
    expect(l).toContain("0 request(s) metered");
    expect(l).toContain("2 ended with no usage to meter");
  });

  it("recibidas = medidas + réplicas + no medidas de inferencia + sin contador", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/messages", { model: "claude-sonnet-4-6", max_tokens: 5, messages: [] });
    await pedir("/v1/chat/completions", { model: "gpt-4o-mini", messages: [], stream: true });
    await pedir("/v1/embeddings", { model: "text-embedding-3-small", input: "x" });
    const e = gw.medicion();
    // embeddings no tiene dialecto: se cuenta por su motivo, no como inferencia recibida.
    expect(e.recibidas).toBe(2);
    expect(e.medidas).toBe(1);
    expect(e.sinContador).toBe(0);
    const l = resumenDeMedicion(e, "claude");
    expect(l).toContain("2 inference request(s) went through the gateway · 1 request(s) metered with the provider's usage");
    expect(l).toContain("2 forwarded but NOT metered");
  });

  it("una ruta de la API sin dialecto sí cuenta, con su motivo", async () => {
    const { gw, pedir } = await montar();
    await pedir("/v1/embeddings", { model: "text-embedding-3-small", input: "x" });
    expect(gw.medicion().noMedidas).toEqual({ "no usage dialect for this route": 1 });
  });
});

// ── De punta a punta: lo que ve quien sale de `bvsala claude` ───────────────

describe.skipIf(process.platform === "win32")("1.2.4 · `bvsala claude` enseña el dinero al salir (bin compilado, sin claves)", () => {
  /** Un «claude» falso: manda `n` peticiones al base URL que le dio el envoltorio y sale. */
  const claudeFalso = (n: number, cabeceras: Record<string, string>): string => `
    const base = process.env.ANTHROPIC_BASE_URL;
    (async () => {
      for (let i = 0; i < ${n}; i++) {
        const r = await fetch(base + "/v1/messages", {
          method: "POST",
          headers: ${JSON.stringify({ "content-type": "application/json", ...cabeceras })},
          body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 5, messages: [{ role: "user", content: "hola " + i }] }),
        });
        await r.text();
      }
    })().catch((e) => { console.error(String(e)); process.exit(3); });
  `;

  async function correr(n: number, cabeceras: Record<string, string>, extra: Record<string, string> = {}) {
    exigirBinCompilado();
    const upstream = await servidor((_path, _cuerpo, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "m", type: "message", model: "claude-sonnet-4-6", usage: { input_tokens: 2000, output_tokens: 300 } }));
    });
    const caja = cajaLimpia();
    caja.terminal("claude", claudeFalso(n, cabeceras));
    const p = lanzar(["claude"], caja.env({ BVSALA_GATEWAY_UPSTREAM: `http://127.0.0.1:${upstream}`, ...extra }));
    try {
      const fin = await p.salida;
      return { codigo: fin.code, stdout: p.stdout(), stderr: p.stderr() };
    } finally {
      p.matar();
      caja.limpiar();
    }
  }

  const unitario = costeMedido("claude-sonnet-4-6", { input_tokens: 2000, output_tokens: 300 })!.costeUsd;

  it("con clave de API: cuántas midió, cuánto costaron a precio de lista, por qué no hubo ahorro y dónde está el detalle", async () => {
    const r = await correr(3, { "x-api-key": "clave-inventada-de-prueba" });
    expect(r.codigo, r.stderr).toBe(0);
    const linea = r.stderr.split("\n").find((l) => l.startsWith("[bvsala claude] metering in this run:"));
    expect(linea, r.stderr).toBeDefined();
    expect(linea).toContain("3 inference request(s) went through the gateway · 3 request(s) metered with the provider's usage");
    expect(linea).toContain(`spent ${dolares(3 * unitario)} at list price`);
    expect(linea).toContain("saved $0.00: nothing was credited");
    expect(linea).toContain("Per-request detail: run it again with BVSALA_GATEWAY_LOG=1");
    // El stdout es del terminal envuelto: ni una línea nuestra.
    expect(r.stdout).toBe("");
  }, 30_000);

  it("con suscripción (beta oauth-*): equivalente a precio de lista, y dice que ahí solo mide", async () => {
    const r = await correr(2, { authorization: "Bearer credencial-inventada", "anthropic-beta": "oauth-2025-04-20" });
    expect(r.codigo, r.stderr).toBe(0);
    expect(r.stderr).toContain(`spent ${dolares(2 * unitario)} at list-price equivalent (subscription traffic: there is no per-token invoice)`);
    expect(r.stderr).toContain("saved $0.00: no saving is credited on a subscription (there is no per-token invoice)");
  }, 30_000);

  it("⛔ con BVSALA_GATEWAY_OBSERVE_ONLY=1 el cartel no dice «TTL tuning ON» ni «ARMED»: una sola línea de solo observar", async () => {
    exigirBinCompilado();
    const caja = cajaLimpia();
    const p = lanzar(
      ["gateway", "--port", "0", "--upstream", "http://127.0.0.1:9"],
      caja.env({ BVSALA_GATEWAY_OBSERVE_ONLY: "1", BVSALA_GATEWAY_SIBLING_MODEL: "1" }),
    );
    try {
      await p.esperar(/savings levers: OBSERVE-ONLY/);
      // El cartel sale entero antes de la línea de las palancas y de lo que va detrás.
      await new Promise((res) => setTimeout(res, 200));
      const todo = p.stdout() + p.stderr();
      expect(todo).toContain("[bvsala gateway] savings levers: OBSERVE-ONLY (BVSALA_GATEWAY_OBSERVE_ONLY=1) - no lever is applied");
      expect(todo).not.toMatch(/cache TTL tuning is the only one ON by default|sibling model routing: ARMED|TTL tuning ON/);
    } finally {
      p.matar();
      caja.limpiar();
    }
  }, 30_000);

  it("⛔ con BVSALA_GATEWAY_OBSERVE_ONLY=1 el resumen dice que ninguna palanca actuó (no la regla de la rebaja)", async () => {
    const r = await correr(2, { "x-api-key": "clave-inventada-de-prueba" }, { BVSALA_GATEWAY_OBSERVE_ONLY: "1" });
    expect(r.codigo, r.stderr).toBe(0);
    expect(r.stderr).toContain("saved $0.00: observe-only mode (BVSALA_GATEWAY_OBSERVE_ONLY=1) applies no lever");
    expect(r.stderr).not.toContain("cache TTL tuning is credited only");
  }, 30_000);

  it("⛔ con BVSALA_GATEWAY_ELISION=0 el resumen culpa al freno, no a la regla de la rebaja (e2e del 22-11)", async () => {
    const r = await correr(2, { "x-api-key": "clave-inventada-de-prueba" }, { BVSALA_GATEWAY_ELISION: "0" });
    expect(r.codigo, r.stderr).toBe(0);
    expect(r.stderr).toContain("saved $0.00: every gateway lever is off (BVSALA_GATEWAY_ELISION=0); unset it to let the levers act");
    expect(r.stderr).not.toContain("cache TTL tuning is credited only");
  }, 30_000);

  it("con BVSALA_GATEWAY_LOG=1 el detalle ya está arriba: la línea no manda a repetir la ejecución", async () => {
    const r = await correr(1, { "x-api-key": "clave-inventada-de-prueba" }, { BVSALA_GATEWAY_LOG: "1" });
    expect(r.codigo, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/\[gateway\] POST \/v1\/messages .*claude-sonnet-4-6 · \$/);
    expect(r.stderr).toContain("Per-request detail: the log lines above.");
    expect(r.stderr).not.toContain("run it again with BVSALA_GATEWAY_LOG=1");
  }, 30_000);
});

describe("el $0 habla de lo acreditado, no de lo cambiado (revisión de #613)", () => {
  it("⛔ ninguna frase del resumen afirma que ninguna palanca cambió una petición", async () => {
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync(new URL("../gateway/recuento.ts", import.meta.url), "utf8");
    expect(fuente).not.toMatch(/no lever changed a request|only measures and changes nothing/);
    expect(fuente).toContain("nothing was credited");
    expect(fuente).toContain("no saving is credited on a subscription");
  });
});

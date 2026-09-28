import { createServer, type Server } from "node:http";
import { afterEach, describe, it, expect } from "vitest";

import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { testLicense } from "./helpers/test-license.js";
import { CarrilSombra, MAX_CADENAS } from "../gateway/sombra-vivo.js";
import { configDeDiales } from "../gateway/diales.js";
import {
  CadenaDeSimulacion,
  aplicarPolitica,
  compactarCuerpo,
  identidad,
  simularSesion,
  type TurnoSombra,
} from "../gateway/sombra.js";
import { oficialHaciaElMock } from "./helpers/gateway-oficial.js";

/**
 * S2.4-vivo · El carril sombra del gateway. Tres verjas:
 *
 *  1. EQUIVALENCIA: la cadena incremental (la del carril vivo) produce
 *     exactamente lo mismo que simularSesion (la del replay que eligió la
 *     política) — si divergen, la cifra viva no es la cifra certificada.
 *  2. E2E: con BVSALA_GATEWAY_SHADOW, cada petición medida de /v1/messages
 *     emite ADEMÁS un registro `basis:"shadow"` con requestId `:shadow` y
 *     contadores de llamadas a cero.
 *  3. Apagado por defecto: sin la opción, ni un registro sombra.
 */

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":1,"cache_creation":{"ephemeral_1h_input_tokens":500}}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"OK"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":42}}\n\n',
  "event: message_stop\ndata: {}\n\n",
].join("");

let recursos: (Server | GatewayArrancado)[] = [];
afterEach(async () => {
  for (const r of recursos) {
    if ("cerrar" in r) await r.cerrar();
    else await new Promise((res) => r.close(res));
  }
  recursos = [];
});

function arrancarUpstreamSse(sse = SSE): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    });
    recursos.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as { port: number }).port));
  });
}

/** El mismo SSE, pero el proveedor declara en message_delta que borró (forma sondeada en vivo el 04-09). */
const TOKENS_BORRADOS = 28_543;
const SSE_CON_BORRADO = SSE.replace(
  '"usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":42}}',
  '"usage":{"input_tokens":100,"cache_read_input_tokens":4000,"output_tokens":42},' +
    `"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_input_tokens":${TOKENS_BORRADOS},"cleared_tool_uses":2}]}}`,
);

function arrancarIngestaFalsa(lotes: unknown[][], features: string[] = []): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      // La elisión del gateway está ARMADA por defecto: con clave de servicio, el canal
      // de entitlements dispara un GET a `/api/org/entitlements` sobre el mismo origen
      // que la ingesta. Estos tests no ejercitan la elisión → fail-closed (features
      // vacío) y ese GET sin cuerpo no se trata como lote (parsear "" tiraba una
      // promesa sin manejar).
      if (req.method === "GET" && (req.url ?? "").startsWith("/api/org/entitlements")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features, refreshAfterSeconds: 300 }));
        return;
      }
      lotes.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown[]);
      res.writeHead(202, { "content-type": "application/json" });
      res.end('{"ingested":1}');
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

function cuerpoTurno(pasos: number): { model: string; messages: unknown[]; stream: boolean } {
  const messages: unknown[] = [{ role: "user", content: "arranca" }];
  for (let i = 0; i < pasos; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `tu_${i}`, name: "bash", input: {} }] });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tu_${i}`, content: `salida del paso ${i} ` + "x".repeat(4000) }],
    });
  }
  // Como Claude Code: el ÚLTIMO mensaje lleva la marca de caché. Sin marcador no
  // hay caché (doctrina del simulador, confirmada por el proveedor), así que un
  // fixture sin marca no simularía nada.
  const ultimo = messages[messages.length - 1] as { content: { cache_control?: unknown }[] };
  ultimo.content[0]!.cache_control = { type: "ephemeral", ttl: "1h" };
  return { model: "claude-haiku-4-5-20251001", messages, stream: true };
}

describe("la cadena incremental ≡ el replay", () => {
  it("paso a paso suma EXACTAMENTE lo que simularSesion calcula de una tacada", () => {
    const turnos: TurnoSombra[] = [1, 2, 3, 4, 5].map((n) => ({
      bloques: compactarCuerpo(cuerpoTurno(n)),
      at: n * 60_000,
      model: "claude-sonnet-4-5",
      entradaReal: 10_000 + n * 2_000,
      escritura1h: true,
    }));
    for (const transformar of [
      (b: Parameters<typeof identidad>[0]) => identidad(b),
      (b: Parameters<typeof identidad>[0], e: Parameters<typeof aplicarPolitica>[2], t: number) =>
        aplicarPolitica("v0", b, e, t),
    ]) {
      const deUnaVez = simularSesion(turnos, transformar);
      const cadena = new CadenaDeSimulacion(transformar);
      let porPasos = 0;
      for (const t of turnos) porPasos += cadena.paso(t).totalUsd;
      expect(cadena.acumulado.totalUsd).toBeCloseTo(deUnaVez.totalUsd, 10);
      expect(porPasos).toBeCloseTo(deUnaVez.totalUsd, 10);
      expect(cadena.acumulado.invalidacionUsd).toBeCloseTo(deUnaVez.invalidacionUsd, 10);
    }
  });

  it("el tope de cadenas expulsa a la más vieja sin romper a las vivas", () => {
    const carril = new CarrilSombra();
    const uso = { input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 100 } };
    for (let i = 0; i < MAX_CADENAS + 5; i++) {
      const paso = carril.observar({
        cuerpo: cuerpoTurno(2),
        uso,
        model: "claude-haiku-4-5-20251001",
        at: Date.now(),
        sessionId: `ses-${i}`,
      });
      expect(paso).not.toBeNull();
    }
  });
});

describe("el gateway con BVSALA_GATEWAY_SHADOW", () => {
  it("emite el registro sombra ADEMÁS del medido: ':shadow', basis shadow, llamadas a cero", async () => {
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamSse();
    const ingesta = await arrancarIngestaFalsa(lotes);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      ...oficialHaciaElMock(upstream),
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      sombra: true,
      log: () => {},
    });
    recursos.push(gw);

    // Dos turnos de la MISMA sesión: el segundo repite el primero y añade un
    // paso — el paraíso de la caché, y el escenario donde v0 decide.
    for (const pasos of [3, 4]) {
      await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": "ses-sombra-1" },
        body: JSON.stringify(cuerpoTurno(pasos)),
      }).then((r) => r.text());
    }

    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    const registros = lotes.flat() as Record<string, unknown>[];

    const medidos = registros.filter((r) => r["basis"] === "measured");
    const sombras = registros.filter((r) => r["basis"] === "shadow");
    expect(medidos).toHaveLength(2);
    expect(sombras).toHaveLength(2);
    for (const s of sombras) {
      expect(String(s["requestId"])).toMatch(/:shadow$/);
      // La sombra aporta CERO a los contadores: ni llamadas ni tokens.
      expect(s["avoidedLlm"]).toBe(0);
      expect(s["actualLlm"]).toBe(0);
      expect(s["actualInputTokens"]).toBe(0);
      // netSavings es proporción acotada.
      expect(s["netSavings"]).toBeGreaterThanOrEqual(-100);
      expect(s["netSavings"]).toBeLessThanOrEqual(1);
      // Y el dinero simulado existe.
      expect(s["baselineCost"]).toBeGreaterThan(0);
      // La atribución viaja también en la sombra.
      expect(s["sessionId"]).toBe("ses-sombra-1");
    }
    // El requestId sombra corresponde 1:1 a un medido (mismo prefijo).
    const idsMedidos = new Set(medidos.map((r) => r["requestId"]));
    for (const s of sombras) expect(idsMedidos.has(String(s["requestId"]).replace(/:shadow$/, ""))).toBe(true);
  });

  it("⛔ sin la opción, ni un registro sombra (apagado por defecto)", async () => {
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamSse();
    const ingesta = await arrancarIngestaFalsa(lotes);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      ...oficialHaciaElMock(upstream),
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      log: () => {},
    });
    recursos.push(gw);

    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpoTurno(3)),
    }).then((r) => r.text());

    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    const registros = lotes.flat() as Record<string, unknown>[];
    expect(registros.some((r) => r["basis"] === "shadow")).toBe(false);
    expect(registros.some((r) => r["basis"] === "measured")).toBe(true);
  });
});

/**
 * B2-4 · La sombra calla donde el proveedor YA borró por NUESTROS diales: si
 * midiera, simularía elidir los mismos tool_result que el proveedor limpió y el
 * panel enseñaría el mismo borrado dos veces (plan S4 § 5). Donde el borrado
 * es del cliente (ya traía nuestros diales), la sombra sigue midiendo.
 */
describe("B2-4 · sombra y borrado del proveedor no se solapan", () => {
  const CM_NUESTRO = { edits: [configDeDiales().edits[0]] };

  async function correr(cuerpoExtra: Record<string, unknown>, sse = SSE_CON_BORRADO): Promise<Record<string, unknown>[]> {
    const lotes: unknown[][] = [];
    const upstream = await arrancarUpstreamSse(sse);
    const ingesta = await arrancarIngestaFalsa(lotes, ["context_elision"]);
    const gw = await arrancarGateway({
      license: testLicense(),
      puerto: 0 as never,
      ...oficialHaciaElMock(upstream),
      serviceAccountKey: "bvk_test",
      meteringUrl: `http://127.0.0.1:${ingesta}`,
      seatId: "test-01",
      sombra: true,
      // 2026-09-09 · este bloque prueba la ATRIBUCIÓN del suelo (B2), que solo
      // tiene sentido cuando los diales son nuestros. Desde que nacen apagados,
      // hay que armarlos explícitamente para reproducir el escenario.
      dialesElision: true,
      log: () => {},
    });
    recursos.push(gw);
    // El canal de entitlements refresca en el arranque; se le deja asentar.
    await new Promise((r) => setTimeout(r, 150));

    await fetch(`http://127.0.0.1:${gw.puerto}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "ses-b2-4" },
      body: JSON.stringify({ ...cuerpoTurno(3), ...cuerpoExtra }),
    }).then((r) => r.text());

    await gw.cerrar();
    await esperar(() => lotes.length > 0);
    return lotes.flat() as Record<string, unknown>[];
  }

  it("⛔ borrado ATRIBUIBLE (el cliente no traía nuestros diales) → medido con suelo, y NINGÚN registro sombra", async () => {
    const registros = await correr({});
    const medidos = registros.filter((r) => r["basis"] === "measured");
    expect(medidos).toHaveLength(1);
    expect(medidos[0]!["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    expect(medidos[0]!["eliminatedInputFloorCost"]).toBeGreaterThan(0);
    expect(registros.some((r) => r["basis"] === "shadow")).toBe(false);
  });

  it("borrado solo de THINKING (config del cliente, no tool_uses) → la sombra sigue midiendo", async () => {
    const soloThinking = SSE_CON_BORRADO.replace(
      `{"type":"clear_tool_uses_20250919","cleared_input_tokens":${TOKENS_BORRADOS},"cleared_tool_uses":2}`,
      '{"type":"clear_thinking_20251015","cleared_input_tokens":40000}',
    );
    expect(soloThinking).not.toBe(SSE_CON_BORRADO);
    const registros = await correr({}, soloThinking);
    const medidos = registros.filter((r) => r["basis"] === "measured");
    expect(medidos).toHaveLength(1);
    expect(medidos[0]!["eliminatedInputTokens"]).toBe(40_000);
    expect("eliminatedInputFloorCost" in medidos[0]!).toBe(false);
    expect(registros.filter((r) => r["basis"] === "shadow")).toHaveLength(1);
  });

  it("borrado DEL CLIENTE (ya mandaba nuestros diales) → conteo sin suelo, y la sombra sigue midiendo", async () => {
    const registros = await correr({ context_management: CM_NUESTRO });
    const medidos = registros.filter((r) => r["basis"] === "measured");
    expect(medidos).toHaveLength(1);
    expect(medidos[0]!["eliminatedInputTokens"]).toBe(TOKENS_BORRADOS);
    expect("eliminatedInputFloorCost" in medidos[0]!).toBe(false);
    expect(registros.filter((r) => r["basis"] === "shadow")).toHaveLength(1);
  });
});

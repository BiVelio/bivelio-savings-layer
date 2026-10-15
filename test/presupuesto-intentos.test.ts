import { describe, it, expect } from "vitest";

import {
  AgregadorDePresupuesto,
  BudgetLedgerEnMemoria,
  ConflictoDeIntento,
  OutboxEnMemoria,
  PruebaInsuficiente,
  TransicionInvalida,
  cotaDeSobre,
  type ClaveDeIntento,
  type EventoDePresupuesto,
  type PruebaDeNoEnvio,
  type SobreDePresupuesto,
} from "../src/metering/presupuesto.js";
import { ConflictoDeRecibo, idDeEvento, idDeIntento, normalizarUso, type AttemptUsage } from "../src/metering/intento.js";

/**
 * D07 · RESERVAR Y LIQUIDAR.
 *
 * Las cifras esperadas están hechas a mano con el precio de lista, no leídas
 * del código: claude-sonnet-4-5 cobra 3 µ$ el token de entrada, 0,3 µ$ el leído
 * de caché, 3,75 µ$ el escrito a 5 min, 6 µ$ a 1 h y 15 µ$ el de salida;
 * gpt-4o-mini 0,15 µ$ la entrada y 0,6 µ$ la salida. Un día fijo, para que un
 * tramo de precio futuro no mueva el test.
 */

const DIA = Date.UTC(2026, 9, 1);
const P = "proj-d07";

// 10 000 de entrada como máximo y max_tokens 1000, sin escrituras de caché:
// 10 000 × 3 + 1000 × 15 = 45 000 µ$.
const SOBRE: SobreDePresupuesto = {
  model: "claude-sonnet-4-5",
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  razonamiento: "dentro_de_salida",
  escriturasDeCache: false,
  maxIntentos: 3,
};
const COTA = 45_000;

// El uso real de un intento: 1000 de entrada, 8000 leídos, 2000 escritos a
// 5 min y 500 de salida = 3000 + 2400 + 7500 + 7500 = 20 400 µ$.
const USO_ANTHROPIC = { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000, output_tokens: 500 };
const USO: AttemptUsage = normalizarUso({ dialecto: "anthropic", uso: USO_ANTHROPIC });
const COSTE = 20_400;

const clave = (logicalCallId: string, attempt = 0, extra: Partial<ClaveDeIntento> = {}): ClaveDeIntento => ({
  projectId: P,
  logicalCallId,
  attempt,
  kind: attempt === 0 ? "primary" : "retry",
  ...extra,
});

async function libro(cap: number, extra: Partial<Parameters<BudgetLedgerEnMemoria["definirPresupuesto"]>[0]> = {}, opciones = {}) {
  let ahora = DIA;
  const l = new BudgetLedgerEnMemoria({ reloj: () => ahora, ...opciones });
  await l.definirPresupuesto({ projectId: P, capMicroUsd: cap, currency: "USD", estricto: true, ...extra });
  return { l, avanzar: (ms: number) => (ahora += ms) };
}

describe("la cota del sobre: el peor caso con el catálogo, redondeado hacia arriba", () => {
  it("sin escrituras, con escrituras (a la prima de 1 h) y con razonamiento facturado aparte", () => {
    expect(cotaDeSobre(SOBRE, DIA)).toMatchObject({ state: "acotada", amountMicroUsd: 45_000, currency: "USD" });
    // Toda la entrada podría escribirse a 1 h: 10 000 × 6 + 1000 × 15.
    expect(cotaDeSobre({ ...SOBRE, escriturasDeCache: true }, DIA)).toMatchObject({ amountMicroUsd: 75_000 });
    // 2000 de razonamiento que max_tokens no cubre: (1000 + 2000) × 15 + 30 000.
    expect(cotaDeSobre({ ...SOBRE, razonamiento: { maxTokens: 2000 } }, DIA)).toMatchObject({ amountMicroUsd: 75_000 });
  });

  it("una fracción de micro-USD redondea HACIA ARRIBA (una cota no puede quedarse corta)", () => {
    // 1 × 0,15 + 1 × 0,6 = 0,75 µ$ → 1.
    const c = cotaDeSobre({ ...SOBRE, model: "gpt-4o-mini", maxInputTokens: 1, maxOutputTokens: 1 }, DIA);
    expect(c).toMatchObject({ state: "acotada", amountMicroUsd: 1 });
    // 3 × 0,15 + 3 × 0,6 = 2,25 µ$ → 3 (al más cercano habría salido 2).
    expect(cotaDeSobre({ ...SOBRE, model: "gpt-4o-mini", maxInputTokens: 3, maxOutputTokens: 3 }, DIA)).toMatchObject({ amountMicroUsd: 3 });
  });

  it("lo que no se puede acotar lo dice, con su motivo", () => {
    const { maxOutputTokens: _, ...sinMax } = SOBRE;
    expect(cotaDeSobre(sinMax, DIA)).toMatchObject({ state: "sin_cota", reason: "output-unbounded" });
    expect(cotaDeSobre({ ...SOBRE, razonamiento: "sin_control" }, DIA)).toMatchObject({ state: "sin_cota", reason: "reasoning-uncontrolled" });
    expect(cotaDeSobre({ ...SOBRE, model: "acme-llm-9" }, DIA)).toMatchObject({ state: "sin_cota", reason: "no-catalog-price" });
    expect(cotaDeSobre({ ...SOBRE, model: "gpt-4o-mini-latest" }, DIA)).toMatchObject({ state: "sin_cota", reason: "inherited-price" });
    // Por encima de 200K la tarifa corta es un suelo, no un techo.
    expect(cotaDeSobre({ ...SOBRE, maxInputTokens: 300_000 }, DIA)).toMatchObject({ state: "sin_cota", reason: "long-context-tier" });
    expect(cotaDeSobre({ ...SOBRE, maxInputTokens: 1.5 }, DIA)).toMatchObject({ state: "sin_cota", reason: "envelope-invalid" });
  });
});

describe("reservar: condicional y atómico", () => {
  it("100 reservas concurrentes nunca pasan del tope (y entran exactamente las que caben)", async () => {
    // Cada reserva espera un turno del bucle de eventos ENTRE leer y escribir:
    // sin la exclusión por proyecto, las cien leerían el mismo «comprometido».
    const cap = 1_000_000;
    const { l } = await libro(cap, {}, { latenciaSimulada: () => new Promise<void>((r) => setTimeout(r, 0)) });
    const resultados = await Promise.all(Array.from({ length: 100 }, (_, n) => l.reservar(clave(`lc-carrera-${n}`), SOBRE)));
    const admitidas = resultados.filter((r) => r.ok);
    // ⌊1 000 000 / 45 000⌋ = 22.
    expect(admitidas).toHaveLength(22);
    expect(resultados.filter((r) => !r.ok && r.reason === "cap_exceeded")).toHaveLength(78);
    const e = (await l.estado(P))!;
    expect(e.reservedMicroUsd).toBe(22 * COTA);
    expect(e.reservedMicroUsd).toBeLessThanOrEqual(cap);
    expect(e.availableMicroUsd).toBe(cap - 22 * COTA);
    expect(l.outbox.pendientes().filter((x) => x.state === "reserved")).toHaveLength(22);
  });

  it("con importes distintos y concurrentes, lo admitido tampoco pasa del tope", async () => {
    const cap = 500_000;
    const { l } = await libro(cap, {}, { latenciaSimulada: () => new Promise<void>((r) => setTimeout(r, Math.random() * 2)) });
    const sobres = Array.from({ length: 100 }, (_, n) => ({ ...SOBRE, maxInputTokens: 1000 + ((n * 7919) % 20_000) }));
    const res = await Promise.all(sobres.map((s, n) => l.reservar(clave(`lc-mixta-${n}`), s)));
    const suma = res.reduce((a, r) => a + (r.ok ? r.amountMicroUsd : 0), 0);
    const e = (await l.estado(P))!;
    expect(suma).toBeLessThanOrEqual(cap);
    expect(e.reservedMicroUsd).toBe(suma);
    // Sin liberaciones lo libre solo baja: un rechazado no cabía cuando se
    // pidió, así que tampoco cabe en lo que quedó al final.
    const libre = cap - suma;
    expect(libre).toBeGreaterThanOrEqual(0);
    const rechazados = res.flatMap((r, n) => (r.ok ? [] : [n]));
    expect(rechazados.length).toBeGreaterThan(0);
    for (const n of rechazados) {
      const c = cotaDeSobre(sobres[n]!, DIA);
      expect(c.state === "acotada" && c.amountMicroUsd > libre).toBe(true);
    }
  });

  it("enteros exactos: el último micro-USD cabe y el siguiente no (≤, no <; sin coma flotante)", async () => {
    // gpt-4o-mini con 1 de entrada y 1 de salida: cota de 1 µ$.
    const s = { ...SOBRE, model: "gpt-4o-mini", maxInputTokens: 1, maxOutputTokens: 1 };
    const { l } = await libro(10);
    for (let n = 0; n < 10; n++) expect((await l.reservar(clave(`lc-uno-${n}`), s)).ok).toBe(true);
    expect(await l.reservar(clave("lc-uno-10"), s)).toMatchObject({ ok: false, reason: "cap_exceeded" });
    expect((await l.estado(P))!).toMatchObject({ reservedMicroUsd: 10, availableMicroUsd: 0 });
  });

  it("tres reservas de 0,1 USD caben en un tope de 0,3 USD (en coma flotante no cabrían)", async () => {
    expect(0.1 + 0.1 + 0.1 <= 0.3).toBe(false);
    const { l } = await libro(300_000, { estricto: false, reservaConservadoraMicroUsd: 100_000 });
    const sinPrecio = { ...SOBRE, model: "acme-llm-9" };
    for (const lc of ["lc-f1", "lc-f2", "lc-f3"]) expect(await l.reservar(clave(lc), sinPrecio)).toMatchObject({ ok: true, amountMicroUsd: 100_000 });
    expect((await l.estado(P))!.availableMicroUsd).toBe(0);
    expect(await l.reservar(clave("lc-f4"), sinPrecio)).toMatchObject({ ok: false, reason: "cap_exceeded" });
  });

  it("un tope estricto rechaza el sobre sin cota; uno no estricto aplica la política conservadora", async () => {
    const { maxOutputTokens: _, ...sinMax } = SOBRE;
    const estricto = await libro(1_000_000);
    expect(await estricto.l.reservar(clave("lc-sc"), sinMax)).toMatchObject({ ok: false, reason: "unbounded_envelope" });
    const conservador = await libro(1_000_000, { estricto: false, reservaConservadoraMicroUsd: 250_000 });
    expect(await conservador.l.reservar(clave("lc-sc"), sinMax)).toMatchObject({ ok: true, amountMicroUsd: 250_000, basis: "conservative_policy" });
    // No estricto pero sin política: se rechaza igual.
    const sinPolitica = await libro(1_000_000, { estricto: false });
    expect(await sinPolitica.l.reservar(clave("lc-sc"), sinMax)).toMatchObject({ ok: false, reason: "unbounded_envelope" });
  });

  it("solo USD, sin FX; y sin presupuesto no se reserva", async () => {
    const l = new BudgetLedgerEnMemoria();
    await expect(l.definirPresupuesto({ projectId: P, capMicroUsd: 1, currency: "EUR" as "USD", estricto: true })).rejects.toThrow(TypeError);
    await expect(l.definirPresupuesto({ projectId: P, capMicroUsd: 0.5, currency: "USD", estricto: true })).rejects.toThrow(TypeError);
    expect(await l.reservar(clave("lc-x"), SOBRE)).toMatchObject({ ok: false, reason: "no_budget" });
  });
});

describe("reintentos: un intento nuevo al proveedor reserva otra vez; el mismo no suma", () => {
  it("el reintento (otro ordinal) reserva de nuevo y el límite de intentos del sobre se respeta", async () => {
    const { l } = await libro(1_000_000);
    const a0 = await l.reservar(clave("lc-r"), SOBRE);
    expect(a0).toMatchObject({ ok: true, attemptId: idDeIntento("lc-r", 0) });
    await l.marcarEnviado(P, idDeIntento("lc-r", 0));
    await l.marcarIncierto(P, idDeIntento("lc-r", 0), "timeout_local");
    const a1 = await l.reservar(clave("lc-r", 1), SOBRE);
    expect(a1).toMatchObject({ ok: true, attemptId: idDeIntento("lc-r", 1), repeated: false });
    // El primero sigue reteniendo: los dos pudieron facturar.
    expect((await l.estado(P))!.pendingExposureMicroUsd).toBe(2 * COTA);
    await l.reservar(clave("lc-r", 2), SOBRE);
    expect(await l.reservar(clave("lc-r", 3), SOBRE)).toMatchObject({ ok: false, reason: "attempt_limit" });
  });

  it("reservar dos veces el mismo intento con el mismo sobre es idempotente; con otro, conflicto", async () => {
    const { l } = await libro(1_000_000);
    await l.reservar(clave("lc-i"), SOBRE);
    expect(await l.reservar(clave("lc-i"), SOBRE)).toMatchObject({ ok: true, repeated: true, amountMicroUsd: COTA });
    expect((await l.estado(P))!.reservedMicroUsd).toBe(COTA);
    await expect(l.reservar(clave("lc-i"), { ...SOBRE, maxOutputTokens: 2000 })).rejects.toThrow(ConflictoDeIntento);
  });
});

describe("liquidar: uso completo y precio conocido convierten la reserva en coste", () => {
  it("la liquidación libera la reserva y apunta el coste del recibo de D02", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-s", 0);
    await l.reservar(clave("lc-s"), SOBRE);
    await l.marcarEnviado(P, id, { providerCorrelation: "req_123" });
    const r = await l.liquidar(P, id, USO);
    expect(r).toEqual({ state: "settled", repeated: false, costMicroUsd: COSTE, receiptEventId: idDeEvento("lc-s", 0), exceededReservation: false });
    expect((await l.estado(P))!).toMatchObject({ spentMicroUsd: COSTE, reservedMicroUsd: 0, pendingExposureMicroUsd: 0, availableMicroUsd: 1_000_000 - COSTE });
    expect(await l.totalDeLlamada(P, "lc-s")).toMatchObject({ state: "priced", amountMicroUsd: COSTE, attempts: 1 });
    expect(await l.intento(P, id)).toMatchObject({ state: "settled", providerCorrelation: "req_123", dispatchedAt: DIA });
  });

  it("el recibo reintentado del mismo intento es un no-op; uno distinto, conflicto; nada suma dos veces", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-d", 0);
    await l.reservar(clave("lc-d"), SOBRE);
    await l.marcarEnviado(P, id);
    await l.liquidar(P, id, USO);
    expect(await l.liquidar(P, id, USO)).toMatchObject({ state: "settled", repeated: true, costMicroUsd: COSTE });
    await expect(l.liquidar(P, id, normalizarUso({ dialecto: "anthropic", uso: { ...USO_ANTHROPIC, output_tokens: 900 } }))).rejects.toThrow(
      ConflictoDeRecibo,
    );
    expect((await l.estado(P))!.spentMicroUsd).toBe(COSTE);
    expect(await l.totalDeLlamada(P, "lc-d")).toMatchObject({ attempts: 1, amountMicroUsd: COSTE });
    expect(l.outbox.pendientes().filter((e) => e.state === "settled")).toHaveLength(1);
  });

  it("no se liquida lo no enviado, ni lo liberado, ni lo estimado", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-n", 0);
    await l.reservar(clave("lc-n"), SOBRE);
    await expect(l.liquidar(P, id, USO)).rejects.toThrow(TransicionInvalida);
    await l.liberar(P, id, { tipo: "no_enviado", motivo: "abortado_antes_de_enviar" });
    await expect(l.liquidar(P, id, USO)).rejects.toThrow(TransicionInvalida);
    await expect(l.liquidar(P, "lc-fantasma:a0", USO)).rejects.toThrow(TransicionInvalida);
  });

  it("un coste real por encima de la reserva se apunta entero y se marca (no se recorta al tope)", async () => {
    const { l } = await libro(50_000);
    const id = idDeIntento("lc-e", 0);
    await l.reservar(clave("lc-e"), SOBRE);
    await l.marcarEnviado(P, id);
    // 10 000 × 3 + 2000 × 15 = 60 000 µ$ > 45 000 reservados.
    const r = await l.liquidar(P, id, normalizarUso({ dialecto: "anthropic", uso: { input_tokens: 10_000, output_tokens: 2000 } }));
    expect(r).toMatchObject({ state: "settled", costMicroUsd: 60_000, exceededReservation: true });
    expect((await l.estado(P))!.availableMicroUsd).toBe(-10_000);
    expect(await l.reservar(clave("lc-e2"), { ...SOBRE, model: "gpt-4o-mini", maxInputTokens: 1, maxOutputTokens: 1 })).toMatchObject({
      ok: false,
      reason: "cap_exceeded",
    });
  });
});

describe("liberar solo con prueba de que no salió", () => {
  it("sin prueba, o con un timeout local como «prueba», se rechaza y la exposición queda", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-l", 0);
    await l.reservar(clave("lc-l"), SOBRE);
    await expect(l.liberar(P, id, undefined as unknown as PruebaDeNoEnvio)).rejects.toThrow(PruebaInsuficiente);
    await expect(l.liberar(P, id, { tipo: "no_enviado", motivo: "timeout_local" } as unknown as PruebaDeNoEnvio)).rejects.toThrow(PruebaInsuficiente);
    await expect(l.liberar(P, id, { motivo: "sin_conexion" } as unknown as PruebaDeNoEnvio)).rejects.toThrow(PruebaInsuficiente);
    expect(await l.intento(P, id)).toMatchObject({ state: "reserved", exposureMicroUsd: COTA });
    expect((await l.estado(P))!.reservedMicroUsd).toBe(COTA);
  });

  it("con prueba válida se libera y el tope recupera la reserva entera", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-l2", 0);
    await l.reservar(clave("lc-l2"), SOBRE);
    await l.liberar(P, id, { tipo: "no_enviado", motivo: "sin_conexion", detalle: "ECONNREFUSED" });
    expect((await l.estado(P))!).toMatchObject({ reservedMicroUsd: 0, pendingExposureMicroUsd: 0, availableMicroUsd: 1_000_000, openAttempts: 0 });
    expect(await l.intento(P, id)).toMatchObject({ state: "released", releaseProof: { motivo: "sin_conexion" } });
  });

  it("timeout DESPUÉS de enviar: incierto, no liberado, y la exposición se retiene", async () => {
    const { l } = await libro(100_000);
    const id = idDeIntento("lc-t", 0);
    await l.reservar(clave("lc-t"), SOBRE);
    await l.marcarEnviado(P, id);
    await expect(l.liberar(P, id, { tipo: "no_enviado", motivo: "abortado_antes_de_enviar" })).rejects.toThrow(TransicionInvalida);
    await l.marcarIncierto(P, id, "timeout_local");
    expect(await l.intento(P, id)).toMatchObject({ state: "uncertain", uncertainReason: "timeout_local", exposureMicroUsd: COTA });
    expect((await l.estado(P))!).toMatchObject({ reservedMicroUsd: 0, uncertainMicroUsd: COTA, pendingExposureMicroUsd: COTA });
    await expect(l.liberar(P, id, { tipo: "no_enviado", motivo: "abortado_antes_de_enviar" })).rejects.toThrow(TransicionInvalida);
    // Y sigue ocupando el tope: 45 000 + 45 000 + 45 000 > 100 000.
    await l.reservar(clave("lc-t2"), SOBRE);
    expect(await l.reservar(clave("lc-t3"), SOBRE)).toMatchObject({ ok: false, reason: "cap_exceeded" });
  });

  it("el incierto se concilia después con el uso completo del proveedor", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-c", 0);
    await l.reservar(clave("lc-c"), SOBRE);
    await l.marcarEnviado(P, id);
    await l.marcarIncierto(P, id, "stream_truncado");
    expect(await l.liquidar(P, id, USO)).toMatchObject({ state: "settled", costMicroUsd: COSTE });
    expect((await l.estado(P))!).toMatchObject({ spentMicroUsd: COSTE, uncertainMicroUsd: 0, pendingExposureMicroUsd: 0 });
  });
});

describe("el coste desconocido nunca es 0", () => {
  it("usage ausente: incierto con la reserva entera retenida, nada liquidado", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-a", 0);
    await l.reservar(clave("lc-a"), SOBRE);
    await l.marcarEnviado(P, id);
    const r = await l.liquidar(P, id, normalizarUso({ dialecto: "anthropic", uso: undefined }));
    expect(r).toEqual({ state: "uncertain", reason: "uso_ausente", exposureMicroUsd: COTA });
    expect((await l.estado(P))!).toMatchObject({ spentMicroUsd: 0, uncertainMicroUsd: COTA });
    expect(await l.totalDeLlamada(P, "lc-a")).toBeUndefined();
  });

  it("modelo sin precio con política conservadora: la reserva queda como exposición; la estimación se etiqueta", async () => {
    const { l } = await libro(1_000_000, { estricto: false, reservaConservadoraMicroUsd: 50_000 });
    const id = idDeIntento("lc-u", 0);
    expect(await l.reservar(clave("lc-u"), { ...SOBRE, model: "acme-llm-9" })).toMatchObject({ ok: true, amountMicroUsd: 50_000 });
    await l.marcarEnviado(P, id);
    expect(await l.liquidar(P, id, USO)).toMatchObject({ state: "uncertain", reason: "sin_precio", exposureMicroUsd: 50_000 });
    await expect(l.estimar(P, id, { amountMicroUsd: 0, source: "tokenizer" })).rejects.toThrow(TypeError);
    await l.estimar(P, id, { amountMicroUsd: 12_345, source: "tokenizer-heuristic" });
    expect((await l.estado(P))!).toMatchObject({ spentMicroUsd: 0, estimatedMicroUsd: 12_345, pendingExposureMicroUsd: 0 });
    const ev = l.outbox.pendientes().find((e) => e.state === "estimated")!;
    expect(ev).toMatchObject({ label: "estimated", amountMicroUsd: 12_345 });
    // Lo estimado no entra en el libro de recibos verificados.
    expect(await l.totalDeLlamada(P, "lc-u")).toBeUndefined();
  });

  it("usage parcial cuyo suelo supera la reserva: la exposición sube al suelo; una estimación no baja de él", async () => {
    const { l } = await libro(1_000_000);
    const id = idDeIntento("lc-p", 0);
    await l.reservar(clave("lc-p"), SOBRE);
    await l.marcarEnviado(P, id);
    // Sin output_tokens: 20 000 × 3 = 60 000 µ$ de suelo > 45 000.
    const parcial = normalizarUso({ dialecto: "anthropic", uso: { input_tokens: 20_000 } });
    expect(await l.liquidar(P, id, parcial)).toEqual({ state: "uncertain", reason: "uso_parcial", exposureMicroUsd: 60_000, lowerBoundMicroUsd: 60_000 });
    await l.estimar(P, id, { amountMicroUsd: 1_000, source: "a-low-guess" });
    expect(await l.intento(P, id)).toMatchObject({ state: "estimated", estimatedMicroUsd: 60_000 });
  });
});

describe("outbox: al menos una vez, deduplicada y tolerante al desorden", () => {
  async function historia() {
    const { l, avanzar } = await libro(1_000_000);
    const ok = (lc: string, n = 0, extra: Partial<ClaveDeIntento> = {}) => l.reservar(clave(lc, n, extra), SOBRE);
    await ok("lc-o1", 0, { experimentRunId: "run-1", armId: "control" });
    await l.marcarEnviado(P, idDeIntento("lc-o1", 0));
    avanzar(10);
    await l.liquidar(P, idDeIntento("lc-o1", 0), USO);
    await ok("lc-o2");
    await l.marcarEnviado(P, idDeIntento("lc-o2", 0));
    await l.marcarIncierto(P, idDeIntento("lc-o2", 0), "cancelado");
    await ok("lc-o2", 1);
    await l.liberar(P, idDeIntento("lc-o2", 1), { tipo: "no_enviado", motivo: "rechazado_localmente" });
    await ok("lc-o3");
    return l;
  }

  it("ordenada por proyecto + llamada lógica, con seq monótono y sin contenido", async () => {
    const l = await historia();
    const ev = l.outbox.pendientes();
    for (const lc of ["lc-o1", "lc-o2", "lc-o3"]) {
      const seqs = ev.filter((e) => e.logicalCallId === lc).map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    }
    expect(ev.map((e) => e.logicalCallId)).toEqual([...ev.map((e) => e.logicalCallId)].sort());
    expect(ev[0]).toMatchObject({ experimentRunId: "run-1", armId: "control", state: "reserved", label: "exposure", currency: "USD" });
    const claves = new Set(ev.flatMap((e) => Object.keys(e)));
    for (const k of claves) expect(["eventId", "projectId", "logicalCallId", "attemptId", "seq", "state", "at", "amountMicroUsd", "exposureMicroUsd", "currency", "label", "experimentRunId", "armId", "receiptEventId"]).toContain(k);
  });

  it("lo no confirmado se vuelve a entregar; encolar dos veces el mismo evento es un no-op", async () => {
    const l = await historia();
    const primera = l.outbox.pendientes(3);
    expect(l.outbox.pendientes(3)).toEqual(primera);
    expect(l.outbox.confirmar(primera.map((e) => e.eventId))).toBe(3);
    expect(l.outbox.pendientes().some((e) => primera.some((p) => p.eventId === e.eventId))).toBe(false);
    expect(l.outbox.encolar(primera[0]!)).toBe("repetido");
    expect(() => l.outbox.encolar({ ...primera[0]!, amountMicroUsd: 1 })).toThrow(ConflictoDeIntento);
  });

  it("el agregado no depende del orden ni de los duplicados, y cuadra con el libro", async () => {
    const l = await historia();
    const ev = l.outbox.pendientes();
    const ordenado = new AgregadorDePresupuesto();
    for (const e of ev) ordenado.aplicar(e);
    const esperado = (await l.estado(P))!;
    const referencia = {
      spentMicroUsd: esperado.spentMicroUsd,
      estimatedMicroUsd: esperado.estimatedMicroUsd,
      pendingExposureMicroUsd: esperado.pendingExposureMicroUsd,
    };
    expect(ordenado.resumen(P)).toMatchObject({ ...referencia, attempts: 4 });
    // Lo sabido a mano: un liquidado (20 400), un incierto (45 000), uno liberado y uno reservado (45 000).
    expect(referencia).toEqual({ spentMicroUsd: COSTE, estimatedMicroUsd: 0, pendingExposureMicroUsd: 2 * COTA });
    let semilla = 7;
    const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let vuelta = 0; vuelta < 50; vuelta++) {
      const entrega: EventoDePresupuesto[] = [...ev, ...ev.filter(() => azar() < 0.5)];
      entrega.sort(() => azar() - 0.5);
      const a = new AgregadorDePresupuesto();
      for (const e of entrega) a.aplicar(e);
      expect(a.resumen(P)).toMatchObject(referencia);
    }
  });

  it("una outbox inyectada recibe los eventos en la misma operación", async () => {
    const outbox = new OutboxEnMemoria();
    const l = new BudgetLedgerEnMemoria({ reloj: () => DIA, outbox });
    await l.definirPresupuesto({ projectId: P, capMicroUsd: 100_000, currency: "USD", estricto: true });
    await l.reservar(clave("lc-x"), SOBRE);
    expect(outbox.pendientes()).toHaveLength(1);
  });
});

describe("recibos abiertos: alerta por antigüedad", () => {
  it("los abiertos más viejos que el umbral se avisan; los cerrados no", async () => {
    const avisos: string[][] = [];
    const { l, avanzar } = await libro(1_000_000, {}, { alertaDeAntiguedad: { umbralMs: 2 * 3_600_000, avisar: (xs: { attemptId: string }[]) => avisos.push(xs.map((x) => x.attemptId)) } });
    await l.reservar(clave("lc-v1"), SOBRE);
    await l.marcarEnviado(P, idDeIntento("lc-v1", 0));
    await l.reservar(clave("lc-v2"), SOBRE);
    await l.marcarEnviado(P, idDeIntento("lc-v2", 0));
    await l.liquidar(P, idDeIntento("lc-v2", 0), USO);
    avanzar(2 * 3_600_000);
    expect(await l.revisarAntiguedad(P)).toEqual([]);
    avanzar(1);
    const viejos = await l.revisarAntiguedad(P);
    expect(viejos.map((x) => x.attemptId)).toEqual([idDeIntento("lc-v1", 0)]);
    expect(avisos).toEqual([[idDeIntento("lc-v1", 0)]]);
  });
});

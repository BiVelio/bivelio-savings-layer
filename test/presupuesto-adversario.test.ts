import { describe, it, expect } from "vitest";

import {
  AgregadorDePresupuesto,
  BudgetLedgerEnMemoria,
  OutboxEnMemoria,
  type ClaveDeIntento,
  type EventoDePresupuesto,
  type OutboxDePresupuesto,
  type SobreDePresupuesto,
} from "../src/metering/presupuesto.js";
import { normalizarUso, type AttemptUsage } from "../src/metering/intento.js";

/**
 * D07 · LA REVISIÓN ADVERSARIA. Lo que el contrato promete y los tests del PR
 * no ejercían: «cada transición deja su evento en la outbox DENTRO de la misma
 * sección crítica». Si `encolar` falla (la outbox duradera caída, un conflicto
 * de cuerpo), la transición tiene que NO haber ocurrido: un libro que ya
 * cambió y una outbox que no lo sabe es un agregador que nunca verá ese
 * gasto, y el reintento cae en la rama «repetido» y tampoco lo emite.
 *
 * Cifras a mano, las del test del PR: claude-sonnet-4-5, 10 000 de entrada y
 * 1000 de salida → 45 000 µ$ de cota; el uso real cuesta 20 400 µ$.
 */

const DIA = Date.UTC(2026, 9, 1);
const P = "proj-d07-adv";
const SOBRE: SobreDePresupuesto = {
  model: "claude-sonnet-4-5",
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  razonamiento: "dentro_de_salida",
  escriturasDeCache: false,
  maxIntentos: 3,
};
const COTA = 45_000;
const USO: AttemptUsage = normalizarUso({
  dialecto: "anthropic",
  uso: { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000, output_tokens: 500 },
});
const COSTE = 20_400;

const clave = (logicalCallId: string, attempt = 0): ClaveDeIntento => ({
  projectId: P,
  logicalCallId,
  attempt,
  kind: attempt === 0 ? "primary" : "retry",
});

/** Una outbox que se cae a voluntad: lo que hace una duradera sin conexión. */
class OutboxQueFalla implements OutboxDePresupuesto {
  readonly real = new OutboxEnMemoria();
  caida = false;
  encolar(e: EventoDePresupuesto): "encolado" | "repetido" {
    if (this.caida) throw new Error("outbox no disponible");
    return this.real.encolar(e);
  }
  pendientes(limite?: number): EventoDePresupuesto[] {
    return this.real.pendientes(limite);
  }
  confirmar(ids: readonly string[]): number {
    return this.real.confirmar(ids);
  }
}

async function montar(cap = 1_000_000) {
  const outbox = new OutboxQueFalla();
  const l = new BudgetLedgerEnMemoria({ reloj: () => DIA, outbox });
  await l.definirPresupuesto({ projectId: P, capMicroUsd: cap, currency: "USD", estricto: true });
  return { l, outbox };
}

function agregar(eventos: EventoDePresupuesto[]) {
  const a = new AgregadorDePresupuesto();
  for (const e of eventos) a.aplicar(e);
  return a.resumen(P);
}

describe("D07 adversario · una outbox que falla deshace la transición (misma sección crítica)", () => {
  it("reservar: sin evento no hay reserva, y el reintento reserva y emite", async () => {
    const { l, outbox } = await montar();
    outbox.caida = true;
    await expect(l.reservar(clave("lc_a"), SOBRE)).rejects.toThrow("outbox no disponible");
    expect(await l.intento(P, "lc_a:a0")).toBeUndefined();
    expect(await l.estado(P)).toMatchObject({ reservedMicroUsd: 0, availableMicroUsd: 1_000_000 });

    outbox.caida = false;
    const r = await l.reservar(clave("lc_a"), SOBRE);
    expect(r).toMatchObject({ ok: true, repeated: false, amountMicroUsd: COTA });
    expect(agregar(outbox.pendientes())).toMatchObject({ pendingExposureMicroUsd: COTA, attempts: 1 });
  });

  it("liquidar: sin evento el intento sigue enviado; el reintento liquida y el agregador ve el gasto", async () => {
    const { l, outbox } = await montar();
    await l.reservar(clave("lc_b"), SOBRE);
    await l.marcarEnviado(P, "lc_b:a0");
    outbox.caida = true;
    await expect(l.liquidar(P, "lc_b:a0", USO)).rejects.toThrow("outbox no disponible");
    expect(await l.intento(P, "lc_b:a0")).toMatchObject({ state: "dispatched", exposureMicroUsd: COTA });
    expect(await l.estado(P)).toMatchObject({ spentMicroUsd: 0, reservedMicroUsd: COTA });
    // El libro de recibos de D02 tampoco se quedó con un recibo huérfano.
    expect(await l.totalDeLlamada(P, "lc_b")).toBeUndefined();

    outbox.caida = false;
    const s = await l.liquidar(P, "lc_b:a0", USO);
    expect(s).toMatchObject({ state: "settled", repeated: false, costMicroUsd: COSTE });
    const ledger = await l.estado(P);
    const agg = agregar(outbox.pendientes());
    expect(agg.spentMicroUsd).toBe(COSTE);
    expect(agg.spentMicroUsd).toBe(ledger!.spentMicroUsd);
    expect(agg.pendingExposureMicroUsd).toBe(ledger!.pendingExposureMicroUsd);
  });

  it("marcarEnviado, liberar, marcarIncierto y estimar: el libro y la outbox no se separan nunca", async () => {
    const { l, outbox } = await montar();
    await l.reservar(clave("lc_c"), SOBRE);
    await l.reservar(clave("lc_d"), SOBRE);
    outbox.caida = true;
    await expect(l.marcarEnviado(P, "lc_c:a0")).rejects.toThrow();
    expect(await l.intento(P, "lc_c:a0")).toMatchObject({ state: "reserved" });
    await expect(l.liberar(P, "lc_d:a0", { tipo: "no_enviado", motivo: "rechazado_localmente" })).rejects.toThrow();
    expect(await l.intento(P, "lc_d:a0")).toMatchObject({ state: "reserved", exposureMicroUsd: COTA });

    outbox.caida = false;
    await l.marcarEnviado(P, "lc_c:a0");
    outbox.caida = true;
    await expect(l.marcarIncierto(P, "lc_c:a0", "timeout_local")).rejects.toThrow();
    expect(await l.intento(P, "lc_c:a0")).toMatchObject({ state: "dispatched" });
    expect(await l.estado(P)).toMatchObject({ uncertainMicroUsd: 0, reservedMicroUsd: 2 * COTA });

    outbox.caida = false;
    await l.marcarIncierto(P, "lc_c:a0", "timeout_local");
    outbox.caida = true;
    await expect(l.estimar(P, "lc_c:a0", { amountMicroUsd: 30_000, source: "mediana" })).rejects.toThrow();
    expect(await l.intento(P, "lc_c:a0")).toMatchObject({ state: "uncertain", exposureMicroUsd: COTA });
    expect(await l.estado(P)).toMatchObject({ estimatedMicroUsd: 0, uncertainMicroUsd: COTA });

    outbox.caida = false;
    await l.estimar(P, "lc_c:a0", { amountMicroUsd: 30_000, source: "mediana" });
    await l.liberar(P, "lc_d:a0", { tipo: "no_enviado", motivo: "rechazado_localmente" });
    const ledger = (await l.estado(P))!;
    const agg = agregar(outbox.pendientes());
    expect(agg).toMatchObject({ estimatedMicroUsd: 30_000, pendingExposureMicroUsd: 0, spentMicroUsd: 0 });
    expect(agg.estimatedMicroUsd).toBe(ledger.estimatedMicroUsd);
    expect(agg.pendingExposureMicroUsd).toBe(ledger.pendingExposureMicroUsd);
    // Los `seq` no saltan: un intento fallido no consumió número.
    const seqs = outbox.pendientes().filter((e) => e.logicalCallId === "lc_c").map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});

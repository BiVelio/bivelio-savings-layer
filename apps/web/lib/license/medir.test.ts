import { describe, expect, it } from "vitest";

import { MEASURE_LIMITS } from "../../../../packages/protocol/src/index";
import {
  aplicarTopeDeAsientos,
  dominioDelCorreo,
  huecoDeVolumen,
  inicioDeMes,
  LIMITES_MEDIR,
  neutralizarParaMedir,
} from "./medir";
import type { UsageRecord } from "@/lib/metering/usage";

describe("lib/license/medir", () => {
  it("los límites de la web son el espejo exacto de los del protocolo", () => {
    expect(LIMITES_MEDIR).toEqual({
      asientos: MEASURE_LIMITS.seats,
      orgsPorCuenta: MEASURE_LIMITS.orgsPerAccount,
      peticionesDiarias: MEASURE_LIMITS.dailyRequests,
      diasDeVigencia: MEASURE_LIMITS.termDays,
      diasDeGracia: MEASURE_LIMITS.graceDays,
    });
  });

  it("neutralizarParaMedir deja la sombra intacta y todo lo demás sin ahorro", () => {
    const recs = [
      { requestId: "a", basis: "measured", baselineCost: 2, actualCost: 1, baselineInputTokens: 9, actualInputTokens: 3, baselineOutputTokens: 5, actualOutputTokens: 5, eliminatedInputTokens: 6, compressedInputTokens: 0, avoidedLlm: 0, netSavings: 0.5 },
      { requestId: "a:shadow", basis: "shadow", baselineCost: 1, actualCost: 0, netSavings: 1 },
    ] as unknown as UsageRecord[];
    const n = neutralizarParaMedir(recs);
    expect(n).toEqual({ neutralizados: 1, referencias: 0 });
    expect(recs[0]).toMatchObject({ baselineCost: 1, baselineInputTokens: 3, eliminatedInputTokens: 0, netSavings: 0 });
    expect(recs[1]).toMatchObject({ baselineCost: 1, actualCost: 0, netSavings: 1 });
  });

  it("aplicarTopeDeAsientos: conocidos siempre, nuevos mientras haya hueco, `unknown` cuenta", () => {
    const r = aplicarTopeDeAsientos([{ seatId: "a" }, { seatId: "b" }, {}, { seatId: "c" }], new Set(["a"]), 3);
    expect(r.admitidos).toEqual([{ seatId: "a" }, { seatId: "b" }, {}]);
    expect(r.asientosRechazados).toEqual(["c"]);
  });

  it("huecoDeVolumen, inicioDeMes y dominioDelCorreo", () => {
    expect(huecoDeVolumen(19_990)).toBe(10);
    expect(huecoDeVolumen(25_000)).toBe(0);
    expect(inicioDeMes(Date.UTC(2026, 8, 29, 23))).toBe("2026-09-01");
    expect(dominioDelCorreo(" Ana@Acme.IO ")).toBe("acme.io");
    expect(dominioDelCorreo("sin-arroba")).toBeNull();
  });
});

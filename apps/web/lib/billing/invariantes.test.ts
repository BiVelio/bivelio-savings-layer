import { describe, it, expect } from "vitest";

import { orgsPagandoSinLicencia } from "./invariantes";
import type { LicenseRow } from "@/lib/metering/entitlement";

/**
 * El invariante que vigila el defecto que costó dos días: alguien pagando y sin
 * producto. Los dos errores posibles son caros y opuestos — callar con un cliente
 * que ha pagado y no tiene nada, o gritar con uno que está perfectamente.
 */

const DIA = 86_400_000;
const AHORA = Date.parse("2026-08-12T12:00:00Z");
const enDias = (n: number) => new Date(AHORA + n * DIA).toISOString();

const viva: LicenseRow = { revoked: false, expires_at: enDias(20), grace_days: 21 };
const caducada: LicenseRow = { revoked: false, expires_at: enDias(-60), grace_days: 21 };
const revocada: LicenseRow = { revoked: true, expires_at: enDias(20), grace_days: 21 };

const sub = (org: string, status: string) => ({ org_id: org, status, stripe_subscription_id: `sub_${org}` });

describe("orgs pagando sin licencia viva", () => {
  it("lo normal: paga y tiene licencia → no aparece", () => {
    const r = orgsPagandoSinLicencia([sub("a", "active")], new Map([["a", [viva]]]), AHORA);
    expect(r).toEqual([]);
  });

  it("PAGA Y NO TIENE NADA: el defecto que esto vigila", () => {
    const r = orgsPagandoSinLicencia([sub("a", "active")], new Map(), AHORA);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ orgId: "a", status: "active", licencias: 0, tuvoYPerdio: false });
  });

  it("LAS TUVO Y LAS PERDIÓ: se distingue, porque apunta a otra causa", () => {
    // "Nunca se le emitió" apunta al camino de alta; "las tuvo y las perdió"
    // apunta a una revocación indebida o a una renovación no entregada.
    const r = orgsPagandoSinLicencia([sub("a", "active")], new Map([["a", [caducada, revocada]]]), AHORA);
    expect(r[0]).toMatchObject({ licencias: 2, tuvoYPerdio: true });
  });

  it("una licencia en GRACIA todavía es producto: no se avisa", () => {
    const enGracia: LicenseRow = { revoked: false, expires_at: enDias(-2), grace_days: 21 };
    expect(orgsPagandoSinLicencia([sub("a", "active")], new Map([["a", [enGracia]]]), AHORA)).toEqual([]);
  });

  it("una revocada NO tapa la ausencia, aunque su fecha sea futura", () => {
    const r = orgsPagandoSinLicencia([sub("a", "active")], new Map([["a", [revocada]]]), AHORA);
    expect(r).toHaveLength(1);
  });

  it("`past_due` SÍ cuenta como pagando: está en gracia, no fuera", () => {
    const r = orgsPagandoSinLicencia([sub("a", "past_due")], new Map(), AHORA);
    expect(r).toHaveLength(1);
  });

  it("`incomplete` NO cuenta: no tener licencia ahí es lo CORRECTO", () => {
    // Un adeudo SEPA tarda días en liquidar. Contarlo daría una alarma falsa cada
    // vez que alguien compra por domiciliación — y una alarma que salta sin
    // motivo deja de mirarse, que es peor que no tenerla.
    expect(orgsPagandoSinLicencia([sub("a", "incomplete")], new Map(), AHORA)).toEqual([]);
  });

  it("una cancelada tampoco: ya no paga", () => {
    for (const s of ["canceled", "unpaid", "incomplete_expired"]) {
      expect(orgsPagandoSinLicencia([sub("a", s)], new Map(), AHORA)).toEqual([]);
    }
  });

  it("con muchas orgs, solo salen las descubiertas", () => {
    const subs = [sub("sana", "active"), sub("rota", "active"), sub("cancelada", "canceled")];
    const lic = new Map([
      ["sana", [viva]],
      ["cancelada", [caducada]],
    ]);
    const r = orgsPagandoSinLicencia(subs, lic, AHORA);
    expect(r.map((x) => x.orgId)).toEqual(["rota"]);
  });
});

import { describe, expect, it } from "vitest";

import { idsConComision, tuvoComisionEnElPeriodo } from "./plan-de-la-org";

/**
 * LA TERCERA VERJA, en puro: ¿tuvo esta organización la modalidad CON comisión
 * en el período? Lista POSITIVA de precios y un período que llega al mes.
 * La ruta (facturar-extractos/tercera-verja.test.ts) y el panel del extracto
 * deciden con esta misma función.
 */

const IDS = ["price_com_m", "price_com_y"];

describe("idsConComision", () => {
  it("trocea por comas, recorta y descarta vacíos (un salto de línea final de `vercel env add` no deja fuera a nadie)", () => {
    expect(idsConComision("price_com_m\n", " price_com_y ", " price_a , price_b ,, \n")).toEqual([
      "price_com_m",
      "price_com_y",
      "price_a",
      "price_b",
    ]);
  });
  it("sin nada configurado: lista vacía", () => {
    expect(idsConComision("", undefined, null)).toEqual([]);
  });
});

describe("tuvoComisionEnElPeriodo", () => {
  it("una suscripción de comisión viva que llega al mes: sí", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: "2026-12-01T10:00:00Z" }], IDS, "2026-11")).toBe(true);
  });
  it("cancelada a mitad de mes (su período llegaba al mes): sí — su último mes se cierra con comisión", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: "2026-11-12T10:00:00Z" }], IDS, "2026-11")).toBe(true);
  });
  it("su período acabó justo al empezar el mes, o antes: no", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: "2026-11-01T00:00:00Z" }], IDS, "2026-11")).toBe(false);
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: "2026-09-01T00:00:00Z" }], IDS, "2026-11")).toBe(false);
  });
  it("sin fecha de fin: sí (no se le quita la comisión a quien la tiene)", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_y", current_period_end: null }], IDS, "2026-11")).toBe(true);
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_y" }], IDS, "2026-11")).toBe(true);
  });
  it("una fecha ilegible no cuenta: equivocarse hacia aquí solo deja una factura sin emitir, con su alerta", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: "mañana" }], IDS, "2026-11")).toBe(false);
  });
  it("Pro, Equipo, un precio hecho a mano o un price_id nulo NO son la modalidad con comisión", () => {
    for (const price_id of ["price_pro_m", "price_team_m", "price_enterprise_a_mano", null, ""]) {
      expect(tuvoComisionEnElPeriodo([{ price_id, current_period_end: "2026-12-01T10:00:00Z" }], IDS, "2026-11"), String(price_id)).toBe(false);
    }
  });
  it("sin precios de comisión configurados, o con un período ilegible: no", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: null }], [], "2026-11")).toBe(false);
    expect(tuvoComisionEnElPeriodo([{ price_id: "price_com_m", current_period_end: null }], IDS, "nov")).toBe(false);
  });
  it("basta con una: ex-comisión (acabó en septiembre) que compra Pro y lo cancela en noviembre: no", () => {
    expect(
      tuvoComisionEnElPeriodo(
        [
          { price_id: "price_com_m", current_period_end: "2026-09-01T00:00:00Z" },
          { price_id: "price_pro_m", current_period_end: "2026-12-01T10:00:00Z" },
        ],
        IDS,
        "2026-11",
      ),
    ).toBe(false);
  });
  it("el price_id de la fila también se recorta", () => {
    expect(tuvoComisionEnElPeriodo([{ price_id: " price_com_m ", current_period_end: "2026-12-01T00:00:00Z" }], IDS, "2026-11")).toBe(true);
  });
});

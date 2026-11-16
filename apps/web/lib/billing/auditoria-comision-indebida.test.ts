import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { candidatosAAbono, DESDE_POR_DEFECTO, ESTADOS_FACTURADOS } from "../../scripts/auditoria-comision-indebida.mjs";

/**
 * scripts/auditoria-comision-indebida.mjs — la auditoría de SOLO LECTURA de la
 * comisión que el cierre facturó, con la regla anterior, a quien hoy no la
 * debería (Pro o Equipo cancelado o impagado, sin suscripción). Lo ejecuta el
 * dueño; aquí se prueba que decide con la MISMA función que el cierre y que el
 * script no puede escribir nada.
 */

const catalogo = { comision: ["price_legacy_m"], pro: ["price_pro_m"], equipo: ["price_team_m"], sinComision: ["price_socio"] };
const sub = (org_id: string, price_id: string, status: string, mas: Record<string, unknown> = {}) => ({
  org_id,
  price_id,
  status,
  created_at: "2026-06-03T09:00:00Z",
  canceled_at: null,
  current_period_end: "2026-11-03T09:00:00Z",
  cancel_at_period_end: false,
  last_event_at: status === "canceled" ? (mas.canceled_at ?? null) : "2026-10-03T09:00:05Z",
  ...mas,
});
const cargo = (org_id: string, periodo: string, estado: string, importe_eur = 12.34) => ({
  org_id,
  periodo,
  estado,
  importe_eur,
  stripe_invoice_id: estado.startsWith("omitido") ? null : `in_${org_id}_${periodo}`,
});

describe("auditoría de la comisión indebida", () => {
  const subs = [
    sub("legado", "price_legacy_m", "active"),
    sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
    sub("equipo-impagado", "price_team_m", "unpaid"),
    sub("rotado", "price_legacy_inclusive", "active"),
  ];

  it("lista los cargos facturados o pagados de quien hoy no llevaría comisión, con ids e importes y nada más", () => {
    const salida = candidatosAAbono(
      [
        cargo("legado", "2026-10", "pagado"),
        cargo("pro-cancelado", "2026-10", "pagado", 40.5),
        cargo("equipo-impagado", "2026-09", "facturado", 7),
        cargo("sin-suscripcion", "2026-10", "pagado", 3.2),
      ],
      subs,
      catalogo,
    );
    expect(salida).toEqual([
      { org_id: "equipo-impagado", periodo: "2026-09", importe_eur: 7, estado: "facturado", stripe_invoice_id: "in_equipo-impagado_2026-09", motivo: "plan_de_cuota_fija", precios: ["price_team_m"], revisar: false, seguro: true },
      { org_id: "pro-cancelado", periodo: "2026-10", importe_eur: 40.5, estado: "pagado", stripe_invoice_id: "in_pro-cancelado_2026-10", motivo: "plan_de_cuota_fija", precios: ["price_pro_m"], revisar: false, seguro: true },
      // Sin ninguna fila no hay Price de Pro/Equipo que lo pruebe: candidato, pero NO «seguro».
      { org_id: "sin-suscripcion", periodo: "2026-10", importe_eur: 3.2, estado: "pagado", stripe_invoice_id: "in_sin-suscripcion_2026-10", motivo: "sin_suscripcion_con_comision", precios: [], revisar: false, seguro: false },
    ]);
  });

  it("⛔ un 0 apoyado en STRIPE_PRICE_IDS_SIN_COMISION NO es «seguro»: enseña el Price para que se compruebe", () => {
    // El fallo que esto cierra (F3): un Price de comisión archivado por error en
    // la lista sin comisión sellaba a 0 sin alerta, y la auditoría presentaba
    // sus facturas —que eran CORRECTAS— como un abono sin más (`revisar: false`).
    const filas = [sub("mal-archivado", "price_socio", "active"), sub("pro-y-socio", "price_pro_m", "active"), sub("pro-y-socio", "price_socio", "active")];
    const salida = candidatosAAbono([cargo("mal-archivado", "2026-10", "pagado"), cargo("pro-y-socio", "2026-10", "pagado")], filas, catalogo);
    expect(salida).toEqual([
      expect.objectContaining({ org_id: "mal-archivado", motivo: "plan_de_cuota_fija", precios: ["price_socio"], revisar: false, seguro: false }),
      // Basta UNA fila fuera de Pro/Equipo para que deje de ser seguro.
      expect.objectContaining({ org_id: "pro-y-socio", precios: ["price_pro_m", "price_socio"], revisar: false, seguro: false }),
    ]);
  });

  it("un Price sin declarar sale marcado REVISAR: no es un abono seguro", () => {
    expect(candidatosAAbono([cargo("rotado", "2026-10", "pagado")], subs, catalogo)).toEqual([
      expect.objectContaining({ org_id: "rotado", motivo: "precio_desconocido", precios: ["price_legacy_inclusive"], revisar: true, seguro: false }),
    ]);
  });

  it("ignora lo que no es una factura emitida (fallido, omitido) y decide por el período de CADA cargo", () => {
    expect(ESTADOS_FACTURADOS).toEqual(["facturado", "pagado"]);
    expect(DESDE_POR_DEFECTO).toBe("2026-09");
    const salida = candidatosAAbono(
      [
        cargo("pro-cancelado", "2026-10", "fallido"),
        cargo("pro-cancelado", "2026-10", "omitido_sin_cliente"),
        // Legado cancelado el 15 de octubre: octubre lo debía, noviembre no.
        cargo("ex-legado", "2026-10", "pagado"),
        cargo("ex-legado", "2026-11", "pagado"),
      ],
      [sub("ex-legado", "price_legacy_m", "canceled", { canceled_at: "2026-10-15T10:00:00Z" })],
      catalogo,
    );
    expect(salida.map((c: { org_id: string; periodo: string }) => `${c.org_id}:${c.periodo}`)).toEqual(["ex-legado:2026-11"]);
  });

  it("⛔ el script es de SOLO LECTURA y no imprime la clave", () => {
    const texto = readFileSync(fileURLToPath(new URL("../../scripts/auditoria-comision-indebida.mjs", import.meta.url)), "utf8");
    const codigo = texto
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const escritura of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc(", 'from "stripe"', "new Stripe"]) {
      expect(codigo, escritura).not.toContain(escritura);
    }
    // El total que se presenta como abonable es el de los «seguro», no el de «sin revisar».
    expect(codigo).toContain("candidatos.filter((c) => c.seguro)");
    expect(codigo).not.toContain("filter((c) => !c.revisar)");
    // La clave solo se pasa al cliente de Supabase: ni console.* ni JSON.stringify la tocan.
    for (const linea of codigo.split("\n").filter((l) => /console\.|JSON\.stringify/.test(l))) {
      expect(linea, linea).not.toMatch(/\bclave\b(?! \?)/);
    }
  });
});

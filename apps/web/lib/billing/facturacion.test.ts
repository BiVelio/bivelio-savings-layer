import { describe, it, expect } from "vitest";

import {
  claveIdempotencia,
  decidirCargo,
  decisionDeComision,
  descripcionDeLinea,
  ensayoDeCargo,
  esFacturaDeComision,
  medioDePagoParaLaFactura,
  metadataDeFactura,
  MINIMO_FACTURABLE_EUR,
  type ExtractoFacturable,
} from "./facturacion";
import { calcularComision } from "./tarifa";
import { construirExtracto } from "./extracto";
import { FX_SOMBRA, VERSION_PRECIOS_CATALOGO } from "./extracto-sombra";

/**
 * LA DECISIÓN DE FACTURAR. Cada caso de estos es dinero cobrado de más o de
 * menos a un cliente real, así que las verjas van por el lado que más duele:
 * la calibración y la doble factura son imposibles POR DECISIÓN, no por
 * costumbre del cron.
 */

const base: ExtractoFacturable = {
  org_id: "0b7e5a54-0000-4000-8000-000000000001",
  periodo: "2026-08",
  es_calibracion: false,
  cargo_eur: 123.45,
  ahorro_medido_eur: 1_500,
  base_medida_eur: 4_000,
  ratio: 0.375,
};
const CLIENTE = "cus_test123";

describe("decidirCargo", () => {
  it("factura el cargo del extracto, céntimo a céntimo", () => {
    const d = decidirCargo(base, CLIENTE, false);
    expect(d).toEqual({ accion: "facturar", centimos: 12_345, clienteStripe: CLIENTE });
  });

  it("⛔ calibración JAMÁS factura, aunque alguien colara un cargo", () => {
    // La constraint de 0016 ya impide un extracto así en la base; esta es la
    // segunda verja, por si el dato llega por otro camino.
    const d = decidirCargo({ ...base, es_calibracion: true }, CLIENTE, false);
    expect(d).toEqual({ accion: "nada", motivo: "calibracion" });
  });

  it("⛔ un período ya facturado no se refactura — venga de donde venga la repetición", () => {
    const d = decidirCargo(base, CLIENTE, true);
    expect(d).toEqual({ accion: "nada", motivo: "ya_facturado" });
  });

  it("cargo 0 no genera nada (ni fila de omisión)", () => {
    expect(decidirCargo({ ...base, cargo_eur: 0 }, CLIENTE, false)).toEqual({ accion: "nada", motivo: "sin_cargo" });
  });

  it("sin cliente de Stripe se OMITE con causa, nunca se pierde en silencio", () => {
    expect(decidirCargo(base, null, false)).toEqual({ accion: "omitir", estado: "omitido_sin_cliente" });
  });

  it("bajo el mínimo cobrable de Stripe se omite con causa", () => {
    const d = decidirCargo({ ...base, cargo_eur: MINIMO_FACTURABLE_EUR - 0.01 }, CLIENTE, false);
    expect(d).toEqual({ accion: "omitir", estado: "omitido_bajo_minimo" });
    // Y el mínimo exacto SÍ se factura: el límite es de Stripe, no un colchón.
    expect(decidirCargo({ ...base, cargo_eur: MINIMO_FACTURABLE_EUR }, CLIENTE, false).accion).toBe("facturar");
  });

  it("los céntimos se redondean como una cifra de factura (half-up)", () => {
    const d = decidirCargo({ ...base, cargo_eur: 10.005 }, CLIENTE, false);
    expect(d).toMatchObject({ accion: "facturar", centimos: 1_001 });
  });

  it("el orden de las verjas: ya-facturado gana incluso a calibración", () => {
    // Reintentar un cron no debe reclasificar nada: lo registrado, registrado.
    const d = decidirCargo({ ...base, es_calibracion: true }, CLIENTE, true);
    expect(d).toEqual({ accion: "nada", motivo: "ya_facturado" });
  });
});

describe("la factura cita el extracto, no una plantilla", () => {
  it("la línea lleva el período y las cifras medidas del extracto", () => {
    const linea = descripcionDeLinea(base);
    expect(linea).toContain("2026-08");
    expect(linea).toContain("€4000.00");
    expect(linea).toContain("€1500.00");
    expect(linea).toContain("37.5%");
    // Y NO lleva el importe de la comisión escrito: ese va como amount de la
    // línea, una sola vez — dos copias del mismo número acaban divergiendo.
    expect(linea).not.toContain("123.45");
  });

  it("la metadata identifica (tipo, org, período) — lo que el webhook necesita", () => {
    const m = metadataDeFactura(base);
    expect(esFacturaDeComision(m)).toBe(true);
    expect(m["bvsala_org_id"]).toBe(base.org_id);
    expect(m["bvsala_periodo"]).toBe("2026-08");
  });

  it("una factura ajena (asientos, u otra cosa) NO es de comisión", () => {
    expect(esFacturaDeComision({})).toBe(false);
    expect(esFacturaDeComision(null)).toBe(false);
    expect(esFacturaDeComision({ bvsala_tipo: "otra" })).toBe(false);
  });
});

describe("idempotencia", () => {
  it("la clave de Stripe es estable por (org, período, pieza) y versionada", () => {
    const a = claveIdempotencia(base.org_id, "2026-08", "factura");
    expect(a).toBe(claveIdempotencia(base.org_id, "2026-08", "factura"));
    expect(a).not.toBe(claveIdempotencia(base.org_id, "2026-08", "linea"));
    expect(a).not.toBe(claveIdempotencia(base.org_id, "2026-09", "factura"));
    expect(a).toMatch(/-v1$/);
  });
});

describe("de punta a punta con la máquina real del extracto", () => {
  it("lo que decide facturar es EXACTAMENTE el cargo que el cierre fijó", () => {
    // Un período por encima del umbral: la comisión de la tarifa, en céntimos.
    const e = construirExtracto({
      orgId: base.org_id,
      periodo: "2026-08",
      esCalibracion: false,
      versionPrecios: VERSION_PRECIOS_CATALOGO,
      fx: FX_SOMBRA,
      filas: [{
        day: "2026-08-10",
        requests: 100,
        baseline_cost: 5_000,
        actual_cost: 3_000,
        measured_requests: 100,
        measured_baseline_cost: 5_000,
        measured_actual_cost: 3_000,
      }],
    });
    const d = decidirCargo(
      {
        org_id: e.orgId,
        periodo: e.periodo,
        es_calibracion: e.esCalibracion,
        cargo_eur: e.cargoEur,
        ahorro_medido_eur: e.ahorroMedidoEur,
        base_medida_eur: e.baseMedidaEur,
        ratio: e.comision.ratio,
      },
      CLIENTE,
      false,
    );
    const esperada = calcularComision(e.baseMedidaEur, e.ahorroMedidoEur).comisionEur;
    expect(e.cargoEur).toBe(esperada);
    expect(d).toMatchObject({ accion: "facturar", centimos: Math.round(esperada * 100) });
  });
});

describe("decisionDeComision — pagado es pegajoso (guardia de orden)", () => {
  it("un `fallido` que YA estaba pagado (0 filas) NO alerta y deja rastro de ignorado", () => {
    const d = decisionDeComision("fallido", false);
    expect(d.alertarFallo).toBe(false);
    expect(d.auditKind).toBe("comision_fallido_ignorado_ya_pagado");
  });

  it("un `fallido` que SÍ se aplica alerta en crítico", () => {
    const d = decisionDeComision("fallido", true);
    expect(d.alertarFallo).toBe(true);
    expect(d.auditKind).toBe("comision_fallido");
  });

  it("un `pagado` no alerta y su audit es comision_pagado", () => {
    const d = decisionDeComision("pagado", true);
    expect(d.alertarFallo).toBe(false);
    expect(d.auditKind).toBe("comision_pagado");
  });
});

describe("medioDePagoParaLaFactura — la factura suelta no hereda el medio de pago de Checkout", () => {
  it("el de la suscripción de asientos manda, venga como id o como objeto expandido", () => {
    expect(medioDePagoParaLaFactura({ suscripcion: { default_payment_method: "pm_sub" }, cliente: { invoice_settings: { default_payment_method: "pm_cus" } } }))
      .toEqual({ id: "pm_sub", origen: "suscripcion" });
    expect(medioDePagoParaLaFactura({ suscripcion: { default_payment_method: { id: "pm_obj" } } })).toEqual({ id: "pm_obj", origen: "suscripcion" });
  });
  it("sin medio en la suscripción, el predeterminado para facturas del cliente", () => {
    expect(medioDePagoParaLaFactura({ suscripcion: { default_payment_method: null }, cliente: { invoice_settings: { default_payment_method: "pm_cus" } } }))
      .toEqual({ id: "pm_cus", origen: "cliente" });
  });
  it("⛔ sin ninguno, null — y el cron lo grita antes de emitir, no lo calla", () => {
    expect(medioDePagoParaLaFactura({ suscripcion: null, cliente: { invoice_settings: { default_payment_method: null } } })).toBeNull();
    expect(medioDePagoParaLaFactura({})).toBeNull();
  });
});

describe("ensayoDeCargo — el ensayo en seco dice exactamente lo que haría", () => {
  it("facturar: céntimos, cliente y de dónde saldría el cobro", () => {
    const ensayo = ensayoDeCargo(base, decidirCargo(base, CLIENTE, false), { id: "pm_sub", origen: "suscripcion" });
    expect(ensayo).toMatchObject({ accion: "facturar", centimos: 12345, cliente: CLIENTE, medio_de_pago: "suscripcion" });
  });
  it("facturar sin medio de pago lo dice en voz alta", () => {
    const ensayo = ensayoDeCargo(base, decidirCargo(base, CLIENTE, false), null);
    expect(ensayo.medio_de_pago).toBe("ninguno");
    expect(ensayo.detalle).toMatch(/SIN medio de pago/);
  });
  it("exenta, omitida y nada llevan su causa y ningún importe", () => {
    expect(ensayoDeCargo(base, "exenta", undefined)).toMatchObject({ accion: "exenta", centimos: null });
    expect(ensayoDeCargo(base, decidirCargo(base, null, false), undefined)).toMatchObject({ accion: "omitir", detalle: "omitido_sin_cliente" });
    expect(ensayoDeCargo(base, decidirCargo(base, CLIENTE, true), undefined)).toMatchObject({ accion: "nada", detalle: "ya_facturado" });
  });
});

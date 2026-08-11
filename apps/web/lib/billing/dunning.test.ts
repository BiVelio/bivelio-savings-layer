import { describe, it, expect, afterEach } from "vitest";

import { decidirDunning, diasRestantesDeGracia, selloDeImpago } from "./dunning";
import { diasDeGracia, DIAS_DE_GRACIA_POR_DEFECTO } from "./gracia";

/**
 * El barrido de impago. Cada caso de aquí es una forma real de perder dinero o de
 * perder un cliente, así que se prueban las DOS direcciones del error: degradar a
 * quien no toca (perder un cliente que iba a pagar) y no degradar a quien sí
 * (regalar el producto para siempre).
 */

const DIA = 86_400_000;
const AHORA = Date.parse("2026-08-11T12:00:00Z");
const haceDias = (n: number) => new Date(AHORA - n * DIA).toISOString();

describe("decisión de impago", () => {
  it("una suscripción sana no se toca", () => {
    expect(decidirDunning({ status: "active", pastDueSince: null, nowMs: AHORA })).toBe("nada");
    expect(decidirDunning({ status: "trialing", pastDueSince: haceDias(99), nowMs: AHORA })).toBe("nada");
  });

  it("una ya cancelada no es asunto de este barrido", () => {
    // La cancelación la resuelve `customer.subscription.deleted`, que sí revoca.
    expect(decidirDunning({ status: "canceled", pastDueSince: haceDias(99), nowMs: AHORA })).toBe("nada");
  });

  it("en impago y dentro de la gracia: no se toca", () => {
    expect(decidirDunning({ status: "past_due", pastDueSince: haceDias(3), nowMs: AHORA })).toBe("nada");
    expect(decidirDunning({ status: "past_due", pastDueSince: haceDias(20), nowMs: AHORA })).toBe("nada");
  });

  it("el día de gracia EXACTO todavía cuenta como dentro", () => {
    // La asimetría manda: ante la duda, el cliente sigue funcionando.
    expect(decidirDunning({ status: "past_due", pastDueSince: haceDias(21), nowMs: AHORA, graciaDias: 21 })).toBe(
      "nada",
    );
  });

  it("pasada la gracia: degrada", () => {
    expect(decidirDunning({ status: "past_due", pastDueSince: haceDias(22), nowMs: AHORA, graciaDias: 21 })).toBe(
      "degradar",
    );
  });

  it("en impago SIN sello: se sella, no se degrada", () => {
    // Sin fecha de inicio no se puede contar nada. Degradar aquí castigaría por
    // un dato que falta, no por un impago demostrado.
    expect(decidirDunning({ status: "past_due", pastDueSince: null, nowMs: AHORA })).toBe("sellar");
  });

  it("un sello ilegible se vuelve a sellar, nunca degrada", () => {
    expect(decidirDunning({ status: "past_due", pastDueSince: "no-es-una-fecha", nowMs: AHORA })).toBe("sellar");
  });

  it("un sello en el FUTURO no degrada", () => {
    // Desfase de reloj o dato manipulado: `nowMs - inicio` sería negativo y con
    // una comparación ingenua podría colarse cualquier cosa.
    const futuro = new Date(AHORA + 5 * DIA).toISOString();
    expect(decidirDunning({ status: "past_due", pastDueSince: futuro, nowMs: AHORA })).toBe("nada");
  });

  it("la gracia por defecto son 21 días, no 14", () => {
    // Ata el valor: con 14 días de gracia, el día 15 degradaría. Con 21, no.
    expect(decidirDunning({ status: "past_due", pastDueSince: haceDias(15), nowMs: AHORA })).toBe("nada");
    expect(decidirDunning({ status: "past_due", pastDueSince: haceDias(30), nowMs: AHORA })).toBe("degradar");
  });
});

describe("el sello vive lo que dura el episodio de impago", () => {
  const AHORA_ISO = new Date(AHORA).toISOString();

  it("al entrar en impago se abre un sello", () => {
    expect(selloDeImpago("past_due", null, AHORA_ISO)).toBe(AHORA_ISO);
  });

  it("dentro del mismo episodio NO se rearma el reloj", () => {
    // Cada reintento fallido de Stripe vuelve a pasar por aquí. Si se resellara,
    // la gracia no terminaría nunca.
    const sello = haceDias(4);
    expect(selloDeImpago("past_due", sello, AHORA_ISO)).toBe(sello);
  });

  it("al RECUPERARSE el cobro el sello se borra — este era el fallo crítico", () => {
    // Sin esto, el sello de un impago resuelto hace meses hacía que el SIGUIENTE
    // degradase el día 1, con cero gracia y con Stripe aún reintentando.
    expect(selloDeImpago("active", haceDias(150), AHORA_ISO)).toBeNull();
    expect(selloDeImpago("trialing", haceDias(150), AHORA_ISO)).toBeNull();
    expect(selloDeImpago("canceled", haceDias(150), AHORA_ISO)).toBeNull();
    expect(selloDeImpago("incomplete", haceDias(150), AHORA_ISO)).toBeNull();
  });

  it("el ciclo entero: impago → cobro → impago vuelve a dar gracia completa", () => {
    const primero = selloDeImpago("past_due", null, haceDias(150));
    const trasCobrar = selloDeImpago("active", primero, haceDias(148));
    const segundo = selloDeImpago("past_due", trasCobrar, AHORA_ISO);
    expect(segundo).toBe(AHORA_ISO);
    expect(decidirDunning({ status: "past_due", pastDueSince: segundo, nowMs: AHORA })).toBe("nada");
  });
});

describe("con licencia viva NO se degrada, aunque nuestro reloj haya pasado", () => {
  it("pasada la gracia pero con el producto funcionándole: no se toca", () => {
    // Degradar aquí dejaría al panel diciendo «sin plan activo» a alguien a quien
    // el SDK le sigue funcionando con su token firmado. Caso real: un fallo de
    // cobro a mitad de ciclo con el periodo principal pagado.
    expect(
      decidirDunning({
        status: "past_due",
        pastDueSince: haceDias(40),
        licenciaViva: true,
        nowMs: AHORA,
        graciaDias: 21,
      }),
    ).toBe("nada");
  });

  it("sin licencia viva y pasada la gracia: ahí sí degrada", () => {
    expect(
      decidirDunning({
        status: "past_due",
        pastDueSince: haceDias(40),
        licenciaViva: false,
        nowMs: AHORA,
        graciaDias: 21,
      }),
    ).toBe("degradar");
  });

  it("la licencia viva no exime de SELLAR: el reloj tiene que arrancar igual", () => {
    expect(
      decidirDunning({ status: "past_due", pastDueSince: null, licenciaViva: true, nowMs: AHORA }),
    ).toBe("sellar");
  });
});

describe("segunda red: un sello anterior al periodo en curso no cuenta", () => {
  it("sello rancio de un episodio ya cerrado: se vuelve a sellar, NO se degrada", () => {
    // Acota el daño de cualquier fila que ya tenga un sello viejo en la base.
    expect(
      decidirDunning({
        status: "past_due",
        pastDueSince: haceDias(150),
        periodStart: haceDias(2),
        nowMs: AHORA,
        graciaDias: 21,
      }),
    ).toBe("sellar");
  });

  it("sello del periodo en curso y pasado de gracia: sí degrada", () => {
    expect(
      decidirDunning({
        status: "past_due",
        pastDueSince: haceDias(30),
        periodStart: haceDias(31),
        nowMs: AHORA,
        graciaDias: 21,
      }),
    ).toBe("degradar");
  });

  it("sin periodo declarado se comporta como antes", () => {
    expect(
      decidirDunning({ status: "past_due", pastDueSince: haceDias(30), periodStart: null, nowMs: AHORA, graciaDias: 21 }),
    ).toBe("degradar");
  });
});

describe("días restantes de gracia (para el aviso del panel)", () => {
  it("cuenta lo que queda", () => {
    expect(diasRestantesDeGracia(haceDias(1), AHORA, 21)).toBe(20);
  });

  it("pasada la gracia es 0, nunca negativo", () => {
    expect(diasRestantesDeGracia(haceDias(40), AHORA, 21)).toBe(0);
  });

  it("sin sello o con sello ilegible no inventa un número", () => {
    expect(diasRestantesDeGracia(null, AHORA, 21)).toBeNull();
    expect(diasRestantesDeGracia("ayer", AHORA, 21)).toBeNull();
  });
});

describe("la constante de gracia", () => {
  afterEach(() => {
    delete process.env.BVSALA_GRACE_DAYS;
  });

  it("por defecto, 21", () => {
    expect(diasDeGracia()).toBe(DIAS_DE_GRACIA_POR_DEFECTO);
    expect(DIAS_DE_GRACIA_POR_DEFECTO).toBe(21);
  });

  it("se puede ajustar por variable de entorno", () => {
    process.env.BVSALA_GRACE_DAYS = "30";
    expect(diasDeGracia()).toBe(30);
  });

  it("un valor inválido cae al de por defecto, NO a algo agresivo", () => {
    // Un dedazo en una variable de entorno no puede poder cortarle el servicio a nadie.
    for (const malo of ["", "abc", "-5", "9999", "NaN"]) {
      process.env.BVSALA_GRACE_DAYS = malo;
      expect(diasDeGracia()).toBe(DIAS_DE_GRACIA_POR_DEFECTO);
    }
  });
});

import { describe, it, expect } from "vitest";

import { MAX_ASIENTOS, avisoDeAsientos, normalizarAsientos } from "./asientos";

/**
 * Los asientos, en las costuras donde se puede perder dinero o cortar a un
 * cliente. Se importa la MISMA función que usan el campo del panel, el tope del
 * servidor y la tarjeta de cuenta — si se reimplantara aquí el criterio, una
 * mutación en la fuente pasaría los tests sin enterarse.
 */

describe("cuántos asientos se compran", () => {
  it("por defecto, uno", () => {
    expect(normalizarAsientos("1")).toBe(1);
  });

  it("acepta una cantidad de empresa", () => {
    expect(normalizarAsientos("20")).toBe(20);
    expect(normalizarAsientos(20)).toBe(20);
  });

  it("el campo VACÍO no rompe el botón: cae a 1", () => {
    // El estado se guarda como TEXTO justamente por esto: borrar el campo para
    // teclear "12" pasa por el vacío, y con un número en el estado eso era NaN a
    // mitad de la edición y el botón parpadeaba deshabilitado.
    expect(normalizarAsientos("")).toBe(1);
    expect(normalizarAsientos("abc")).toBe(1);
    expect(normalizarAsientos(null)).toBe(1);
    expect(normalizarAsientos(undefined)).toBe(1);
  });

  it("cero y negativos no pueden llegar a Stripe", () => {
    expect(normalizarAsientos("0")).toBe(1);
    expect(normalizarAsientos(-5)).toBe(1);
  });

  it("los decimales se TRUNCAN, no se redondean hacia arriba", () => {
    // Redondear hacia arriba cobraría un asiento que nadie pidió.
    expect(normalizarAsientos("3.9")).toBe(3);
    expect(normalizarAsientos(1.99)).toBe(1);
  });

  it("un dedazo enorme se acota — y este es el tope del SERVIDOR, no solo del campo", () => {
    // El cuerpo de la petición lo puede mandar cualquiera con sesión y un `curl`:
    // sin tope, `seats: 1e9` crea una sesión de Checkout por un importe absurdo, y
    // si alguien la completa es un cobro REAL que hay que reembolsar a mano.
    expect(normalizarAsientos("999999")).toBe(MAX_ASIENTOS);
    expect(normalizarAsientos(1e9)).toBe(MAX_ASIENTOS);
    expect(normalizarAsientos(Infinity)).toBe(1); // no finito: no es una cantidad
  });
});

describe("qué se le enseña al cliente sobre sus asientos", () => {
  const base = { planActivo: true, rotacionEsteMes: false };

  it("sin plan activo no se dice nada", () => {
    expect(avisoDeAsientos({ ...base, planActivo: false, usados: 5, pagados: 1 })).toBe("nada");
  });

  it("«no se pudo medir» NO se pinta como cero", () => {
    // Un cero inventado le diría que no está usando nada justo cuando el problema
    // es que no hemos podido mirar.
    expect(avisoDeAsientos({ ...base, usados: null, pagados: 3 })).toBe("nada");
  });

  it("CERO no se pinta: los días 1 y 2 de cada mes lo son TODOS", () => {
    // `billable_seats` solo cuenta un asiento con TRES días distintos de actividad
    // en el mes natural, así que a principio de mes el cero es del calendario, no
    // del cliente. Enseñarlo le diría a una flota que lleva un año corriendo que
    // no está usando nada.
    expect(avisoDeAsientos({ ...base, usados: 0, pagados: 3 })).toBe("nada");
  });

  it("dentro de lo pagado: se informa, sin alarmar", () => {
    expect(avisoDeAsientos({ ...base, usados: 2, pagados: 3 })).toBe("en-uso");
    expect(avisoDeAsientos({ ...base, usados: 3, pagados: 3 })).toBe("en-uso"); // justo en el límite
  });

  it("por encima de lo pagado: se avisa del exceso", () => {
    // El caso que impide cobrar de verdad por asiento: 15 máquinas, 1 pagado.
    expect(avisoDeAsientos({ ...base, usados: 15, pagados: 1 })).toBe("exceso");
  });

  it("si rotó la clave este mes, NO se le pide que suba la suscripción", () => {
    // `deriveSeatId` es HMAC(clave, huella): al rotar, todas las máquinas estrenan
    // seat_id y el mes cuenta los viejos Y los nuevos. Pedirle que doble su
    // factura por haber revocado —que es lo que le recomendamos por seguridad—
    // es la peor factura posible.
    expect(avisoDeAsientos({ ...base, rotacionEsteMes: true, usados: 40, pagados: 20 })).toBe("rotado");
  });

  it("pero la rotación no tapa un uso normal: dentro de lo pagado sigue siendo «en uso»", () => {
    expect(avisoDeAsientos({ ...base, rotacionEsteMes: true, usados: 5, pagados: 20 })).toBe("en-uso");
  });

  it("sin asientos pagados declarados no se acusa de exceso a nadie", () => {
    expect(avisoDeAsientos({ ...base, usados: 15, pagados: null })).toBe("en-uso");
  });
});

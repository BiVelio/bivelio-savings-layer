import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LOS TOPES DE LAS INVITACIONES, con sus números (W3, auditoría del lanzamiento).
 *
 * 2026-11-19 · el dueño sube el tope GLOBAL de la ruta de 100 a 1.000 por hora:
 * con 100, el pico del lanzamiento (muchos equipos dándose de alta a la vez)
 * dejaba a usuarios legítimos en un 429 sin haber hecho nada raro. Los topes
 * por organización (en la base) y por usuario (en memoria) NO cambian: son los
 * que frenan a quien abusa. Si alguien cambia cualquiera de estos números sin
 * querer, esta prueba falla.
 */

const UNA_HORA = 60 * 60_000;

/** El módulo se reimporta en cada prueba: el limitador en memoria empieza vacío. */
const cargar = () => import("./limite-invitaciones");

beforeEach(() => {
  vi.resetModules();
});

describe("tope de las invitaciones", () => {
  it("los números: 5 al día gratis, 20 de pago, 10 por hora por usuario y 1.000 por hora en total", async () => {
    const m = await cargar();
    expect(m.TOPE_ORG_GRATIS).toBe(5);
    expect(m.TOPE_ORG_DE_PAGO).toBe(20);
    expect(m.VENTANA_ORG_MS).toBe(24 * UNA_HORA);
    expect(m.TOPE_USUARIO).toBe(10);
    expect(m.VENTANA_USUARIO_MS).toBe(UNA_HORA);
    expect(m.TOPE_GLOBAL).toBe(1_000);
  });

  it("el pico del lanzamiento: 1.000 personas distintas invitan en la misma hora y ninguna se queda fuera", async () => {
    const { limitePorUsuario } = await cargar();
    const cortadas: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      if (!limitePorUsuario.permitir(`usuario-inventado-${i}`).ok) cortadas.push(i);
    }
    // Con el tope de antes (100) se cortaba a partir de la persona 101.
    expect(cortadas).toEqual([]);
  });

  it("el tope global existe: la invitación 1.001 de la hora es un «global», venga de quien venga", async () => {
    const { limitePorUsuario } = await cargar();
    for (let i = 0; i < 1_000; i++) limitePorUsuario.permitir(`usuario-inventado-${i}`);
    expect(limitePorUsuario.permitir("alguien-nuevo-inventado")).toEqual({ ok: false, motivo: "global" });
  });

  it("el tope por usuario no se ha movido: la undécima de la misma persona en una hora se corta", async () => {
    const { limitePorUsuario } = await cargar();
    const res = Array.from({ length: 11 }, () => limitePorUsuario.permitir("misma-persona-inventada").ok);
    expect(res.filter(Boolean)).toHaveLength(10);
    expect(limitePorUsuario.permitir("misma-persona-inventada")).toEqual({ ok: false, motivo: "clave" });
  });
});

import { describe, it, expect } from "vitest";

import { compresionFiel } from "../src/compression/compression.js";

/**
 * LA FIDELIDAD DE LA COMPRESIÓN SE COMPRUEBA, NO SE CREE.
 *
 * `pipeline.ts` decidía con `applies = !result.skipped && result.fidelityPassed`,
 * o sea creyéndose lo que el compresor declaraba de sí mismo. La palanca es
 * INYECTABLE —se la vendemos al cliente como tal—, así que ese `true` puede venir
 * de cualquier parte; y el camino por defecto tampoco lo respaldaba, porque
 * `withProtectedSpans` con la lista vacía devuelve `true` incondicionalmente.
 *
 * El caso que lo motiva, reproducido: «No, nunca cobres dos veces al cliente»
 * comprimido a «cobres dos veces al cliente» —sentido INVERTIDO— y certificado
 * como `fidelityPassed: true`.
 *
 * La verja mira DOS hechos, no el contenido: números y paridad de negación. Los
 * casos de «debe PASAR» son tan importantes como los de «debe CORTAR»: una verja
 * que rechaza compresiones fieles apaga la palanca de hecho, y el cliente paga
 * igual el coste y la latencia del compresor sin llevarse el ahorro.
 */
describe("compresionFiel", () => {
  const debeCortar: [string, string, string][] = [
    ["se come un «no»", "No, nunca cobres dos veces al cliente", "cobres dos veces al cliente"],
    ["se come «nunca» (es)", "nunca es seguro tomar aspirina aqui", "es seguro tomar aspirina aqui"],
    ["se come «jamás» CON tilde", "jamás firmes sin leer el contrato", "firmes sin leer el contrato"],
    ["se come «sense» (ca)", "factura sense IVA per al client", "factura IVA per al client"],
    ["cambia un número", "el reembolso es del 100 por ciento", "el reembolso es del 200 por ciento"],
    ["pierde un importe", "transferir 4500 euros el dia 12", "transferir euros el dia 12"],
    ["cambia una fecha", "vence el 20/07/2026 sin prorroga", "vence el 21/07/2026 sin prorroga"],
  ];
  it.each(debeCortar)("corta: %s", (_n, a, b) => {
    expect(compresionFiel(a, b)).toBe(false);
  });

  const debePasar: [string, string, string][] = [
    ["poda de relleno neutro", "por favor, resume este informe trimestral de ventas", "resume informe trimestral ventas"],
    ["NORMALIZA PUNTUACIÓN sin cambiar sentido", "No, nunca cobres dos veces.", "no nunca cobres dos veces"],
    ["colapsa líneas DUPLICADAS", "importe 100\nimporte 100\nrevisar", "importe 100\nrevisar"],
    ["conserva las dos negaciones", "no firmes nunca el contrato adjunto", "no firmes nunca contrato"],
    ["reordena sin perder nada", "el pago de 300 euros no se aplica", "no se aplica el pago de 300 euros"],
  ];
  it.each(debePasar)("deja pasar: %s", (_n, a, b) => {
    expect(compresionFiel(a, b)).toBe(true);
  });

  it("la puntuación NO decide: es el defecto que apagaría la palanca", () => {
    // «no,» y «nada.» no casan con la lista si se cuenta sobre el texto crudo, y
    // cualquier compresor real normaliza puntuación. Sin normalizar, esto daría
    // false y se tiraría una compresión perfectamente fiel.
    expect(compresionFiel("no cobres, nada mas, gracias", "no cobres nada mas gracias")).toBe(true);
  });

  it("usa la MISMA lista de negaciones que la caché semántica, con tildes", () => {
    // Una segunda copia de la lista diverge —se queda sin tildes o sin es/ca— y
    // entonces una verja deja pasar lo que la otra corta. Con tilde y sin ella.
    expect(compresionFiel("jamás cobres de mas", "cobres de mas")).toBe(false);
    expect(compresionFiel("jamas cobres de mas", "cobres de mas")).toBe(false);
    expect(compresionFiel("ningún cargo adicional", "cargo adicional")).toBe(false);
  });
});

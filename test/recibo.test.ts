import { describe, it, expect } from "vitest";

import { renderizarRecibo, totalizar, type DatosDelRecibo } from "../gateway/recibo.js";

/**
 * EL RECIBO es la pieza COMERCIAL: es lo que ve alguien antes de pagar. Lo que
 * estas pruebas protegen no es el formato, es la honestidad — que los tres
 * carriles no se sumen nunca y que lo no facturable esté dicho en la misma
 * línea en que aparece.
 */
const DATOS: DatosDelRecibo = {
  desde: "2026-09-07 10:00:00",
  hasta: "2026-09-07 18:00:00",
  versionPrecios: "2026-09-06",
  version: "0.4.16",
  porModelo: {
    "claude-fable-5": {
      peticiones: 100, costeUsd: 80, tokensEntrada: 9_000_000, tokensSalida: 40_000,
      ahorroMedidoUsd: 4, tokensElididos: 1_200_000, ahorroSombraUsd: 22, verja: "aplica",
    },
    "claude-opus-4-8": {
      peticiones: 40, costeUsd: 20, tokensEntrada: 2_000_000, tokensSalida: 10_000,
      ahorroMedidoUsd: 0, tokensElididos: 0, ahorroSombraUsd: -3, verja: "no-compensa",
    },
  },
};

describe("recibo · la aritmética", () => {
  it("totaliza los tres carriles POR SEPARADO, sin sumarlos jamás", () => {
    const t = totalizar(DATOS);
    expect(t.peticiones).toBe(140);
    expect(t.costeUsd).toBe(100);
    expect(t.ahorroMedidoUsd).toBe(4);
    expect(t.tokensElididos).toBe(1_200_000);
    expect(t.ahorroSombraUsd).toBe(19); // 22 − 3: el negativo RESTA, no se esconde
  });

  it("el porcentaje va sobre la factura que HABRÍA salido, no sobre la pagada", () => {
    // Denominador = coste pagado + ahorro. Usar solo lo pagado inflaría la cifra.
    const t = totalizar(DATOS);
    expect(t.pctMedido).toBeCloseTo((4 / 104) * 100, 6);
    expect(t.pctMedido).toBeLessThan((4 / 100) * 100); // más honesto que el atajo
  });

  it("un recibo sin tráfico no divide por cero ni inventa porcentajes", () => {
    const t = totalizar({ ...DATOS, porModelo: {} });
    expect(t.pctMedido).toBe(0);
    expect(t.pctSombra).toBe(0);
  });
});

describe("recibo · la honestidad", () => {
  const texto = renderizarRecibo(DATOS);

  it("dice que solo se factura LO MEDIDO", () => {
    expect(texto).toContain("esto es lo único que se factura");
    expect(texto).toMatch(/nunca entran en la factura/i);
  });

  it("marca lo del proveedor como conteo, no como dinero", () => {
    expect(texto).toContain("se enseña, no se cobra");
    expect(texto).toMatch(/El contador es del proveedor, no nuestro/);
  });

  it("marca lo hipotético como simulado y admite que puede ser negativo", () => {
    expect(texto).toContain("simulado, nunca cobrado");
    expect(texto).toMatch(/Nadie ejecutó esto/);
    expect(texto).toMatch(/puede salir NEGATIVO/i);
  });

  it("enseña la verja por modelo — dónde NO se aplica y por qué", () => {
    expect(texto).toContain("aplica");
    expect(texto).toContain("no-compensa");
    expect(texto).toMatch(/tu tráfico viaja intacto/);
  });

  it("lleva la garantía, el suelo de cero y la promesa de privacidad", () => {
    expect(texto).toMatch(/90 % de cada euro/);
    expect(texto).toMatch(/Un mes sin ahorro es un mes sin comisión: 0 €/);
    // La promesa exacta de la LICENSE-CLOUD.md §5: nunca llegan A BIVELIO (sí al
    // proveedor), y lo que sube no son «solo conteos y coste».
    expect(texto).toMatch(/prompts, respuestas y claves del proveedor nunca llegan/);
    expect(texto).toMatch(/LICENSE-CLOUD\.md §5/);
    expect(texto).not.toMatch(/no salen de tu máquina|solo suben/);
  });

  it("es auditable: cita versión de precios, de gateway y a quién reclamar", () => {
    expect(texto).toContain("2026-09-06");
    expect(texto).toContain("0.4.16");
    expect(texto).toContain("support@bivelio.com");
    expect(texto).toMatch(/Verifícalo contra tu consola/);
  });

  it("un modelo con ahorro hipotético NEGATIVO se enseña, no se esconde", () => {
    // opus-4-8 va a −3 USD: tiene que aparecer con signo menos en su fila.
    expect(texto).toMatch(/claude-opus-4-8.*−/);
  });
});

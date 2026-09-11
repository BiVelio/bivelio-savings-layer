import { describe, it, expect } from "vitest";

import {
  VERSION_DE_LA_VERJA,
  valorNumerico,
  verjaDeExtraccion,
} from "../corpus/verja-de-extraccion.js";
import type { Respuesta, UnidadDeEvidencia } from "../corpus/tipos.js";

/**
 * LAS PRUEBAS DE LA VERJA DE EXTRACCIÓN.
 *
 * La verja decide si una respuesta de extracción se acepta o si la tarea se
 * repite con el proveedor aprobado. Su único fallo caro es el FALSO ACEPTADO:
 * dar por buena una respuesta plausible e inventada. Rechazar de más cuesta
 * dinero medible (repetir la tarea); aceptar de menos entrega un dato falso que
 * nadie vuelve a mirar.
 *
 * Por eso estas pruebas están escritas al revés de lo habitual: la mayoría no
 * comprueban que la verja diga «sí» cuando debe, sino que diga «NO» cuando
 * alguien le pone delante algo que se le parece mucho a una respuesta buena —
 * el importe de al lado, la fecha con los dígitos cambiados de sitio, la cita a
 * una unidad que no se entregó.
 */

/** Evidencia de trabajo: una factura escrita como la escribiría el documento. */
const EVIDENCIA: UnidadDeEvidencia[] = [
  {
    id: "u1",
    papel: "necesaria",
    texto: "Factura F-2024-118. Base imponible 12.480,55 €. Fecha de emisión 12/03/2025.",
    fuente: "factura F-2024-118",
  },
  {
    id: "u2",
    papel: "necesaria",
    texto: "Tipo de IVA aplicado: 21,00 %. Vencimiento el 30 de abril de 2025.",
    fuente: "factura F-2024-118",
  },
  {
    id: "u3",
    papel: "distractora",
    texto: "Factura F-2024-1118, de otro cliente, por 12.408,55 €.",
    fuente: "factura F-2024-1118",
  },
];

/** Una respuesta con un único campo importe, para no repetir andamiaje. */
function respuestaImporte(cantidad: string, citas: string[]): Respuesta {
  return {
    tipo: "valor",
    campos: [
      {
        nombre: "base_imponible",
        valor: { clase: "importe", cantidad, moneda: "EUR", base: "sin-iva" },
        critico: true,
        citas,
      },
    ],
  };
}

describe("valorNumerico — cómo escribe los números un documento español", () => {
  it("lee el punto de millares y la coma decimal", () => {
    expect(valorNumerico("12.480,55")).toBeCloseTo(12480.55, 5);
    expect(valorNumerico("1.234.567,89")).toBeCloseTo(1234567.89, 5);
  });

  it("lee también la escritura del JSON, con punto decimal", () => {
    expect(valorNumerico("12480.55")).toBeCloseTo(12480.55, 5);
  });

  it("resuelve el punto solo por el tamaño del último grupo", () => {
    // Tres cifras detrás: millares. Cualquier otra cosa: decimal.
    expect(valorNumerico("12.480")).toBeCloseTo(12480, 5);
    expect(valorNumerico("12.48")).toBeCloseTo(12.48, 5);
  });

  it("acepta la coma sola como decimal, que es lo que hace es/ca", () => {
    expect(valorNumerico("21,00")).toBeCloseTo(21, 5);
  });

  it("devuelve null ante lo que no es un número", () => {
    expect(valorNumerico("cláusula")).toBeNull();
    expect(valorNumerico("")).toBeNull();
    expect(valorNumerico("..")).toBeNull();
  });
});

describe("la verja acepta lo que está sostenido por la evidencia", () => {
  it("acepta un importe que aparece en su unidad citada, escrito a la española", () => {
    const v = verjaDeExtraccion(respuestaImporte("12480.55", ["u1"]), EVIDENCIA);
    expect(v.aceptada).toBe(true);
    expect(v.reparos).toEqual([]);
    expect(v.cobertura).toEqual({ rastreados: 1, rastreables: 1 });
    expect(v.version).toBe(VERSION_DE_LA_VERJA);
  });

  it("acepta una fecha ISO escrita en el documento como dd/mm/aaaa", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "fecha_emision", valor: { clase: "fecha", iso: "2025-03-12" }, critico: true, citas: ["u1"] },
      ],
    };
    expect(verjaDeExtraccion(r, EVIDENCIA).aceptada).toBe(true);
  });

  it("acepta una fecha escrita en letra («30 de abril de 2025»)", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "fecha_vencimiento", valor: { clase: "fecha", iso: "2025-04-30" }, critico: true, citas: ["u2"] },
      ],
    };
    expect(verjaDeExtraccion(r, EVIDENCIA).aceptada).toBe(true);
  });

  it("acepta un porcentaje y un identificador rastreables", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "tipo_iva", valor: { clase: "porcentaje", valor: "21.00" }, critico: true, citas: ["u2"] },
        { nombre: "numero", valor: { clase: "identificador", valor: "F-2024-118" }, critico: true, citas: ["u1"] },
      ],
    };
    expect(verjaDeExtraccion(r, EVIDENCIA).aceptada).toBe(true);
  });

  it("declara el alcance omitido sin que eso sea un fallo", () => {
    const v = verjaDeExtraccion(respuestaImporte("12480.55", ["u1"]), EVIDENCIA);
    expect(v.aceptada).toBe(true);
    expect(v.alcance_omitido).toEqual(["u2", "u3"]);
  });
});

describe("★ la verja caza el falso aceptado", () => {
  it("rechaza un importe que no está en su unidad citada", () => {
    const v = verjaDeExtraccion(respuestaImporte("99999.00", ["u1"]), EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((r) => r.motivo)).toContain("valor-no-rastreable");
  });

  it("rechaza el importe DE AL LADO — la trampa que más dinero mueve", () => {
    // 12.408,55 existe en el corpus, pero en u3, que no es la unidad citada.
    const v = verjaDeExtraccion(respuestaImporte("12408.55", ["u1"]), EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos[0]?.motivo).toBe("valor-no-rastreable");
    expect(v.reparos[0]?.campo).toBe("base_imponible");
  });

  it("NO deja que un ISO del texto pase por una fecha con los dígitos cambiados", () => {
    // Regresión: «12/03/2025» en u1 no puede hacer rastreable un 2012-03-25,
    // ni el ISO «2025-03-12» puede leerse además como «25-03-12».
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "fecha_emision", valor: { clase: "fecha", iso: "2012-03-25" }, critico: true, citas: ["u1"] },
      ],
    };
    const v = verjaDeExtraccion(r, EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((m) => m.motivo)).toContain("valor-no-rastreable");
  });

  it("rechaza la fecha invertida (mm/dd por dd/mm)", () => {
    // u1 dice 12/03/2025. Un lector americano leería 3 de diciembre.
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "fecha_emision", valor: { clase: "fecha", iso: "2025-12-03" }, critico: true, citas: ["u1"] },
      ],
    };
    expect(verjaDeExtraccion(r, EVIDENCIA).aceptada).toBe(false);
  });

  it("rechaza una cita a una unidad que no se entregó", () => {
    const v = verjaDeExtraccion(respuestaImporte("12480.55", ["u9"]), EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((r) => r.motivo)).toContain("cita-inexistente");
  });

  it("rechaza un campo sin ninguna cita", () => {
    const v = verjaDeExtraccion(respuestaImporte("12480.55", []), EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((r) => r.motivo)).toContain("campo-sin-cita");
  });
});

describe("la verja exige forma, porque quien inventa suele inventar bien formado", () => {
  it("rechaza un importe sin dos decimales", () => {
    const v = verjaDeExtraccion(respuestaImporte("12480.5", ["u1"]), EVIDENCIA);
    expect(v.reparos.map((r) => r.motivo)).toContain("forma-invalida");
    expect(v.aceptada).toBe(false);
  });

  it("rechaza una fecha que no es ISO", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "f", valor: { clase: "fecha", iso: "12/03/2025" }, critico: true, citas: ["u1"] },
      ],
    };
    expect(verjaDeExtraccion(r, EVIDENCIA).aceptada).toBe(false);
  });

  it("rechaza una opción fuera de su conjunto cerrado", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        {
          nombre: "estado",
          valor: { clase: "opcion", valor: "pagada_a_medias", opciones: ["pagada", "pendiente"] },
          critico: true,
          citas: ["u1"],
        },
      ],
    };
    const v = verjaDeExtraccion(r, EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((m) => m.motivo)).toContain("forma-invalida");
  });

  it("rechaza una respuesta de valor sin campos", () => {
    const v = verjaDeExtraccion({ tipo: "valor", campos: [] }, EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos[0]?.motivo).toBe("respuesta-vacia");
  });
});

describe("contradicción y abstención", () => {
  const CHOQUE: UnidadDeEvidencia[] = [
    { id: "c1", papel: "contradictoria", texto: "El importe pactado es 1.000,00 €.", fuente: "anexo I" },
    { id: "c2", papel: "contradictoria", texto: "El importe pactado es 2.000,00 €.", fuente: "anexo II" },
  ];

  it("rechaza contestar con un valor cuando la evidencia se contradice", () => {
    const r = respuestaImporte("1000.00", ["c1"]);
    const v = verjaDeExtraccion(r, CHOQUE);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((m) => m.motivo)).toContain("contradiccion-no-resuelta");
  });

  it("acepta abstenerse cuando se enseña el choque", () => {
    const r: Respuesta = {
      tipo: "abstencion",
      motivo: "contradiccion-sin-regla-de-desempate",
      que_falta: "una regla que decida entre el anexo I y el anexo II",
      citas: ["c1", "c2"],
    };
    const v = verjaDeExtraccion(r, CHOQUE);
    expect(v.aceptada).toBe(true);
    expect(v.alcance_omitido).toEqual([]);
  });

  it("rechaza abstenerse sin citar nada — eso es callarse, no abstenerse", () => {
    const r: Respuesta = {
      tipo: "abstencion",
      motivo: "evidencia-insuficiente",
      que_falta: "el importe",
      citas: [],
    };
    const v = verjaDeExtraccion(r, CHOQUE);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((m) => m.motivo)).toContain("abstencion-sin-prueba");
  });

  it("rechaza abstenerse sin decir qué falta", () => {
    const r: Respuesta = {
      tipo: "abstencion",
      motivo: "evidencia-insuficiente",
      que_falta: "   ",
      citas: ["c1"],
    };
    expect(verjaDeExtraccion(r, CHOQUE).aceptada).toBe(false);
  });

  it("rechaza una abstención que cita una unidad inexistente", () => {
    const r: Respuesta = {
      tipo: "abstencion",
      motivo: "evidencia-insuficiente",
      que_falta: "el importe",
      citas: ["z9"],
    };
    const v = verjaDeExtraccion(r, CHOQUE);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((m) => m.motivo)).toContain("cita-inexistente");
  });
});

describe("la verja falla CERRADA", () => {
  it("rechaza sin evidencia alguna", () => {
    expect(verjaDeExtraccion(respuestaImporte("12480.55", ["u1"]), []).aceptada).toBe(false);
  });

  it("rechaza, sin lanzar, ante una respuesta deformada", () => {
    // Lo que llegaría de un modelo local que devuelve algo que no es del tipo.
    const basura = { tipo: "valor", campos: [{ nombre: "x" }] } as unknown as Respuesta;
    const v = verjaDeExtraccion(basura, EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.length).toBeGreaterThan(0);
  });

  it("una referencia a una unidad inexistente no pasa", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "clausula", valor: { clase: "referencia", unidad: "u42" }, critico: true, citas: ["u1"] },
      ],
    };
    const v = verjaDeExtraccion(r, EVIDENCIA);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((m) => m.motivo)).toContain("cita-inexistente");
  });

  it("un booleano no se declara rastreado, porque no se puede rastrear", () => {
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        { nombre: "esta_pagada", valor: { clase: "booleano", valor: true }, critico: true, citas: ["u1"] },
      ],
    };
    const v = verjaDeExtraccion(r, EVIDENCIA);
    expect(v.cobertura).toEqual({ rastreados: 0, rastreables: 0 });
    expect(v.aceptada).toBe(true);
  });
});

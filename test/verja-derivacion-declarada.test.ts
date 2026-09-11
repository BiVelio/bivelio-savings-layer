import { describe, it, expect } from "vitest";

import {
  VERSION_DE_LA_VERJA,
  literalEstaCopiado,
  verjaDeExtraccion,
} from "../corpus/verja-de-extraccion.js";
import type { CampoRespuesta, DerivacionDeclarada, Respuesta, UnidadDeEvidencia } from "../corpus/tipos.js";

/**
 * LA CUENTA DECLARADA — las pruebas del camino que sustituye a adivinar.
 *
 * La verja 1.0.0 tenía que decidir si «968,00» está sostenido por una evidencia
 * que solo escribe «800,00» y «168,00», y para eso BUSCABA la cuenta. Medido: con
 * dos términos se recuperan derivaciones legítimas pero se cuela un importe
 * inventado; con tres, el falso rechazo baja 6,6 puntos y los escapes del modo
 * estrella se triplican. Buscar no escala.
 *
 * Declarar sí: quien responde ya hizo la cuenta, y la verja pasa de recorrer n^k
 * fórmulas a comprobar UNA. Estas pruebas están escritas con el mismo sesgo que
 * las de la verja entera —la mayoría comprueban que diga NO— porque el único
 * fallo que no se recupera es el falso aceptado, y una cuenta declarada es
 * precisamente una forma nueva de intentar justificar un número falso.
 */

/** Una factura con base, cuota y total, escrita como la escribiría el documento. */
const EVIDENCIA: UnidadDeEvidencia[] = [
  {
    id: "u1",
    papel: "necesaria",
    texto: "Factura F-2025-700, emitida el 30/06/2024. Base imponible: 800,00 €.",
    fuente: "factura F-2025-700",
  },
  {
    id: "u2",
    papel: "necesaria",
    texto: "IVA repercutido al 21 % sobre la base imponible: 168,00 €.",
    fuente: "factura F-2025-700",
  },
  {
    id: "u3",
    papel: "necesaria",
    texto: "El pago se efectuará a 60 días naturales desde la fecha de factura.",
    fuente: "condiciones generales",
  },
  {
    id: "u4",
    papel: "distractora",
    texto: "Otra factura, de otro cliente, por 968,00 € con vencimiento el 01/07/2025.",
    fuente: "factura ajena",
  },
];

function campo(
  nombre: string,
  valor: CampoRespuesta["valor"],
  citas: string[],
  derivacion?: DerivacionDeclarada,
): CampoRespuesta {
  return { nombre, valor, critico: true, citas, ...(derivacion ? { derivacion } : {}) };
}

const importe = (cantidad: string) =>
  ({ clase: "importe", cantidad, moneda: "EUR", base: "con-iva" }) as const;

const respuesta = (...campos: CampoRespuesta[]): Respuesta => ({ tipo: "valor", campos });

/** Sin búsqueda ciega: la única forma de sostener un valor calculado es declararlo. */
const SIN_CIEGA = { derivacionCiega: false } as const;
const veredicto = (r: Respuesta) => verjaDeExtraccion(r, EVIDENCIA, undefined, SIN_CIEGA);
const motivos = (r: Respuesta) => veredicto(r).reparos.map((x) => x.motivo);

describe("la cuenta declarada se comprueba, y basta una", () => {
  it("la verja dice en qué versión está, porque un perfil que se factura tiene que poder decirlo", () => {
    expect(VERSION_DE_LA_VERJA).toBe("1.1.0");
  });

  it("una suma declarada que cuadra se ACEPTA aunque el total no esté escrito en ninguna unidad", () => {
    const r = respuesta(
      campo("total_factura", importe("968.00"), ["u1", "u2"], {
        operacion: "suma",
        operandos: [
          { unidad: "u1", literal: "800,00" },
          { unidad: "u2", literal: "168,00" },
        ],
      }),
    );
    expect(veredicto(r).aceptada).toBe(true);
    expect(veredicto(r).cobertura).toEqual({ rastreados: 1, rastreables: 1 });
  });

  it("una cuenta que NO da el valor afirmado se rechaza, y el motivo dice qué da", () => {
    const r = respuesta(
      campo("total_factura", importe("986.00"), ["u1", "u2"], {
        operacion: "suma",
        operandos: [
          { unidad: "u1", literal: "800,00" },
          { unidad: "u2", literal: "168,00" },
        ],
      }),
    );
    const v = veredicto(r);
    expect(v.aceptada).toBe(false);
    expect(v.reparos[0]?.motivo).toBe("derivacion-no-cuadra");
    expect(v.reparos[0]?.detalle).toContain("968");
  });

  it("un operando de una unidad que el campo NO cita se rechaza: la cita no se salta por la cuenta", () => {
    const r = respuesta(
      campo("total_factura", importe("968.00"), ["u1"], {
        operacion: "suma",
        operandos: [
          { unidad: "u1", literal: "800,00" },
          { unidad: "u2", literal: "168,00" },
        ],
      }),
    );
    expect(motivos(r)).toContain("operando-no-copiado");
  });

  it("un operando que no está escrito en su unidad se rechaza: se COPIA, no se recuerda", () => {
    const r = respuesta(
      campo("total_factura", importe("968.00"), ["u1", "u2"], {
        operacion: "suma",
        operandos: [
          { unidad: "u1", literal: "900,00" },
          { unidad: "u2", literal: "68,00" },
        ],
      }),
    );
    expect(motivos(r)).toContain("operando-no-copiado");
  });

  it("la aridad equivocada no se interpreta: se rechaza", () => {
    const r = respuesta(
      campo("total_factura", importe("800.00"), ["u1"], {
        operacion: "suma",
        operandos: [{ unidad: "u1", literal: "800,00" }],
      }),
    );
    expect(motivos(r)).toContain("derivacion-no-cuadra");
  });

  it("una fecha a plazo se sostiene con `fecha-mas-dias`", () => {
    const r = respuesta(
      campo("fecha_vencimiento", { clase: "fecha", iso: "2024-08-29" }, ["u1", "u3"], {
        operacion: "fecha-mas-dias",
        operandos: [
          { unidad: "u1", literal: "30/06/2024" },
          { unidad: "u3", literal: "60" },
        ],
      }),
    );
    expect(veredicto(r).aceptada).toBe(true);
  });

  it("y si el plazo declarado no lleva a esa fecha, se rechaza", () => {
    const r = respuesta(
      campo("fecha_vencimiento", { clase: "fecha", iso: "2024-08-30" }, ["u1", "u3"], {
        operacion: "fecha-mas-dias",
        operandos: [
          { unidad: "u1", literal: "30/06/2024" },
          { unidad: "u3", literal: "60" },
        ],
      }),
    );
    const v = veredicto(r);
    expect(v.aceptada).toBe(false);
    expect(v.reparos[0]?.detalle).toContain("2024-08-29");
  });

  it("un porcentaje sobre una base se sostiene con `porcentaje`", () => {
    const r = respuesta(
      campo("cuota_iva", { clase: "importe", cantidad: "168.00", moneda: "EUR", base: "solo-cuota" }, ["u1", "u2"], {
        operacion: "porcentaje",
        operandos: [
          { unidad: "u1", literal: "800,00" },
          { unidad: "u2", literal: "21" },
        ],
      }),
    );
    expect(veredicto(r).aceptada).toBe(true);
  });

  it("una operación que devuelve fecha no puede sostener un importe, ni al revés", () => {
    const r = respuesta(
      campo("total_factura", importe("968.00"), ["u1", "u3"], {
        operacion: "fecha-mas-dias",
        operandos: [
          { unidad: "u1", literal: "30/06/2024" },
          { unidad: "u3", literal: "60" },
        ],
      }),
    );
    expect(motivos(r)).toContain("derivacion-no-cuadra");
  });
});

describe("★ el agujero que encontró el banco: recortar un operando de dentro de otro número", () => {
  it("no se puede sacar un «01» del día de una fecha para construir una cifra", () => {
    // Medido: con esto permitido, `suma(01, 07, 2,90) = 10,90` colaba sobre una
    // unidad que solo dice «vigente l'01/07/2025 és del 2,90 %». Una fecha regala
    // cuatro operandos pequeños, y con operandos pequeños se arma casi cualquier
    // número.
    expect(literalEstaCopiado("vigente el 01/07/2025, del 2,90 %", "01")).toBe(false);
    expect(literalEstaCopiado("vigente el 01/07/2025, del 2,90 %", "07")).toBe(false);
    expect(literalEstaCopiado("vigente el 01/07/2025, del 2,90 %", "2025")).toBe(false);
  });

  it("ni media cifra de un importe: «2.000» no se copia de «2.000,00»", () => {
    expect(literalEstaCopiado("Base imponible: 2.000,00 €", "2.000")).toBe(false);
    expect(literalEstaCopiado("Base imponible: 2.000,00 €", "2.000,00")).toBe(true);
  });

  it("ni la mitad sin signo: de «-450,00» se copia «-450,00», no «450,00»", () => {
    expect(literalEstaCopiado("Retención: -450,00 €", "450,00")).toBe(false);
    expect(literalEstaCopiado("Retención: -450,00 €", "-450,00")).toBe(true);
  });

  it("pero una fecha seguida de coma SÍ está copiada — el centinela es asimétrico a propósito", () => {
    // Excluir la coma por la derecha rechazaba media docena de cuentas correctas:
    // «emitida el 30/06/2024, por 4.235,00 €» es la forma normal de escribirlo.
    expect(literalEstaCopiado("emitida el 30/06/2024, por 4.235,00 €", "30/06/2024")).toBe(true);
    expect(literalEstaCopiado("a 60 días naturales desde la fecha.", "60")).toBe(true);
    expect(literalEstaCopiado("al 21 % sobre la base", "21")).toBe(true);
  });

  it("y la verja lo aplica, no solo el ayudante", () => {
    const r = respuesta(
      campo("tipo_demora", { clase: "porcentaje", valor: "8.00" }, ["u4"], {
        operacion: "suma",
        operandos: [
          { unidad: "u4", literal: "01" },
          { unidad: "u4", literal: "07" },
        ],
      }),
    );
    expect(motivos(r)).toContain("operando-no-copiado");
  });
});

describe("★ encadenar campos sin lavar la cita", () => {
  const diasYRecargo = (citasDelSegundo: string[]): Respuesta =>
    respuesta(
      campo("base_imponible", { clase: "importe", cantidad: "800.00", moneda: "EUR", base: "sin-iva" }, ["u1"]),
      campo("total_factura", importe("968.00"), citasDelSegundo, {
        operacion: "suma",
        operandos: [{ campo: "base_imponible" }, { unidad: "u2", literal: "168,00" }],
      }),
    );

  it("un campo puede apoyarse en otro campo ya sostenido", () => {
    expect(veredicto(diasYRecargo(["u1", "u2"])).aceptada).toBe(true);
  });

  it("pero tiene que citar TAMBIÉN la evidencia de ese campo", () => {
    // El banco lo cazó: sin esta exigencia, el modo `cita-movida-a-distractora`
    // pasaba de 7 escapes a 12, porque un campo se sostenía apoyándose en un
    // hermano mientras su propia cita no sostenía nada.
    const v = veredicto(diasYRecargo(["u2"]));
    expect(v.aceptada).toBe(false);
    expect(v.reparos.map((x) => x.detalle).join(" ")).toContain("u1");
  });

  it("un operando que apunta a un campo que no existe se rechaza", () => {
    const r = respuesta(
      campo("total_factura", importe("968.00"), ["u1", "u2"], {
        operacion: "suma",
        operandos: [{ campo: "no_existe" }, { unidad: "u2", literal: "168,00" }],
      }),
    );
    expect(motivos(r)).toContain("derivacion-no-cuadra");
  });

  it("una dependencia circular no se resuelve, y por eso se RECHAZA", () => {
    const r = respuesta(
      campo("a", importe("968.00"), ["u1", "u2"], { operacion: "suma", operandos: [{ campo: "b" }, { unidad: "u2", literal: "168,00" }] }),
      campo("b", importe("800.00"), ["u1", "u2"], { operacion: "suma", operandos: [{ campo: "a" }, { unidad: "u2", literal: "168,00" }] }),
    );
    const v = veredicto(r);
    expect(v.aceptada).toBe(false);
    expect(v.reparos.every((x) => x.motivo === "derivacion-no-cuadra")).toBe(true);
  });
});

describe("las dos posturas de la búsqueda ciega", () => {
  const sinDeclarar = respuesta(campo("total_factura", importe("968.00"), ["u1", "u2"]));

  it("con la búsqueda ciega ENCENDIDA (el defecto de la 1.0.0) el total calculado pasa", () => {
    expect(verjaDeExtraccion(sinDeclarar, EVIDENCIA).aceptada).toBe(true);
  });

  it("con la búsqueda ciega APAGADA hay que declarar, y el motivo lo dice así", () => {
    const v = veredicto(sinDeclarar);
    expect(v.aceptada).toBe(false);
    expect(v.reparos[0]?.motivo).toBe("derivacion-no-declarada");
  });

  it("una cuenta declarada que miente se rechaza AUNQUE el valor esté escrito: no es decoración", () => {
    const r = respuesta(
      campo("base_imponible", { clase: "importe", cantidad: "800.00", moneda: "EUR", base: "sin-iva" }, ["u1", "u2"], {
        operacion: "suma",
        operandos: [
          { unidad: "u1", literal: "800,00" },
          { unidad: "u2", literal: "168,00" },
        ],
      }),
    );
    expect(verjaDeExtraccion(r, EVIDENCIA).aceptada).toBe(false);
    expect(motivos(r)).toContain("derivacion-no-cuadra");
  });
});

describe("el techo de operandos es el de lo medido", () => {
  it("una suma declarada de cuatro términos se rechaza, aunque todos estén bien copiados", () => {
    // El banco solo ha medido el precio de hasta TRES términos, que es lo que el
    // declarador explora. Más términos es más libertad para CONSTRUIR una cuenta
    // que justifique un número falso, y esa libertad sin medir no se regala.
    const r: Respuesta = {
      tipo: "valor",
      campos: [
        campo("total_factura", importe("1049.00"), ["u1", "u2", "u3"], {
          operacion: "suma",
          operandos: [
            { unidad: "u1", literal: "800,00" },
            { unidad: "u2", literal: "168,00" },
            { unidad: "u2", literal: "21" },
            { unidad: "u3", literal: "60" },
          ],
        }),
      ],
    };
    const v = verjaDeExtraccion(r, EVIDENCIA, undefined, { derivacionCiega: false });
    expect(v.aceptada).toBe(false);
    expect(v.reparos[0]?.detalle).toContain("operandos");
  });
});

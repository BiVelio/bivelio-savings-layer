import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CasoDelCorpus, FicheroDeCasos } from "../corpus/tipos.js";
import { citasObligatorias, camposCriticos } from "../corpus/tipos.js";
import { validarFichero, resumen } from "../corpus/validar.js";
import { evaluarSeleccion, evaluarCorpus } from "../corpus/evaluar.js";
import { normalizeText } from "../src/canonicalization/canonicalize.js";

/**
 * LA VERJA DEL CORPUS DE FACTURACIÓN Y COBROS (fase F6).
 *
 * Un golden set no se revisa a ojo: 60 casos con evidencia, citas y presupuesto
 * son unos cuantos miles de referencias cruzadas, y basta una cita rota para que
 * el juez apruebe a quien no debería. Esto corre el validador entero y, además,
 * comprueba el REPARTO: un corpus donde todo es fácil, todo es español o nadie
 * se abstiene no mide lo que dice medir.
 */

const cargar = (nombre: string): FicheroDeCasos =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../corpus/facturacion-y-cobros/${nombre}`, import.meta.url)), "utf8"),
  ) as FicheroDeCasos;

const es = cargar("casos-es.json");
const ca = cargar("casos-ca.json");
const casos: CasoDelCorpus[] = [...es.casos, ...ca.casos];
const r = resumen(casos);

describe("corpus de facturación y cobros · integridad", () => {
  it("el fichero en español pasa el validador entero", () => {
    expect(validarFichero(es)).toEqual([]);
  });

  it("el fichero en catalán pasa el validador entero", () => {
    expect(validarFichero(ca)).toEqual([]);
  });

  it("no hay ids repetidos entre los dos ficheros", () => {
    const ids = casos.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("los dos ficheros declaran la limitación del golden set sintético", () => {
    for (const f of [es, ca]) {
      expect(f.sintetico).toBe(true);
      expect(f.advertencia).toMatch(/sintétic/i);
      expect(f.advertencia).toMatch(/no demuestra/i);
    }
  });
});

describe("corpus de facturación y cobros · reparto", () => {
  it("son 60 casos", () => {
    expect(r.total).toBe(60);
  });

  it("el reparto es/ca es real, no decorativo: ninguno baja del 40 %", () => {
    // La aceptación de F6 exige «sin degradación por idioma». Con cinco casos en
    // catalán no se puede afirmar ni negar nada de un idioma.
    expect(r.porIdioma["es"]).toBeGreaterThanOrEqual(24);
    expect(r.porIdioma["ca"]).toBeGreaterThanOrEqual(24);
  });

  it("al menos 8 casos donde la respuesta correcta es abstenerse", () => {
    expect(r.abstenciones).toBeGreaterThanOrEqual(8);
    // Y en los dos idiomas: abstenerse en español y contestar en catalán sería
    // exactamente la degradación por idioma que hay que poder detectar.
    for (const idioma of ["es", "ca"] as const) {
      const n = casos.filter((c) => c.idioma === idioma && c.respuesta.tipo === "abstencion").length;
      expect(n).toBeGreaterThanOrEqual(4);
    }
  });

  it("la mayoría de los casos son difíciles: un corpus fácil no demuestra nada", () => {
    expect(r.porDificultad["dificil"]).toBeGreaterThanOrEqual(casos.length / 2);
  });

  it("las trampas caras del dominio están cubiertas con casos de sobra", () => {
    // Importes parecidos, con IVA / sin IVA, fechas y identificadores: las
    // cuatro que el encargo declara caras en facturación.
    expect(r.porTrampa["importes-parecidos"]).toBeGreaterThanOrEqual(10);
    expect(r.porTrampa["con-iva-sin-iva"]).toBeGreaterThanOrEqual(10);
    expect(r.porTrampa["fechas-parecidas"]).toBeGreaterThanOrEqual(10);
    expect(r.porTrampa["identificadores-parecidos"]).toBeGreaterThanOrEqual(8);
  });

  it("cada clase de trampa declarada tiene al menos tres casos", () => {
    // Con uno solo, un fallo es anécdota y un acierto es suerte.
    const flojas = Object.entries(r.porTrampa).filter(([, n]) => n < 3);
    expect(flojas).toEqual([]);
  });

  it("las trampas de idioma se ejercitan en catalán, que es donde rompen", () => {
    const enCatalan = (t: string) =>
      casos.filter((c) => c.idioma === "ca" && c.trampas.includes(t as never)).length;
    expect(enCatalan("diacritico")).toBeGreaterThanOrEqual(2);
    expect(enCatalan("ela-geminada")).toBeGreaterThanOrEqual(2);
    expect(enCatalan("apostrof")).toBeGreaterThanOrEqual(3);
    expect(enCatalan("numero-gramatical")).toBeGreaterThanOrEqual(1);
  });

  it("hay contradicciones con regla de desempate y contradicciones sin ella", () => {
    const conRegla = casos.filter((c) => c.desempate && c.desempate.regla !== "ninguna").length;
    const sinRegla = casos.filter((c) => c.desempate?.regla === "ninguna").length;
    expect(conRegla).toBeGreaterThanOrEqual(10);
    expect(sinRegla).toBeGreaterThanOrEqual(2);
  });

  it("todos los casos ejercen presión real sobre el presupuesto", () => {
    // `validarCaso` ya lo exige uno a uno; esto vigila el agregado, que es lo
    // que se puede degradar sin que ningún caso falle: 60 casos con una sola
    // unidad de sobra cada uno no son un knapsack, son un `filter`.
    expect(r.unidadesDescartables).toBeGreaterThanOrEqual(120);
  });
});

describe("corpus de facturación y cobros · el corpus es ejecutable", () => {
  it("quedarse con todas las unidades conserva los críticos y se pasa del presupuesto", () => {
    // El brazo naive: mandarlo todo. Nunca se equivoca y nunca ahorra. Es la
    // referencia contra la que el knapsack tiene que ganar tokens SIN perder
    // campos críticos.
    for (const c of casos) {
      const todo = evaluarSeleccion(c, c.evidencia.map((u) => u.id));
      expect(todo.conservaCriticos).toBe(true);
      expect(todo.invertidaPorContradiccion).toBe(false);
      expect(todo.dentroDePresupuesto).toBe(false);
    }
  });

  it("un selector perfecto —el que se queda con las citas obligatorias— aprueba los 60", () => {
    const informe = evaluarCorpus(casos, (c) => citasObligatorias(c));
    expect(informe.aprobados).toBe(60);
    expect(informe.invertidos).toBe(0);
    expect(informe.distractorasRetenidas).toBe(0);
    expect(informe.fallos).toEqual([]);
  });

  it("un selector que se queda con las primeras unidades falla, y el informe dice dónde", () => {
    // Sirve para comprobar que el puntuador DETECTA el fallo, no para juzgar a
    // nadie: es el orden del recuperador sin criterio ninguno.
    const informe = evaluarCorpus(casos, (c) =>
      c.evidencia.slice(0, c.presupuesto.unidades_max).map((u) => u.id),
    );
    expect(informe.aprobados).toBeLessThan(60);
    expect(informe.fallos.length).toBeGreaterThan(0);
    expect(Object.keys(informe.porIdioma).sort()).toEqual(["ca", "es"]);
  });

  it("tirar la unidad que manda y quedarse con la derogada se marca como inversión", () => {
    // El fallo caro tiene nombre propio en el informe porque es el único que el
    // cliente no ve: la respuesta sale bien formada y dice lo contrario.
    const conDesempate = casos.filter((c) => c.desempate && c.desempate.regla !== "ninguna");
    expect(conDesempate.length).toBeGreaterThan(0);
    for (const c of conDesempate) {
      const d = c.desempate!;
      const seleccion = c.evidencia
        .map((u) => u.id)
        .filter((id) => id !== d.ganadora)
        .slice(0, c.presupuesto.unidades_max);
      const res = evaluarSeleccion(c, [...new Set([...seleccion, ...d.desplazadas])]);
      expect(res.invertidaPorContradiccion).toBe(true);
      expect(res.aprobado).toBe(false);
    }
  });
});

describe("corpus de facturación y cobros · contra las normalizaciones que ya existen", () => {
  it("hay pares que `normalizeText` colapsa y que el caso distingue", () => {
    // El antecedente del 2026-08-14: plegar diacríticos dejó muda una
    // herramienta cuyo `intent` iba acentuado. Estos pares son el mismo
    // mecanismo escrito como dinero.
    const pares: ReadonlyArray<readonly [string, string]> = [
      ["el cliente abonó 968,00 €", "el cliente abono 968,00 €"],
      ["una pròrroga de 15 dies", "una prorroga de 15 dies"],
      ["per cada mes de retard", "per cada més de retard"],
      ["MOD-CEL·LA-12", "MOD-CELLA-12"],
    ];
    for (const [a, b] of pares) {
      expect(normalizeText(a)).toBe(normalizeText(b));
    }
  });

  it("los casos que dependen de eso están etiquetados, y son de los difíciles", () => {
    const linguisticos = casos.filter((c) =>
      c.trampas.some((t) => t === "diacritico" || t === "ela-geminada" || t === "numero-gramatical"),
    );
    expect(linguisticos.length).toBeGreaterThanOrEqual(6);
    for (const c of linguisticos) {
      expect(c.dificultad).not.toBe("facil");
      expect(c.nota ?? "").not.toBe("");
    }
  });

  it("ninguna respuesta se puede acertar copiando una cifra del texto tal cual", () => {
    // Los importes de la respuesta van en decimal con punto («2484.50») y los
    // documentos los escriben como los escribe un documento («2.484,50 €»). Si
    // alguna vez coinciden, el comprobador podría aprobar por coincidencia de
    // cadenas en vez de por comprensión.
    for (const c of casos) {
      if (c.respuesta.tipo !== "valor") continue;
      const textos = c.evidencia.map((u) => u.texto).join(" ");
      for (const campo of camposCriticos(c)) {
        if (campo.valor.clase !== "importe") continue;
        if (Number(campo.valor.cantidad) < 1) continue; // «0.09» aparece como «0,09» y no colisiona
        expect(textos).not.toContain(`${campo.valor.cantidad} €`);
      }
    }
  });
});

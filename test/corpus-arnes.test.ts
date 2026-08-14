/**
 * LA VERJA DEL KNAPSACK DE EVIDENCIA (F6).
 *
 * Hoy pasa con el selector trivial —mandarlo todo— y su trabajo empieza el día
 * que alguien enchufe aquí el knapsack de verdad: en cuanto una selección tire
 * una unidad que sostiene un campo crítico, o deje una cita muerta, o convierta
 * un caso de abstención en un caso respondible, esto se pone rojo.
 *
 * ─── LO QUE SE EXIGE, Y LO QUE NO ───────────────────────────────────────────
 *
 * Se exige CONSERVACIÓN, no ahorro. `mandarloTodo` aprueba los 150 casos y se
 * sale del presupuesto en los 150: es lo correcto, porque hoy no hay palanca.
 * El ahorro se mide y se informa —`tokens: 0 de 25743`— y esa es la cifra que
 * dice que todavía no hay nada. Mezclar las dos en un solo `aprobado` haría que
 * la verja no pudiera distinguir «aún no hay knapsack» de «el knapsack rompe
 * cosas», que es justo lo que tendrá que distinguir.
 *
 * ─── EL DESGLOSE NO ES UN EXTRA ─────────────────────────────────────────────
 *
 * La aceptación de F6 dice «sin degradación por idioma NI POR TIPO DOCUMENTAL».
 * Una media global que esconda el catalán de contratos hundido es exactamente
 * el informe que el plan prohíbe, así que la verja se aplica CELDA A CELDA del
 * cruce idioma × dominio, no sobre el agregado.
 */

import { describe, expect, it } from "vitest";

import {
  CorpusCorrupto,
  cargarCorpus,
  declaraciones,
  problemasDelCorpus,
  type CasoDelArnes,
} from "../corpus/arnes/cargar.js";
import {
  abstencionSigueSiendoPosible,
  brecha,
  degradaciones,
  peorCelda,
  puntuarCaso,
  puntuarCorpus,
} from "../corpus/arnes/metricas.js";
import {
  conEntradaLimpia,
  entradaDelCaso,
  lasPrimerasK,
  mandarloTodo,
} from "../corpus/arnes/selectores.js";
import { oraculo } from "../corpus/arnes/mutantes.js";
import { contarTokens, tokensDelCaso } from "../corpus/arnes/tokens.js";
import { TRAMPAS_CANONICAS, canonizar, trampasDesconocidas } from "../corpus/arnes/trampas.js";

const casos = cargarCorpus();
const todo = puntuarCorpus(casos, conEntradaLimpia(mandarloTodo), { nombre: "mandarlo-todo" });

// Un caso mínimo y sano, para romperlo de una manera cada vez. Se valida contra
// sí mismo antes de cada mutación: un molde que ya viniera roto haría que todas
// las pruebas de abajo pasaran por el motivo equivocado.
function caso(parche: Partial<CasoDelArnes> = {}): CasoDelArnes {
  return {
    id: "tst-es-001",
    origen: "facturacion",
    idioma: "es",
    dominio: "pruebas",
    dificultad: "dificil",
    trampas: ["negacion"],
    consulta: "¿Qué importe hay que pagar por la factura F-2026-118?",
    unidades: [
      { id: "u1", papel: "necesaria", papelOriginal: "necesaria", texto: "La factura F-2026-118 asciende a 1.240,55 € sin IVA.", orden: 0 },
      { id: "u2", papel: "distractora", papelOriginal: "distractora", texto: "La factura F-2026-1118 asciende a 1.204,55 € sin IVA.", orden: 1 },
      { id: "u3", papel: "distractora", papelOriginal: "distractora", texto: "El plazo de pago habitual del proveedor es de treinta días.", orden: 2 },
    ],
    presupuestoMax: 2,
    presupuestoImputado: false,
    necesarias: ["u1"],
    citas: ["u1"],
    abstencion: false,
    valores: [{ campo: "importe_total", valor: "1240.55", critico: true }],
    citasPorCampo: { importe_total: ["u1"] },
    nota: "molde de prueba",
    ...parche,
  };
}

const decl = (c: CasoDelArnes) =>
  new Map([
    [
      c.id,
      {
        id: c.id,
        presupuesto: c.presupuestoMax,
        unidades: c.unidades.map((u) => u.id),
        necesarias: c.necesarias,
        citas: c.citas,
        criticos: c.valores.filter((v) => v.critico).map((v) => v.campo),
        camposDeLaRespuesta: c.valores.map((v) => v.campo),
        abstencion: c.abstencion,
      },
    ],
  ]);

describe("arnés F6 · el cargador valida al leer", () => {
  it("carga los 150 casos y ninguno le da problema", () => {
    expect(casos).toHaveLength(150);
    expect(problemasDelCorpus(casos, declaraciones())).toEqual([]);
  });

  it("el molde de prueba está sano antes de romperlo", () => {
    expect(problemasDelCorpus([caso()], decl(caso()))).toEqual([]);
  });

  it("⛔ un id repetido no pasa: un caso contado dos veces falsea el desglose", () => {
    const p = problemasDelCorpus([caso(), caso()], decl(caso()));
    expect(p.some((x) => x.includes("id repetido"))).toBe(true);
  });

  it("⛔ una cita a una unidad que no existe no pasa", () => {
    const c = caso({ citas: ["u9"], citasPorCampo: { importe_total: ["u9"] }, necesarias: [] });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes('cita "u9" no existe'))).toBe(true);
  });

  it("⛔ una necesaria que nadie cita no pasa: es relleno que infla la presión", () => {
    const c = caso({ necesarias: ["u1", "u3"] });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("es relleno"))).toBe(true);
  });

  it("⛔ un campo declarado crítico que la respuesta no trae no pasa", () => {
    const c = caso();
    const d = decl(c);
    d.get(c.id)!.criticos = ["importe_total", "fecha_vencimiento"];
    d.get(c.id)!.camposDeLaRespuesta = ["importe_total"];
    const p = problemasDelCorpus([c], d);
    expect(p.some((x) => x.includes('"fecha_vencimiento" se declara crítico'))).toBe(true);
  });

  it("⛔ un caso sin ningún campo crítico no pasa: no hay nada que el knapsack rompa", () => {
    const c = caso({ valores: [{ campo: "importe_total", valor: "1240.55", critico: false }] });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("ningún campo crítico"))).toBe(true);
  });

  it("⛔ una abstención sin citas no pasa: abstenerse sin enseñar por qué es callarse", () => {
    const c = caso({ abstencion: true, citas: [], necesarias: [], citasPorCampo: undefined });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("abstención sin citas"))).toBe(true);
  });

  it("⛔ una abstención por contradicción con un solo lado no pasa", () => {
    const c = caso({
      abstencion: true,
      citasPorCampo: undefined,
      unidades: caso().unidades.map((u) =>
        u.id === "u1" ? { ...u, papel: "contradictoria" as const } : u,
      ),
      necesarias: [],
    });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("un solo lado"))).toBe(true);
  });

  it("⛔ un caso donde caben todas las unidades no pasa: mide un `map`, no un knapsack", () => {
    const c = caso({ presupuestoMax: 3 });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("caben todas"))).toBe(true);
  });

  it("⛔ un caso irresoluble no pasa: las obligatorias no caben en el presupuesto", () => {
    const c = caso({ presupuestoMax: 1, citas: ["u1", "u2"], citasPorCampo: { importe_total: ["u1", "u2"] } });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("irresoluble"))).toBe(true);
  });

  it("⛔ la proyección tiene que decir lo mismo que el fichero de datos", () => {
    // Es la comprobación que encontró el presupuesto fantasma: `vista.ts`
    // recalculaba con 0,6 lo que `reparar.ts` había escrito con 0,5, y diez de
    // los cuarenta casos de soporte se puntuaban contra un 3 que el fichero
    // declaraba como 2. Ninguna de las 95 pruebas anteriores comparaba las dos.
    const c = caso();
    const d = decl(c);
    d.get(c.id)!.presupuesto = 1;
    const p = problemasDelCorpus([c], d);
    expect(p.some((x) => x.includes("el fichero declara un presupuesto de 1"))).toBe(true);
  });

  it("⛔ un caso declarado que la vista no devuelve no pasa: nadie lo puntúa", () => {
    const p = problemasDelCorpus([], decl(caso()));
    expect(p.some((x) => x.includes("la vista no lo devuelve"))).toBe(true);
  });

  it("un corpus corrupto revienta RUIDOSAMENTE, y con todos los problemas", () => {
    const e = new CorpusCorrupto(["a: uno", "b: dos"]);
    expect(e).toBeInstanceOf(Error);
    expect(e.problemas).toHaveLength(2);
    expect(e.message).toContain("no puede arbitrar nada");
    expect(e.message).toContain("a: uno");
  });
});

describe("arnés F6 · el selector no puede ver la respuesta", () => {
  it("la entrada no lleva papeles, ni citas, ni necesarias, ni valores", () => {
    const entrada = entradaDelCaso(casos[0]!);
    const claves = Object.keys(entrada);
    for (const prohibida of ["necesarias", "citas", "valores", "abstencion", "citasPorCampo"]) {
      expect(claves, prohibida).not.toContain(prohibida);
    }
    const texto = JSON.stringify(entrada);
    expect(texto).not.toContain("necesaria");
    expect(texto).not.toContain("distractora");
  });

  it("lo que ve es lo que verá en producción: consulta, trozos y presupuesto", () => {
    const c = casos[0]!;
    const entrada = entradaDelCaso(c);
    expect(entrada.consulta).toBe(c.consulta);
    expect(entrada.unidades.map((u) => u.id)).toEqual(c.unidades.map((u) => u.id));
    expect(entrada.presupuestoMax).toBe(c.presupuestoMax);
  });
});

describe("arnés F6 · LA VERJA", () => {
  it("el selector por defecto conserva los 150 casos", () => {
    expect(todo.global.total).toBe(150);
    expect(todo.global.aprobados).toBe(150);
    expect(todo.fallos).toEqual([]);
  });

  it("100 % de campos críticos y 100 % de citas conservadas", () => {
    expect(todo.global.coberturaDeCamposCriticos).toBe(1);
    expect(todo.global.citasConservadas).toBe(1);
    expect(todo.global.camposCriticos).toBeGreaterThan(300);
    expect(todo.global.citas).toBeGreaterThan(250);
  });

  it("las 22 abstenciones siguen siendo posibles después de seleccionar", () => {
    expect(todo.global.abstenciones).toBe(22);
    expect(todo.global.tasaDeAbstencionCorrecta).toBe(1);
  });

  it("SIN DEGRADACIÓN por idioma ni por tipo documental, celda a celda", () => {
    // El umbral es 100 % porque eso es lo que dice la aceptación de F6. Un
    // 99,3 % global con una celda del cruce al 88 % es el informe que el plan
    // prohíbe publicar como aprobado.
    expect(degradaciones(todo)).toEqual([]);
    expect(brecha(todo)).toBe(0);
    expect(peorCelda(todo)?.coberturaDeCamposCriticos).toBe(1);
  });

  it("el cruce tiene las seis celdas: dos idiomas por tres tipos documentales", () => {
    expect(todo.porIdiomaYDominio.map((c) => c.clave)).toEqual([
      "ca·contratos",
      "ca·facturacion-y-cobros",
      "ca·soporte-y-politicas",
      "es·contratos",
      "es·facturacion-y-cobros",
      "es·soporte-y-politicas",
    ]);
    for (const c of todo.porIdiomaYDominio) expect(c.total, c.clave).toBeGreaterThanOrEqual(17);
  });

  it("⚠️ y ahorra CERO: aprobar la verja no es tener una palanca", () => {
    // Es la mitad que falta. `mandarloTodo` conserva el 100 % de todo y no
    // ahorra un solo token, así que «conserva los campos críticos» no puede
    // leerse nunca como «el knapsack funciona».
    expect(todo.global.tokensAhorrados).toBe(0);
    expect(todo.global.fraccionAhorrada).toBe(0);
    expect(todo.global.fueraDePresupuesto).toBe(150);
    expect(todo.global.tokensTotales).toBeGreaterThan(20000);
  });

  it("la cuenta de tokens va marcada como ESTIMADA hasta la última línea", () => {
    // Publicar una estimación como medida es la clase de mentira que este
    // producto existe para no contar. Si algún día se enchufa un tokenizador
    // exacto, esto falla y se cambia a mano, que es lo que se quiere.
    expect(todo.contador.exacto).toBe(false);
    expect(todo.contador.id).toBe("corpus-heuristico");
  });
});

describe("arnés F6 · el arnés suspende a quien tiene que suspender", () => {
  it("un selector que cabe en presupuesto pero tira lo que no debe SUSPENDE", () => {
    const primeras = puntuarCorpus(casos, conEntradaLimpia(lasPrimerasK), { nombre: "primeras-k" });
    expect(primeras.global.fueraDePresupuesto).toBe(0);
    expect(primeras.global.fraccionAhorrada).toBeGreaterThan(0.3);
    // Y aun así suspende, que es lo único que importa.
    expect(primeras.global.aprobados).toBeLessThan(60);
    expect(degradaciones(primeras).length).toBeGreaterThan(10);
  });

  it("el desglose señala la celda hundida, no la esconde en la media", () => {
    const primeras = puntuarCorpus(casos, conEntradaLimpia(lasPrimerasK), { nombre: "primeras-k" });
    expect(brecha(primeras)).toBeGreaterThan(0.2);
    const ejes = new Set(degradaciones(primeras).map((d) => d.eje));
    expect(ejes.has("idioma")).toBe(true);
    expect(ejes.has("dominio")).toBe(true);
    expect(ejes.has("idioma×dominio")).toBe(true);
  });

  it("el oráculo aprueba los 150 Y ahorra: existe siempre una selección correcta", () => {
    const o = puntuarCorpus(casos, oraculo, { nombre: "oraculo" });
    expect(o.global.aprobados).toBe(150);
    expect(o.global.fueraDePresupuesto).toBe(0);
    expect(o.global.fraccionAhorrada).toBeGreaterThan(0.4);
    expect(degradaciones(o)).toEqual([]);
  });
});

describe("arnés F6 · las métricas dicen lo que parece que dicen", () => {
  it("un campo crítico necesita TODAS sus citas, no una cualquiera", () => {
    // Una referencia cruzada («según la cláusula 4.2») vive en dos unidades.
    // Conservar solo una deja el campo sin sostener aunque la cita no esté
    // muerta del todo, y contarlo como intacto sería regalar el caso.
    const c = caso({ citas: ["u1", "u2"], citasPorCampo: { importe_total: ["u1", "u2"] } });
    const r = puntuarCaso(c, ["u1"]);
    expect(r.camposCriticosIntactos).toBe(0);
    expect(r.camposCriticosHuerfanos).toEqual([]);
    expect(r.aprobado).toBe(false);
  });

  it("un campo sin NINGUNA cita viva sale además como huérfano", () => {
    const c = caso({ citas: ["u1", "u2"], citasPorCampo: { importe_total: ["u1", "u2"] } });
    const r = puntuarCaso(c, ["u3"]);
    expect(r.camposCriticosHuerfanos).toEqual(["importe_total"]);
  });

  it("un id inventado suspende: no se puede contar como selección vacía y correcta", () => {
    const r = puntuarCaso(caso(), ["u1", "u404"]);
    expect(r.idsInventados).toEqual(["u404"]);
    expect(r.aprobado).toBe(false);
  });

  it("la granularidad de las citas se informa, no se disimula", () => {
    // 60 casos escriben las citas por campo; los otros 90 solo tienen una lista
    // global y a cada campo se le atribuye entera. Es una aproximación, y
    // callarla sería informar de una precisión que no se tiene.
    expect(todo.granularidad.porCampo).toBe(60);
    expect(todo.granularidad.global).toBe(90);
    expect(puntuarCaso(caso({ citasPorCampo: undefined }), ["u1"]).granularidadDeCitas).toBe("global");
    expect(puntuarCaso(caso(), ["u1"]).granularidadDeCitas).toBe("por-campo");
  });

  it("una abstención deja de serlo si se tira la cita que enseña el hueco", () => {
    // Sin contradicción: la abstención es por falta de un dato, y lo único que
    // hay que conservar es la unidad que enseña que el dato no está.
    const c = caso({
      abstencion: true,
      citas: ["u1"],
      citasPorCampo: undefined,
      necesarias: [],
    });
    expect(abstencionSigueSiendoPosible(c, new Set(["u1"])).ok).toBe(true);
    const rota = abstencionSigueSiendoPosible(c, new Set(["u2"]));
    expect(rota.ok).toBe(false);
    expect(rota.motivo).toContain("citas que enseñan");
  });

  it("…y deja de serlo AUNQUE las citas sobrevivan, si el choque desaparece", () => {
    // La segunda condición no la implica la primera. Aquí `u2` contradice a
    // `u1` y no está citada: tirarla no deja ninguna cita muerta y aun así
    // convierte el caso en respondible. El cargador prohíbe esta forma en el
    // corpus real, y esta comprobación es la segunda cerradura de la misma
    // puerta: la que sigue cerrada si alguien afloja la primera.
    const c = caso({
      abstencion: true,
      citas: ["u1"],
      citasPorCampo: undefined,
      necesarias: [],
      unidades: caso().unidades.map((u) =>
        u.id === "u3" ? u : { ...u, papel: "contradictoria" as const },
      ),
    });
    expect(abstencionSigueSiendoPosible(c, new Set(["u1", "u2"])).ok).toBe(true);
    const rota = abstencionSigueSiendoPosible(c, new Set(["u1"]));
    expect(rota.ok).toBe(false);
    expect(rota.motivo).toContain("un solo lado");
    expect(puntuarCaso(c, ["u1"]).aprobado).toBe(false);
  });

  it("⛔ el cargador prohíbe una contradictoria sin citar en un caso de abstención", () => {
    const c = caso({
      abstencion: true,
      citas: ["u1"],
      citasPorCampo: undefined,
      necesarias: [],
      unidades: caso().unidades.map((u) =>
        u.id === "u3" ? u : { ...u, papel: "contradictoria" as const },
      ),
    });
    const p = problemasDelCorpus([c], decl(c));
    expect(p.some((x) => x.includes("unidad contradictoria u2 sin citar"))).toBe(true);
  });

  it("los tokens se cuentan sobre el texto recuperado y nunca salen negativos", () => {
    const c = casos[0]!;
    const total = tokensDelCaso(c, { id: "x", exact: false, count: (t) => t.length });
    expect(total).toBe(c.unidades.reduce((n, u) => n + u.texto.length, 0));
    const nada = contarTokens(c, new Set());
    expect(nada.ahorrados).toBe(nada.totales);
    expect(nada.fraccionAhorrada).toBe(1);
    const todos = contarTokens(c, new Set(c.unidades.map((u) => u.id)));
    expect(todos.ahorrados).toBe(0);
  });
});

describe("arnés F6 · el vocabulario de trampas está unificado y cerrado", () => {
  it("los alias de los tres corpus se colapsan en una sola fila", () => {
    // `apostrof` y `apostrofo` son la misma trampa. Sin unificar salen en dos
    // filas de cuatro y cinco, y las dos parecen cobertura mínima donde hay una
    // sola clase con nueve casos.
    expect(canonizar("apostrofo")).toBe("apostrof");
    expect(canonizar("diacriticos")).toBe("diacritico");
    const apostrofo = todo.porTrampa.find((c) => c.clave === "apostrof");
    expect(apostrofo?.total).toBe(9);
    expect(todo.porTrampa.map((c) => c.clave)).not.toContain("apostrofo");
  });

  it("nadie ha inventado una trampa fuera del vocabulario", () => {
    const desconocidas = trampasDesconocidas(casos.flatMap((c) => c.trampas));
    expect(desconocidas).toEqual([]);
    expect(TRAMPAS_CANONICAS).toHaveLength(17);
  });

  it("las 17 clases están todas ejercitadas por algún caso", () => {
    const cubiertas = new Set(todo.porTrampa.map((c) => c.clave));
    for (const t of TRAMPAS_CANONICAS) expect(cubiertas.has(t), t).toBe(true);
  });
});

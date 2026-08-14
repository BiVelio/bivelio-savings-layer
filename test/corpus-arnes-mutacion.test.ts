/**
 * LA VERIFICACIÓN POR MUTACIÓN. Comprueba que la verja tiene dientes.
 *
 * ─── EL PROBLEMA QUE RESUELVE ───────────────────────────────────────────────
 *
 * `test/corpus-arnes.test.ts` está verde. Eso, por sí solo, no dice nada: el
 * selector por defecto —mandarlo todo— conserva absolutamente todo por
 * construcción, así que un arnés que no comprobara NADA saldría igual de verde.
 * Un test que solo se ha visto pasar es un test que nadie ha probado.
 *
 * La única prueba de que una verja sirve es romperla y verla suspender. Aquí se
 * rompe de cuatro maneras, una por invariante, y se exige además que cada
 * mutante rompa EL SUYO: un mutante que suspende por el motivo equivocado
 * acredita que el arnés detecta algo, no que detecte lo que dice.
 *
 * ─── POR QUÉ VIVE EN LA SUITE Y NO EN UNA SESIÓN ────────────────────────────
 *
 * Mutar a mano, correr, y revertir es una comprobación que caduca en el primer
 * refactor. Escrita aquí se repite en cada `pnpm test`: si alguien afloja
 * `puntuarCaso` —quita la comprobación de citas, cuenta un campo crítico como
 * intacto con una sola cita viva, deja de mirar las contradicciones— no falla
 * un test de los buenos, falla el que exige que los malos suspendan. Y ese es
 * mucho más incómodo de racionalizar como «ya lo arreglo luego».
 *
 * ─── EL MUTANTE QUE IMPORTA ────────────────────────────────────────────────
 *
 * `responde-una-abstencion` es el único que no se ve. Los otros tres dejan la
 * respuesta sin evidencia, y eso el cliente lo nota. Ese deja un solo lado de
 * la contradicción: el caso queda perfectamente respondible, el modelo contesta
 * con seguridad y con la cita en su sitio, y lo que contesta es lo contrario de
 * lo correcto. Un fallo por quedarse corto lo ve alguien. Este no lo ve nadie.
 */

import { describe, expect, it } from "vitest";

import { cargarCorpus, type CasoDelArnes } from "../corpus/arnes/cargar.js";
import { degradaciones, puntuarCorpus } from "../corpus/arnes/metricas.js";
import { MUTANTES, respondeUnaAbstencion, tiraUnaCita } from "../corpus/arnes/mutantes.js";
import { conEntradaLimpia, mandarloTodo } from "../corpus/arnes/selectores.js";

const casos = cargarCorpus();
const sano = puntuarCorpus(casos, conEntradaLimpia(mandarloTodo), { nombre: "sano" });

describe("verificación por mutación · el control", () => {
  it("sin mutar, la verja pasa: si no, lo de abajo no demostraría nada", () => {
    expect(sano.global.aprobados).toBe(150);
    expect(degradaciones(sano)).toEqual([]);
  });
});

describe("verificación por mutación · cada mutante suspende", () => {
  for (const m of MUTANTES) {
    it(`⛔ «${m.nombre}» hace fallar la verja`, () => {
      const informe = puntuarCorpus(casos, m.selector, { nombre: m.nombre });
      expect(informe.global.aprobados, m.nombre).toBeLessThan(150);
      expect(informe.fallos.length, m.nombre).toBeGreaterThan(0);
    });
  }

  it("⛔ «tira-una-cita» suspende por CITAS MUERTAS, no por otra cosa", () => {
    const i = puntuarCorpus(casos, tiraUnaCita, { nombre: "tira-una-cita" });
    expect(i.global.aprobados).toBe(0);
    expect(i.global.citasConservadas).toBeLessThan(1);
    expect(i.fallos.every((f) => f.citasMuertas.length > 0)).toBe(true);
    expect(i.fallos.every((f) => f.idsInventados.length === 0)).toBe(true);
    expect(degradaciones(i).some((d) => d.metrica === "citasConservadas")).toBe(true);
  });

  it("⛔ «tira-una-necesaria» suspende por CAMPOS CRÍTICOS sin sostener", () => {
    const i = puntuarCorpus(casos, MUTANTES[1]!.selector, { nombre: "tira-una-necesaria" });
    expect(i.global.coberturaDeCamposCriticos).toBeLessThan(0.5);
    expect(i.fallos.some((f) => f.necesariasPerdidas.length > 0)).toBe(true);
    expect(
      degradaciones(i).some((d) => d.metrica === "coberturaDeCamposCriticos"),
    ).toBe(true);
  });

  it("⛔ «responde-una-abstencion» suspende SOLO por las abstenciones que fabrica", () => {
    // Es el fallo caro y el que mejor se disfraza: 92 % de aprobados, el 98 %
    // de las citas vivas, y doce casos donde el modelo contestará con
    // seguridad lo contrario de lo correcto. Si el arnés solo mirase citas y
    // campos críticos, este mutante pasaría por «casi perfecto».
    const i = puntuarCorpus(casos, respondeUnaAbstencion, { nombre: "responde-una-abstencion" });
    expect(i.global.aprobados).toBeLessThan(150);
    expect(i.global.tasaDeAbstencionCorrecta).toBeLessThan(1);
    expect(i.fallos.length).toBe(12);
    for (const f of i.fallos) {
      expect(f.esAbstencion, f.casoId).toBe(true);
      expect(f.abstencionSostenible, f.casoId).toBe(false);
      expect(f.abstencionRota, f.casoId).toContain("un solo lado");
    }
    // Y las abstenciones rotas están en los dos idiomas: un mutante que solo
    // rompiera el castellano no probaría que el desglose por idioma sirve.
    expect(new Set(i.fallos.map((f) => f.idioma))).toEqual(new Set(["es", "ca"]));
  });

  it("⛔ «inventa-ids» suspende aunque no pierda ni una cita", () => {
    // El único que conserva el 100 % de todo y aun así no puede aprobar. Sin
    // esta comprobación, un selector que devolviera los ids del caso anterior
    // saldría con cobertura perfecta.
    const i = puntuarCorpus(casos, MUTANTES[3]!.selector, { nombre: "inventa-ids" });
    expect(i.global.coberturaDeCamposCriticos).toBe(1);
    expect(i.global.citasConservadas).toBe(1);
    expect(i.global.aprobados).toBe(0);
    expect(i.fallos.every((f) => f.idsInventados.length === 1)).toBe(true);
  });
});

describe("verificación por mutación · el caso que el corpus real no sabe expresar", () => {
  // Encontrado mutando el propio arnés: al quitar `abst.ok` de `aprobado`, los
  // cuatro mutantes de arriba SEGUÍAN suspendiendo. Motivo: en los 150 casos de
  // hoy los dos lados de una contradicción están siempre citados, así que tirar
  // uno rompe también las citas y el mutante suspende por la otra puerta. La
  // comprobación de abstención no quedaba fijada por ninguna de las cuatro.
  //
  // Este corpus de un solo caso es la que la fija: una contradictoria SIN citar.
  // El cargador prohíbe esa forma en los datos reales —hay un test— y por eso
  // hay que construirla a mano. Las dos comprobaciones son la misma puerta con
  // dos cerraduras: si alguien quita una, esto se pone rojo.
  const conContradictoriaSinCitar: CasoDelArnes = {
    id: "mut-es-001",
    origen: "facturacion",
    idioma: "es",
    dominio: "pruebas",
    dificultad: "dificil",
    trampas: ["abstencion"],
    consulta: "¿Se puede devolver un artículo comprado en rebajas?",
    unidades: [
      { id: "u1", papel: "contradictoria", papelOriginal: "contradictoria", texto: "Las FAQ dicen que los artículos de rebajas no admiten devolución.", orden: 0 },
      { id: "u2", papel: "contradictoria", papelOriginal: "contradictoria", texto: "La política v4 dice que los artículos de rebajas conservan el plazo general.", orden: 1 },
      { id: "u3", papel: "distractora", papelOriginal: "distractora", texto: "El reembolso se abona en el mismo medio de pago en catorce días.", orden: 2 },
    ],
    presupuestoMax: 2,
    presupuestoImputado: false,
    necesarias: [],
    citas: ["u1"],
    abstencion: true,
    valores: [{ campo: "abstencion", valor: "contradiccion-sin-regla-de-desempate", critico: true }],
    nota: "solo para la mutación: u2 contradice a u1 y nadie la cita",
  };

  it("⛔ tirar el otro lado suspende AUNQUE no muera ninguna cita", () => {
    const i = puntuarCorpus([conContradictoriaSinCitar], () => ["u1"], { nombre: "mut" });
    expect(i.global.citasConservadas).toBe(1);
    expect(i.global.coberturaDeCamposCriticos).toBe(1);
    // Y aun así suspende: es lo único que lo separa de un aprobado perfecto.
    expect(i.global.aprobados).toBe(0);
    expect(i.global.tasaDeAbstencionCorrecta).toBe(0);
    expect(i.fallos[0]?.abstencionRota).toContain("un solo lado");
  });

  it("conservar los dos lados aprueba: el caso no está roto de fábrica", () => {
    const i = puntuarCorpus([conContradictoriaSinCitar], () => ["u1", "u2"], { nombre: "mut" });
    expect(i.global.aprobados).toBe(1);
    expect(i.global.tasaDeAbstencionCorrecta).toBe(1);
  });
});

describe("verificación por mutación · el desglose también se rompe", () => {
  it("una mutación hunde celdas del cruce idioma × dominio, no solo la media", () => {
    // La comprobación que hace falta para creerse el desglose: si al romper el
    // selector la media bajara y las celdas no, el cruce sería decorativo.
    const i = puntuarCorpus(casos, tiraUnaCita, { nombre: "tira-una-cita" });
    for (const celda of i.porIdiomaYDominio) {
      expect(celda.coberturaDeCamposCriticos, celda.clave).toBeLessThan(1);
    }
    const ejes = new Set(degradaciones(i).map((d) => d.eje));
    expect(ejes).toEqual(new Set(["idioma", "dominio", "idioma×dominio"]));
  });

  it("la degradación se ve en los DOS idiomas por separado", () => {
    const i = puntuarCorpus(casos, tiraUnaCita, { nombre: "tira-una-cita" });
    const idiomas = degradaciones(i)
      .filter((d) => d.eje === "idioma")
      .map((d) => d.clave);
    expect(new Set(idiomas)).toEqual(new Set(["es", "ca"]));
  });
});

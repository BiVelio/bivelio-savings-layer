import { describe, it, expect } from "vitest";

import casosEs from "../corpus/knapsack-evidencia/contratos/contratos.es.json";
import casosCa from "../corpus/knapsack-evidencia/contratos/contratos.ca.json";
import {
  evaluaSeleccion,
  unidadesNecesarias,
  unidadesPrescindibles,
  type CasoDeEvidencia,
  type Trampa,
} from "../corpus/knapsack-evidencia/forma.js";
import { normalizeText } from "../src/canonicalization/canonicalize.js";
import { keyTokensMatch } from "../src/cache/semantic.js";

/**
 * VERJA DEL CORPUS DE CONTRATOS (golden set de F6, el knapsack de evidencia).
 *
 * Un corpus sin verja es un montón de JSON: se degrada en el primer parche, y
 * la degradación es invisible porque nadie mira 50 ficheros a mano. Lo que se
 * comprueba aquí no es la ortografía de los casos, es que cada caso siga siendo
 * capaz de FALLAR:
 *
 *   · que haya presión de presupuesto (si cabe todo, no hay knapsack que medir);
 *   · que exista una elección correcta dentro de ese presupuesto;
 *   · que las unidades necesarias sean realmente citables y las prescindibles
 *     realmente prescindibles;
 *   · que la trampa declarada produzca un valor CONCRETO distinto del correcto,
 *     y no un «podría fallar» genérico;
 *   · que el reparto por idioma y por clase de trampa no se vacíe con el tiempo.
 *
 * Y hay dos comprobaciones que no miran al corpus sino al CÓDIGO REAL del
 * repositorio (`canonicalize.ts` y `semantic.ts`): las notas de varios casos
 * afirman cosas sobre cómo normaliza el producto hoy. Si eso cambia, estas dos
 * fallan y la nota se actualiza. Una afirmación sobre el código que nadie
 * comprueba envejece hasta convertirse en mentira.
 */

const casos = [...casosEs, ...casosCa] as unknown as CasoDeEvidencia[];
const porId = new Map(casos.map((c) => [c.id, c]));

const TRAMPAS_VALIDAS: ReadonlySet<Trampa> = new Set<Trampa>([
  "negacion",
  "excepcion",
  "condicion",
  "importes-parecidos",
  "fechas-parecidas",
  "referencia-cruzada",
  "verbo-modal",
  "identificadores-parecidos",
  "derogacion",
  "unidades",
  "abstencion",
  "diacriticos",
  "ela-geminada",
  "apostrofo",
]);

/** Sufijos de campo que obligan a un valor numérico: son los que se comparan. */
const SUFIJOS_NUMERICOS = ["_eur", "_pct", "_dias", "_horas", "_m2", "_anys", "_dies", "_hores"];

describe("corpus de contratos · forma de cada caso", () => {
  it("son 50 casos con id único, bien formado y coherente con el idioma", () => {
    expect(casos).toHaveLength(50);
    expect(new Set(casos.map((c) => c.id)).size).toBe(50);
    for (const c of casos) {
      expect(c.id, `${c.id}: formato de id`).toMatch(/^ct-(es|ca)-\d{3}$/);
      expect(c.id.startsWith(`ct-${c.idioma}-`), `${c.id}: el id no dice el idioma que declara`).toBe(
        true,
      );
      expect(c.dominio).toBe("contratos");
      expect(c.subdominio.length, `${c.id}: subdominio`).toBeGreaterThan(0);
      expect(c.consulta.trim().length, `${c.id}: consulta vacía`).toBeGreaterThan(10);
      expect(c.nota.trim().length, `${c.id}: sin nota (el porqué va en el JSON, no en un comentario)`)
        .toBeGreaterThan(40);
    }
  });

  it("las unidades tienen id único dentro del caso y texto real", () => {
    for (const c of casos) {
      expect(c.unidades.length, `${c.id}: hacen falta al menos 3 unidades`).toBeGreaterThanOrEqual(3);
      const ids = c.unidades.map((u) => u.id);
      expect(new Set(ids).size, `${c.id}: ids de unidad repetidos`).toBe(ids.length);
      for (const u of c.unidades) {
        expect(u.texto.trim().length, `${c.id}/${u.id}: texto vacío`).toBeGreaterThan(20);
      }
    }
  });

  it("toda cita apunta a una unidad existente, y nunca a una prescindible", () => {
    for (const c of casos) {
      const ids = new Set(c.unidades.map((u) => u.id));
      expect(c.citasObligatorias.length, `${c.id}: sin citas obligatorias`).toBeGreaterThan(0);
      for (const cita of c.citasObligatorias) {
        expect(ids.has(cita), `${c.id}: cita ${cita} inexistente`).toBe(true);
        const papel = c.unidades.find((u) => u.id === cita)?.papel;
        expect(
          papel === "necesaria" || papel === "contradictoria",
          `${c.id}: cita ${cita} apunta a una unidad ${papel}; una cita a algo prescindible no sostiene nada`,
        ).toBe(true);
      }
    }
  });

  it("toda unidad necesaria está citada — si no, no es necesaria, es decorado", () => {
    for (const c of casos) {
      const citadas = new Set(c.citasObligatorias);
      for (const u of unidadesNecesarias(c)) {
        expect(citadas.has(u.id), `${c.id}: ${u.id} es necesaria y no se cita`).toBe(true);
      }
    }
  });

  it("los campos críticos existen en la respuesta y las cifras son números", () => {
    for (const c of casos) {
      const claves = Object.keys(c.respuesta.campos);
      expect(claves.length, `${c.id}: respuesta sin campos`).toBeGreaterThan(0);
      expect(c.camposCriticos.length, `${c.id}: sin campos críticos`).toBeGreaterThan(0);
      for (const campo of c.camposCriticos) {
        expect(claves, `${c.id}: campo crítico ${campo} no está en la respuesta`).toContain(campo);
      }
      for (const [clave, valor] of Object.entries(c.respuesta.campos)) {
        if (SUFIJOS_NUMERICOS.some((s) => clave.endsWith(s))) {
          const ok = typeof valor === "number" || valor === null || Array.isArray(valor);
          expect(
            ok,
            `${c.id}: ${clave} = ${JSON.stringify(valor)} — una cifra guardada como texto no se puede comparar`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("corpus de contratos · el caso tiene que poder fallar", () => {
  it("el presupuesto aprieta: siempre sobra algo que tirar y siempre cabe lo que hay que conservar", () => {
    for (const c of casos) {
      const max = c.presupuesto.maxUnidades;
      expect(
        max,
        `${c.id}: el presupuesto (${max}) no da ni para las citas obligatorias (${c.citasObligatorias.length})`,
      ).toBeGreaterThanOrEqual(c.citasObligatorias.length);
      expect(
        max,
        `${c.id}: el presupuesto (${max}) da para las ${c.unidades.length} unidades; sin presión no hay knapsack que medir`,
      ).toBeLessThan(c.unidades.length);
    }
  });

  it("cada caso tiene al menos una unidad que el knapsack debe tirar", () => {
    for (const c of casos) {
      expect(unidadesPrescindibles(c).length, `${c.id}: no hay nada que descartar`).toBeGreaterThan(0);
    }
  });

  it("la selección correcta pasa la evaluación, y perder una necesaria la suspende", () => {
    for (const c of casos) {
      const buena = evaluaSeleccion(c, c.citasObligatorias);
      expect(buena.conservaNecesarias, `${c.id}: la selección de referencia pierde una necesaria`).toBe(
        true,
      );
      expect(buena.citasAccesibles, `${c.id}: la selección de referencia deja una cita muerta`).toBe(
        true,
      );
      expect(buena.dentroDePresupuesto, `${c.id}: la selección de referencia se pasa de presupuesto`)
        .toBe(true);

      const necesarias = unidadesNecesarias(c);
      if (necesarias.length > 0) {
        const sinLaPrimera = c.citasObligatorias.filter((id) => id !== necesarias[0]!.id);
        const mala = evaluaSeleccion(c, sinLaPrimera);
        expect(
          mala.conservaNecesarias,
          `${c.id}: se puede tirar ${necesarias[0]!.id} sin que la evaluación se entere — entonces no era necesaria`,
        ).toBe(false);
      }
    }
  });

  it("la trampa declarada nombra un valor CONCRETO distinto del correcto", () => {
    const conTrampa = casos.filter((c) => c.campoTrampa);
    expect(conTrampa.length, "hacen falta trampas declaradas para poder diagnosticar").toBeGreaterThanOrEqual(
      30,
    );
    for (const c of conTrampa) {
      const t = c.campoTrampa!;
      expect(
        Object.keys(c.respuesta.campos),
        `${c.id}: la trampa apunta a ${t.campo}, que no es un campo de la respuesta`,
      ).toContain(t.campo);
      expect(
        JSON.stringify(t.valorErroneo),
        `${c.id}: el valor «erróneo» de ${t.campo} es el correcto`,
      ).not.toBe(JSON.stringify(c.respuesta.campos[t.campo]));
      expect(t.siSeCae.length, `${c.id}: trampa sin unidades que perder`).toBeGreaterThan(0);
      for (const id of t.siSeCae) {
        const u = c.unidades.find((x) => x.id === id);
        expect(u, `${c.id}: la trampa cita la unidad ${id}, que no existe`).toBeDefined();
        expect(
          u!.papel,
          `${c.id}: perder ${id} (${u!.papel}) no puede causar un error; una trampa se dispara al tirar algo necesario`,
        ).toBe("necesaria");
      }
      const cayendo = evaluaSeleccion(
        c,
        c.unidades.map((u) => u.id).filter((id) => !t.siSeCae.includes(id)),
      );
      expect(cayendo.cayoEnLaTrampa, `${c.id}: la trampa no se detecta al dispararla`).toBe(true);
      expect(cayendo.conservaNecesarias).toBe(false);
    }
  });
});

describe("corpus de contratos · abstenerse es una respuesta", () => {
  const abstenciones = casos.filter((c) => c.respuesta.abstenerse);

  it("hay al menos 8 casos donde la respuesta correcta es no responder", () => {
    expect(abstenciones.length).toBeGreaterThanOrEqual(8);
  });

  it("toda abstención dice POR QUÉ, y la contradictoria enseña las dos partes del choque", () => {
    for (const c of abstenciones) {
      expect(c.respuesta.motivoAbstencion, `${c.id}: abstención sin motivo`).toBeDefined();
      expect(c.trampas, `${c.id}: una abstención declara la trampa «abstencion»`).toContain("abstencion");
      if (c.respuesta.motivoAbstencion === "contradiccion-sin-regla-de-desempate") {
        const contradictorias = c.unidades.filter((u) => u.papel === "contradictoria");
        expect(
          contradictorias.length,
          `${c.id}: una contradicción necesita al menos dos versiones enfrentadas`,
        ).toBeGreaterThanOrEqual(2);
        for (const u of contradictorias) {
          expect(
            c.citasObligatorias,
            `${c.id}: ${u.id} contradice y no se cita; con una sola de las dos, abstenerse deja de estar justificado`,
          ).toContain(u.id);
        }
      }
    }
  });

  it("ninguna abstención lleva trampa de campo — no hay respuesta que errar, hay una que no dar", () => {
    for (const c of abstenciones) {
      expect(c.campoTrampa, `${c.id}: una abstención no tiene «valor erróneo»`).toBeUndefined();
    }
  });

  it("las abstenciones no son todas del mismo motivo ni del mismo idioma", () => {
    const motivos = new Set(abstenciones.map((c) => c.respuesta.motivoAbstencion));
    expect(motivos.size, "hacen falta los dos motivos: falta evidencia y hay contradicción").toBe(2);
    const idiomas = new Set(abstenciones.map((c) => c.idioma));
    expect(idiomas, "abstenerse tiene que estar probado en los dos idiomas").toEqual(
      new Set(["es", "ca"]),
    );
  });
});

describe("corpus de contratos · reparto y cobertura", () => {
  it("el reparto por idioma es real, no una cuota simbólica", () => {
    const ca = casos.filter((c) => c.idioma === "ca").length;
    const es = casos.filter((c) => c.idioma === "es").length;
    expect(es).toBeGreaterThanOrEqual(25);
    expect(ca, "menos de 15 casos en catalán no sostienen una afirmación por idioma").toBeGreaterThanOrEqual(
      15,
    );
  });

  it("hay casos fáciles de control y una mayoría difícil", () => {
    const por = (d: string) => casos.filter((c) => c.dificultad === d).length;
    expect(por("facil"), "sin controles fáciles no se distingue elegir bien de mandarlo todo")
      .toBeGreaterThanOrEqual(4);
    expect(por("dificil"), "un corpus fácil no demuestra nada").toBeGreaterThanOrEqual(25);
    expect(por("facil") + por("media") + por("dificil")).toBe(50);
  });

  it("cada clase de trampa está declarada y cubierta por varios casos", () => {
    const cuenta = new Map<Trampa, number>();
    for (const c of casos) {
      expect(c.trampas.length, `${c.id}: sin trampa declarada`).toBeGreaterThan(0);
      for (const t of c.trampas) {
        expect(TRAMPAS_VALIDAS.has(t), `${c.id}: trampa desconocida «${t}»`).toBe(true);
        cuenta.set(t, (cuenta.get(t) ?? 0) + 1);
      }
    }
    // Las diez que el plan declara peligrosas en documentos jurídicos.
    const minimos: Array<[Trampa, number]> = [
      ["negacion", 5],
      ["excepcion", 5],
      ["condicion", 10],
      ["importes-parecidos", 8],
      ["fechas-parecidas", 5],
      ["referencia-cruzada", 6],
      ["verbo-modal", 5],
      ["identificadores-parecidos", 3],
      ["derogacion", 5],
      ["unidades", 4],
      ["abstencion", 8],
    ];
    for (const [trampa, minimo] of minimos) {
      expect(cuenta.get(trampa) ?? 0, `cobertura insuficiente de «${trampa}»`).toBeGreaterThanOrEqual(
        minimo,
      );
    }
  });

  it("los subdominios del encargo están todos representados", () => {
    const esperados = [
      "prestacion-de-servicios",
      "arrendamiento",
      "confidencialidad",
      "niveles-de-servicio",
      "penalizacion-por-retraso",
      "prorroga-tacita",
      "resolucion-anticipada",
      "proteccion-de-datos",
    ];
    const presentes = new Set(casos.map((c) => c.subdominio));
    for (const s of esperados) {
      expect(presentes, `falta el subdominio ${s}`).toContain(s);
      const n = casos.filter((c) => c.subdominio === s).length;
      expect(n, `${s} con ${n} casos es testimonial`).toBeGreaterThanOrEqual(4);
    }
  });

  it("el catalán ejercita lo que de verdad rompe, no es castellano traducido", () => {
    const ca = casos.filter((c) => c.idioma === "ca");
    const texto = (c: CasoDeEvidencia) => c.consulta + c.unidades.map((u) => u.texto).join(" ");

    const conGeminada = ca.filter((c) => texto(c).includes("·"));
    expect(conGeminada.length, "la ela geminada tiene que aparecer en el TEXTO, no solo en la etiqueta")
      .toBeGreaterThanOrEqual(3);

    const conApostrofo = ca.filter((c) => /\w'\w/.test(texto(c)));
    expect(conApostrofo.length, "l'import, s'ha, d'aquest").toBeGreaterThanOrEqual(15);

    const conAcentos = ca.filter((c) => /[àèòéíóúï]/.test(texto(c)));
    expect(conAcentos.length, "accents oberts i tancats").toBeGreaterThanOrEqual(15);

    const despeses = ca.filter((c) => texto(c).includes("despeses") && texto(c).includes("despesa"));
    expect(despeses.length, "«despeses» contra «despesa» en el mismo caso").toBeGreaterThanOrEqual(1);

    const minimosCa: Array<[Trampa, number]> = [
      ["ela-geminada", 3],
      ["apostrofo", 3],
      ["diacriticos", 2],
    ];
    for (const [t, minimo] of minimosCa) {
      expect(
        ca.filter((c) => c.trampas.includes(t)).length,
        `cobertura insuficiente de «${t}» en catalán`,
      ).toBeGreaterThanOrEqual(minimo);
    }
  });

  it("los gemelos existen, son simétricos y no son el mismo caso dos veces", () => {
    const conPar = casos.filter((c) => c.par);
    expect(conPar.length, "sin gemelos no se puede medir la degradación por idioma").toBeGreaterThanOrEqual(
      20,
    );
    for (const c of conPar) {
      const otro = porId.get(c.par!);
      expect(otro, `${c.id}: el gemelo ${c.par} no existe`).toBeDefined();
      expect(otro!.par, `${c.id} apunta a ${c.par}, que no le devuelve la referencia`).toBe(c.id);
      expect(c.subdominio, `${c.id}/${c.par}: gemelos de subdominio distinto`).toBe(otro!.subdominio);
      // Un gemelo cambia EXACTAMENTE una cosa: o el idioma (y entonces mide
      // degradación por idioma), o la respuesta (y entonces mide que el
      // selector razona en vez de reconocer la forma del caso). Si no cambia
      // ninguna de las dos, es el mismo caso escrito dos veces y no mide nada.
      const cambiaIdioma = c.idioma !== otro!.idioma;
      const cambiaRespuesta =
        JSON.stringify(c.respuesta) !== JSON.stringify(otro!.respuesta);
      expect(
        cambiaIdioma || cambiaRespuesta,
        `${c.id}/${c.par}: gemelo que no cambia ni el idioma ni la respuesta`,
      ).toBe(true);
    }
    const cruzados = conPar.filter((c) => porId.get(c.par!)!.idioma !== c.idioma);
    expect(cruzados.length, "hacen falta gemelos es/ca para poder atribuir un fallo al idioma")
      .toBeGreaterThanOrEqual(16);
  });
});

describe("corpus de contratos · lo que el corpus afirma sobre ESTE código", () => {
  /**
   * Estas cuatro pruebas no validan el corpus: validan que las notas del corpus
   * sigan siendo ciertas sobre `src/`. Si una falla, lo que cambió es el
   * producto, y la nota del caso que la menciona hay que reescribirla.
   */

  it("el punto volado se pliega: col·legi ≡ collegi (ct-ca-002, ct-ca-008, ct-ca-018)", () => {
    expect(normalizeText("Col·legi d'Enginyers")).toBe(normalizeText("Collegi d'Enginyers"));
    expect(normalizeText("instal·lació")).toBe(normalizeText("installació"));
    // Y lo que NO se pliega: entre cifras el mismo signo es una multiplicación.
    expect(normalizeText("2·3")).toContain("·");
  });

  it("los diacríticos se pliegan: «més» y «mes» son el mismo token (ct-ca-014)", () => {
    expect(normalizeText("més")).toBe(normalizeText("mes"));
    expect(normalizeText("no podrà ser mai més del 15 %")).toContain("mes");
  });

  it("las cifras y las fechas sobreviven a la normalización — de eso vive el corpus", () => {
    expect(normalizeText("12.480,55 EUR")).toContain("12.480,55");
    expect(normalizeText("12.408,55 EUR")).not.toBe(normalizeText("12.480,55 EUR"));
    expect(normalizeText("30/06/2026")).toContain("30/06/2026");
    expect(normalizeText("99,95 %")).not.toBe(normalizeText("99,5 %"));
  });

  it("la paridad de negación de la caché semántica NO ve «sense» ni «sin»", () => {
    // TRIPWIRE, no bendición. `NEGATIONS` en src/cache/semantic.ts está escrita
    // en inglés; el castellano cuela de rebote porque «no» coincide, pero
    // «sin», «sense», «cap» y «ni» no están. Las notas de ct-ca-003 y ct-ca-013
    // lo dicen, y quien escriba F6 no debe suponer que ese guardarraíl existe en
    // catalán. El día que alguien amplíe la lista, esta prueba fallará: la
    // acción correcta entonces es actualizar esas dos notas, no relajar esto.
    const conSense = normalizeText(
      "la informacio que el receptor ja tenia abans de la signatura sense cap obligacio de secret",
    );
    const senseSense = normalizeText(
      "la informacio que el receptor ja tenia abans de la signatura amb obligacio de secret",
    );
    expect(keyTokensMatch(conSense, senseSense)).toBe(true);

    // El contraste: lo que la lista SÍ separa hoy es la negación inglesa.
    expect(
      keyTokensMatch(
        normalizeText("the insurance covers water damage in the leased warehouse"),
        normalizeText("the insurance does not cover water damage in the leased warehouse"),
      ),
    ).toBe(false);
  });
});

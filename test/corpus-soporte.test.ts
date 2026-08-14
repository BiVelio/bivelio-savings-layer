import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeText } from "../src/canonicalization/canonicalize.js";
import { keyTokensMatch } from "../src/cache/semantic.js";

/**
 * Verjas del corpus de SOPORTE Y POLÍTICAS DE PRODUCTO (fase F6, knapsack de
 * evidencia).
 *
 * Este fichero NO prueba el knapsack —todavía no existe—. Prueba que el corpus
 * que lo va a juzgar está bien construido, que es un requisito previo: un
 * golden set con una cita rota o con un campo crítico que la respuesta no trae
 * aprueba a cualquiera. Cuando se escriba el algoritmo, estas verjas siguen
 * siendo las que garantizan que el examen es válido.
 */

const RUTA = fileURLToPath(new URL("../benchmarks/corpus/soporte/casos.json", import.meta.url));

interface Unidad {
  id: string;
  papel: "necesaria" | "distractora" | "contradictoria";
  texto: string;
  vigencia?: { desde: string; hasta: string | null };
  deroga?: string;
  derogadaPor?: string;
}

interface Gemelo {
  caso: string;
  porQueDifiere: string;
  colisionaEnCache: boolean;
}

interface Caso {
  id: string;
  idioma: "es" | "ca";
  dominio: string;
  subdominio: string;
  dificultad: "facil" | "media" | "dificil";
  trampas: string[];
  consulta: string;
  evidencia: Unidad[];
  respuesta: { tipo: "estructurada" | "abstencion"; campos: Record<string, unknown> };
  camposCriticos: string[];
  citas: string[];
  abstencion: null | { motivo: string; explicacion: string };
  reglaDeDesempate?: string;
  gemelo?: Gemelo | null;
  nota?: string;
}

const corpus = JSON.parse(readFileSync(RUTA, "utf8")) as { casos: Caso[]; naturaleza: string };
const casos = corpus.casos;
const porId = new Map(casos.map((c) => [c.id, c]));

describe("corpus de soporte · forma", () => {
  it("tiene 40 casos con id único", () => {
    expect(casos).toHaveLength(40);
    expect(new Set(casos.map((c) => c.id)).size).toBe(40);
  });

  it("declara idioma, dificultad y dominio de un vocabulario cerrado", () => {
    for (const c of casos) {
      expect(["es", "ca"], c.id).toContain(c.idioma);
      expect(["facil", "media", "dificil"], c.id).toContain(c.dificultad);
      expect(c.dominio, c.id).toBe("soporte-y-politicas");
      expect(c.consulta.trim().length, c.id).toBeGreaterThan(0);
    }
  });

  it("reparte es/ca de verdad, no por cuota simbólica", () => {
    const ca = casos.filter((c) => c.idioma === "ca").length;
    const es = casos.filter((c) => c.idioma === "es").length;
    // Un reparto decorativo sería 36/4. El criterio es que la lengua menor
    // sostenga sola una evaluación: al menos 15 casos y al menos 6 difíciles.
    expect(ca).toBeGreaterThanOrEqual(15);
    expect(es).toBeGreaterThanOrEqual(15);
    const caDificiles = casos.filter((c) => c.idioma === "ca" && c.dificultad === "dificil").length;
    expect(caDificiles).toBeGreaterThanOrEqual(6);
  });
});

describe("corpus de soporte · evidencia y citas", () => {
  it("cada unidad de evidencia tiene id único dentro del caso y un papel válido", () => {
    for (const c of casos) {
      const ids = c.evidencia.map((u) => u.id);
      expect(new Set(ids).size, c.id).toBe(ids.length);
      for (const u of c.evidencia) {
        expect(["necesaria", "distractora", "contradictoria"], `${c.id}/${u.id}`).toContain(u.papel);
        expect(u.texto.trim().length, `${c.id}/${u.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("todo caso tiene al menos una necesaria (o contradictoria) y al menos una distractora", () => {
    for (const c of casos) {
      const sostiene = c.evidencia.filter((u) => u.papel !== "distractora").length;
      const distractoras = c.evidencia.filter((u) => u.papel === "distractora").length;
      // Sin distractora no se mide nada: el knapsack no tiene qué descartar.
      expect(sostiene, c.id).toBeGreaterThanOrEqual(1);
      expect(distractoras, c.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("las citas resuelven a unidades que existen en el caso", () => {
    for (const c of casos) {
      const ids = new Set(c.evidencia.map((u) => u.id));
      expect(c.citas.length, c.id).toBeGreaterThanOrEqual(1);
      for (const cita of c.citas) expect(ids.has(cita), `${c.id} cita ${cita}`).toBe(true);
    }
  });

  it("toda unidad NECESARIA está citada: si sin ella la respuesta es imposible, sostenerla es obligatorio", () => {
    for (const c of casos) {
      for (const u of c.evidencia.filter((x) => x.papel === "necesaria")) {
        expect(c.citas, `${c.id}: ${u.id} es necesaria y no está en citas`).toContain(u.id);
      }
    }
  });

  it("ninguna DISTRACTORA está citada: una distractora citada es un caso mal diseñado", () => {
    for (const c of casos) {
      for (const u of c.evidencia.filter((x) => x.papel === "distractora")) {
        expect(c.citas, `${c.id}: ${u.id} es distractora y aparece en citas`).not.toContain(u.id);
      }
    }
  });

  it("toda unidad CONTRADICTORIA se resuelve: o la deroga otra, o el caso declara desempate, o se abstiene", () => {
    for (const c of casos) {
      const contradictorias = c.evidencia.filter((u) => u.papel === "contradictoria");
      if (contradictorias.length === 0) continue;
      const resuelto =
        c.respuesta.tipo === "abstencion" ||
        typeof c.reglaDeDesempate === "string" ||
        contradictorias.every((u) => u.deroga || u.derogadaPor);
      expect(resuelto, `${c.id}: contradicción sin regla de desempate ni abstención`).toBe(true);

      // Las referencias de derogación apuntan a unidades reales del caso.
      const ids = new Set(c.evidencia.map((u) => u.id));
      for (const u of c.evidencia) {
        if (u.deroga) expect(ids.has(u.deroga), `${c.id}/${u.id} deroga ${u.deroga}`).toBe(true);
        if (u.derogadaPor)
          expect(ids.has(u.derogadaPor), `${c.id}/${u.id} derogadaPor ${u.derogadaPor}`).toBe(true);
      }
    }
  });
});

describe("corpus de soporte · respuesta comprobable por máquina", () => {
  it("los campos críticos existen en la respuesta estructurada", () => {
    for (const c of casos.filter((x) => x.respuesta.tipo === "estructurada")) {
      expect(c.camposCriticos.length, c.id).toBeGreaterThanOrEqual(1);
      for (const campo of c.camposCriticos) {
        expect(
          Object.prototype.hasOwnProperty.call(c.respuesta.campos, campo),
          `${c.id}: campo crítico «${campo}» ausente de la respuesta`,
        ).toBe(true);
      }
    }
  });

  it("ningún valor de respuesta es prosa libre que haya que juzgar a ojo", () => {
    for (const c of casos) {
      for (const [k, v] of Object.entries(c.respuesta.campos)) {
        const tipoOk = ["boolean", "number", "string"].includes(typeof v);
        expect(tipoOk, `${c.id}.${k}`).toBe(true);
        if (typeof v === "string") {
          // Un valor comprobable es un importe, una fecha, un id, un enum. No
          // una frase: si hay que leerla para saber si acierta, no es una verja.
          expect(v.trim().split(/\s+/).length, `${c.id}.${k} = «${v}» parece prosa`).toBeLessThanOrEqual(4);
        }
      }
    }
  });

  it("abstención y respuesta estructurada son mutuamente excluyentes y están motivadas", () => {
    for (const c of casos) {
      if (c.respuesta.tipo === "abstencion") {
        expect(c.abstencion, `${c.id} se abstiene sin motivo`).not.toBeNull();
        expect(c.abstencion!.motivo.length, c.id).toBeGreaterThan(0);
        expect(c.abstencion!.explicacion.length, c.id).toBeGreaterThan(20);
        expect(Object.keys(c.respuesta.campos), c.id).toHaveLength(0);
        expect(c.camposCriticos, c.id).toHaveLength(0);
      } else {
        expect(c.abstencion, `${c.id} no se abstiene pero trae motivo`).toBeNull();
        expect(Object.keys(c.respuesta.campos).length, c.id).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("hay abstenciones de los dos tipos y en las dos lenguas", () => {
    const abst = casos.filter((c) => c.respuesta.tipo === "abstencion");
    expect(abst.length).toBeGreaterThanOrEqual(3);
    const motivos = new Set(abst.map((c) => c.abstencion!.motivo));
    // Que falte un dato y que la evidencia se contradiga son fallos distintos y
    // exigen respuestas distintas del sistema (pedir el dato / escalar).
    expect(motivos.has("evidencia-insuficiente")).toBe(true);
    expect(motivos.has("evidencia-contradictoria-sin-regla-de-desempate")).toBe(true);
    expect(new Set(abst.map((c) => c.idioma)).size).toBe(2);
  });
});

describe("corpus de soporte · trampas", () => {
  it("todo caso difícil declara al menos una trampa y explica el porqué en `nota`", () => {
    for (const c of casos.filter((x) => x.dificultad === "dificil")) {
      expect(c.trampas.length, `${c.id} difícil sin trampa declarada`).toBeGreaterThanOrEqual(1);
      expect((c.nota ?? "").length, `${c.id} difícil sin nota`).toBeGreaterThan(40);
    }
  });

  it("cubre el catálogo de trampas que el plan declara no eliminables", () => {
    const vistas = new Set(casos.flatMap((c) => c.trampas));
    for (const t of [
      "negacion",
      "excepcion",
      "condicion",
      "importes-parecidos",
      "fechas-parecidas",
      "referencia-cruzada",
      "verbo-modal",
      "identificador-casi-igual",
      "derogacion",
      "unidades",
      "abstencion",
    ]) {
      expect(vistas, `falta la trampa ${t}`).toContain(t);
    }
  });

  it("la negación es la trampa reina del dominio y la versión derogada la segunda", () => {
    const con = (t: string) => casos.filter((c) => c.trampas.includes(t)).length;
    expect(con("negacion")).toBeGreaterThanOrEqual(8);
    expect(con("derogacion") + con("version-desactualizada")).toBeGreaterThanOrEqual(4);
  });
});

describe("corpus de soporte · pares casi idénticos con respuesta distinta", () => {
  const conGemelo = casos.filter((c) => c.gemelo);

  it("hay al menos 6 pares y el vínculo es mutuo", () => {
    expect(conGemelo.length).toBeGreaterThanOrEqual(12);
    for (const c of conGemelo) {
      const otro = porId.get(c.gemelo!.caso);
      expect(otro, `${c.id} apunta a un gemelo inexistente`).toBeDefined();
      expect(otro!.gemelo?.caso, `${c.id} y ${otro!.id} no se apuntan mutuamente`).toBe(c.id);
      expect(otro!.idioma, `${c.id}: los gemelos deben compartir idioma`).toBe(c.idioma);
    }
  });

  it("los gemelos DIFIEREN en la respuesta: un par con la misma respuesta no prueba nada", () => {
    for (const c of conGemelo) {
      const otro = porId.get(c.gemelo!.caso)!;
      expect(
        JSON.stringify(c.respuesta.campos),
        `${c.id} y ${otro.id} tienen la misma respuesta: el par no distingue nada`,
      ).not.toBe(JSON.stringify(otro.respuesta.campos));
    }
  });

  it("los gemelos difieren además en qué evidencia los sostiene", () => {
    for (const c of conGemelo) {
      const otro = porId.get(c.gemelo!.caso)!;
      expect(
        c.citas.join(","),
        `${c.id} y ${otro.id} se sostienen en la misma evidencia`,
      ).not.toBe(otro.citas.join(","));
    }
  });

  /**
   * La verja que convierte el corpus en un detector vivo.
   *
   * Cada par declara `colisionaEnCache`, es decir: si HOY las dos consultas
   * —que tienen respuesta DISTINTA— sobreviven juntas al guardarraíl
   * determinista de `keyTokensMatch`. Cuando colisionan, la caché semántica
   * puede servir la respuesta de una a la otra.
   *
   * Si este test falla, no es que el corpus esté roto: es que alguien ha tocado
   * la normalización o el guardarraíl y el par ha cambiado de lado. Ese es
   * justo el aviso que se quiere. Actualizar el campo es la reacción correcta,
   * después de mirar cuál de los dos lados cambió.
   */
  it("declara con exactitud qué pares atraviesan hoy el guardarraíl determinista", () => {
    for (const c of conGemelo) {
      const otro = porId.get(c.gemelo!.caso)!;
      const colisionaReal = keyTokensMatch(normalizeText(c.consulta), normalizeText(otro.consulta));
      expect(
        colisionaReal,
        `${c.id} ↔ ${otro.id}: el corpus declara colisionaEnCache=${c.gemelo!.colisionaEnCache} ` +
          `y keyTokensMatch dice ${colisionaReal}. Si el guardarraíl ha mejorado, actualiza el campo.`,
      ).toBe(c.gemelo!.colisionaEnCache);
    }
  });

  it("al menos un par colisionante invierte un booleano, no solo una cifra", () => {
    const inversiones = conGemelo.filter((c) => {
      if (!c.gemelo!.colisionaEnCache) return false;
      const otro = porId.get(c.gemelo!.caso)!;
      return Object.entries(c.respuesta.campos).some(
        ([k, v]) => typeof v === "boolean" && typeof otro.respuesta.campos[k] === "boolean" && otro.respuesta.campos[k] !== v,
      );
    });
    expect(inversiones.length, "ningún par colisionante invierte un sí/no").toBeGreaterThanOrEqual(1);
  });
});

describe("corpus de soporte · catalán de verdad", () => {
  const ca = casos.filter((c) => c.idioma === "ca");
  const textoDe = (c: Caso) => [c.consulta, ...c.evidencia.map((u) => u.texto)].join(" ");

  it("ejercita la ela geminada, el apóstrofo y los acentos abierto/cerrado", () => {
    const todo = ca.map(textoDe).join(" ");
    // Ela geminada: cancel·lació, instal·lació, anul·lació, sol·licitud.
    expect((todo.match(/·/g) ?? []).length, "ela geminada ausente").toBeGreaterThanOrEqual(8);
    // Apóstrofo: l'import, s'ha, d'aquest.
    expect((todo.match(/\w'\w/g) ?? []).length, "apóstrofos ausentes").toBeGreaterThanOrEqual(20);
    // Acento abierto (è/ò) y cerrado (é/ó) conviviendo.
    expect(/[èò]/.test(todo), "sin acentos abiertos").toBe(true);
    expect(/[éó]/.test(todo), "sin acentos cerrados").toBe(true);
  });

  it("la ela geminada y el apóstrofo se comportan como dice la nota del corpus", () => {
    // El punto volado entre letras es adorno y se pliega: quien escribe
    // «cancellació» acierta la misma clave que quien escribe «cancel·lació».
    expect(normalizeText("cancel·lació")).toBe(normalizeText("cancellació"));
    expect(normalizeText("instal·lació")).toBe(normalizeText("installació"));
    // El apóstrofo DENTRO de palabra es ortografía y se conserva: «l'import» y
    // «el import» son claves distintas. Es la asimetría es/ca que el README
    // documenta — el catalán no se beneficia del plegado tanto como el español.
    expect(normalizeText("l'import")).not.toBe(normalizeText("el import"));
    expect(normalizeText("l'import")).toContain("'");
  });

  it("el catalán cubre los mismos subdominios críticos que el castellano", () => {
    const subs = new Set(ca.map((c) => c.subdominio));
    // Devoluciones, garantía, transporte, zonas, reembolsos, cambios y
    // cancelaciones: si el catalán solo tuviera casos fáciles de un subdominio,
    // «sin degradación por idioma» no sería medible.
    expect(subs.size).toBeGreaterThanOrEqual(6);
  });
});

describe("corpus de soporte · honestidad", () => {
  it("se declara sintético en el propio fichero de datos", () => {
    // La limitación no puede vivir solo en el README: quien consuma el JSON
    // desde un script tiene que tropezarse con ella.
    expect(corpus.naturaleza).toBe("sintetico");
  });
});

/**
 * EL CARGADOR QUE VALIDA AL LEER. Fase F6 — knapsack de evidencia.
 *
 * ─── POR QUÉ EXISTE, SI YA HAY UN VALIDADOR ─────────────────────────────────
 *
 * `corpus/validar.ts` valida la forma de FACTURACIÓN. `test/corpus-contratos`
 * y `test/corpus-soporte` validan las suyas. Cada dominio se comprueba contra
 * el molde en el que fue escrito, y los tres pasan.
 *
 * Pero lo que puntúa a un selector no es ninguna de las tres formas: es la
 * PROYECCIÓN de las tres sobre `CasoVista` (`corpus/vista.ts`). Y esa
 * proyección no la comprobaba nadie. `cargarCorpusEntero()` lee tres JSON con
 * tres esquemas distintos, aplana campos, renombra papeles («derogada» pasa a
 * «distractora»), imputa presupuestos donde no los hay — y devuelve 150 objetos
 * sin haber mirado ni uno. Un fallo ahí no rompe nada al cargar: arbitra.
 *
 * Que no es hipotético lo demuestra lo que encontró este cargador el primer día
 * que corrió: `PRESUPUESTO_IMPUTADO()` en la vista dividía por 0,6 mientras
 * `auditoria/reparar.ts` había ESCRITO los presupuestos del fichero de soporte
 * con 0,5. Diez de los cuarenta casos de soporte se estaban puntuando contra un
 * presupuesto de 3 que el fichero de datos declaraba como 2. Ninguna de las 95
 * pruebas del corpus lo veía, porque ninguna comparaba las dos cifras: la del
 * dato y la de la proyección.
 *
 * ─── LO QUE COMPRUEBA, Y POR QUÉ CADA COSA ──────────────────────────────────
 *
 *   · IDS ÚNICOS EN TODO EL CORPUS, no solo dentro de cada fichero. Dos casos
 *     con el mismo id hacen que un informe por dominio cuente uno dos veces.
 *   · CITAS QUE APUNTAN A UNIDADES QUE EXISTEN. Una cita muerta no se puede
 *     conservar, así que un caso con una cita fantasma es un caso que suspende
 *     a cualquier selector, incluido el correcto.
 *   · TODA NECESARIA SE CITA. Una unidad marcada «necesaria» que ningún campo
 *     cita no es necesaria: es relleno que sube la presión del caso sin subir
 *     su dificultad, y desplaza el ahorro medido hacia arriba.
 *   · CAMPOS CRÍTICOS PRESENTES EN LA RESPUESTA. Un nombre declarado crítico
 *     que no está entre los campos de la respuesta desaparece sin ruido al
 *     proyectar, y con él desaparece del denominador de la cobertura: el
 *     corpus mide 100 % de conservación de los campos que se acordó de tener.
 *   · ABSTENCIONES BIEN FORMADAS. Abstenerse sin poder enseñar por qué no es
 *     abstenerse, es callarse: hace falta al menos una cita. Y una
 *     contradicción necesita DOS lados; con uno solo el caso tiene respuesta.
 *   · HAY PRESIÓN Y HAY SOLUCIÓN: `necesarias ≤ presupuesto < total`. Por
 *     debajo el caso es irresoluble y no mide nada; por encima caben todas y
 *     tampoco.
 *   · FIDELIDAD DE LA PROYECCIÓN: lo que la vista dice de un caso tiene que ser
 *     lo que el fichero de datos declara. Es la comprobación que encontró el
 *     presupuesto fantasma y la única que puede encontrar el siguiente.
 *
 * ─── CÓMO FALLA ─────────────────────────────────────────────────────────────
 *
 * Ruidosamente y de una vez: `CorpusCorrupto` con TODOS los problemas, no con
 * el primero. Un corpus se arregla de una pasada; parar en el primer error
 * obliga a diez ciclos para diez erratas y garantiza que alguien acabe
 * silenciando la comprobación.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cargarCorpusEntero, type CasoVista } from "../vista.js";

/** El caso tal y como lo ve el arnés: la vista única, ya validada. */
export type CasoDelArnes = CasoVista;

/** Un corpus que no se puede usar para arbitrar nada. */
export class CorpusCorrupto extends Error {
  readonly problemas: readonly string[];

  constructor(problemas: readonly string[]) {
    const muestra = problemas.slice(0, 12).map((p) => `  · ${p}`).join("\n");
    const resto = problemas.length > 12 ? `\n  … y ${problemas.length - 12} más` : "";
    super(
      `el corpus tiene ${problemas.length} problema(s) y no puede arbitrar nada:\n${muestra}${resto}`,
    );
    this.name = "CorpusCorrupto";
    this.problemas = problemas;
  }
}

// ─── Lo que el fichero de datos DECLARA ──────────────────────────────────────
//
// Se lee del JSON crudo, no de la vista. Todo el valor de esta parte está en
// que las dos lecturas sean independientes: comparar la vista consigo misma no
// puede descubrir que la vista se equivoca.

export interface Declaracion {
  id: string;
  /** El presupuesto ESCRITO en el fichero. `undefined` si el caso no lo trae. */
  presupuesto?: number;
  unidades: string[];
  necesarias: string[];
  citas: string[];
  /** Nombres de campo declarados críticos. */
  criticos: string[];
  /** Nombres de campo que la respuesta trae de verdad. */
  camposDeLaRespuesta: string[];
  abstencion: boolean;
}

type Json = Record<string, unknown>;

const leer = (ruta: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8"));

const comoLista = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

function declaracionesDeFacturacion(): Declaracion[] {
  const ficheros = [
    "../facturacion-y-cobros/casos-es.json",
    "../facturacion-y-cobros/casos-ca.json",
  ];
  return ficheros.flatMap((ruta) => {
    const casos = ((leer(ruta) as Json)["casos"] ?? []) as Json[];
    return casos.map((c): Declaracion => {
      const evidencia = comoLista(c["evidencia"]) as unknown as Json[];
      const r = (c["respuesta"] ?? {}) as Json;
      const abstencion = r["tipo"] === "abstencion";
      const campos = (comoLista(r["campos"]) as unknown as Json[]) ?? [];
      const criticos = campos.filter((x) => x["critico"] === true);
      return {
        id: String(c["id"]),
        presupuesto: ((c["presupuesto"] ?? {}) as Json)["unidades_max"] as number | undefined,
        unidades: evidencia.map((u) => String(u["id"])),
        necesarias: evidencia.filter((u) => u["papel"] === "necesaria").map((u) => String(u["id"])),
        // Las citas obligatorias de facturación cuelgan de cada campo crítico;
        // al abstenerse, de la propia abstención.
        citas: abstencion
          ? [...new Set(comoLista(r["citas"]))]
          : [...new Set(criticos.flatMap((x) => comoLista(x["citas"])))],
        criticos: criticos.map((x) => String(x["nombre"])),
        camposDeLaRespuesta: abstencion ? [] : campos.map((x) => String(x["nombre"])),
        abstencion,
      };
    });
  });
}

function declaracionesDeContratos(): Declaracion[] {
  const ficheros = [
    "../knapsack-evidencia/contratos/contratos.es.json",
    "../knapsack-evidencia/contratos/contratos.ca.json",
  ];
  return ficheros.flatMap((ruta) => {
    const casos = leer(ruta) as Json[];
    return casos.map((c): Declaracion => {
      const unidades = comoLista(c["unidades"]) as unknown as Json[];
      const r = (c["respuesta"] ?? {}) as Json;
      const campos = (r["campos"] ?? {}) as Json;
      return {
        id: String(c["id"]),
        presupuesto: ((c["presupuesto"] ?? {}) as Json)["maxUnidades"] as number | undefined,
        unidades: unidades.map((u) => String(u["id"])),
        necesarias: unidades.filter((u) => u["papel"] === "necesaria").map((u) => String(u["id"])),
        citas: comoLista(c["citasObligatorias"]),
        criticos: comoLista(c["camposCriticos"]),
        camposDeLaRespuesta: Object.keys(campos),
        abstencion: r["abstenerse"] === true,
      };
    });
  });
}

function declaracionesDeSoporte(): Declaracion[] {
  const casos = ((leer("../../benchmarks/corpus/soporte/casos.json") as Json)["casos"] ??
    []) as Json[];
  return casos.map((c): Declaracion => {
    const evidencia = comoLista(c["evidencia"]) as unknown as Json[];
    const r = (c["respuesta"] ?? {}) as Json;
    const campos = (r["campos"] ?? {}) as Json;
    return {
      id: String(c["id"]),
      presupuesto: ((c["presupuesto"] ?? {}) as Json)["unidades_max"] as number | undefined,
      unidades: evidencia.map((u) => String(u["id"])),
      necesarias: evidencia.filter((u) => u["papel"] === "necesaria").map((u) => String(u["id"])),
      citas: comoLista(c["citas"]),
      criticos: comoLista(c["camposCriticos"]),
      camposDeLaRespuesta: Object.keys(campos),
      abstencion: r["tipo"] === "abstencion",
    };
  });
}

/** Lo que los tres ficheros de datos declaran, indexado por id de caso. */
export function declaraciones(): Map<string, Declaracion> {
  const todas = [
    ...declaracionesDeFacturacion(),
    ...declaracionesDeContratos(),
    ...declaracionesDeSoporte(),
  ];
  return new Map(todas.map((d) => [d.id, d]));
}

// ─── Las comprobaciones ──────────────────────────────────────────────────────

/**
 * Campos declarados críticos cuyo valor se aplana a cadena vacía al proyectar.
 * `ct-es-016.limite_prorrogas` vale `null` a propósito —«no hay límite de
 * prórrogas»— y `valorATexto(null)` devuelve `""`, indistinguible de un campo
 * que se perdió. Es una pérdida de la proyección, no un defecto del caso, y va
 * en lista CERRADA para que la próxima no se cuele detrás de esta.
 */
export const VALOR_VACIO_ACEPTADO: readonly string[] = ["ct-es-016:limite_prorrogas"];

const IGUALES = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

/**
 * Todos los problemas del corpus, en una lista. Vacía = se puede arbitrar.
 *
 * Función pura: recibe la vista y las declaraciones, no toca el disco. Se puede
 * llamar desde un test con un corpus inventado, que es como se comprueba que un
 * validador valida — un validador que solo se ha probado contra datos correctos
 * es un validador que nadie ha probado.
 */
export function problemasDelCorpus(
  casos: readonly CasoDelArnes[],
  decls: ReadonlyMap<string, Declaracion>,
): string[] {
  const problemas: string[] = [];
  const di = (caso: string, m: string) => problemas.push(`${caso}: ${m}`);

  if (casos.length === 0) problemas.push("corpus vacío: no hay nada que cargar");

  const vistos = new Set<string>();
  for (const c of casos) {
    if (vistos.has(c.id)) di(c.id, "id repetido en el corpus entero, no solo en su fichero");
    vistos.add(c.id);

    // ── Unidades ────────────────────────────────────────────────────────────
    const ids = new Set<string>();
    for (const u of c.unidades) {
      if (ids.has(u.id)) di(c.id, `unidad repetida "${u.id}"`);
      ids.add(u.id);
      if (u.texto.trim().length < 20) di(c.id, `unidad ${u.id}: texto de adorno`);
    }
    if (c.unidades.length < 3) di(c.id, "menos de tres unidades: no hay nada que seleccionar");
    if (!c.unidades.some((u) => u.papel === "distractora")) {
      di(c.id, "ninguna unidad prescindible: el caso no prueba que se tire lo correcto");
    }

    // ── Citas ───────────────────────────────────────────────────────────────
    if (c.citas.length === 0) di(c.id, "sin citas obligatorias: no hay nada que conservar");
    for (const cita of c.citas) {
      if (!ids.has(cita)) di(c.id, `cita "${cita}" no existe entre las unidades`);
    }
    if (new Set(c.citas).size !== c.citas.length) di(c.id, "citas repetidas");
    for (const n of c.necesarias) {
      if (!c.citas.includes(n)) {
        di(c.id, `unidad ${n} se declara necesaria y no la cita nadie: es relleno`);
      }
    }

    // ── Campos críticos ─────────────────────────────────────────────────────
    const criticos = c.valores.filter((v) => v.critico);
    if (!c.abstencion && criticos.length === 0) {
      di(c.id, "ningún campo crítico: no hay nada que el knapsack pueda romper");
    }
    for (const v of criticos) {
      if (v.valor.trim() === "" && !VALOR_VACIO_ACEPTADO.includes(`${c.id}:${v.campo}`)) {
        di(c.id, `campo crítico "${v.campo}" sin valor tras proyectar`);
      }
    }

    // ── Citas por campo, cuando el corpus las escribe por campo ─────────────
    if (c.citasPorCampo) {
      for (const [campo, citas] of Object.entries(c.citasPorCampo)) {
        if (citas.length === 0) di(c.id, `campo "${campo}" sin citas`);
        for (const cita of citas) {
          if (!ids.has(cita)) di(c.id, `campo "${campo}": cita "${cita}" no existe`);
        }
      }
      const union = new Set(
        criticos.flatMap((v) => c.citasPorCampo?.[v.campo] ?? []),
      );
      const esperadas = c.abstencion ? new Set(c.citasPorCampo["abstencion"] ?? []) : union;
      if (!IGUALES([...esperadas], c.citas)) {
        di(
          c.id,
          `las citas por campo (${[...esperadas].sort().join(",")}) no suman las citas obligatorias (${[...c.citas].sort().join(",")})`,
        );
      }
    }

    // ── Contradicciones y abstenciones ──────────────────────────────────────
    //
    // Una contradicción necesita dos lados, pero los dos lados NO llevan
    // siempre la misma etiqueta. Cuando hay regla de desempate, el lado que
    // gana se marca `necesaria` (es la cláusula que manda) y el que pierde,
    // `contradictoria`: `ct-es-010` enfrenta 85,00 EUR/hora (necesaria, más la
    // cláusula de prevalencia) contra 92,00 EUR/hora (contradictoria), y
    // `sop-es-012` la garantía v4 vigente contra la v3 derogada. Ahí una sola
    // `contradictoria` es correcta. Los dos lados solo llevan la MISMA etiqueta
    // cuando no hay nada que los ordene — y entonces la respuesta es abstenerse.
    const contradictorias = c.unidades.filter((u) => u.papel === "contradictoria");
    if (contradictorias.length > 0 && c.necesarias.length === 0 && contradictorias.length < 2) {
      di(c.id, "una unidad contradictoria y nada a lo que contradecir");
    }
    if (c.abstencion) {
      if (c.citas.length === 0) {
        di(c.id, "abstención sin citas: abstenerse sin poder enseñar por qué es callarse");
      }
      if (contradictorias.length === 1) {
        di(
          c.id,
          "abstención por contradicción con un solo lado: sin el otro, el caso tiene respuesta",
        );
      }
      // Una contradictoria que nadie cita se puede tirar sin que salte ninguna
      // otra comprobación, y al tirarla la abstención deja de estar justificada
      // en silencio. Es el agujero por el que se cuela el fallo caro.
      for (const u of contradictorias) {
        if (!c.citas.includes(u.id)) {
          di(c.id, `unidad contradictoria ${u.id} sin citar en un caso de abstención`);
        }
      }
    }

    // ── Presión ─────────────────────────────────────────────────────────────
    if (!Number.isInteger(c.presupuestoMax) || c.presupuestoMax < 1) {
      di(c.id, `presupuesto "${c.presupuestoMax}" no es un entero positivo`);
    } else {
      if (c.presupuestoMax >= c.unidades.length) {
        di(
          c.id,
          `presupuesto ${c.presupuestoMax} sobre ${c.unidades.length} unidades: caben todas y no hay knapsack`,
        );
      }
      const obligatorias = new Set([...c.necesarias, ...c.citas]);
      if (obligatorias.size > c.presupuestoMax) {
        di(
          c.id,
          `${obligatorias.size} unidades obligatorias no caben en un presupuesto de ${c.presupuestoMax}: el caso es irresoluble`,
        );
      }
    }

    // ── Fidelidad de la proyección ──────────────────────────────────────────
    const d = decls.get(c.id);
    if (!d) {
      di(c.id, "la vista lo devuelve y ningún fichero de datos lo declara");
      continue;
    }
    if (d.presupuesto !== undefined && d.presupuesto !== c.presupuestoMax) {
      di(
        c.id,
        `el fichero declara un presupuesto de ${d.presupuesto} y la vista puntúa contra ${c.presupuestoMax}`,
      );
    }
    if (d.presupuesto === undefined && !c.presupuestoImputado) {
      di(c.id, "presupuesto no declarado y la vista no lo marca como imputado");
    }
    if (!IGUALES(d.unidades, c.unidades.map((u) => u.id))) {
      di(c.id, "la vista y el fichero no traen las mismas unidades");
    }
    if (!IGUALES(d.necesarias, c.necesarias)) {
      di(c.id, "la vista y el fichero no coinciden en qué unidades son necesarias");
    }
    if (!IGUALES(d.citas, c.citas)) {
      di(c.id, "la vista y el fichero no coinciden en las citas obligatorias");
    }
    if (d.abstencion !== c.abstencion) {
      di(c.id, "la vista y el fichero no coinciden en si el caso se abstiene");
    }
    for (const nombre of d.criticos) {
      if (!d.camposDeLaRespuesta.includes(nombre) && d.camposDeLaRespuesta.length > 0) {
        di(c.id, `campo "${nombre}" se declara crítico y la respuesta no lo trae`);
      }
      if (!criticos.some((v) => v.campo === nombre)) {
        di(c.id, `campo crítico "${nombre}" se pierde al proyectar`);
      }
    }
    if (criticos.length !== d.criticos.length && d.criticos.length > 0) {
      di(
        c.id,
        `el fichero declara ${d.criticos.length} campos críticos y la vista proyecta ${criticos.length}`,
      );
    }
  }

  // Un caso declarado que la vista no devuelve es un caso que nadie puntúa.
  for (const id of decls.keys()) {
    if (!vistos.has(id)) problemas.push(`${id}: el fichero lo declara y la vista no lo devuelve`);
  }

  return problemas;
}

/**
 * Los 150 casos, validados. Lanza `CorpusCorrupto` si algo no cuadra.
 *
 * La clase incómoda NO entra: rompe a propósito `necesarias ≤ presupuesto`, así
 * que aquí solo produciría ruido. Se carga con `cargarClaseIncomoda()` de la
 * vista y se lee aparte, que es para lo que existe.
 */
export function cargarCorpus(): CasoDelArnes[] {
  const casos = cargarCorpusEntero();
  const problemas = problemasDelCorpus(casos, declaraciones());
  if (problemas.length > 0) throw new CorpusCorrupto(problemas);
  return casos;
}

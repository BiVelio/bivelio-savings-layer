/**
 * LA VERJA DE LA AUDITORÍA. No comprueba que el corpus sea bueno: comprueba que
 * no se vuelva FÁCIL sin que nadie se entere.
 *
 * Un golden set se degrada solo. Cada vez que alguien añade un caso, mueve un
 * presupuesto o reescribe una distractora, el conjunto se acerca un poco más al
 * punto en el que un `slice` de nueve caracteres aprueba. Ese punto no avisa: la
 * tasa agregada SUBE, y subir parece bueno. Las cifras de aquí abajo son las
 * medidas el 2026-08-14 sobre los 150 casos de los tres dominios; los márgenes
 * son deliberadamente anchos, porque lo que se vigila es la dirección, no el
 * decimal.
 *
 * Si uno de estos tests falla porque el corpus ha mejorado, se sube el listón y
 * se escribe por qué. Lo que no se puede es bajarlo en silencio.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cargarClaseIncomoda, cargarCorpusEntero } from "../corpus/vista.js";
import {
  adivinabilidad,
  idiomas,
  lineasBase,
  nucleoDiscriminante,
  plausibilidad,
  presupuestos,
  sesgoDePosicion,
} from "../corpus/auditoria/auditar.js";
import { azarK, correr, evaluar, oraculo } from "../corpus/auditoria/lineas-base.js";
import { serializar, type Estilo } from "../corpus/auditoria/formato.js";
import { esEco, reparar } from "../corpus/auditoria/reparar.js";

const casos = cargarCorpusEntero();
const incomodos = cargarClaseIncomoda();
const tasa = (nombre: string): number =>
  lineasBase(casos).find((i) => i.nombre === nombre)?.tasa ?? -1;

describe("auditoría del corpus · la vista une los tres dominios", () => {
  it("carga los 150 casos de los tres corpus con una sola forma", () => {
    expect(casos).toHaveLength(150);
    const porOrigen: Record<string, number> = {};
    for (const c of casos) porOrigen[c.origen] = (porOrigen[c.origen] ?? 0) + 1;
    expect(porOrigen).toEqual({ facturacion: 60, contratos: 50, soporte: 40 });
  });

  it("todos los casos plantean de verdad un knapsack: necesarias ≤ k < total", () => {
    // Sin esto no hay nada que elegir. Los 40 de soporte no traían presupuesto
    // y por eso aprobaban a cualquier selector que no tirase nada.
    for (const c of casos) {
      expect(c.necesarias.length, c.id).toBeLessThanOrEqual(c.presupuestoMax);
      expect(c.presupuestoMax, c.id).toBeLessThan(c.unidades.length);
    }
    expect(presupuestos(casos).sinPresion).toEqual([]);
  });

  it("las citas obligatorias apuntan a unidades que existen", () => {
    for (const c of casos) {
      const ids = new Set(c.unidades.map((u) => u.id));
      for (const cita of c.citas) expect(ids.has(cita), `${c.id} → ${cita}`).toBe(true);
    }
  });
});

describe("auditoría del corpus · las líneas base tontas", () => {
  it("mandarlo todo conserva la evidencia, se sale del presupuesto y no ahorra nada", () => {
    const inf = lineasBase(casos).find((i) => i.nombre === "mandarlo-todo")!;
    expect(inf.resueltos).toBe(0);
    expect(inf.fueraDePresupuesto).toBe(150);
    expect(inf.ahorroMedio).toBe(0);
  });

  it("el oráculo resuelve los 150: existe siempre una selección correcta", () => {
    const inf = correr("oraculo", casos, oraculo);
    expect(inf.resueltos).toBe(150);
    expect(inf.ahorroMedio).toBeGreaterThan(0.5);
  });

  it("la posición no lleva señal: coger las k primeras empata con el azar", () => {
    // El corpus original tenía sesgo en los dos sentidos: en contratos y soporte
    // las necesarias iban las primeras (74 % y 92,5 % para un `slice`), y en
    // facturación la permutación estaba elegida para que ese mismo `slice`
    // fallara los 60 — que es afinar contra una línea base, no quitarle
    // información a la posición. Ahora se baraja uniforme y lo que se exige es
    // el empate con el azar.
    const azar = azarK(casos);
    expect(Math.abs(tasa("primeros-k") - azar)).toBeLessThan(0.1);
    expect(Math.abs(tasa("ultimos-k") - azar)).toBeLessThan(0.1);
    const s = sesgoDePosicion(casos);
    expect(Math.abs(s.posicionMediaNecesarias - s.posicionMediaPrescindibles)).toBeLessThan(0.1);
  });

  it("ninguna línea base tonta pasa del 75 %, y la mejor es el solape léxico", () => {
    // 71,3 % el 2026-08-14. Es la cifra incómoda del informe: un BM25 de una
    // línea —lo que ya hace el recuperador que produjo estas unidades— resuelve
    // siete de cada diez casos. Un knapsack que no le saque una diferencia clara
    // no es una palanca de ahorro, es una segunda pasada del mismo ranking.
    for (const inf of lineasBase(casos)) {
      if (inf.nombre === "oraculo") continue;
      expect(inf.tasa, inf.nombre).toBeLessThan(0.75);
    }
    expect(tasa("solape-lexico-k")).toBeGreaterThan(tasa("primeros-k"));
  });

  it("el núcleo discriminante no encoge: al menos 17 casos que ninguna tonta resuelve", () => {
    // 17 de 150 el 2026-08-14 — el 11,3 %. Las otras 133 las regala alguna de
    // las cuatro. Es el número que hay que enseñar antes de gatear F6 con esto,
    // y el que un caso nuevo debería subir.
    const n = nucleoDiscriminante(casos);
    expect(n.nucleo.length).toBeGreaterThanOrEqual(17);
    expect(n.porIdioma["ca"] ?? 0).toBeGreaterThanOrEqual(5);
  });
});

describe("auditoría del corpus · adivinar la respuesta sin la evidencia", () => {
  const a = adivinabilidad(casos);

  it("casi ningún campo crítico se puede copiar de la propia consulta", () => {
    // Un campo cuyo valor está literal en la pregunta («zona = Ceuta» cuando el
    // cliente escribe «a Ceuta») no demuestra haber leído nada. Los 18 que
    // había están degradados a no críticos; los 3 que quedan son casos donde el
    // valor coincide con una palabra de la consulta por casualidad.
    expect(a.enLaConsulta.length).toBeLessThanOrEqual(4);
  });

  it("ningún campo crítico es una constante que el modelo sepa de memoria", () => {
    // Las que había: el IVA general al 21 % (ct-es-011, ct-ca-015), los 3 años
    // de garantía legal (sop-es-012, sop-ca-010) y los 30 días de devolución
    // que anuncia medio comercio electrónico. En los tres casos lo que se sabe
    // de memoria era EXACTAMENTE la respuesta correcta, así que un modelo que
    // tirase el documento aprobaba. Arreglados: IPSI de Ceuta al 4 %, garantía
    // comercial de 5 años frente a la derogada de 3, ventana de 21 días.
    const restantes = a.sabidaDeMemoria.map((x) => `${x.id}:${x.campo}`);
    expect(restantes).toEqual(["ct-es-022:plazo_dias", "ct-ca-016:termini_dies", "ct-ca-019:termini_dies"]);
  });

  it("un valor crítico casi nunca se puede leer en una distractora", () => {
    // Que el valor esté en la contradictoria o en la derogada es la trampa. Que
    // esté en una DISTRACTORA es un defecto: tirar la necesaria sale gratis.
    const fugas = a.enUnaPrescindible.filter((x) => x.papel === "distractora");
    expect(fugas.map((x) => x.id).sort()).toEqual([
      "ct-ca-002",
      "ct-ca-007",
      "sop-es-004",
      "sop-es-005",
      "sop-es-005",
    ]);
  });

  it("ni «di siempre que sí» ni «no contestes nunca» sacan buena nota", () => {
    for (const p of Object.values(a.baseRateBooleanos)) expect(p).toBeLessThan(0.65);
    expect(a.tasaDeAbstencion).toBeGreaterThan(0.08);
    expect(a.tasaDeAbstencion).toBeLessThan(0.25);
  });
});

describe("auditoría del corpus · las distractoras distraen", () => {
  it("de media, la peor necesaria NO se parece a la consulta más que la mejor distractora", () => {
    const p = plausibilidad(casos);
    expect(p.margenMedio).toBeLessThanOrEqual(0);
    expect(p.casosDuros).toBeGreaterThan(p.casosRegalados);
  });
});

describe("auditoría del corpus · el catalán no es decorativo", () => {
  const i = idiomas(casos);

  it("el reparto es real y ningún idioma baja del 40 %", () => {
    expect((i.porIdioma["ca"] ?? 0) / casos.length).toBeGreaterThanOrEqual(0.4);
    expect((i.porIdioma["es"] ?? 0) / casos.length).toBeGreaterThanOrEqual(0.4);
  });

  it("la ela geminada y el diacrítico colisionan de verdad bajo `normalizeText`", () => {
    // Contra el código real, no contra una idea de él. Si algún día
    // `normalizeText` deja de plegar el punto volado o la tilde, esto falla y
    // avisa de que esos casos ya no prueban lo que dicen probar.
    expect(i.colisionesTrasNormalizar.length).toBeGreaterThanOrEqual(10);
    const tokens = i.colisionesTrasNormalizar.map((x) => x.token);
    expect(tokens).toContain("cella");
    expect(tokens).toContain("collegi");
    expect(tokens).toContain("prorroga");
    expect(tokens).toContain("mes");
  });

  it("el apóstrofo rompe tokens de la consulta, que es lo que hace de verdad", () => {
    // `normalizeText` BORRA el apóstrofo (está en su clase `PUNTUACION`), así
    // que «l'import» entra como `limport` y deja de casar con `import`. No
    // colisiona con nada: pega el artículo al sustantivo, y eso es lo que hay
    // que medir.
    expect(i.tokensRotosPorApostrofo.length).toBeGreaterThanOrEqual(5);
  });

  it("se sabe qué casos llevan la etiqueta de idioma sin llevar la trampa", () => {
    // Nueve casos declaran `diacritico`, `ela-geminada` o `numero-gramatical` y
    // no producen ninguna colisión: la distinción que dicen explotar sobrevive
    // intacta. Van en lista cerrada para que no crezcan sin que nadie lo note.
    expect(i.etiquetadosSinColision.sort()).toEqual([
      "ct-ca-008",
      "ct-ca-018",
      "fac-ca-002",
      "fac-ca-011",
      "fac-ca-014",
      "fac-ca-023",
      "fac-ca-028",
      "sop-ca-006",
      "sop-ca-016",
    ]);
  });
});

describe("auditoría del corpus · la clase incómoda", () => {
  it("son 12, viven aparte y no entran en ninguna tasa agregada", () => {
    expect(incomodos).toHaveLength(12);
    expect(casos.some((c) => c.id.startsWith("inc-"))).toBe(false);
  });

  it("dos son irresolubles a propósito: no existe selección correcta", () => {
    const irresolubles = incomodos.filter((c) => c.irresoluble);
    expect(irresolubles.map((c) => c.id)).toEqual(["inc-es-003", "inc-ca-003"]);
    // Y por eso rompen el invariante que los otros 150 sí cumplen.
    for (const c of irresolubles) expect(c.necesarias.length).toBeGreaterThan(c.presupuestoMax);
  });

  it("ninguna línea base tonta resuelve ni uno de los resolubles", () => {
    // Es la condición para que sirvan: un caso incómodo que un `slice` resuelva
    // no enseña un agujero, enseña una casualidad.
    const resolubles = incomodos.filter((c) => !c.irresoluble);
    for (const inf of lineasBase(resolubles)) {
      if (inf.nombre === "oraculo") continue;
      expect(inf.resueltos, inf.nombre).toBe(0);
    }
    expect(correr("oraculo", resolubles, oraculo).resueltos).toBe(resolubles.length);
  });

  it("cada caso dice por qué hoy no sabríamos resolverlo", () => {
    for (const c of incomodos) {
      expect(c.porQueNoSabemosResolverlo.length, c.id).toBeGreaterThan(200);
      expect(c.clase.length, c.id).toBeGreaterThan(0);
    }
    expect(new Set(incomodos.map((c) => c.clase)).size).toBe(6);
  });

  it("los pares es/ca son simétricos", () => {
    const porClase = new Map<string, string[]>();
    for (const c of incomodos) porClase.set(c.clase, [...(porClase.get(c.clase) ?? []), c.idioma]);
    for (const [clase, idiomasDeLaClase] of porClase) {
      expect(idiomasDeLaClase.sort(), clase).toEqual(["ca", "es"]);
    }
  });
});

describe("auditoría del corpus · las reparaciones son estables", () => {
  const ruta = (p: string) => fileURLToPath(new URL("../" + p, import.meta.url));
  const ficheros: Array<[string, Estilo]> = [
    ["corpus/facturacion-y-cobros/casos-es.json", "expandido"],
    ["corpus/facturacion-y-cobros/casos-ca.json", "expandido"],
    ["corpus/knapsack-evidencia/contratos/contratos.es.json", "compacto"],
    ["corpus/knapsack-evidencia/contratos/contratos.ca.json", "compacto"],
    ["benchmarks/corpus/soporte/casos.json", "compacto"],
  ];

  it("el serializador es idempotente: reescribir sin tocar nada no produce diff", () => {
    for (const [f, estilo] of ficheros) {
      const original = readFileSync(ruta(f), "utf8");
      expect(serializar(JSON.parse(original), estilo), f).toBe(original);
    }
  });

  it("volver a correr la reparación no cambia nada", () => {
    // Si barajar lo ya barajado diera otro orden, cada ejecución ensuciaría un
    // diff y el fichero de datos perdería su historia.
    expect(reparar(false)).toEqual([]);
  });

  it("`esEco` mira tokens, no subcadenas", () => {
    // Por subcadena, «ARR-2026-118» aparecería dentro de «ARR-2026-118-B» y la
    // trampa de los identificadores casi iguales quedaría marcada como defecto.
    expect(esEco("¿Qué ampara la orden ARR-2026-118-B?", "ARR-2026-118")).toBe(false);
    expect(esEco("¿Qué ampara la orden ARR-2026-118?", "ARR-2026-118")).toBe(true);
    expect(esEco("¿Cuál es el plazo para Ceuta?", true)).toBe(false);
  });
});

describe("auditoría del corpus · el evaluador no se puede engañar", () => {
  it("pasarse del presupuesto no cuenta como resuelto aunque conserve todo", () => {
    const c = casos[0]!;
    const r = evaluar(c, c.unidades.map((u) => u.id));
    expect(r.conservaNecesarias).toBe(true);
    expect(r.dentroDePresupuesto).toBe(false);
    expect(r.resuelto).toBe(false);
  });

  it("perder una sola cita obligatoria basta para suspender", () => {
    for (const c of casos.slice(0, 20)) {
      const sel = [...new Set([...c.necesarias, ...c.citas])].slice(1);
      if (sel.length === c.citas.length) continue;
      expect(evaluar(c, sel).resuelto).toBe(false);
    }
  });
});

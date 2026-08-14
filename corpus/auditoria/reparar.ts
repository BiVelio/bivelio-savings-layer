/**
 * LAS REPARACIONES MECÁNICAS DEL CORPUS. Tres, y cada una arregla un defecto
 * que la auditoría midió, no una sospecha:
 *
 *   1. REORDENAR. `primeros-k` —un `slice`, nueve caracteres— resolvía 74 de
 *      los 150 casos: 37/50 en contratos y 37/40 en soporte, porque las
 *      unidades necesarias tienden a ir escritas las primeras. Facturación
 *      estaba en el extremo opuesto y también equivocado: su permutación se
 *      había elegido para que `primeros-k` fallara los 60, que es afinar el
 *      corpus contra una línea base concreta en vez de quitarle la información.
 *      Aquí la posición se baraja de manera UNIFORME y determinista, sembrada
 *      con el id del caso, y lo que se pide después no es que `primeros-k`
 *      suspenda: es que empate con el azar. Eso es lo que significa que la
 *      posición no lleve señal.
 *
 *   2. PRESUPUESTO EN SOPORTE. Sus 40 casos no traían ninguno. Un caso sin
 *      presupuesto no plantea un knapsack: mandarlo todo es óptimo, gratis y
 *      correcto, así que esos 40 aprobaban a cualquier selector que no tirara
 *      nada. Se les escribe uno con la regla de abajo, y el fichero queda
 *      marcado con `presupuesto_imputado_por` para que nadie lo confunda con
 *      una decisión de quien escribió los casos.
 *
 *   3. CAMPOS ECO. 18 campos marcados como CRÍTICOS tienen por valor algo que
 *      ya está literalmente en la pregunta: `zona=Ceuta` cuando el cliente
 *      escribe «a Ceuta», `expediente=RMA 4471-A` cuando lo cita él mismo.
 *      Devolverlos no demuestra haber leído la evidencia, demuestra saber
 *      copiar. Dejan de ser críticos (siguen en la respuesta) y así la
 *      conservación de campos críticos vuelve a medir lo que dice medir.
 *
 * Ninguna toca el TEXTO de una unidad ni el valor de una respuesta: los
 * arreglos de contenido —los que hacen falta cuando la respuesta correcta se
 * puede adivinar de memoria— van a mano, caso a caso, y se listan en el README.
 *
 *   pnpm tsx corpus/auditoria/reparar.ts             (dice qué cambiaría)
 *   pnpm tsx corpus/auditoria/reparar.ts --escribir  (lo escribe)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { normalizeText } from "../../src/canonicalization/canonicalize.js";
import { serializar, type Estilo } from "./formato.js";

const SEMILLA = "f6-knapsack-2026-08-14";

/**
 * La fracción de unidades que caben, para los casos que no traen presupuesto.
 * Es la MEDIANA de `unidades_max / total` de los 110 casos que sí lo traen
 * (0,500), y no un número redondo elegido por gusto: con otra fracción los 40
 * casos imputados quedarían sistemáticamente más flojos o más duros que el
 * resto y el desglose por dominio mediría la imputación, no el dominio.
 */
const FRACCION = 0.5;

export function presupuestoImputado(total: number, necesarias: number): number {
  return Math.min(Math.max(necesarias, Math.ceil(total * FRACCION)), Math.max(1, total - 1));
}

// ─── 1. Reordenar ────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function generador(semilla: number): () => number {
  let s = semilla >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * Fisher-Yates uniforme sembrado con el id del caso: reproducible y sin sesgo.
 *
 * Baraja siempre desde el ORDEN CANÓNICO (unidades por id), nunca desde el
 * orden en que estén ahora. Sin eso la reparación no es idempotente —barajar lo
 * ya barajado da otra cosa— y correrla dos veces produce un diff cada vez, que
 * es la manera más fácil de que un fichero de datos deje de tener historia.
 */
export function barajar<T extends { id?: unknown }>(xs: T[], clave: string): T[] {
  const rnd = generador(fnv1a(SEMILLA + "|" + clave));
  const natural = (s: string): [string, number] => {
    const m = /^(\D*)(\d*)/.exec(s);
    return [m?.[1] ?? s, Number(m?.[2] ?? 0)];
  };
  const out = [...xs].sort((a, b) => {
    const [pa, na] = natural(String(a.id ?? ""));
    const [pb, nb] = natural(String(b.id ?? ""));
    return pa === pb ? na - nb : pa < pb ? -1 : 1;
  });
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

// ─── 3. Campos eco ───────────────────────────────────────────────────────────

/** Tokens de un texto, sin puntuación de cierre y ya normalizados. */
function tokensDe(texto: string): Set<string> {
  return new Set(
    normalizeText(texto)
      .split(/\s+/)
      .map((t) => t.replace(/^[("']+|[)"',.;:]+$/g, ""))
      .filter(Boolean),
  );
}

/**
 * ¿El valor está LITERAL en la consulta? Token a token, nunca por subcadena:
 * por subcadena, «ARR-2026-118» aparecería dentro de «ARR-2026-118-B» y la
 * trampa de los identificadores casi iguales quedaría marcada como defecto.
 */
export function esEco(consulta: string, valor: unknown): boolean {
  if (typeof valor === "boolean" || valor === null || valor === undefined) return false;
  const v = normalizeText(String(valor)).trim();
  if (v.length < 3) return false;
  const q = tokensDe(consulta);
  const partes = v.split(/\s+/).filter(Boolean);
  return partes.every((p) => q.has(p.replace(/^[("']+|[)"',.;:]+$/g, "")));
}

// ─── Aplicación ──────────────────────────────────────────────────────────────

interface Cambio {
  fichero: string;
  caso: string;
  que: string;
}

const raiz = (p: string): string => fileURLToPath(new URL("../../" + p, import.meta.url));

type Json = Record<string, unknown>;

function valorPlano(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Json;
    for (const k of ["cantidad", "iso", "valor"]) if (k in o) return o[k];
  }
  return v;
}

export function reparar(escribir: boolean): Cambio[] {
  const cambios: Cambio[] = [];

  const ficheros: Array<{ ruta: string; estilo: Estilo }> = [
    { ruta: "corpus/facturacion-y-cobros/casos-es.json", estilo: "expandido" },
    { ruta: "corpus/facturacion-y-cobros/casos-ca.json", estilo: "expandido" },
    { ruta: "corpus/knapsack-evidencia/contratos/contratos.es.json", estilo: "compacto" },
    { ruta: "corpus/knapsack-evidencia/contratos/contratos.ca.json", estilo: "compacto" },
    { ruta: "benchmarks/corpus/soporte/casos.json", estilo: "compacto" },
  ];

  for (const { ruta, estilo } of ficheros) {
    const bruto = JSON.parse(readFileSync(raiz(ruta), "utf8")) as Json | Json[];
    const casos = (Array.isArray(bruto) ? bruto : (bruto["casos"] as Json[])) ?? [];

    for (const caso of casos) {
      const id = String(caso["id"]);
      const clave = caso["evidencia"] ? "evidencia" : "unidades";
      const unidades = caso[clave] as Json[];

      // 1. Reordenar.
      const antes = unidades.map((u) => String(u["id"])).join(",");
      const despues = barajar(unidades, id);
      if (despues.map((u) => String(u["id"])).join(",") !== antes) {
        caso[clave] = despues;
        cambios.push({ fichero: ruta, caso: id, que: "orden de la evidencia barajado" });
      }

      // 2. Presupuesto donde no lo hay.
      if (!caso["presupuesto"]) {
        const necesarias = (caso[clave] as Json[]).filter((u) => u["papel"] === "necesaria").length;
        const max = presupuestoImputado((caso[clave] as Json[]).length, necesarias);
        caso["presupuesto"] = { unidades_max: max };
        cambios.push({ fichero: ruta, caso: id, que: `presupuesto imputado: ${max}` });
      }

      // 3. Campos eco.
      const consulta = String(caso["consulta"]);
      const respuesta = caso["respuesta"] as Json | undefined;
      if (Array.isArray(caso["camposCriticos"])) {
        const campos = (respuesta?.["campos"] ?? {}) as Json;
        const criticos = caso["camposCriticos"] as string[];
        const eco = criticos.filter((n) => esEco(consulta, valorPlano(campos[n])));
        const quedan = criticos.filter((n) => !eco.includes(n));
        if (eco.length > 0 && quedan.length > 0) {
          caso["camposCriticos"] = quedan;
          caso["camposEco"] = eco;
          cambios.push({ fichero: ruta, caso: id, que: `campos eco degradados: ${eco.join(", ")}` });
        }
      } else if (respuesta && Array.isArray(respuesta["campos"])) {
        const campos = respuesta["campos"] as Json[];
        const eco = campos.filter((c) => c["critico"] && esEco(consulta, valorPlano(c["valor"])));
        const quedan = campos.filter((c) => c["critico"] && !eco.includes(c));
        if (eco.length > 0 && quedan.length > 0) {
          for (const c of eco) c["critico"] = false;
          cambios.push({
            fichero: ruta,
            caso: id,
            que: `campos eco degradados: ${eco.map((c) => String(c["nombre"])).join(", ")}`,
          });
        }
      }
    }

    if (!Array.isArray(bruto) && cambios.some((c) => c.fichero === ruta && c.que.startsWith("presupuesto"))) {
      bruto["presupuesto_imputado_por"] =
        "corpus/auditoria/reparar.ts — los casos no traían presupuesto y sin él no plantean un knapsack";
    }

    if (escribir) writeFileSync(raiz(ruta), serializar(bruto, estilo), "utf8");
  }

  return cambios;
}

if (process.argv[1]?.endsWith("reparar.ts")) {
  const escribir = process.argv.includes("--escribir");
  const cambios = reparar(escribir);
  const porTipo: Record<string, number> = {};
  for (const c of cambios) {
    const t = c.que.split(":")[0] as string;
    porTipo[t] = (porTipo[t] ?? 0) + 1;
  }
  console.log(escribir ? "ESCRITO" : "SIMULACIÓN (usa --escribir)");
  console.log(porTipo);
  for (const c of cambios.filter((x) => !x.que.startsWith("orden"))) {
    console.log(`  ${c.caso.padEnd(12)} ${c.que}`);
  }
}

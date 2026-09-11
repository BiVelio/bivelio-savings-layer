/**
 * QUÉ LE LLEGA AL MODELO — por cada terminal abierto, lo que de verdad sale por
 * el cable, y lo que la capa intermedia habría cambiado.
 *
 * POR QUÉ EXISTE. Una capa que reescribe peticiones y no se puede auditar es un
 * acto de fe. Esto la vuelve mirable: una línea por petición, con la sesión, el
 * cliente, el modelo, el tamaño del cuerpo, cuántas herramientas se declararon y
 * el informe exacto de la transformación. Y sirve para lo que pidió el dueño el
 * 2026-09-11: «dime para cada uno de los chats/terminales abiertos exactamente
 * qué te llega».
 *
 * POR QUÉ EN SOMBRA, Y POR QUÉ ESO ES EL DATO BUENO. El espía NO guarda el
 * cuerpo de la petición —solo `requestShape`, un resumen de estructura— así que
 * la transformación no se puede medir sobre la captura a posteriori. Aquí sí: el
 * gateway tiene el cuerpo real en la mano, calcula lo que HABRÍA enviado, lo
 * anota y manda el original. Cuerpos reales, números reales, riesgo cero y coste
 * cero. Es la única forma honesta de saber si la palanca vale algo ANTES de
 * encenderla.
 *
 * ⚠️ LO QUE ESTE REGISTRO NO RESPONDE, y hay que decirlo antes de que alguien
 * lea un porcentaje de menos bytes y lo confunda con dinero: **recortar bytes que
 * iban a leerse de caché no ahorra casi nada** —0,1× en dólares, ~0 en cupo de
 * suscripción (medido: una ventana absorbió 18,9 M de tokens leídos sin mover el
 * contador)—. Por eso cada línea separa los bytes del PREFIJO de los bytes del
 * TURNO. La cifra que puede valer dinero es la segunda.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { InformeDeCapa } from "./caveman.js";

export interface LineaQueLlega {
  at: string;
  /** Sesión del cliente, cuando la manda (Claude Code la manda; otros, no). */
  sesion?: string;
  /** Puerto del cliente: distingue terminales abiertos aunque compartan sesión. */
  cliente?: number;
  /** Qué cliente/agente es, si se pudo identificar por la cabecera. */
  agente?: string;
  modelo?: string;
  forma: InformeDeCapa["forma"];
  /** Tamaño del cuerpo tal y como llegó del cliente. */
  bytes: number;
  /** Herramientas declaradas en la petición. */
  herramientas?: number;
  /** Bytes que viven en el PREFIJO (system + tools): casi siempre van a caché. */
  bytesPrefijo?: number;
  /** Bytes del TURNO en curso: lo único que se escribe nuevo. */
  bytesTurno?: number;
  /** Lo que la capa cambió (o habría cambiado, en sombra). */
  informe: InformeDeCapa;
  /** `true` si se calculó sin enviarlo. */
  sombra: boolean;
}

const RUTA_DEFECTO = `${process.env.HOME ?? "."}/.bvsala-f0/que-llega.jsonl`;

/**
 * Anota una línea. Nunca lanza: si el disco falla, la petición del usuario no se
 * entera — un instrumento de medida jamás puede tumbar el camino caliente.
 */
export function anotarQueLlega(linea: LineaQueLlega, ruta = RUTA_DEFECTO): void {
  try {
    const dir = dirname(ruta);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(ruta, `${JSON.stringify(linea)}\n`);
  } catch {
    /* el instrumento calla, el tráfico sigue */
  }
}

/** Separa el cuerpo en prefijo (system + tools) y turno (el resto). */
export function partirCuerpo(cuerpo: string): { bytesPrefijo: number; bytesTurno: number; herramientas?: number; modelo?: string } {
  try {
    const j = JSON.parse(cuerpo) as Record<string, unknown>;
    const prefijo = JSON.stringify({ system: j.system ?? null, tools: j.tools ?? null }).length;
    return {
      bytesPrefijo: prefijo,
      bytesTurno: Math.max(0, cuerpo.length - prefijo),
      ...(Array.isArray(j.tools) ? { herramientas: j.tools.length } : {}),
      ...(typeof j.model === "string" ? { modelo: j.model } : {}),
    };
  } catch {
    return { bytesPrefijo: 0, bytesTurno: cuerpo.length };
  }
}

export interface ResumenPorTerminal {
  clave: string;
  sesion?: string;
  cliente?: number;
  agente?: string;
  modelos: string[];
  peticiones: number;
  bytes: number;
  bytesPrefijo: number;
  bytesTurno: number;
  herramientasMediana: number;
  /** Bytes que la capa recortaría, separados por dónde viven. */
  recorteEnPrefijo: number;
  recorteEnTurno: number;
  porTransformacion: Record<string, { veces: number; recorte: number }>;
  formas: string[];
  sombra: boolean;
}

const mediana = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Agrupa las líneas por TERMINAL (sesión + puerto del cliente). */
export function resumirPorTerminal(lineas: LineaQueLlega[]): ResumenPorTerminal[] {
  const grupos = new Map<string, LineaQueLlega[]>();
  for (const l of lineas) {
    const clave = `${l.sesion ?? "sin-sesion"}#${l.cliente ?? 0}`;
    const g = grupos.get(clave);
    if (g) g.push(l);
    else grupos.set(clave, [l]);
  }
  return [...grupos.entries()].map(([clave, g]) => {
    const porTransformacion: Record<string, { veces: number; recorte: number }> = {};
    let recorteEnPrefijo = 0;
    let recorteEnTurno = 0;
    for (const l of g) {
      for (const c of l.informe.cambios) {
        const t = (porTransformacion[c.cual] ??= { veces: 0, recorte: 0 });
        t.veces += 1;
        const delta = c.antes - c.despues;
        t.recorte += delta;
        // El código de caveman va al prefijo y SUMA bytes (delta negativo); el
        // resto recorta el turno. Esa distinción es la que decide si vale dinero.
        if (c.donde.includes("system") || c.donde.includes("prefijo")) recorteEnPrefijo += delta;
        else recorteEnTurno += delta;
      }
    }
    return {
      clave,
      ...(g[0]!.sesion !== undefined ? { sesion: g[0]!.sesion } : {}),
      ...(g[0]!.cliente !== undefined ? { cliente: g[0]!.cliente } : {}),
      ...(g[0]!.agente !== undefined ? { agente: g[0]!.agente } : {}),
      modelos: [...new Set(g.map((l) => l.modelo).filter((m): m is string => !!m))],
      peticiones: g.length,
      bytes: g.reduce((a, l) => a + l.bytes, 0),
      bytesPrefijo: g.reduce((a, l) => a + (l.bytesPrefijo ?? 0), 0),
      bytesTurno: g.reduce((a, l) => a + (l.bytesTurno ?? 0), 0),
      herramientasMediana: mediana(g.map((l) => l.herramientas ?? 0)),
      recorteEnPrefijo,
      recorteEnTurno,
      porTransformacion,
      formas: [...new Set(g.map((l) => l.informe.forma))],
      sombra: g.every((l) => l.sombra),
    };
  });
}

/** Lee el registro y lo pinta. Pensado para `bvsala que-llega`. */
export function pintarQueLlega(ruta = RUTA_DEFECTO, desdeMs = 0): string {
  let crudo = "";
  try {
    crudo = readFileSync(ruta, "utf8");
  } catch {
    return `No hay registro todavía en ${ruta}.\nEnciéndelo con BVSALA_GATEWAY_QUE_LLEGA=1 y abre una ventana nueva.`;
  }
  const lineas: LineaQueLlega[] = [];
  for (const l of crudo.split("\n")) {
    if (!l.trim()) continue;
    try {
      const x = JSON.parse(l) as LineaQueLlega;
      if (desdeMs && Date.parse(x.at) < desdeMs) continue;
      lineas.push(x);
    } catch {
      /* una línea a medio escribir no invalida el informe */
    }
  }
  if (!lineas.length) return "El registro existe pero está vacío para ese periodo.";

  const fuera: string[] = [];
  const resumenes = resumirPorTerminal(lineas).sort((a, b) => b.peticiones - a.peticiones);
  fuera.push(`\n═══ QUÉ LE LLEGA AL MODELO · ${lineas.length} peticiones · ${resumenes.length} terminales ═══\n`);
  for (const r of resumenes) {
    const km = (n: number) => `${(n / 1024).toFixed(0)} KB`;
    fuera.push(`── ${r.clave}${r.agente ? `  [${r.agente}]` : ""}${r.sombra ? "  (SOMBRA: no se envió)" : "  (APLICADO)"}`);
    fuera.push(`   ${r.peticiones} peticiones · forma ${r.formas.join("+")} · modelo ${r.modelos.join(", ") || "?"}`);
    fuera.push(`   cuerpo ${km(r.bytes)} → prefijo ${km(r.bytesPrefijo)} (${((100 * r.bytesPrefijo) / Math.max(1, r.bytes)).toFixed(0)} %) · turno ${km(r.bytesTurno)}`);
    fuera.push(`   herramientas declaradas (mediana): ${r.herramientasMediana}`);
    if (Object.keys(r.porTransformacion).length) {
      for (const [cual, t] of Object.entries(r.porTransformacion))
        fuera.push(`     ${cual.padEnd(18)} ${String(t.veces).padStart(4)} veces · ${t.recorte >= 0 ? "−" : "+"}${Math.abs(t.recorte).toLocaleString("es")} chars`);
      fuera.push(`   ★ recorte en el TURNO (lo que puede valer dinero): ${r.recorteEnTurno.toLocaleString("es")} chars`);
      fuera.push(`     recorte en el PREFIJO (se lee de caché: ~0 en cupo, 0,1× en dólares): ${r.recorteEnPrefijo.toLocaleString("es")} chars`);
    } else {
      fuera.push(`     la capa no cambió nada en este terminal`);
    }
    fuera.push("");
  }
  const turno = resumenes.reduce((a, r) => a + r.recorteEnTurno, 0);
  const prefijo = resumenes.reduce((a, r) => a + r.recorteEnPrefijo, 0);
  const bytes = resumenes.reduce((a, r) => a + r.bytes, 0);
  fuera.push(`═══ TOTAL ═══`);
  fuera.push(`  cuerpo visto            : ${(bytes / 1_048_576).toFixed(1)} MB`);
  fuera.push(`  recorte en el TURNO     : ${turno.toLocaleString("es")} chars = ${((100 * turno) / Math.max(1, bytes)).toFixed(2)} % del cuerpo`);
  fuera.push(`  movimiento en el PREFIJO: ${prefijo.toLocaleString("es")} chars (negativo = la capa AÑADE)`);
  fuera.push(
    `\n  Lectura: solo el recorte del TURNO puede convertirse en dinero. Lo del\n` +
      `  prefijo se lee de caché a 0,1× en dólares y a ~0 en cupo de suscripción,\n` +
      `  así que recortarlo ahí no paga — y si la capa AÑADE al prefijo, eso sí se\n` +
      `  paga una vez por sesión en forma de escritura de caché.`,
  );
  return fuera.join("\n");
}

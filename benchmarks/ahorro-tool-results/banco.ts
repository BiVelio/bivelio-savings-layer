/**
 * EL BANCO EN SECO DE LOS CUATRO BRAZOS (D08 del plan Caveman 2026-10-14).
 *
 * Pregunta: sobre las MISMAS sesiones, ¿cuánto cuesta la entrada de cada brazo
 * —contando la caché de prefijo, el schema de recuperación y las rondas de
 * recuperación— y cuántas tareas se resuelven bien con lo que el brazo deja
 * ver? Sin red, sin claves y sin un céntimo.
 *
 * Los brazos (prefijo P- para no chocar con las letras de benchmarks/brazos.ts):
 *
 *  · P-A referencia   — el cuerpo tal cual, con la caché nativa.
 *  · P-B determinista — A + el perfil `lossless-data` de D03 sobre cada
 *                        tool_result (función pura: se reaplica igual en cada
 *                        petición). Sin omisiones.
 *  · P-C recuperable  — A + la proyección estable de D06 en modo
 *                        `recoverable` con ejecutor real: elecciones
 *                        persistidas, vista previa con handle, el schema de
 *                        recuperación en `tools` y, si la tarea lo necesita,
 *                        rondas de recuperación por el bucle de D06 contra el
 *                        almacén de D04.
 *  · P-D competidor   — Caveman aislado. NO SE EJECUTA: no hay release ni
 *                        commit fijado y, por regla del dueño, no se descargan
 *                        ni ejecutan binarios de terceros. El hueco está y el
 *                        informe lo dice («no ejecutado»).
 *
 * EL «MODELO» ES UN LECTOR DETERMINISTA, no un LLM: con el texto que el brazo
 * envía, responde la tarea (conteos, literales, causas) y, en P-C, pide
 * recuperar SOLO cuando la vista previa no basta para responder. Así se mide si
 * la información SIGUE AHÍ (integridad) y cuánto cuesta traerla, no si un
 * modelo la usaría bien. Ningún resultado de este banco mide calidad de
 * modelo; el ensayo pagado necesita presupuesto aprobado (hoy: 0).
 *
 * LOS TOKENS SON o200k_base (gpt-tokenizer) y los precios los del catálogo
 * versionado (Anthropic: escritura 1,25× a 5 min, lectura con descuento). o200k
 * no es el tokenizador de Anthropic: todo coste es ESTIMADO, los dólares son
 * ilustrativos y la comparación entre brazos es la cifra. El simulador de
 * caché es el del carril sombra (gateway/sombra.ts), calibrado al 3 % de error
 * de escritura.
 *
 * Uso: `pnpm ahorro:banco` escribe `benchmarks/evidencia/ahorro-tool-results-2026-10-15.json`;
 * `test/banco-ahorro-tool-results.test.ts` lo recalcula y exige que coincida bit a bit.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encode } from "gpt-tokenizer/encoding/o200k_base";

import { CadenaDeSimulacion, type BloqueSombra } from "../../gateway/sombra.js";
import { compactToolOutput, LOSSLESS_JSON_TRANSFORM_ID, LOSSLESS_JSON_VERSION } from "../../src/compression/cola.js";
import {
  crearEjecutorDeRecuperacion,
  ejecutarConRecuperacion,
  ESQUEMA_DE_RECUPERACION,
  HERRAMIENTA_DE_RECUPERACION,
  ProyectorEstable,
  REVISION_DEL_ADAPTADOR,
  VISTA_PREVIA_TRANSFORM_ID,
  VISTA_PREVIA_VERSION,
  type InformeDeProyeccion,
  type MensajeDeAnthropic,
} from "../../src/compression/proyeccion-estable.js";
import { PRECIOS_AL_DIA } from "../../src/pricing/catalogo.js";
import {
  AlmacenRecuperableEnMemoria,
  type AlmacenRecuperable,
  type AmbitoRecuperable,
  type GuardadoRecuperable,
  type LecturaRecuperable,
  type OpcionesDeGuardado,
  type OpcionesDeLectura,
} from "../../src/retrieval/almacen-recuperable.js";
import { AlmacenDeEleccionesEnMemoria } from "../../src/retrieval/elecciones-persistidas.js";
import { sha256 } from "../../src/util/hash.js";
import { corpus, FAMILIAS, type Caso, type Familia, type Tarea } from "./corpus.js";

export const BRAZOS = ["P-A", "P-B", "P-C"] as const;
export type Brazo = (typeof BRAZOS)[number];
export const MODELOS = ["claude-sonnet-5", "claude-opus-5-5"] as const;
export const CONDICIONES = ["frio", "caliente"] as const;
export type Condicion = (typeof CONDICIONES)[number];
export const CASOS_POR_FAMILIA = 12;
export const SEMILLA = 20_261_015;
export const FECHA = "2026-10-15";
/** Instante fijo para tarifar y para el reloj del almacén. */
const AHORA = Date.UTC(2026, 9, 15, 12, 0, 0);
/** Segundos entre peticiones: dentro del TTL de 5 min, como un agente activo. */
const PASO_MS = 30_000;

type Registro = Record<string, unknown>;

const memo = new Map<string, number>();
export function tokens(t: string): number {
  let n = memo.get(t);
  if (n === undefined) {
    n = encode(t).length;
    memo.set(t, n);
  }
  return n;
}

// --- el almacén determinista del banco ------------------------------------------

/**
 * El almacén de D04 de verdad (ámbito, política, integridad, cuota), con un
 * ALIAS determinista delante del handle aleatorio: el handle entra en la vista
 * previa y sus tokens en la cifra, así que sin esto el artefacto no sería
 * reproducible bit a bit. Solo para el banco: un handle predecible en
 * producción sería un handle ajeno legible.
 */
class AlmacenDeterministaDelBanco implements AlmacenRecuperable {
  private readonly real: AlmacenRecuperableEnMemoria;
  private readonly alias = new Map<string, string>();
  private n = 0;
  constructor(private readonly semilla: string) {
    this.real = new AlmacenRecuperableEnMemoria({ now: () => AHORA });
  }
  private aReal(h: string): string {
    return this.alias.get(h) ?? "no-existe";
  }
  async put(a: AmbitoRecuperable, b: Uint8Array, o: OpcionesDeGuardado): Promise<GuardadoRecuperable> {
    const r = await this.real.put(a, b, o);
    if (!r.ok) return r;
    const alias = `bvr1_${sha256(`${this.semilla}:${this.n++}`).slice(0, 32)}`;
    this.alias.set(alias, r.handle);
    return { ...r, handle: alias };
  }
  get(a: AmbitoRecuperable, h: string, o: OpcionesDeLectura): Promise<LecturaRecuperable> {
    return this.real.get(a, this.aReal(h), o);
  }
  pin(a: AmbitoRecuperable, h: string, hasta: number) {
    return this.real.pin(a, this.aReal(h), hasta);
  }
  delete(a: AmbitoRecuperable, h: string) {
    return this.real.delete(a, this.aReal(h));
  }
  revokeScope(a: AmbitoRecuperable, nivel?: "session" | "branch" | "epoch") {
    return this.real.revokeScope(a, nivel);
  }
}

// --- los cuerpos de la sesión ---------------------------------------------------

const SYSTEM =
  "Eres un agente de mantenimiento de un repositorio TypeScript. Usa la herramienta bash para inspeccionar el " +
  "proyecto. Responde siempre con el dato exacto que se pide, en JSON, sin explicaciones. No inventes valores: si " +
  "no los ves, búscalos. Respeta las convenciones del repositorio y no modifiques ficheros salvo que se pida.";
const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command in the repository and return its output.",
    input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  },
];
const PRIMER_MENSAJE = "Revisa el estado del repositorio con las herramientas y prepárate para responder preguntas.";
const PRIMER_MENSAJE_EDITADO = "Revisa SOLO la parte de facturación del repositorio y prepárate para responder preguntas.";

function pregunta(t: Tarea): string {
  const s = t.salidas.map((i) => i + 1).join(", ");
  switch (t.tipo) {
    case "json-nulos":
      return `En la salida ${s}, ¿cuántas filas tienen "${t.campo}" a null?`;
    case "json-literal":
      return `En la salida ${s}, ¿cuál es el literal exacto de "${t.campo}" en la fila ${t.fila}?`;
    case "json-maximo":
      return `En la salida ${s}, ¿qué fila tiene el mayor "${t.campo}" y cuánto vale?`;
    case "json-duplicada":
      return `En la salida ${s}, ¿qué valores tiene "${t.campo}" en la fila ${t.fila}, en orden?`;
    case "log-fallos":
      return `En la salida ${s}, ¿qué ficheros de test fallaron?`;
    case "log-exit":
      return `En la salida ${s}, ¿con qué exit code terminó?`;
    case "log-skipped":
      return `En la salida ${s}, ¿cuántos tests se saltaron?`;
    case "log-duracion":
      return `¿Cuántos ms tardó cada uno de estos tests: ${t.casos.map((c, k) => `caso-${String(c).padStart(4, "0")} en la salida ${t.salidas[k]! + 1}`).join("; ")}?`;
    case "ls-cuenta":
      return `En la salida ${s}, ¿cuántas entradas lista ls (sin la línea total)?`;
  }
}

const idDe = (j: number) => `toolu_${String(j).padStart(2, "0")}`;

/** Petición `r` (0..K-1: tras la salida r; K: la pregunta final). */
function cuerpoDe(c: Caso, r: number): Registro {
  const K = c.salidas.length;
  const editado = c.forkEn !== undefined && r > c.forkEn;
  const mensajes: Registro[] = [{ role: "user", content: editado ? PRIMER_MENSAJE_EDITADO : PRIMER_MENSAJE }];
  for (let j = 0; j <= Math.min(r, K - 1); j++) {
    const s = c.salidas[j]!;
    mensajes.push({ role: "assistant", content: [{ type: "tool_use", id: idDe(j), name: s.herramienta, input: s.argumentos }] });
    mensajes.push({ role: "user", content: [{ type: "tool_result", tool_use_id: idDe(j), content: s.contenido }] });
  }
  if (r === K) {
    mensajes.push({ role: "assistant", content: [{ type: "text", text: "Tengo los resultados." }] });
    mensajes.push({ role: "user", content: pregunta(c.tarea) });
  }
  return { model: "claude-sonnet-5", max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages: mensajes };
}

// --- el lector determinista (el «modelo» del banco) -----------------------------

interface Vista {
  /** Líneas visibles, en orden. */
  lineas: string[];
  /** ¿Están a la vista TODAS las líneas con marcador (fail, warn, skipped, exit…)? */
  marcadoresCompletos: boolean;
  esVistaPrevia: boolean;
  handle?: string;
}

/** Lo que el lector ve de un texto: entero, o lo que enseña una vista previa de D06. */
export function vistaDe(texto: string): Vista {
  if (!texto.startsWith("[bvsala: shortened tool result")) return { lineas: texto.split("\n"), marcadoresCompletos: true, esVistaPrevia: false };
  const handle = /"handle":"(bvr1_[A-Za-z0-9_-]{32})"/.exec(texto)?.[1];
  const lineas: string[] = [];
  let completos = true;
  for (const l of texto.split("\n").slice(1)) {
    if (l.startsWith("--- ")) {
      if (/ lines omitted /.test(l) && /, first \d+ shown/.test(l)) completos = false;
      continue;
    }
    const m = /^L\d+: (.*)$/.exec(l);
    lineas.push(m ? m[1]! : l);
  }
  return { lineas, marcadoresCompletos: completos, esVistaPrevia: true, ...(handle ? { handle } : {}) };
}

type Lexema = string;

/** Lexemas de un JSON plano (array de objetos de primitivos), con su texto exacto y SIN rechazar duplicadas. */
function lexemas(texto: string): Lexema[] | null {
  const out: Lexema[] = [];
  let i = 0;
  while (i < texto.length) {
    const c = texto[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("[]{}:,".includes(c)) {
      out.push(c);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < texto.length && texto[j] !== '"') j += texto[j] === "\\" ? 2 : 1;
      if (j >= texto.length) return null;
      out.push(texto.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(texto.slice(i, i + 64));
    if (!m) return null;
    out.push(m[1]!);
    i += m[1]!.length;
  }
  return out;
}

function filas(texto: string): [string, string][][] | null {
  const lx = lexemas(texto);
  if (!lx || lx[0] !== "[") return null;
  const salida: [string, string][][] = [];
  let actual: [string, string][] | null = null;
  for (let i = 1; i < lx.length; i++) {
    const t = lx[i]!;
    if (t === "{") actual = [];
    else if (t === "}") {
      if (actual) salida.push(actual);
      actual = null;
    } else if (actual && lx[i + 1] === ":") {
      actual.push([JSON.parse(t) as string, lx[i + 2]!]);
      i += 2;
    }
  }
  return salida;
}

const RE_FALLO = /^FAIL\s+(\S+)/;
const RE_SALTADO = /^\s*↓ .*\[skipped\]$/;
const RE_EXIT = /^exit code (\d+)$/;

/** ¿Se puede responder con lo que se ve? (Si no, el lector pide recuperar.) */
function basta(t: Tarea, v: Vista, salida: number): boolean {
  if (!v.esVistaPrevia) return true;
  switch (t.tipo) {
    case "log-fallos":
    case "log-skipped":
      return v.marcadoresCompletos;
    case "log-exit":
      return v.lineas.some((l) => RE_EXIT.test(l));
    case "log-duracion": {
      const k = t.salidas.indexOf(salida);
      const caso = `caso-${String(t.casos[k]).padStart(4, "0")}.test.ts (`;
      return v.lineas.some((l) => l.includes(caso));
    }
    default:
      return false;
  }
}

/** La respuesta, calculada SOLO con lo que se ve. */
function responder(t: Tarea, vistas: Map<number, Vista>): unknown {
  const v = (i: number) => vistas.get(i)!;
  switch (t.tipo) {
    case "log-fallos":
      return [...new Set(v(t.salidas[0]).lineas.map((l) => RE_FALLO.exec(l)?.[1]).filter((x): x is string => !!x))].sort();
    case "log-skipped":
      return v(t.salidas[0]).lineas.filter((l) => RE_SALTADO.test(l)).length;
    case "log-exit": {
      const m = v(t.salidas[0]).lineas.map((l) => RE_EXIT.exec(l)).filter(Boolean).at(-1);
      return m ? Number(m[1]) : null;
    }
    case "log-duracion":
      return t.salidas.map((s, k) => {
        const re = new RegExp(`caso-${String(t.casos[k]).padStart(4, "0")}\\.test\\.ts \\((\\d+) ms\\)`);
        const m = v(s).lineas.map((l) => re.exec(l)).find(Boolean);
        return m ? Number(m[1]) : null;
      });
    case "ls-cuenta":
      return v(t.salidas[0]).lineas.filter((l) => /^[-d][rwx-]{9}/.test(l)).length;
    default: {
      const fs = filas(v(t.salidas[0]).lineas.join("\n"));
      if (!fs) return null;
      if (t.tipo === "json-nulos") return fs.filter((f) => f.some(([k, x]) => k === t.campo && x === "null")).length;
      if (t.tipo === "json-maximo") {
        let mejor = -1;
        let valor = -Infinity;
        fs.forEach((f, i) => {
          const x = Number(f.find(([k]) => k === t.campo)?.[1]);
          if (x > valor) {
            valor = x;
            mejor = i;
          }
        });
        return { fila: mejor, valor };
      }
      if (t.tipo === "json-duplicada") return (fs[t.fila] ?? []).filter(([k]) => k === t.campo).map(([, x]) => x);
      return (fs[t.fila] ?? []).find(([k]) => k === t.campo)?.[1] ?? null;
    }
  }
}

/** Los textos de tool_result de un cuerpo, por id. */
function resultadosDe(cuerpo: Registro): Map<string, string> {
  const salida = new Map<string, string>();
  for (const m of cuerpo.messages as Registro[]) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Registro[]) {
      if (b.type === "tool_result") salida.set(String(b.tool_use_id), String(b.content));
    }
  }
  return salida;
}

// --- los brazos -----------------------------------------------------------------

interface Peticion {
  cuerpo: Registro;
  /** Ronda de recuperación (no es un turno de la trayectoria). */
  recuperacion: boolean;
}

interface Ejecucion {
  peticiones: Peticion[];
  respuesta: string;
  correcta: boolean;
  /** Solo P-C: la respuesta sin recuperar nada (para medir qué se pierde sin recuperación). */
  correctaSinRecuperar?: boolean;
  recuperaciones: number;
  recuperacionesExactas: number;
  motivos: Record<string, number>;
  /** Tokens del schema de recuperación, sumados sobre las peticiones que lo llevan. */
  tokensDeEsquema: number;
}

const ambitoDe = (c: Caso) => ({ tenantId: "banco", projectId: "d08", sessionId: c.id, branchId: "main" });

/**
 * Las decisiones AL NACER (o al reconstruir en época nueva), una vez por
 * segmento y motivo: una reutilización, o el mismo bypass repetido en cada
 * ronda, no es una decisión nueva.
 */
function contarMotivos(destino: Record<string, number>, informe: InformeDeProyeccion, vistos: Set<string>): void {
  for (const s of informe.segments) {
    if (s.status === "reused") continue;
    const k = `${s.transformId}:${s.reason}`;
    const clave = `${informe.epoch}:${s.segmentId}:${k}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    destino[k] = (destino[k] ?? 0) + 1;
  }
}

function responderCuerpo(c: Caso, cuerpo: Registro): string {
  const textos = resultadosDe(cuerpo);
  const vistas = new Map(c.tarea.salidas.map((i) => [i, vistaDe(textos.get(idDe(i)) ?? "")]));
  return JSON.stringify(responder(c.tarea, vistas));
}

function brazoA(c: Caso): Ejecucion {
  const peticiones = Array.from({ length: c.salidas.length + 1 }, (_, r) => ({ cuerpo: cuerpoDe(c, r), recuperacion: false }));
  const respuesta = responderCuerpo(c, peticiones.at(-1)!.cuerpo);
  return { peticiones, respuesta, correcta: respuesta === c.esperado, recuperaciones: 0, recuperacionesExactas: 0, motivos: {}, tokensDeEsquema: 0 };
}

function brazoB(c: Caso): Ejecucion {
  const motivos: Record<string, number> = {};
  const peticiones = Array.from({ length: c.salidas.length + 1 }, (_, r) => {
    const cuerpo = structuredClone(cuerpoDe(c, r));
    for (const m of cuerpo.messages as Registro[]) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content as Registro[]) {
        if (b.type !== "tool_result") continue;
        const x = compactToolOutput(String(b.content), { profile: "lossless-data" }, tokens);
        // Al nacer: la salida r en la petición r (la final no trae salidas nuevas).
        if (b.tool_use_id === idDe(r)) {
          const k = `${x.changed ? LOSSLESS_JSON_TRANSFORM_ID : "identity"}:${x.decision!.reason}`;
          motivos[k] = (motivos[k] ?? 0) + 1;
        }
        b.content = x.text;
      }
    }
    return { cuerpo, recuperacion: false };
  });
  const respuesta = responderCuerpo(c, peticiones.at(-1)!.cuerpo);
  return { peticiones, respuesta, correcta: respuesta === c.esperado, recuperaciones: 0, recuperacionesExactas: 0, motivos, tokensDeEsquema: 0 };
}

async function brazoC(c: Caso): Promise<Ejecucion> {
  const almacen = new AlmacenDeterministaDelBanco(`${SEMILLA}:${c.id}`);
  const proyector = new ProyectorEstable({
    modo: "recoverable",
    ambito: ambitoDe(c),
    politica: "politica-del-banco-v1",
    elecciones: new AlmacenDeEleccionesEnMemoria(),
    almacen,
    ejecutor: crearEjecutorDeRecuperacion(almacen),
    contarTokens: tokens,
    tokenizer: "o200k_base",
    now: () => AHORA,
  });
  const esquema = tokens(JSON.stringify(ESQUEMA_DE_RECUPERACION));
  const peticiones: Peticion[] = [];
  const motivos: Record<string, number> = {};
  const vistos = new Set<string>();
  let tokensDeEsquema = 0;
  const K = c.salidas.length;
  for (let r = 0; r < K; r++) {
    const p = await proyector.proyectar(cuerpoDe(c, r));
    contarMotivos(motivos, p.informe, vistos);
    peticiones.push({ cuerpo: p.cuerpo, recuperacion: false });
    if (p.informe.recoveryToolInjected) tokensDeEsquema += esquema;
  }

  // La pregunta final, por el bucle de D06. El «modelo» pide recuperar la
  // primera salida que necesita y no basta; cuando todo basta, responde.
  let correctaSinRecuperar: boolean | undefined;
  let exactas = 0;
  const crear = async (cuerpo: Registro): Promise<MensajeDeAnthropic> => {
    const ronda = peticiones.length - K;
    peticiones.push({ cuerpo, recuperacion: ronda > 0 });
    if ((cuerpo.tools as Registro[]).some((t) => t.name === HERRAMIENTA_DE_RECUPERACION)) tokensDeEsquema += esquema;
    const textos = resultadosDe(cuerpo);
    if (ronda === 0) correctaSinRecuperar = responderCuerpo(c, cuerpo) === c.esperado;
    const vistas = new Map<number, Vista>();
    for (const i of c.tarea.salidas) {
      const recuperado = textos.get(`toolu_rec_${i}`);
      const v = vistaDe(recuperado ?? textos.get(idDe(i)) ?? "");
      if (!basta(c.tarea, v, i) && v.handle && recuperado === undefined) {
        return { content: [{ type: "tool_use", id: `toolu_rec_${i}`, name: HERRAMIENTA_DE_RECUPERACION, input: { handle: v.handle } }] };
      }
      vistas.set(i, v);
    }
    return { content: [{ type: "text", text: JSON.stringify(responder(c.tarea, vistas)) }] };
  };
  const r = await ejecutarConRecuperacion({ cuerpo: cuerpoDe(c, K), proyector, crear });
  for (const i of r.informes) contarMotivos(motivos, i, vistos);
  // Integridad: cada original recuperado, contra el de la fuente, por sha256.
  // La última ronda lleva todas las recuperaciones de la llamada (se acumulan).
  const ultima = peticiones.filter((x) => x.recuperacion).at(-1);
  if (ultima) {
    for (const [id, texto] of resultadosDe(ultima.cuerpo)) {
      if (!id.startsWith("toolu_rec_")) continue;
      if (sha256(texto) === sha256(c.salidas[Number(id.slice("toolu_rec_".length))]!.contenido)) exactas++;
    }
  }
  const respuesta = String((r.mensaje.content[0] as Registro).text ?? "");
  return {
    peticiones,
    respuesta,
    correcta: respuesta === c.esperado,
    correctaSinRecuperar: correctaSinRecuperar ?? false,
    recuperaciones: r.recuperaciones,
    recuperacionesExactas: exactas,
    motivos,
    tokensDeEsquema,
  };
}

// --- la simulación de caché -------------------------------------------------------

function bloquesDe(cuerpo: Registro): BloqueSombra[] {
  const bloques: BloqueSombra[] = [];
  const poner = (clave: string, tipo: string, texto: string) =>
    bloques.push({ clave: sha256(`${tipo}\u0000${clave}`), tipo, marca: null, bytes: tokens(texto), bytesV1: tokens(texto), clase: "otro", esError: false });
  const tools = JSON.stringify(cuerpo.tools);
  poner(tools, "tools", tools);
  poner(String(cuerpo.system), "system", String(cuerpo.system));
  bloques[1]!.marca = "5m";
  for (const m of cuerpo.messages as Registro[]) {
    if (typeof m.content === "string") {
      poner(m.content, `${m.role}:text`, m.content);
      continue;
    }
    for (const b of m.content as Registro[]) {
      const texto =
        b.type === "text" ? String(b.text) : b.type === "tool_use" ? `${String(b.name)}${JSON.stringify(b.input)}` : String(b.content);
      poner(JSON.stringify(b), `${String(m.role)}:${String(b.type)}`, texto);
    }
  }
  bloques.at(-1)!.marca = "5m";
  return bloques;
}

interface Coste {
  usd: number;
  tokensEntrada: number;
  tokensEscritos: number;
  tokensLeidos: number;
  invalidacionUsd: number;
  /** Lo que cuestan solo las rondas de recuperación. */
  usdRecuperacion: number;
  tokensRecuperacion: number;
}

function simular(peticiones: Peticion[], modelo: string, condicion: Condicion): Coste {
  const cadena = new CadenaDeSimulacion((bloques) => bloques.map((b) => ({ clave: b.clave, bytes: b.bytes })));
  const coste: Coste = { usd: 0, tokensEntrada: 0, tokensEscritos: 0, tokensLeidos: 0, invalidacionUsd: 0, usdRecuperacion: 0, tokensRecuperacion: 0 };
  if (condicion === "caliente") {
    // Otra sesión de la misma app acaba de escribir tools + system: el prefijo
    // común ya está en caché. Su coste no es de este caso.
    const previa = bloquesDe(peticiones[0]!.cuerpo).slice(0, 2);
    cadena.paso({ bloques: previa, at: AHORA - 60_000, model: modelo, entradaReal: previa.reduce((s, b) => s + b.bytes, 0), escritura1h: false });
  }
  peticiones.forEach((p, t) => {
    const bloques = bloquesDe(p.cuerpo);
    const d = cadena.paso({ bloques, at: AHORA + t * PASO_MS, model: modelo, entradaReal: bloques.reduce((s, b) => s + b.bytes, 0), escritura1h: false });
    coste.usd += d.totalUsd;
    coste.tokensEntrada += d.tokensEntrada;
    coste.tokensEscritos += d.tokensEscritos;
    coste.tokensLeidos += d.tokensLeidos;
    coste.invalidacionUsd += d.invalidacionUsd;
    if (p.recuperacion) {
      coste.usdRecuperacion += d.totalUsd;
      coste.tokensRecuperacion += d.tokensEntrada + d.tokensEscritos + d.tokensLeidos;
    }
  });
  return coste;
}

// --- el artefacto -------------------------------------------------------------------

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (parte: number, total: number) => (total > 0 ? r2((parte / total) * 100) : 0);

export interface ResultadoDeBrazo {
  /** Coste de entrada ESTIMADO (simulado) de todas las peticiones, recuperación incluida. */
  usdEstimado: number;
  ahorroPctFrenteA: number;
  tokens: { entradaSinCache: number; escrituraCache: number; lecturaCache: number; total: number };
  invalidacionUsd: number;
  overhead: { tokensEsquemaRecuperacion: number; tokensRondasRecuperacion: number; usdRondasRecuperacion: number };
  /** Casos en que el brazo sale MÁS caro que P-A (ahorro negativo). */
  casosConAhorroNegativo: number;
  /** usd / tareas correctas; null si ninguna es correcta (nunca 0). */
  usdPorTareaCorrecta: number | null;
}

export interface ArtefactoCuatroBrazos {
  fecha: string;
  metodo: string;
  advertencias: string[];
  manifiesto: {
    semilla: number;
    casosPorFamilia: number;
    casos: number;
    corpusSha256: string;
    paquete: string;
    tokenizador: string;
    catalogoDePrecios: string;
    transformaciones: Record<string, string>;
    adaptador: string;
    ordenDeBrazos: string;
  };
  brazos: Record<"P-A" | "P-B" | "P-C" | "P-D", { nombre: string; estado: "ejecutado" | "no_ejecutado"; motivo?: string }>;
  calidad: Record<
    Brazo,
    { correctas: number; total: number; tasaPct: number; correctasSinRecuperar?: number; recuperaciones?: number; recuperacionesExactas?: number }
  >;
  resultados: Record<string, Record<Condicion, Record<Brazo, ResultadoDeBrazo>>>;
  motivos: Record<Brazo, Record<string, number>>;
  porFamilia: Record<
    string,
    Record<Brazo, { correctas: number; total: number; recuperaciones: number; ahorroPctFrenteA: Record<string, Record<Condicion, number>>; casosConAhorroNegativo: Record<string, Record<Condicion, number>> }>
  >;
  porCaso: { id: string; familia: Familia; orden: string; correcta: Record<Brazo, boolean>; recuperaciones: number; usdSonnet: Record<Condicion, Record<Brazo, number>> }[];
  veredicto: { resultado: "inconcluso"; motivo: string };
}

export async function medirCuatroBrazos(casosPorFamilia = CASOS_POR_FAMILIA): Promise<ArtefactoCuatroBrazos> {
  memo.clear();
  const casos = corpus(casosPorFamilia, SEMILLA);
  const corpusSha256 = sha256(JSON.stringify(casos));

  const ejecuciones: Record<Brazo, Ejecucion>[] = [];
  for (const c of casos) {
    // El orden alterna por caso (plan p. 11). Aquí no cambia nada —cada brazo
    // tiene su caché y su almacén—, pero el manifiesto lo fija para el ensayo pagado.
    const orden: Brazo[] = c.orden === "directo" ? [...BRAZOS] : [...BRAZOS].reverse();
    const e = {} as Record<Brazo, Ejecucion>;
    for (const b of orden) e[b] = b === "P-A" ? brazoA(c) : b === "P-B" ? brazoB(c) : await brazoC(c);
    ejecuciones.push(e);
  }

  const costes = ejecuciones.map((e) =>
    Object.fromEntries(
      MODELOS.map((m) => [m, Object.fromEntries(CONDICIONES.map((cd) => [cd, Object.fromEntries(BRAZOS.map((b) => [b, simular(e[b].peticiones, m, cd)]))]))]),
    ) as Record<string, Record<Condicion, Record<Brazo, Coste>>>,
  );

  const calidad = {} as ArtefactoCuatroBrazos["calidad"];
  for (const b of BRAZOS) {
    const correctas = ejecuciones.filter((e) => e[b].correcta).length;
    calidad[b] = { correctas, total: casos.length, tasaPct: pct(correctas, casos.length) };
    if (b === "P-C") {
      calidad[b].correctasSinRecuperar = ejecuciones.filter((e) => e[b].correctaSinRecuperar).length;
      calidad[b].recuperaciones = ejecuciones.reduce((s, e) => s + e[b].recuperaciones, 0);
      calidad[b].recuperacionesExactas = ejecuciones.reduce((s, e) => s + e[b].recuperacionesExactas, 0);
    }
  }

  const agregar = (indices: number[], modelo: string, cd: Condicion, b: Brazo): ResultadoDeBrazo => {
    const de = (i: number, x: Brazo) => costes[i]![modelo]![cd][x];
    const usd = indices.reduce((s, i) => s + de(i, b).usd, 0);
    const usdA = indices.reduce((s, i) => s + de(i, "P-A").usd, 0);
    const correctas = indices.filter((i) => ejecuciones[i]![b].correcta).length;
    const t = (k: "tokensEntrada" | "tokensEscritos" | "tokensLeidos") => Math.round(indices.reduce((s, i) => s + de(i, b)[k], 0));
    return {
      usdEstimado: r6(usd),
      ahorroPctFrenteA: pct(usdA - usd, usdA),
      tokens: { entradaSinCache: t("tokensEntrada"), escrituraCache: t("tokensEscritos"), lecturaCache: t("tokensLeidos"), total: t("tokensEntrada") + t("tokensEscritos") + t("tokensLeidos") },
      invalidacionUsd: r6(indices.reduce((s, i) => s + de(i, b).invalidacionUsd, 0)),
      overhead: {
        tokensEsquemaRecuperacion: indices.reduce((s, i) => s + ejecuciones[i]![b].tokensDeEsquema, 0),
        tokensRondasRecuperacion: Math.round(indices.reduce((s, i) => s + de(i, b).tokensRecuperacion, 0)),
        usdRondasRecuperacion: r6(indices.reduce((s, i) => s + de(i, b).usdRecuperacion, 0)),
      },
      // Tolerancia de redondeo de coma flotante, no de dinero.
      casosConAhorroNegativo: indices.filter((i) => de(i, b).usd > de(i, "P-A").usd + 1e-12).length,
      usdPorTareaCorrecta: correctas > 0 ? r6(usd / correctas) : null,
    };
  };

  const todos = casos.map((_, i) => i);
  const resultados: ArtefactoCuatroBrazos["resultados"] = {};
  for (const m of MODELOS) {
    resultados[m] = {} as Record<Condicion, Record<Brazo, ResultadoDeBrazo>>;
    for (const cd of CONDICIONES) {
      resultados[m][cd] = Object.fromEntries(BRAZOS.map((b) => [b, agregar(todos, m, cd, b)])) as Record<Brazo, ResultadoDeBrazo>;
    }
  }

  const porFamilia: ArtefactoCuatroBrazos["porFamilia"] = {};
  for (const f of FAMILIAS) {
    const ind = todos.filter((i) => casos[i]!.familia === f);
    porFamilia[f] = Object.fromEntries(
      BRAZOS.map((b) => [
        b,
        {
          correctas: ind.filter((i) => ejecuciones[i]![b].correcta).length,
          total: ind.length,
          recuperaciones: ind.reduce((s, i) => s + ejecuciones[i]![b].recuperaciones, 0),
          ahorroPctFrenteA: Object.fromEntries(MODELOS.map((m) => [m, Object.fromEntries(CONDICIONES.map((cd) => [cd, agregar(ind, m, cd, b).ahorroPctFrenteA]))])),
          casosConAhorroNegativo: Object.fromEntries(MODELOS.map((m) => [m, Object.fromEntries(CONDICIONES.map((cd) => [cd, agregar(ind, m, cd, b).casosConAhorroNegativo]))])),
        },
      ]),
    ) as ArtefactoCuatroBrazos["porFamilia"][string];
  }

  const motivos = Object.fromEntries(
    BRAZOS.map((b) => {
      const acc: Record<string, number> = {};
      for (const e of ejecuciones) for (const [k, n] of Object.entries(e[b].motivos)) acc[k] = (acc[k] ?? 0) + n;
      return [b, Object.fromEntries(Object.keys(acc).sort().map((k) => [k, acc[k]!]))];
    }),
  ) as Record<Brazo, Record<string, number>>;

  return {
    fecha: FECHA,
    metodo:
      "dry bench: seeded synthetic sessions (plan p. 11 families), a deterministic reader as the 'model' (answers from " +
      "what each arm sends; in P-C it retrieves only when the preview is not enough), and the shadow-lane prefix-cache " +
      "simulator (breakpoints on system and on the last block, 5m TTL). Input cost only, ESTIMATED.",
    advertencias: [
      "offline: the reader is deterministic code, not an LLM; these results do NOT measure model quality",
      "a paid replay (real model, real usage) needs budget approval; the approved budget for this round is 0",
      "tokens are o200k_base, not Anthropic's tokenizer: USD is illustrative, the comparison between arms is the figure",
      "output tokens are not simulated (also the small tool_use of each retrieval round)",
      "retrievals happen only at the final question and are kept in the history of that call",
      "P-D (Caveman) is not run: no pinned release/commit and third-party binaries are not downloaded or executed",
    ],
    manifiesto: {
      semilla: SEMILLA,
      casosPorFamilia,
      casos: casos.length,
      corpusSha256,
      paquete: "@bivelio/savings-layer 0.5.2",
      tokenizador: "o200k_base (gpt-tokenizer)",
      catalogoDePrecios: PRECIOS_AL_DIA,
      transformaciones: {
        [LOSSLESS_JSON_TRANSFORM_ID]: LOSSLESS_JSON_VERSION,
        [VISTA_PREVIA_TRANSFORM_ID]: VISTA_PREVIA_VERSION,
      },
      adaptador: REVISION_DEL_ADAPTADOR,
      ordenDeBrazos: "alternated per case: even ids P-A,P-B,P-C; odd ids reversed; separate cache and store per arm",
    },
    brazos: {
      "P-A": { nombre: "referencia (Savings actual, caché nativa)", estado: "ejecutado" },
      "P-B": { nombre: "determinista (lossless-data, D03)", estado: "ejecutado" },
      "P-C": { nombre: "recuperable (proyección estable D06 + almacén D04)", estado: "ejecutado" },
      "P-D": {
        nombre: "competidor (Caveman estándar aislado)",
        estado: "no_ejecutado",
        motivo:
          "no release/commit pinned (D05 open) and, by the owner's rule, third-party binaries are not downloaded or executed",
      },
    },
    calidad,
    resultados,
    motivos,
    porFamilia,
    porCaso: casos.map((c, i) => ({
      id: c.id,
      familia: c.familia,
      orden: c.orden,
      correcta: Object.fromEntries(BRAZOS.map((b) => [b, ejecuciones[i]![b].correcta])) as Record<Brazo, boolean>,
      recuperaciones: ejecuciones[i]!["P-C"].recuperaciones,
      usdSonnet: Object.fromEntries(
        CONDICIONES.map((cd) => [cd, Object.fromEntries(BRAZOS.map((b) => [b, r6(costes[i]!["claude-sonnet-5"]![cd][b].usd)]))]),
      ) as Record<Condicion, Record<Brazo, number>>,
    })),
    veredicto: {
      resultado: "inconcluso",
      motivo:
        "pre-registered protocol (docs/especificaciones/CAVEMAN-D08-PROTOCOLO.md): quality needs a paid replay with a real " +
        "model; offline figures only validate the contract, integrity and estimated input cost",
    },
  };
}

// --- CLI ------------------------------------------------------------------------------

const RUTA = fileURLToPath(new URL(`../evidencia/ahorro-tool-results-${FECHA}.json`, import.meta.url));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = await medirCuatroBrazos();
  writeFileSync(RUTA, `${JSON.stringify(a, null, 2)}\n`);
  for (const [modelo, porCondicion] of Object.entries(a.resultados)) {
    for (const [cd, brazos] of Object.entries(porCondicion)) {
      const fila = BRAZOS.map((b) => `${b} ${brazos[b].ahorroPctFrenteA.toFixed(2)}% (peores ${brazos[b].casosConAhorroNegativo}, $/correcta ${brazos[b].usdPorTareaCorrecta})`);
      console.log(`${modelo.padEnd(16)} ${cd.padEnd(9)} ${fila.join(" | ")}`);
    }
  }
  console.log(JSON.stringify(a.calidad));
  console.log(`\nescrito ${RUTA}`);
}

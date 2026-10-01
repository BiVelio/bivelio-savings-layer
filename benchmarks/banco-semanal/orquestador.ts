/**
 * `pnpm banco:semanal` — EL BANCO SEMANAL: las cuatro baterías publicadas
 * (GSM8K, BFCL, XSTest, MT-Bench) contra el FUENTE de main, diez modelos, 50 $.
 * ---------------------------------------------------------------------------
 *   --vivo | --seco        obligatorio uno. SECO: cada arnés en su modo sin red de
 *                          proveedor (proveedor falso), una submuestra mínima; valida
 *                          la fontanería sin gastar. VIVO: gasta, con los topes de plan.ts.
 *   --salida DIR           por defecto benchmarks/out/banco-semanal/<runId>
 *   --modelos a,b          filtra por id (openai/gpt-4o-mini) o id corto (gpt-4o-mini)
 *   --baterias a,b         filtra baterías (gsm8k,bfcl,xstest,mt-bench)
 *   --jornada N            para un modelo con cuota diaria de peticiones (plan.ts,
 *                          CUOTA_DIARIA), qué jornada de sus baterías se mide (1, 2…).
 *                          Por defecto, la de la semana (rota). Las demás baterías
 *                          de ese modelo salen «aplazada por cuota».
 *   --previa DIR           la salida de la tirada EN VIVO anterior: sus cuadres de
 *                          factura pendientes se vuelven a leer (factura.ts)
 *
 * NO REIMPLEMENTA NINGUNA BATERÍA: lanza cada arnés como proceso aparte, una
 * celda (modelo × batería) por proceso, con sus flags, y lee su artefacto.
 * Un arnés que muere solo tumba su celda.
 *
 * El dinero: ver plan.ts (topes por celda, del juez, y la caja global que
 * reserva antes de lanzar). Las reglas que hacen fallar: umbrales.ts.
 *
 * CREDENCIALES: el orquestador no lee ninguna clave. El entorno pasa tal cual a
 * cada arnés, que es quien las usa (y las tapa en lo que escribe). Lo único que
 * hace con ellas es BORRAR sus valores de los registros de cada celda antes de
 * guardarlos, sin imprimirlos: busca en el entorno las variables cuyo nombre
 * parece de secreto y sustituye su valor por «[redactado]».
 *
 * Sale con 1 si el veredicto no es limpio (en SECO, solo si falla la fontanería).
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BV_SALA_VERSION } from "../../src/version.js";
import { extraer, type PreguntaCrudaMtBench } from "./extraer.js";
import { cuadrarLaFactura, cuadresPendientesDe, type Cuadre } from "./factura.js";
import {
  argumentosDe,
  BATERIAS,
  CajaGlobal,
  CONCURRENCIA_POR_BATERIA,
  CUOTA_DIARIA,
  jornadaPorDefecto,
  MODELOS_DEL_BANCO,
  peticionesMaximas,
  PLAZO_DE_CELDA_MS,
  planificar,
  reparto,
  tocaEnLaJornada,
  TopeGlobalAgotado,
  validarPlan,
  type Bateria,
  type Celda,
  type Familia,
  type Modo,
  type ModeloDelBanco,
} from "./plan.js";
import { configDesdeEntorno } from "../modelos.js";
import { endpointDeModelo } from "../transporte.js";
import { resumenMarkdown } from "./resumen.js";
import { soporte } from "./soporte.js";
import { evaluar, type Regla, type ResultadoDeCelda } from "./umbrales.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..");
const TSX = join(RAIZ, "node_modules", ".bin", "tsx");

/** Reglas que en SECO sí hacen fallar: las de fontanería. Las de calidad, en SECO, no miden nada. */
export const REGLAS_DE_FONTANERIA: ReadonlySet<Regla> = new Set(["arnes-falla", "tope-excedido", "tope-global", "bateria-sin-medir"]);

/** La variable con la clave de cada proveedor cuando tiene endpoint directo (docs/BANCO-SEMANAL.md). */
const CLAVE_DE_LA_FAMILIA: Readonly<Record<Familia, string>> = {
  anthropic: "BVSALA_DEMO_ANTHROPIC_API_KEY",
  openai: "BVSALA_DEMO_OPENAI_API_KEY",
  google: "BVSALA_DEMO_GOOGLE_API_KEY",
};

/**
 * En vivo, el nombre de la variable cuya clave le falta al endpoint que usaría
 * el arnés para este modelo, o null. Decide con el mismo `endpointDeModelo` que
 * los arneses (directo de su familia, o la pasarela), así que no puede
 * discrepar de ellos. Solo mira si la clave está: su valor no sale de aquí.
 */
export function claveQueFalta(modelo: ModeloDelBanco, modo: Modo, env: NodeJS.ProcessEnv): string | null {
  if (modo !== "vivo") return null;
  const cfg = configDesdeEntorno(env);
  const e = endpointDeModelo(modelo.id, cfg);
  if (!e || e.transporte === "mock" || e.apiKey) return null;
  return directoDeLaFamilia(modelo.familia, cfg) ? CLAVE_DE_LA_FAMILIA[modelo.familia] : "BVSALA_DEMO_API_KEY";
}

function directoDeLaFamilia(familia: Familia, cfg: ReturnType<typeof configDesdeEntorno>): boolean {
  return !!(familia === "anthropic" ? cfg.anthropicBaseUrl : familia === "openai" ? cfg.openaiBaseUrl : cfg.googleBaseUrl);
}

/** Los valores de las variables del entorno con nombre de secreto, para taparlos en los registros. Nunca se imprimen. */
export function valoresSecretos(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && typeof v === "string" && v.length >= 8)
    .map(([, v]) => v!);
}

export function redactar(texto: string, secretos: readonly string[]): string {
  let t = texto;
  for (const s of secretos) t = t.split(s).join("[redactado]");
  // Lo que tenga FORMA de clave aunque no esté en el entorno.
  return t.replace(/\b(sk-(?:ant-)?|AIza|vck_)[A-Za-z0-9_-]{16,}/g, "[redactado]");
}

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: RAIZ, encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

interface Ejecucion {
  codigo: number | null;
  plazoAgotado: boolean;
  registro: string;
}

function ejecutar(args: string[], registro: string, secretos: readonly string[], env: NodeJS.ProcessEnv): Promise<Ejecucion> {
  return new Promise((res) => {
    const hijo = spawn(TSX, args, { cwd: RAIZ, env, stdio: ["ignore", "pipe", "pipe"] });
    let salida = "";
    const anotar = (b: Buffer) => {
      salida += b.toString("utf8");
      // Los registros de un arnés pueden ser largos; se guarda la cola.
      if (salida.length > 2_000_000) salida = salida.slice(-1_000_000);
    };
    hijo.stdout.on("data", anotar);
    hijo.stderr.on("data", anotar);
    let plazoAgotado = false;
    const reloj = setTimeout(() => {
      plazoAgotado = true;
      hijo.kill("SIGTERM");
      setTimeout(() => hijo.kill("SIGKILL"), 10_000).unref();
    }, PLAZO_DE_CELDA_MS);
    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      const limpio = redactar(salida, secretos);
      writeFileSync(registro, limpio);
      res({ codigo, plazoAgotado, registro: limpio });
    });
  });
}

const cola = (t: string, n = 6) =>
  t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" ⏎ ")
    .slice(0, 600);

/** Dónde deja cada arnés su artefacto para una celda; GSM8K no tiene flag de salida. */
function artefactoDe(c: Celda, modo: Modo, dir: string): { json: string; crudo?: string } {
  switch (c.bateria) {
    case "gsm8k":
      return { json: join(RAIZ, "benchmarks", "out", "gsm8k", modo === "vivo" ? "resultado.json" : "seco.json") };
    case "bfcl":
      return { json: join(dir, "bfcl.json") };
    case "xstest":
      return { json: join(dir, "xstest.json") };
    case "mt-bench": {
      const json = existsSync(dir) ? readdirSync(dir).find((f) => /^mt-bench-.*\.json$/.test(f)) : undefined;
      const base = json ? json.replace(/\.json$/, "") : "";
      return { json: json ? join(dir, json) : join(dir, "(sin artefacto).json"), crudo: join(RAIZ, "benchmarks", "out", "mt-bench", `${base}-respuestas.jsonl`) };
    }
  }
}

async function correrCelda(
  c: Celda,
  modo: Modo,
  raiz: string,
  runId: string,
  caja: CajaGlobal,
  secretos: readonly string[],
  jornada: number | null,
): Promise<ResultadoDeCelda> {
  const que = `${c.bateria}/${c.modelo.id}`;
  const aplazada = motivoDeAplazamiento(c, jornada, modo);
  if (aplazada) {
    console.log(`[banco] ■ ${que}: aplazada por cuota diaria — ${aplazada}`);
    return { bateria: c.bateria, modelo: c.modelo.id, estado: "aplazada-por-cuota", motivo: aplazada };
  }
  const s = soporte(c.bateria, c.modelo);
  if (!s.ok) return { bateria: c.bateria, modelo: c.modelo.id, estado: "sin-soporte", motivo: s.motivo };
  // Sin la clave de su proveedor no se lanza el arnés ni se reserva caja: algunos
  // arneses (XSTest) salen con error sin artefacto, y eso no es un fallo de la capa.
  const falta = claveQueFalta(c.modelo, modo, process.env);
  if (falta) {
    console.log(`[banco] ■ ${que}: no medible — sin ${falta} en el entorno`);
    return { bateria: c.bateria, modelo: c.modelo.id, estado: "sin-clave", motivo: `sin ${falta} en el entorno` };
  }
  const reserva = modo === "vivo" ? c.reservaUsd : 0;
  try {
    caja.reservar(reserva, que);
  } catch (e) {
    if (e instanceof TopeGlobalAgotado) return { bateria: c.bateria, modelo: c.modelo.id, estado: "omitida-por-tope-global", motivo: e.message };
    throw e;
  }
  const dir = join(raiz, c.bateria, c.modelo.corto);
  mkdirSync(dir, { recursive: true });
  const previo = artefactoDe(c, modo, dir).json;
  if (c.bateria === "gsm8k") rmSync(previo, { force: true });
  const inicio = Date.now();
  console.log(`[banco] ▶ ${que} (tope ${c.topeUsd.toFixed(2)} $${c.topeJuezUsd ? ` + juez ${c.topeJuezUsd.toFixed(2)} $` : ""})`);
  const ej = await ejecutar(argumentosDe(c, modo, dir, runId), join(dir, "registro.log"), secretos, { ...process.env, BVSALA_DEV_OPEN: "1" });
  const art = artefactoDe(c, modo, dir);
  const fresco = existsSync(art.json) && statSync(art.json).mtimeMs >= inicio - 1000;
  let resultado: ResultadoDeCelda;
  if (ej.plazoAgotado) {
    resultado = { bateria: c.bateria, modelo: c.modelo.id, estado: "arnes-falla", motivo: `plazo de ${PLAZO_DE_CELDA_MS / 60_000} min agotado`, topeUsd: reserva };
  } else if (!fresco) {
    resultado = {
      bateria: c.bateria,
      modelo: c.modelo.id,
      estado: "arnes-falla",
      motivo: `el arnés salió con ${ej.codigo} sin artefacto: ${cola(ej.registro)}`,
      topeUsd: reserva,
    };
  } else {
    try {
      if (c.bateria === "gsm8k") copyFileSync(art.json, join(dir, "gsm8k.json"));
      let crudo: { modelo: string; preguntas: PreguntaCrudaMtBench[] }[] | undefined;
      if (art.crudo && existsSync(art.crudo)) {
        copyFileSync(art.crudo, join(dir, "respuestas.jsonl"));
        crudo = readFileSync(art.crudo, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { modelo: string; preguntas: PreguntaCrudaMtBench[] });
      }
      const medicion = extraer(c.bateria, JSON.parse(readFileSync(art.json, "utf8")), c.modelo, crudo);
      resultado = { bateria: c.bateria, modelo: c.modelo.id, estado: "medida", topeUsd: c.reservaUsd, medicion };
    } catch (e) {
      resultado = { bateria: c.bateria, modelo: c.modelo.id, estado: "arnes-falla", motivo: `artefacto ilegible: ${(e as Error).message}`, topeUsd: reserva };
    }
  }
  caja.liquidar(reserva, resultado.estado === "medida" ? (modo === "vivo" ? resultado.medicion.gastoUsd : 0) : null, que);
  const g = resultado.estado === "medida" ? `${resultado.medicion.gastoUsd.toFixed(4)} $` : "—";
  console.log(`[banco] ■ ${que}: ${resultado.estado}${resultado.estado === "arnes-falla" ? ` — ${resultado.motivo}` : ""} · gasto ${g} · caja ${caja.gastado.toFixed(2)} $`);
  return resultado;
}

/**
 * La jornada de este banco (índice desde 0) para los modelos con cuota diaria:
 * la de `--jornada` (desde 1) o, sin ella, la de la semana. null si ningún
 * modelo tiene cuota.
 */
export function jornadaDelBanco(argJornada: string | undefined, ahora: Date): number | null {
  const cuotas = Object.values(CUOTA_DIARIA);
  if (!cuotas.length) return null;
  if (argJornada === undefined || argJornada.trim() === "") return jornadaPorDefecto(cuotas[0]!, ahora);
  const n = Number(argJornada);
  const max = Math.max(...cuotas.map((q) => q.jornadas.length));
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--jornada: ${argJornada} no es una jornada (1…${max})`);
  return n - 1;
}

/** Por qué no se lanza la celda (su batería no toca en esta jornada), o null. En SECO no hay cuota que gastar: se lanza todo. */
export function motivoDeAplazamiento(c: Celda, jornada: number | null, modo: Modo): string | null {
  const cuota = CUOTA_DIARIA[c.modelo.id];
  if (modo !== "vivo" || !cuota || jornada === null || tocaEnLaJornada(c, jornada)) return null;
  const suya = cuota.jornadas.findIndex((js) => js.includes(c.bateria));
  return (
    `${cuota.peticiones} peticiones al día para ${c.modelo.id}: este banco mide su jornada ${(jornada % cuota.jornadas.length) + 1} ` +
    `(${cuota.jornadas[jornada % cuota.jornadas.length]!.join(", ")}); ${c.bateria} va en la ${suya + 1} ` +
    `(hasta ${peticionesMaximas(c.bateria, c.modelo)} peticiones) — \`--jornada ${suya + 1}\` otro día`
  );
}

/** Corre las celdas de una batería con su concurrencia; las baterías van en paralelo entre sí. */
async function correrCarril(celdas: Celda[], concurrencia: number, f: (c: Celda) => Promise<ResultadoDeCelda>): Promise<ResultadoDeCelda[]> {
  const out: ResultadoDeCelda[] = new Array(celdas.length);
  let i = 0;
  const trabajador = async () => {
    while (i < celdas.length) {
      const k = i++;
      out[k] = await f(celdas[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrencia, celdas.length) }, trabajador));
  return out;
}

export function filtrarCeldas(celdas: Celda[], modelos?: string, baterias?: string): Celda[] {
  const ms = modelos?.split(",").map((s) => s.trim()).filter(Boolean);
  const bs = baterias?.split(",").map((s) => s.trim()).filter(Boolean);
  for (const m of ms ?? []) {
    if (!MODELOS_DEL_BANCO.some((x) => x.id === m || x.corto === m)) throw new Error(`--modelos: ${m} no es un modelo del banco`);
  }
  for (const b of bs ?? []) if (!(BATERIAS as readonly string[]).includes(b)) throw new Error(`--baterias: ${b} no es una batería`);
  return celdas.filter((c) => (!ms || ms.includes(c.modelo.id) || ms.includes(c.modelo.corto)) && (!bs || bs.includes(c.bateria)));
}

async function principal(): Promise<void> {
  const vivo = process.argv.includes("--vivo");
  const seco = process.argv.includes("--seco");
  if (vivo === seco) throw new Error("hace falta exactamente uno de --vivo o --seco");
  const modo: Modo = vivo ? "vivo" : "seco";
  const runId = randomBytes(3).toString("hex");
  const raiz = resolve(RAIZ, arg("salida") ?? join("benchmarks", "out", "banco-semanal", runId));
  mkdirSync(raiz, { recursive: true });

  const plan = planificar();
  const errores = validarPlan(plan);
  if (errores.length) throw new Error(`plan inválido, no se gasta nada: ${errores.join("; ")}`);
  const celdas = filtrarCeldas(plan, arg("modelos"), arg("baterias"));
  const jornada = jornadaDelBanco(arg("jornada"), new Date());
  // Un banco que no lanzaría NADA (todo aplazado por cuota) no puede salir en verde sin medir.
  if (celdas.length && celdas.every((c) => motivoDeAplazamiento(c, jornada, modo) !== null)) {
    throw new Error(`nada que medir: todas las celdas elegidas quedan fuera de la jornada ${(jornada ?? 0) + 1}; elige otra con --jornada`);
  }
  const caja = new CajaGlobal();
  const secretos = valoresSecretos(process.env);
  const inicio = new Date().toISOString();
  const r = reparto(plan);
  console.log(
    `[banco] ${modo.toUpperCase()} · ${celdas.length} celdas${jornada !== null ? ` · jornada ${jornada + 1} de los modelos con cuota diaria` : ""} · asignados ${r.asignadoUsd.toFixed(2)} $ de ${caja.limiteUsd.toFixed(2)} $ · salida ${raiz}`,
  );

  // BFCL en SECO lee el dataset de su caché: se baja y verifica una vez (red a GitHub, sin gasto).
  if (modo === "seco" && celdas.some((c) => c.bateria === "bfcl")) {
    const ej = await ejecutar(["benchmarks/publicados/bfcl/arnes.ts", "--preparar"], join(raiz, "bfcl-preparar.log"), secretos, process.env);
    if (ej.codigo !== 0) console.log(`[banco] BFCL --preparar salió con ${ej.codigo}: ${cola(ej.registro)}`);
  }

  const porBateria = await Promise.all(
    BATERIAS.map((b: Bateria) =>
      correrCarril(
        celdas.filter((c) => c.bateria === b),
        CONCURRENCIA_POR_BATERIA[b],
        (c) => correrCelda(c, modo, raiz, runId, caja, secretos, jornada),
      ),
    ),
  );
  const resultados = porBateria.flat();
  // La factura real (criterio 4): solo en vivo, cuando ya no queda ninguna llamada en vuelo.
  const finDeCeldas = new Date().toISOString();
  let factura: Cuadre[] = [];
  if (modo === "vivo") {
    const previa = arg("previa") ? join(resolve(RAIZ, arg("previa")!), "resultados.json") : null;
    let previos: Cuadre[] = [];
    try {
      if (previa && existsSync(previa)) previos = cuadresPendientesDe(JSON.parse(readFileSync(previa, "utf8")));
    } catch (e) {
      console.log(`[banco] factura · la tirada anterior no se pudo leer (${(e as Error).name}): sus pendientes no se re-comprueban`);
    }
    factura = await cuadrarLaFactura({ runId, ventana: { inicio, fin: finDeCeldas }, resultados, env: process.env, previos, log: (s) => console.log(s) });
  }
  const bruto = evaluar(resultados, caja.motivoDelAborto, factura);
  const veredicto =
    modo === "vivo"
      ? bruto
      : {
          ok: bruto.infracciones.every((i) => !REGLAS_DE_FONTANERIA.has(i.regla)),
          infracciones: bruto.infracciones.filter((i) => REGLAS_DE_FONTANERIA.has(i.regla)),
          avisos: [
            ...bruto.infracciones.filter((i) => !REGLAS_DE_FONTANERIA.has(i.regla)).map((i) => `(SECO, no cuenta) ${i.regla} · ${i.bateria} · ${i.modelo}: ${i.detalle}`),
            ...bruto.avisos,
          ],
        };
  const commit = git(["rev-parse", "--short", "HEAD"]);
  const datos = {
    modo,
    commit,
    version: BV_SALA_VERSION,
    inicio,
    fin: new Date().toISOString(),
    gastoUsd: caja.gastado,
    reparto: r,
    resultados,
    veredicto,
    factura,
  };
  writeFileSync(join(raiz, "resultados.json"), redactar(JSON.stringify({ runId, ...datos, plan }, null, 2), secretos) + "\n");
  const md = redactar(resumenMarkdown(datos), secretos);
  writeFileSync(join(raiz, "resumen.md"), md);
  console.log(`\n${md}`);
  if (!veredicto.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch((e) => {
    console.error(`[banco] ${redactar(e instanceof Error ? (e.stack ?? e.message) : String(e), valoresSecretos(process.env))}`);
    process.exit(1);
  });
}

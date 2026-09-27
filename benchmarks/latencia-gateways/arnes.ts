/**
 * LATENCIA DE GATEWAYS · EL ARNÉS — `pnpm latencia:gateways`.
 *
 * Mide cuánto añade un gateway local (el de BV-SALA y los OSS que se le
 * comparan) entre el cliente y un upstream FALSO que responde al instante. Cada
 * ronda manda la misma petición directa y a través de CADA gateway, en una
 * permutación aleatoria; el sobrecoste de un gateway es la mediana de sus
 * diferencias con el directo de la misma ronda, con su IC 95 % (nucleo.ts
 * explica por qué ese estimador y por qué todos en la misma ronda).
 *
 * Qué arranca solo:
 *   · el upstream falso (proceso propio, en --puerto-upstream, 9911 por defecto);
 *   · el gateway de BV-SALA, compilado desde el fuente a un .js y corriendo en
 *     Node pelado, en dos modos: `bvsala` (solo reenvía) y `bvsala-medido` (mide
 *     cada petición contra una ingesta falsa).
 * Qué NO arranca: LiteLLM, Bifrost, Portkey y Helicone. Se lanzan a mano con las
 * versiones y configuraciones fijadas en benchmarks/latencia-gateways/README.md
 * (todas apuntan al upstream falso en 127.0.0.1:9911) y aquí se nombran:
 *
 *   pnpm latencia:gateways                                   # solo BV-SALA
 *   pnpm latencia:gateways -- --objetivos bvsala,bvsala-medido,litellm,bifrost,portkey,helicone
 *   pnpm latencia:gateways -- --rondas 600 --guardar         # evidencia en benchmarks/evidencia/
 *   pnpm latencia:gateways -- --concurrencia 32 --peticiones 4000   # además, carga (por brazo)
 *   pnpm latencia:gateways -- --escenarios 1k,200k-stream     # solo esos (1k, 1k-stream, 200k, 200k-stream)
 *
 * Ninguna petición sale de 127.0.0.1 y ninguna lleva una clave real: los
 * gateways reciben claves de relleno y el upstream falso no mira ninguna.
 */
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CABECERA_MARKDOWN,
  compararCuerpos,
  cuerpoDeChat,
  cuerpoDeFidelidad,
  esElPrincipal,
  filaMarkdown,
  ordenesMultibrazo,
  percentiles,
  resumir,
  type Fidelidad,
  type Percentiles,
  type ResumenDeEscenario,
  type Ronda,
  type Tiempos,
} from "./nucleo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..", "..");

// ── Objetivos ──────────────────────────────────────────────────────────────

export interface Objetivo {
  nombre: string;
  /** Origen del gateway, p. ej. http://127.0.0.1:4000 */
  base: string;
  /** Ruta de Chat Completions en ESE gateway. */
  rutaChat: string;
  /** El `model` que ese gateway espera para llegar al upstream falso. */
  modelo: string;
  cabeceras: Record<string, string>;
  /** Proceso a vigilar (memoria residente al final), si se conoce. */
  pid?: number;
}

/**
 * Los gateways de terceros tal como los dejan las configuraciones de
 * benchmarks/latencia-gateways/configs/ (puertos incluidos). El upstream falso
 * vive en 127.0.0.1:<puertoUpstream>; Portkey lo recibe por cabecera.
 */
export function objetivosDeTerceros(puertoUpstream: number, modeloBase = "gpt-4o-mini"): Record<string, Objetivo> {
  return {
    litellm: {
      nombre: "litellm",
      base: "http://127.0.0.1:4000",
      rutaChat: "/v1/chat/completions",
      // El alias de configs/litellm.yaml (un `model_name` por modelo).
      modelo: `bench-${modeloBase}`,
      cabeceras: {},
    },
    bifrost: {
      nombre: "bifrost",
      base: "http://127.0.0.1:8080",
      rutaChat: "/v1/chat/completions",
      modelo: `openai/${modeloBase}`,
      cabeceras: {},
    },
    portkey: {
      nombre: "portkey",
      base: "http://127.0.0.1:8787",
      rutaChat: "/v1/chat/completions",
      modelo: modeloBase,
      cabeceras: {
        "x-portkey-provider": "openai",
        "x-portkey-custom-host": `http://127.0.0.1:${puertoUpstream}/v1`,
        authorization: "Bearer relleno-no-es-una-clave",
      },
    },
    helicone: {
      nombre: "helicone",
      base: "http://127.0.0.1:8090",
      rutaChat: "/ai/chat/completions",
      modelo: `openai/${modeloBase}`,
      cabeceras: {},
    },
  };
}

// ── Escenarios ─────────────────────────────────────────────────────────────

export interface Escenario {
  /** Lo que se pasa a `--escenarios` (separados por comas). */
  id: string;
  nombre: string;
  bytes: number;
  stream: boolean;
}

export const ESCENARIOS: readonly Escenario[] = [
  { id: "1k", nombre: "chat 1 KB", bytes: 1_024, stream: false },
  { id: "1k-stream", nombre: "chat 1 KB, stream", bytes: 1_024, stream: true },
  // El tamaño de un turno de agente de código: Claude Code manda 100–200 KB por
  // petición en una sesión mediada. Un gateway que parsea o copia el cuerpo lo
  // paga aquí, no en el de 1 KB.
  { id: "200k", nombre: "chat 200 KB", bytes: 200_000, stream: false },
  { id: "200k-stream", nombre: "chat 200 KB, stream", bytes: 200_000, stream: true },
];

// ── El cliente ─────────────────────────────────────────────────────────────

export class ErrorDePeticion extends Error {}

/**
 * Una petición POST y sus tiempos, desde que se empieza a escribir hasta el
 * primer byte del cuerpo y hasta el final. Un estado ≠ 200 es un error: una
 * respuesta de error rápida no puede pasar por una petición rápida.
 */
export function peticion(agente: Agent, url: URL, cuerpo: string, cabeceras: Record<string, string>): Promise<Tiempos> {
  return new Promise((resolver, rechazar) => {
    const t0 = process.hrtime.bigint();
    let primero: bigint | null = null;
    const req = request(
      url,
      {
        method: "POST",
        agent: agente,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(cuerpo), ...cabeceras },
      },
      (res) => {
        const trozos: Buffer[] = [];
        res.on("data", (t: Buffer) => {
          if (primero === null) primero = process.hrtime.bigint();
          trozos.push(t);
        });
        res.on("end", () => {
          const fin = process.hrtime.bigint();
          if (res.statusCode !== 200) {
            const texto = Buffer.concat(trozos).toString("utf8").slice(0, 300);
            rechazar(new ErrorDePeticion(`HTTP ${res.statusCode} en ${url.href}: ${texto}`));
            return;
          }
          const ms = (t: bigint) => Number(t - t0) / 1e6;
          resolver({ primerByteMs: ms(primero ?? fin), totalMs: ms(fin) });
        });
        res.on("error", rechazar);
      },
    );
    req.on("error", rechazar);
    req.end(cuerpo);
  });
}

export interface DestinoDeMedida {
  url: URL;
  cabeceras: Record<string, string>;
  cuerpo: string;
}

export interface BrazoDeMedida {
  nombre: string;
  destino: DestinoDeMedida;
}

/**
 * Las rondas de un escenario con TODOS los gateways a la vez: en cada ronda, el
 * directo y cada gateway en una permutación aleatoria (nucleo.ts →
 * ordenesMultibrazo). Devuelve, por gateway, sus rondas pareadas con el directo
 * de la MISMA ronda, listas para `resumir`.
 */
export async function medirEscenarioMultibrazo(opts: {
  directo: DestinoDeMedida;
  gateways: readonly BrazoDeMedida[];
  rondas: number;
  calentamiento: number;
  semilla?: number;
}): Promise<Record<string, Ronda[]>> {
  const brazos: DestinoDeMedida[] = [opts.directo, ...opts.gateways.map((g) => g.destino)];
  const agentes = brazos.map(() => new Agent({ keepAlive: true, maxSockets: 1 }));
  const una = (i: number) => peticion(agentes[i]!, brazos[i]!.url, brazos[i]!.cuerpo, brazos[i]!.cabeceras);
  try {
    for (let c = 0; c < opts.calentamiento; c++) for (let i = 0; i < brazos.length; i++) await una(i);
    const salida: Record<string, Ronda[]> = Object.fromEntries(opts.gateways.map((g) => [g.nombre, [] as Ronda[]]));
    for (const orden of ordenesMultibrazo(opts.rondas, brazos.length, opts.semilla)) {
      const t: Tiempos[] = new Array(brazos.length);
      for (const i of orden) t[i] = await una(i);
      const posDirecto = orden.indexOf(0);
      opts.gateways.forEach((g, k) => {
        salida[g.nombre]!.push({
          directo: t[0]!,
          gateway: t[k + 1]!,
          primero: posDirecto < orden.indexOf(k + 1) ? "directo" : "gateway",
        });
      });
    }
    return salida;
  } finally {
    for (const a of agentes) a.destroy();
  }
}

export interface ResultadoDeFidelidad {
  /** Lo que llegó al upstream frente a lo que mandó el cliente (sin contar `model`). */
  peticion: Fidelidad;
  /** Lo que devolvió el gateway frente a lo que devuelve el upstream directo. */
  respuesta: Fidelidad;
}

/**
 * La prueba de fidelidad: una petición con los campos que cambian la factura
 * (nucleo.ts → cuerpoDeFidelidad) por el gateway, y lo que el upstream falso
 * dice haber recibido; y la respuesta por el gateway frente a la directa. No se
 * cronometra.
 */
export async function medirFidelidad(o: Objetivo, origenUpstream: string, modeloBase = "gpt-4o-mini"): Promise<ResultadoDeFidelidad> {
  const post = async (url: URL, cuerpo: string, cabeceras: Record<string, string>) => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...cabeceras }, body: cuerpo });
    const texto = await r.text();
    if (!r.ok) throw new ErrorDePeticion(`HTTP ${r.status} en ${url.href}: ${texto.slice(0, 300)}`);
    return texto;
  };
  const enviado = cuerpoDeFidelidad(o.modelo);
  const viaGateway = await post(new URL(o.rutaChat, o.base), enviado, o.cabeceras);
  const recibido = await (await fetch(new URL("/banco/ultima-peticion", origenUpstream))).text();
  const directa = await post(new URL("/v1/chat/completions", origenUpstream), cuerpoDeFidelidad(modeloBase), {});
  return { peticion: compararCuerpos(enviado, recibido, ["model"]), respuesta: compararCuerpos(directa, viaGateway) };
}

export interface CargaDeBrazo {
  rps: number;
  total: Percentiles;
  errores: number;
  peticiones: number;
}

/**
 * Carga con varios brazos: dos pasadas por todos (directo incluido), la segunda
 * en orden inverso, con `peticionesPorBrazo / 2` en cada bloque. La alternancia
 * reparte la deriva de la máquina entre brazos; no la elimina (con N en vuelo no
 * hay pares).
 */
export async function medirCargaVarios(opts: {
  brazos: readonly BrazoDeMedida[];
  concurrencia: number;
  peticionesPorBrazo: number;
}): Promise<Record<string, CargaDeBrazo>> {
  const porBloque = Math.max(1, Math.floor(opts.peticionesPorBrazo / 2));
  const acum = new Map<string, { ms: number[]; segundos: number; errores: number }>();
  for (const b of opts.brazos) acum.set(b.nombre, { ms: [], segundos: 0, errores: 0 });
  const pasadas = [opts.brazos, [...opts.brazos].reverse()];
  for (const pasada of pasadas) {
    for (const b of pasada) {
      const a = acum.get(b.nombre)!;
      const agente = new Agent({ keepAlive: true, maxSockets: opts.concurrencia });
      let pendientes = porBloque;
      const t0 = process.hrtime.bigint();
      const trabajador = async () => {
        while (pendientes > 0) {
          pendientes--;
          try {
            a.ms.push((await peticion(agente, b.destino.url, b.destino.cuerpo, b.destino.cabeceras)).totalMs);
          } catch {
            a.errores++;
          }
        }
      };
      await Promise.all(Array.from({ length: opts.concurrencia }, trabajador));
      a.segundos += Number(process.hrtime.bigint() - t0) / 1e9;
      agente.destroy();
    }
  }
  const out: Record<string, CargaDeBrazo> = {};
  for (const [n, a] of acum) out[n] = { rps: a.ms.length / a.segundos, total: percentiles(a.ms), errores: a.errores, peticiones: porBloque * 2 };
  return out;
}

// ── Procesos ───────────────────────────────────────────────────────────────

/**
 * El lanzador de BV-SALA COMPILADO a un .js (tsup, sin las defines de npm: la
 * clave inyectada sigue valiendo, como desde el fuente). Así el gateway corre en
 * Node pelado, como el paquete publicado, y ni la latencia ni la memoria cargan
 * con el transpilador de tsx. `--bvsala-desde-fuente` lo salta.
 */
function compilarLanzador(): string {
  const destino = mkdtempSync(join(tmpdir(), "bvsala-banco-"));
  process.on("exit", () => rmSync(destino, { recursive: true, force: true }));
  execFileSync(
    "pnpm",
    ["-s", "exec", "tsup", join(AQUI, "lanzar-bvsala.ts"), "--no-config", "--format", "esm", "--platform", "node", "--target", "node20", "--out-dir", destino, "--silent"],
    { cwd: RAIZ, stdio: ["ignore", "ignore", "inherit"] },
  );
  return join(destino, "lanzar-bvsala.js");
}

/**
 * Arranca un fichero como proceso propio y espera `{ listo: puerto }`: un .ts de
 * este directorio con tsx, o un .js ya compilado con Node pelado.
 */
function lanzar(fichero: string, args: string[]): Promise<{ hijo: ChildProcess; puerto: number }> {
  return new Promise((resolver, rechazar) => {
    const js = fichero.endsWith(".js");
    const hijo = fork(js ? fichero : join(AQUI, fichero), args, {
      cwd: RAIZ,
      execArgv: js ? [] : ["--import", "tsx"],
      // stdout a /dev/null: el log por petición del gateway cuesta lo mismo que
      // en una terminal que no lo lee. stderr se ve (arranque y errores).
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const tope = setTimeout(() => rechazar(new Error(`${fichero} no avisó en 30 s`)), 30_000);
    hijo.once("message", (m) => {
      clearTimeout(tope);
      const puerto = (m as { listo?: number }).listo;
      if (typeof puerto === "number") resolver({ hijo, puerto });
      else rechazar(new Error(`${fichero}: mensaje inesperado ${JSON.stringify(m)}`));
    });
    hijo.once("exit", (code) => {
      clearTimeout(tope);
      rechazar(new Error(`${fichero} salió con ${code} antes de avisar`));
    });
  });
}

/** Memoria residente de un proceso en MB (ps), o null si no se puede leer. */
export function rssMb(pid: number): number | null {
  try {
    const kb = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

/** Lo que el upstream falso ha recibido, por tipo (le pregunta por IPC). */
function recuentoDe(hijo: ChildProcess): Promise<Record<string, number> | null> {
  return new Promise((resolver) => {
    const tope = setTimeout(() => resolver(null), 2_000);
    hijo.once("message", (m) => {
      clearTimeout(tope);
      resolver((m as { recuento?: Record<string, number> }).recuento ?? null);
    });
    hijo.send({ pide: "recuento" });
  });
}

// ── Principal ──────────────────────────────────────────────────────────────

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pids(): Record<string, number> {
  const out: Record<string, number> = {};
  process.argv.forEach((a, i) => {
    if (a !== "--pid") return;
    const [n, p] = (process.argv[i + 1] ?? "").split("=");
    if (n && p && Number.isFinite(Number(p))) out[n] = Number(p);
  });
  return out;
}

async function principal(): Promise<void> {
  const cargaAlEmpezar = loadavg().map((x) => Math.round(x * 10) / 10);
  const puertoUpstream = Number(arg("--puerto-upstream") ?? 9911);
  const rondas = Number(arg("--rondas") ?? 400);
  const calentamiento = Number(arg("--calentamiento") ?? 40);
  const concurrencia = arg("--concurrencia") ? Number(arg("--concurrencia")) : 0;
  const peticionesCarga = Number(arg("--peticiones") ?? 4000);
  const nombres = (arg("--objetivos") ?? "bvsala,bvsala-medido").split(",").map((s) => s.trim()).filter(Boolean);
  const soloEscenarios = arg("--escenarios")?.split(",").map((s) => s.trim());
  const escenarios = ESCENARIOS.filter((e) => !soloEscenarios || soloEscenarios.includes(e.id));
  if (escenarios.length === 0) throw new Error(`--escenarios: ninguno conocido (${ESCENARIOS.map((e) => e.id).join(", ")})`);
  const pidsDeTerceros = pids();

  const hijos: ChildProcess[] = [];
  const limpiar = () => hijos.forEach((h) => h.connected && h.disconnect());
  process.on("exit", limpiar);

  // Con --usar-upstream-existente el upstream falso ya corre (lanzado a mano en
  // --puerto-upstream) y el arnés no arranca otro.
  const existente = process.argv.includes("--usar-upstream-existente");
  const up = existente ? null : await lanzar("upstream-falso.ts", ["--puerto", String(puertoUpstream)]);
  if (up) hijos.push(up.hijo);
  const origenUpstream = `http://127.0.0.1:${up?.puerto ?? puertoUpstream}`;
  console.error(`upstream falso en ${origenUpstream}`);

  const terceros = objetivosDeTerceros(up?.puerto ?? puertoUpstream);
  const objetivos: Objetivo[] = [];
  const conBvsala = nombres.some((n) => n.startsWith("bvsala"));
  const lanzadorBvsala = conBvsala && !process.argv.includes("--bvsala-desde-fuente") ? compilarLanzador() : "lanzar-bvsala.ts";
  for (const n of nombres) {
    if (n === "bvsala" || n === "bvsala-medido") {
      const g = await lanzar(lanzadorBvsala, ["--upstream", origenUpstream, "--modo", n === "bvsala" ? "paso" : "medido"]);
      hijos.push(g.hijo);
      objetivos.push({ nombre: n, base: `http://127.0.0.1:${g.puerto}`, rutaChat: "/v1/chat/completions", modelo: "gpt-4o-mini", cabeceras: {}, ...(g.hijo.pid ? { pid: g.hijo.pid } : {}) });
    } else if (terceros[n]) {
      const o = terceros[n]!;
      objetivos.push(pidsDeTerceros[n] ? { ...o, pid: pidsDeTerceros[n]! } : o);
    } else {
      throw new Error(`objetivo desconocido: ${n} (conocidos: bvsala, bvsala-medido, ${Object.keys(terceros).join(", ")})`);
    }
  }

  const resultados: { objetivo: string; escenario: string; resumen: ResumenDeEscenario }[] = [];
  // Fidelidad por modelo: gpt-4o-mini no admite Flex en OpenAI y un gateway que
  // quite `service_tier` ahí podría estar «protegiendo» al cliente de un 400;
  // gpt-5-mini sí lo admite, y ahí quitarlo es cobrar el doble.
  const modelosFidelidad = (arg("--modelos-fidelidad") ?? "gpt-4o-mini,gpt-5-mini").split(",").map((s) => s.trim()).filter(Boolean);
  const fidelidades: Record<string, ResultadoDeFidelidad | { error: string }> = {};
  const errores: { objetivo: string; escenario: string; error: string }[] = [];
  const filasDeError: string[] = [];
  const memoria: Record<string, number | null> = {};
  const filas: string[] = [];
  // 1 · Fidelidad, gateway a gateway (no se cronometra).
  for (const o of objetivos) {
    for (const m of modelosFidelidad) {
      const clave = `${o.nombre} · ${m}`;
      const destino = terceros[o.nombre] ? objetivosDeTerceros(up?.puerto ?? puertoUpstream, m)[o.nombre]! : { ...o, modelo: m };
      try {
        fidelidades[clave] = await medirFidelidad({ ...o, modelo: destino.modelo, cabeceras: destino.cabeceras }, origenUpstream, m);
      } catch (e) {
        fidelidades[clave] = { error: (e instanceof Error ? e.message : String(e)).replace(/\|/g, "/").slice(0, 200) };
      }
    }
  }

  // 2 · Latencia: todos los gateways en las mismas rondas, escenario a escenario.
  for (const [i, e] of escenarios.entries()) {
    const directo: DestinoDeMedida = {
      url: new URL("/v1/chat/completions", origenUpstream),
      cabeceras: {},
      cuerpo: cuerpoDeChat({ bytes: e.bytes, modelo: "gpt-4o-mini", stream: e.stream }),
    };
    // Una sonda por gateway: el que falla en este escenario sale como fila de
    // error y no entra en las rondas (un 500 rápido no es un gateway rápido).
    const vivos: BrazoDeMedida[] = [];
    for (const o of objetivos) {
      const destino: DestinoDeMedida = {
        url: new URL(o.rutaChat, o.base),
        cabeceras: o.cabeceras,
        cuerpo: cuerpoDeChat({ bytes: e.bytes, modelo: o.modelo, stream: e.stream }),
      };
      const sonda = new Agent({ keepAlive: false });
      try {
        await peticion(sonda, destino.url, destino.cuerpo, destino.cabeceras);
        vivos.push({ nombre: o.nombre, destino });
      } catch (err) {
        const motivo = (err instanceof Error ? err.message : String(err)).replace(/\|/g, "/").slice(0, 160);
        errores.push({ objetivo: o.nombre, escenario: e.nombre, error: motivo });
        filasDeError.push(`| ${o.nombre} | ${e.nombre} | 0 | error: ${motivo} | — | — | — |`);
      } finally {
        sonda.destroy();
      }
    }
    console.error(`· ${e.nombre} · ${rondas} rondas · ${vivos.map((v) => v.nombre).join(", ")}`);
    const porGateway = await medirEscenarioMultibrazo({ directo, gateways: vivos, rondas, calentamiento, semilla: 1000 + i });
    for (const v of vivos) {
      const resumen = resumir(porGateway[v.nombre]!, 7 + i);
      resultados.push({ objetivo: v.nombre, escenario: e.nombre, resumen });
    }
  }

  // 3 · Carga (opcional): todos los brazos en bloques alternos.
  let cargaPorBrazo: Record<string, CargaDeBrazo> | null = null;
  if (concurrencia > 0) {
    const cuerpo = (m: string) => cuerpoDeChat({ bytes: 1_024, modelo: m, stream: false });
    console.error(`· carga c=${concurrencia} · ${peticionesCarga} peticiones por brazo`);
    cargaPorBrazo = await medirCargaVarios({
      brazos: [
        { nombre: "directo", destino: { url: new URL("/v1/chat/completions", origenUpstream), cabeceras: {}, cuerpo: cuerpo("gpt-4o-mini") } },
        ...objetivos.map((o) => ({ nombre: o.nombre, destino: { url: new URL(o.rutaChat, o.base), cabeceras: o.cabeceras, cuerpo: cuerpo(o.modelo) } })),
      ],
      concurrencia,
      peticionesPorBrazo: peticionesCarga,
    });
  }
  for (const o of objetivos) if (o.pid) memoria[o.nombre] = rssMb(o.pid);

  // Las filas, ordenadas por gateway y escenario como antes.
  for (const o of objetivos) {
    for (const e of escenarios) {
      const r = resultados.find((x) => x.objetivo === o.nombre && x.escenario === e.nombre);
      if (r) filas.push(filaMarkdown(o.nombre, e.nombre, r.resumen));
      else filas.push(...filasDeError.filter((f) => f.startsWith(`| ${o.nombre} | ${e.nombre} |`)));
    }
  }

  console.log(CABECERA_MARKDOWN);
  for (const f of filas) console.log(f);
  if (cargaPorBrazo) {
    const d = cargaPorBrazo["directo"]!;
    console.log(
      `\n| Brazo | Concurrencia | Peticiones | RPS | p50 (ms) | p99 (ms) | Errores |\n|---|---|---|---|---|---|---|`,
    );
    for (const [n, c] of Object.entries(cargaPorBrazo)) {
      console.log(`| ${n} | ${concurrencia} | ${c.peticiones} | ${c.rps.toFixed(0)} | ${c.total.p50.toFixed(2)} | ${c.total.p99.toFixed(2)} | ${c.errores} |`);
    }
    console.log(`\n(El directo marca el techo del cliente: ${d.rps.toFixed(0)} RPS.)`);
  }
  console.log("\n| Gateway | Petición: bytes intactos | Petición: claves perdidas / añadidas / cambiadas (sin `model`) | Respuesta: bytes intactos | Respuesta: claves perdidas / añadidas / cambiadas |\n|---|---|---|---|---|");
  const lista = (xs: string[]) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "—");
  for (const [n, fi] of Object.entries(fidelidades)) {
    if ("error" in fi) {
      console.log(`| ${n} | error: ${fi.error} | | | |`);
      continue;
    }
    const p = fi.peticion;
    const r = fi.respuesta;
    console.log(
      `| ${n} | ${p.identicoEnBytes ? "sí" : "no"} | ${lista(p.perdidas)} / ${lista(p.anadidas)} / ${lista(p.cambiadas)} | ` +
        `${r.identicoEnBytes ? "sí" : "no"} | ${lista(r.perdidas)} / ${lista(r.anadidas)} / ${lista(r.cambiadas)} |`,
    );
  }
  if (Object.keys(memoria).length) console.log(`\nMemoria residente al final (MB): ${JSON.stringify(memoria)}`);

  if (process.argv.includes("--guardar")) {
    const fecha = new Date().toISOString().slice(0, 10);
    // --etiqueta distingue dos tiradas del mismo día (p. ej. «a» y «b»).
    const etiqueta = arg("--etiqueta");
    const destino = join(RAIZ, "benchmarks", "evidencia", `latencia-gateways-${fecha}${etiqueta ? `-${etiqueta}` : ""}.json`);
    mkdirSync(dirname(destino), { recursive: true });
    const versiones: Record<string, string> = {};
    process.argv.forEach((a, i) => {
      if (a !== "--version") return;
      const [n, v] = (process.argv[i + 1] ?? "").split("=");
      if (n && v) versiones[n] = v;
    });
    writeFileSync(
      destino,
      JSON.stringify(
        {
          fecha: new Date().toISOString(),
          metodo:
            "Rondas pareadas directo/gateway en orden aleatorio equilibrado contra un upstream falso local; " +
            "sobrecoste = mediana de las diferencias con IC 95 % por bootstrap (benchmarks/latencia-gateways/nucleo.ts).",
          maquina: { cpu: cpus()[0]?.model ?? "?", nucleos: cpus().length, memoriaGb: Math.round(totalmem() / 2 ** 30), node: process.version, plataforma: `${process.platform}/${process.arch}` },
          parametros: { rondas, calentamiento, concurrencia, peticionesCarga, bvsalaCompilado: !process.argv.includes("--bvsala-desde-fuente") },
          // La carga media de la máquina al terminar (1, 5 y 15 min): la tirada
          // compartió máquina con otros procesos y esto lo deja escrito.
          cargaDeLaMaquina: { alEmpezar: cargaAlEmpezar, alTerminar: loadavg().map((x) => Math.round(x * 10) / 10) },
          versiones,
          resultados,
          errores,
          fidelidades,
          carga: cargaPorBrazo,
          memoriaMb: memoria,
          recuentoDelUpstream: up ? await recuentoDe(up.hijo) : null,
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`evidencia en ${destino}`);
  }
  limpiar();
}

if (esElPrincipal(import.meta.url)) {
  principal().then(
    () => process.exit(0),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}

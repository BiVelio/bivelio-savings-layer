/**
 * EL REPLAY DE LA PALANCA DE TTL sobre las capturas del espía (~/.bvsala-f0).
 *
 * Lee cada captura en STREAMING, decide cada petición con el código real del
 * gateway (nucleo.ts → gateway/tarifa.ts), simula la factura con y sin la
 * palanca y escribe SOLO agregados: cifras, conteos, intervalos.
 *
 * PRIVACIDAD — la captura es tráfico privado del dueño:
 *  · De cada registro se leen el cuerpo de la petición (para la huella, que
 *    son hashes), el `usage` de la respuesta, `at`, `status` y UNA cabecera:
 *    `x-claude-code-session-id`, que se hashea en cuanto se lee. Ninguna otra
 *    cabecera se toca (la captura puede llevar la clave de API en ellas).
 *  · Nada de contenido sale: ni a la consola, ni a la salida, ni en errores
 *    (una línea ilegible se cuenta y se salta; el mensaje del parser, que
 *    puede citar el texto, jamás se imprime).
 *  · La salida no lleva ids de sesión, ni siquiera hasheados: solo cuentas.
 *
 * Uso:
 *   pnpm ttl:replay [captura.jsonl ...] [--salida=<ruta.json>] [--remuestreos=10000]
 *   (sin capturas: todas las de ~/.bvsala-f0/)
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { PRIMA_1H, PRIMA_5M, UMBRAL_REESCRITURA, visitarMarcasDeCache } from "../../gateway/tarifa.js";
import { PRECIOS_AL_DIA, precioDeLista } from "../../src/pricing/catalogo.js";
import {
  agregar,
  bootstrap,
  DecisorComoElGateway,
  diaDe,
  prepararCuerpo,
  TTL_1H_MS,
  TTL_5M_MS,
  type CuerpoPreparado,
  desglosar,
  simular,
  type FilaTtl,
  type OpcionesSimulacion,
  type PeticionTtl,
  type UsoTtl,
} from "./nucleo.js";

/** Los periodos de captura, por día UTC de la petición. */
export const PERIODOS: readonly { nombre: string; desde: string; hasta: string }[] = [
  { nombre: "P1 · 23-08 → 06-09 (corpus del informe de septiembre)", desde: "2026-08-23", hasta: "2026-09-06" },
  { nombre: "P2 · 07-09 → 10-09 (grabado detrás del gateway desde el 08-09)", desde: "2026-09-07", hasta: "2026-09-10" },
  { nombre: "P3 · 11-09 (la captura sigue abierta hasta el 23-09, pero solo trae tráfico del 11-09)", desde: "2026-09-11", hasta: "2026-09-23" },
];

export function periodoDe(dia: string): string {
  for (const p of PERIODOS) if (dia >= p.desde && dia <= p.hasta) return p.nombre;
  return "fuera de periodo";
}

interface UsoCrudo {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface Registro {
  at?: string;
  method?: string;
  path?: string;
  status?: number;
  requestHeaders?: Record<string, unknown>;
  requestBody?: { model?: unknown; messages?: unknown };
  sse?: { usage?: { usage?: UsoCrudo }[] };
  responseBodyBase64?: string;
}

/** El usage definitivo: message_delta pisa a message_start, el desglose se FUSIONA (regla del ObservadorSse). */
export function usageDe(r: Registro): UsoCrudo | null {
  if (r.sse?.usage?.length) {
    let uso: UsoCrudo = {};
    let desglose: UsoCrudo["cache_creation"] | undefined;
    for (const { usage } of r.sse.usage) {
      if (!usage) continue;
      if (usage.cache_creation) desglose = { ...desglose, ...usage.cache_creation };
      uso = { ...uso, ...usage };
    }
    if (desglose) uso.cache_creation = desglose;
    return uso;
  }
  if (r.responseBodyBase64 && !r.sse) {
    try {
      const d = JSON.parse(Buffer.from(r.responseBodyBase64, "base64").toString("utf8")) as { usage?: UsoCrudo };
      return d.usage ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function usoTtlDe(u: UsoCrudo): UsoTtl {
  const e5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const e1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const total = u.cache_creation_input_tokens ?? e5 + e1;
  return {
    entrada: u.input_tokens ?? 0,
    lectura: u.cache_read_input_tokens ?? 0,
    escritura5m: e5,
    escritura1h: e1,
    escrituraSinDesglose: Math.max(0, total - e5 - e1),
    salida: u.output_tokens ?? 0,
  };
}

/** La misma verja que `idSeguro` en servidor.ts; el valor se hashea al instante. */
function sesionDe(cabeceras: Record<string, unknown> | undefined): string | undefined {
  const v = cabeceras?.["x-claude-code-session-id"];
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== "string" || !/^[A-Za-z0-9._:/-]{1,128}$/.test(s)) return undefined;
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export interface Diagnostico {
  ficheros: number;
  lineas: number;
  ilegibles: number;
  messages: number;
  sinUsage: number;
  noOk: number;
  sinSesion: number;
  intactos: number;
  desordenadas: number;
  /** Peticiones con la fracción nueva ≥ umbral (la regla diría «rebaja»). */
  sobreUmbral: number;
  /** De ellas, sin ninguna marca de 1h que rebajar (rebajarTtlDeCache → null). */
  sobreUmbralSinMarcas1h: number;
  /** Peticiones sin ninguna marca de 1h, en total. */
  sinMarcas1h: number;
  /** Hilos de caché distintos (sesión + system). */
  hilos: number;
}

/**
 * ¿Pasó este cuerpo por la palanca de un gateway ANTES de llegar al espía?
 *
 * Desde el 2026-09-08 el espía grabó DETRÁS de un gateway con la palanca
 * armada (las capturas lo delatan: `claude-fable-5-1`, el modelo hermano,
 * aparece el 09-07, y las marcas `"ttl":"5m"` explícitas el 09-08, el mismo
 * día que producción empieza a acreditar ahorro medido). Claude Code nunca
 * escribe `"5m"`: pide `"1h"` o deja la marca sin `ttl`. Un cuerpo cuyas
 * marcas son TODAS `"5m"` explícitas es la salida de `rebajarTtlDeCache`.
 *
 * Si lo es, devuelve el cuerpo con esas marcas otra vez en `"1h"` (lo que
 * mandó el cliente) y `true`. Recorre solo los sitios donde la API lee una
 * marca, con el mismo visitante que la palanca (visitarMarcasDeCache).
 */
export function restaurarMarcas(json: Record<string, unknown>): boolean {
  const marcas: Record<string, unknown>[] = [];
  visitarMarcasDeCache(json, (m) => marcas.push(m));
  if (marcas.length === 0 || !marcas.every((m) => m.ttl === "5m")) return false;
  for (const m of marcas) m.ttl = "1h";
  return true;
}

/** Lo que el replay necesita de una petición para reconstruir su línea base. */
export interface ParaRestaurar {
  atMs: number;
  hilo: string;
  modelo: string;
  uso: UsoTtl;
  rebajadaEnOrigen: boolean;
}

/** La palanca TAL COMO CORRIÓ entonces, leída de la captura (por modelo). */
export interface PalancaReal {
  peticiones: number;
  rebajas: number;
  /** Prima ahorrada por esas rebajas (5m escrito × entrada × 0,75). */
  bruto: number;
  /** Turnos siguientes que reescribieron lo que una entrada de 1h habría guardado. */
  fallos: number;
  /** Lo que esos fallos costaron de más (estimado al deshacerlos). */
  costeFallos: number;
}

/**
 * Reconstruye la LÍNEA BASE (sin palanca) de un tramo grabado detrás del
 * gateway, en sitio, en orden de llegada:
 *
 *  1. Una petición rebajada en origen escribió a 5m lo que el cliente pidió a
 *     1h: su escritura de 5m vuelve a 1h.
 *  2. El turno siguiente de su hilo, si llegó pasados 5 min (y antes de 1h),
 *     pagó un fallo que la base no habría pagado: lo que la entrada de 1h
 *     habría cubierto (hasta lectura + escritura del turno rebajado) vuelve de
 *     escritura a lectura.
 *
 * Devuelve la palanca real por modelo: rebajas, bruto y fallos observados.
 */
export function restaurarAntesDelGateway(peticiones: ParaRestaurar[]): Record<string, PalancaReal> {
  const porModelo: Record<string, PalancaReal> = {};
  const previo = new Map<string, { atMs: number; rebajada: boolean; cubierto: number }>();
  for (const p of peticiones) {
    const m = (porModelo[p.modelo] ??= { peticiones: 0, rebajas: 0, bruto: 0, fallos: 0, costeFallos: 0 });
    m.peticiones++;
    const precio = precioDeLista(p.modelo, p.atMs);
    const entrada = (precio?.inputPer1k ?? 0) / 1000;
    const lectura = (precio?.cachedInputPer1k ?? (precio?.inputPer1k ?? 0) * 0.1) / 1000;
    const u = p.uso;
    const ant = previo.get(p.hilo);
    if (ant !== undefined && ant.rebajada) {
      const hueco = p.atMs - ant.atMs;
      if (hueco > TTL_5M_MS && hueco <= TTL_1H_MS) {
        const escrito = u.escritura1h + u.escritura5m + u.escrituraSinDesglose;
        const devuelto = Math.max(0, Math.min(ant.cubierto, u.lectura + escrito) - u.lectura);
        if (devuelto > 0) {
          let resto = devuelto;
          const de1h = Math.min(resto, u.escritura1h);
          u.escritura1h -= de1h;
          resto -= de1h;
          const de5m = Math.min(resto, u.escritura5m);
          u.escritura5m -= de5m;
          resto -= de5m;
          u.escrituraSinDesglose -= Math.min(resto, u.escrituraSinDesglose);
          u.lectura += devuelto;
          m.fallos++;
          // Lo pagado de más: escribir (a la prima de ese turno) lo que se habría leído.
          const prima = p.rebajadaEnOrigen ? PRIMA_5M : PRIMA_1H;
          m.costeFallos += devuelto * (entrada * prima - lectura);
        }
      }
    }
    if (p.rebajadaEnOrigen) {
      m.rebajas++;
      m.bruto += u.escritura5m * entrada * (PRIMA_1H - PRIMA_5M);
      u.escritura1h += u.escritura5m;
      u.escritura5m = 0;
    }
    previo.set(p.hilo, {
      atMs: p.atMs,
      rebajada: p.rebajadaEnOrigen,
      cubierto: u.lectura + u.escritura1h + u.escritura5m + u.escrituraSinDesglose,
    });
  }
  return porModelo;
}

interface Leida {
  atMs: number;
  orden: number;
  sesion: string | undefined;
  modelo: string;
  uso: UsoTtl;
  prep: CuerpoPreparado | null;
  rebajadaEnOrigen: boolean;
}

async function leer(
  ficheros: string[],
): Promise<{ peticiones: PeticionTtl[]; diag: Diagnostico; palancaReal: Record<string, Record<string, PalancaReal>> }> {
  const leidas: Leida[] = [];
  const diag: Diagnostico = { ficheros: ficheros.length, lineas: 0, ilegibles: 0, messages: 0, sinUsage: 0, noOk: 0, sinSesion: 0, intactos: 0, desordenadas: 0, sobreUmbral: 0, sobreUmbralSinMarcas1h: 0, sinMarcas1h: 0, hilos: 0 };
  let ultimoMs = -Infinity;
  for (const ruta of ficheros) {
    const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
    for await (const linea of rl) {
      if (!linea) continue;
      diag.lineas++;
      let r: Registro;
      try {
        r = JSON.parse(linea) as Registro;
      } catch {
        diag.ilegibles++;
        continue;
      }
      if (r.method !== "POST" || r.path !== "/v1/messages" || !Array.isArray(r.requestBody?.messages)) continue;
      diag.messages++;
      if (r.status !== 200) {
        diag.noOk++;
        continue;
      }
      const uso = usageDe(r);
      const atMs = r.at ? Date.parse(r.at) : NaN;
      if (uso === null || !Number.isFinite(atMs)) {
        diag.sinUsage++;
        continue;
      }
      // La captura graba al TERMINAR la respuesta; el gateway decide al LLEGAR.
      if (atMs < ultimoMs) diag.desordenadas++;
      ultimoMs = Math.max(ultimoMs, atMs);
      const sesion = sesionDe(r.requestHeaders);
      if (sesion === undefined) diag.sinSesion++;
      // Lo que mandó el CLIENTE: si un gateway ya rebajó el cuerpo, se deshace.
      const rebajadaEnOrigen = restaurarMarcas(r.requestBody as Record<string, unknown>);
      // El gateway recibe el cuerpo en bytes: se le da en bytes.
      const prep = prepararCuerpo(Buffer.from(JSON.stringify(r.requestBody), "utf8"));
      if (prep === null) diag.intactos++;
      leidas.push({
        atMs,
        orden: leidas.length,
        sesion,
        modelo: typeof r.requestBody?.model === "string" ? r.requestBody.model : "?",
        uso: usoTtlDe(uso),
        prep,
        rebajadaEnOrigen,
      });
    }
  }
  // Orden de llegada (estable): así es como el gateway habría visto el tráfico.
  leidas.sort((a, b) => a.atMs - b.atMs || a.orden - b.orden);
  // La línea base de los tramos grabados detrás del gateway, por periodo.
  const palancaReal: Record<string, Record<string, PalancaReal>> = {};
  for (const periodo of new Set(leidas.map((l) => periodoDe(diaDe(l.atMs))))) {
    palancaReal[periodo] = restaurarAntesDelGateway(
      leidas
        .filter((l) => periodoDe(diaDe(l.atMs)) === periodo)
        .map((l) => ({
          atMs: l.atMs,
          hilo: `${l.sesion ?? "sin-sesion"}:${l.prep?.huella.system ?? "?"}`,
          modelo: l.modelo,
          uso: l.uso,
          rebajadaEnOrigen: l.rebajadaEnOrigen,
        })),
    );
  }
  const decisor = new DecisorComoElGateway();
  const hilos = new Set<string>();
  const peticiones = leidas.map((l): PeticionTtl => {
    const d = decisor.decidir(l.prep, l.sesion, l.atMs);
    hilos.add(d.hilo);
    if (l.prep !== null && l.prep.rebaja === null) diag.sinMarcas1h++;
    if (d.fraccion >= UMBRAL_REESCRITURA) {
      diag.sobreUmbral++;
      if (l.prep !== null && l.prep.rebaja === null) diag.sobreUmbralSinMarcas1h++;
    }
    return {
      atMs: l.atMs,
      sesion: l.sesion ?? `sin-sesion:${d.hilo}`,
      hilo: d.hilo,
      prefijoComun: d.prefijoComun,
      modelo: l.modelo,
      uso: l.uso,
      rebajada: d.rebajada,
      yaEran5m: d.yaEran5m,
      herramientaDeServidor: d.herramientaDeServidor,
    };
  });
  diag.hilos = hilos.size;
  return { peticiones, diag, palancaReal };
}

const redondo = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function compacto<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? redondo(v, 4) : v])) as T;
}

/**
 * El corpus del informe del 06-09 (docs/POR-QUE-AB-Y-DONDE-ESTA-EL-DINERO.md,
 * Parte 2: 3.305 peticiones, $1.232,91). Sus totales por modelo cuadran al
 * céntimo con P1 SIN claude-sonnet-5 (fable-5 $1.036,5x en 1.92x peticiones,
 * opus-4-8 $176,76, opus-5 $19,33, haiku $0,2x): aquel análisis no incluyó
 * ese tráfico. Para reproducirlo se recorta igual.
 */
export function esCorpusDel0609(f: FilaTtl): boolean {
  return f.dia <= "2026-09-06" && !f.modelo.startsWith("claude-sonnet-5");
}

export function informeDe(filas: FilaTtl[], remuestreos: number) {
  const global = agregar(filas);
  const corpus0609 = filas.filter(esCorpusDel0609);
  return {
    global: compacto({ ...global }),
    reproduccion0609: { ...compacto({ ...agregar(corpus0609) }), ic95PorSesion: bootstrap(corpus0609, "sesion", remuestreos) },
    ic95: {
      porSesion: bootstrap(filas, "sesion", remuestreos),
      porDia: bootstrap(filas, "dia", remuestreos),
    },
    porModelo: Object.fromEntries(Object.entries(desglosar(filas, (f) => f.modelo)).map(([k, v]) => [k, compacto({ ...v })])),
    porPeriodo: Object.fromEntries(
      Object.entries(desglosar(filas, (f) => periodoDe(f.dia))).map(([k, v]) => [
        k,
        {
          ...compacto({ ...v }),
          ic95PorSesion: bootstrap(
            filas.filter((f) => periodoDe(f.dia) === k),
            "sesion",
            remuestreos,
          ),
        },
      ]),
    ),
    porPeriodoYModelo: Object.fromEntries(
      Object.entries(desglosar(filas, (f) => `${periodoDe(f.dia)} · ${f.modelo}`)).map(([k, v]) => [k, compacto({ ...v })]),
    ),
    porDia: Object.fromEntries(Object.entries(desglosar(filas, (f) => f.dia)).map(([k, v]) => [k, { peticiones: v.peticiones, costeBase: redondo(v.costeBase), neto: redondo(v.neto), rebajas: v.rebajas, fallos: v.fallos }])),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opcion = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const remuestreos = Number(opcion("remuestreos") ?? 10_000);
  const salida = opcion("salida");
  // Volcado por petición (sin contenido; sesión ya hasheada) para análisis
  // locales. NUNCA dentro del repo: lleva el ritmo del tráfico del dueño.
  const filasRuta = opcion("filas");
  const dir = join(homedir(), ".bvsala-f0");
  const explicitos = args.filter((a) => !a.startsWith("--"));
  const ficheros = (explicitos.length
    ? explicitos
    : readdirSync(dir)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(dir, f))
  ).sort((a, b) => basename(a).localeCompare(basename(b)));

  // La verja de la fe de erratas del 06-09: fable-5 tiene que salir a $10/MTok.
  const fable = precioDeLista("claude-fable-5", Date.parse("2026-09-01"));
  if (fable?.inputPer1k !== 0.01) {
    console.error("[ttl] catálogo: claude-fable-5 no está a $0,01/1k de entrada — no se valora nada");
    process.exit(1);
  }

  const t0 = Date.now();
  const { peticiones, diag, palancaReal } = await leer(ficheros);
  console.error(`[ttl] ${peticiones.length} peticiones en ${Math.round((Date.now() - t0) / 1000)} s`);

  const variantes: Record<string, OpcionesSimulacion> = {
    hilo: { prefijoCompartido: false },
    "hilo+prefijo-compartido": { prefijoCompartido: true },
    "hilo · fallo a 1,25× (aritmética del 06-09)": { prefijoCompartido: false, primaFallo: "5m" },
  };
  const resultado = {
    generado: new Date().toISOString(),
    umbral: UMBRAL_REESCRITURA,
    preciosAlDia: PRECIOS_AL_DIA,
    diagnostico: diag,
    palancaRealEnLaCaptura: Object.fromEntries(
      Object.entries(palancaReal).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([m, x]) => [m, compacto({ ...x })]))]),
    ),
    variantes: Object.fromEntries(Object.entries(variantes).map(([k, o]) => [k, informeDe(simular(peticiones, o), remuestreos)])),
  };
  if (filasRuta) {
    if (resolve(filasRuta).startsWith(resolve(dirname(fileURLToPath(import.meta.url)), "../.."))) {
      console.error("[ttl] --filas no puede apuntar dentro del repo");
      process.exit(1);
    }
    const filas = simular(peticiones, variantes.hilo!);
    writeFileSync(filasRuta, filas.map((f) => JSON.stringify(f)).join("\n") + "\n");
  }
  const json = JSON.stringify(resultado, null, 2);
  if (salida) {
    mkdirSync(dirname(salida), { recursive: true });
    writeFileSync(salida, json + "\n");
    console.error(`[ttl] agregados en ${salida}`);
  } else {
    console.log(json);
  }
}

const esMain = process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]));
if (esMain) {
  main().catch((e: unknown) => {
    // Solo el tipo de error: un mensaje podría citar contenido de la captura.
    console.error(`[ttl] fallo: ${e instanceof Error ? e.name : "desconocido"}`);
    process.exit(1);
  });
}

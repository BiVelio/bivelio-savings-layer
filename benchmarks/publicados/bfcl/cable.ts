/**
 * EL CABLE DE LA BATERÍA: presupuesto duro, contador propio y reintentos.
 * ---------------------------------------------------------------------------
 * Los DOS brazos salen por el mismo `fetch` envuelto:
 *
 *   · el brazo A lo llama directamente;
 *   · el brazo B lo recibe la capa como `fetchImpl` de su adaptador, así que
 *     también pasan por aquí las llamadas que la capa decida hacer por su
 *     cuenta (reparaciones, reintentos). Nada del brazo B escapa al contador.
 *
 * Por cada llamada: (1) antes de enviarla, si el gasto del modelo más el PEOR
 * caso de esta llamada cruza el tope, NO se envía (`PresupuestoAgotado`); (2)
 * al volver, el coste se calcula del `usage` CRUDO del proveedor con el precio
 * de lista del catálogo — la misma aritmética para los dos brazos, sin leer
 * nada del informe de la capa; (3) 429/5xx/529 se reintentan con espera
 * exponencial (respetando `retry-after`), igual para los dos brazos.
 *
 * Lo que se guarda de cada llamada es el CUERPO de la petición y de la
 * respuesta; nunca las cabeceras, que es donde viaja la clave.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { CostModel } from "../../../src/index.js";

export type Familia = "anthropic" | "openai";
export type Brazo = "A" | "B";

export class PresupuestoAgotado extends Error {
  constructor(readonly modelo: string, readonly gastado: number, readonly tope: number) {
    super(`presupuesto de ${modelo} agotado: ${gastado.toFixed(4)} $ gastados, tope ${tope} $`);
  }
}

/** El libro de gasto de UN modelo (A + B juntos contra el mismo tope). */
export class Presupuesto {
  gastado = 0;
  reservado = 0;
  readonly porBrazo: Record<Brazo, number> = { A: 0, B: 0 };
  readonly llamadas: Record<Brazo, number> = { A: 0, B: 0 };
  agotado = false;
  constructor(
    readonly modelo: string,
    readonly tope: number,
  ) {}

  /** Reserva el peor caso de una unidad de trabajo; false = no cabe y la tirada de este modelo para aquí. */
  reservar(monto: number): boolean {
    if (this.agotado || this.gastado + this.reservado + monto > this.tope) {
      this.agotado = true;
      return false;
    }
    this.reservado += monto;
    return true;
  }

  liberar(monto: number): void {
    this.reservado = Math.max(0, this.reservado - monto);
  }

  /** La guarda por llamada: ninguna llamada sale si su peor caso cruza el tope. */
  comprobarLlamada(peorCaso: number): void {
    if (this.gastado + peorCaso > this.tope) {
      this.agotado = true;
      throw new PresupuestoAgotado(this.modelo, this.gastado, this.tope);
    }
  }

  cargar(brazo: Brazo, coste: number): void {
    this.gastado += coste;
    this.porBrazo[brazo] += coste;
    this.llamadas[brazo] += 1;
  }
}

/** Uso facturable leído de la respuesta cruda, en el vocabulario común. */
export interface UsoCrudo {
  /** Entrada total (incluidas lecturas y escrituras de caché). */
  entrada: number;
  lecturaCache: number;
  escrituraCache: number;
  escritura1h: number;
  salida: number;
  razonamiento?: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function usoDeRespuesta(familia: Familia, cuerpo: unknown): UsoCrudo | null {
  const u = obj(obj(cuerpo)?.["usage"]);
  if (!u) return null;
  if (familia === "anthropic") {
    if (typeof u["input_tokens"] !== "number" || typeof u["output_tokens"] !== "number") return null;
    const lectura = num(u["cache_read_input_tokens"]);
    const escritura = num(u["cache_creation_input_tokens"]);
    return {
      entrada: num(u["input_tokens"]) + lectura + escritura,
      lecturaCache: lectura,
      escrituraCache: escritura,
      escritura1h: Math.min(escritura, num(obj(u["cache_creation"])?.["ephemeral_1h_input_tokens"])),
      salida: num(u["output_tokens"]),
    };
  }
  if (typeof u["prompt_tokens"] !== "number" || typeof u["completion_tokens"] !== "number") return null;
  const det = obj(u["prompt_tokens_details"]);
  const detSal = obj(u["completion_tokens_details"]);
  return {
    entrada: num(u["prompt_tokens"]),
    lecturaCache: num(det?.["cached_tokens"]),
    escrituraCache: num(det?.["cache_write_tokens"]),
    escritura1h: 0,
    salida: num(u["completion_tokens"]),
    ...(typeof detSal?.["reasoning_tokens"] === "number" ? { razonamiento: detSal["reasoning_tokens"] as number } : {}),
  };
}

/**
 * (entrada − leída − escrita)·in + leída·inCacheada + escrita·in·prima
 * (+ la de 1 h a 2×) + salida·out. Precios por 1k tokens, del catálogo.
 */
export function costeDeUso(u: UsoCrudo, precio: CostModel, prima: number): number {
  const normales = Math.max(0, u.entrada - u.lecturaCache - u.escrituraCache);
  const escritura5m = Math.max(0, u.escrituraCache - u.escritura1h);
  return (
    (normales / 1000) * precio.inputPer1k +
    (u.lecturaCache / 1000) * (precio.cachedInputPer1k ?? precio.inputPer1k) +
    (escritura5m / 1000) * precio.inputPer1k * prima +
    (u.escritura1h / 1000) * precio.inputPer1k * 2 +
    (u.salida / 1000) * precio.outputPer1k
  );
}

/** Tope de salida que se reserva como peor caso de una llamada (el defecto de Anthropic en la capa y en A). */
export const SALIDA_PEOR_CASO = 4096;

/** Peor caso de una llamada: el cuerpo entero como entrada (≈ 3 caracteres/token, a lo alto) + la salida máxima. */
export function peorCasoDeLlamada(cuerpo: string, precio: CostModel): number {
  const entrada = Math.ceil(cuerpo.length / 3) + 800; // + el preámbulo de herramientas del proveedor
  return (entrada / 1000) * precio.inputPer1k + (SALIDA_PEOR_CASO / 1000) * precio.outputPer1k;
}

/** Semáforo por proveedor: las baterías hermanas comparten las claves. */
export class Semaforo {
  private libres: number;
  private cola: (() => void)[] = [];
  constructor(n: number) {
    this.libres = n;
  }
  async con<T>(f: () => Promise<T>): Promise<T> {
    if (this.libres > 0) this.libres--;
    else await new Promise<void>((r) => this.cola.push(r));
    try {
      return await f();
    } finally {
      const sig = this.cola.shift();
      if (sig) sig();
      else this.libres++;
    }
  }
}

/** Una llamada tal como pasó por el cable (sin cabeceras). */
export interface LlamadaDelCable {
  brazo: Brazo;
  unidad: string;
  url: string;
  status: number;
  peticion: Obj | null;
  respuesta: Obj | null;
  uso: UsoCrudo | null;
  coste: number;
  intentos: number;
}

/** La unidad de trabajo en curso (la entrada BFCL), para atribuir llamadas del brazo B aunque vayan en paralelo. */
export const unidadEnCurso = new AsyncLocalStorage<{ unidad: string; brazo: Brazo; registro: LlamadaDelCable[] }>();

const REINTENTABLE = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface OpcionesDelCable {
  familia: Familia;
  presupuesto: Presupuesto;
  precio: CostModel;
  prima: number;
  semaforo: Semaforo;
  base?: typeof fetch;
  pausasMs?: readonly number[];
  dormir?: (ms: number) => Promise<void>;
}

/** Quita de un texto cualquier cosa con forma de credencial (por si un error del proveedor la repitiera). */
export function sinSecretos(texto: string): string {
  return texto
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9*_-]{4,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._*-]+/gi, "Bearer [redacted]")
    .replace(/(x-api-key|authorization)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1: [redacted]");
}

/** El `fetch` de un modelo y un brazo. El brazo se lee del contexto de la unidad. */
export function crearCable(o: OpcionesDelCable): typeof fetch {
  // `globalThis.fetch` en el momento de la llamada: así pasa por la verja de hosts (procedencia.ts).
  const base = o.base ?? ((i: Parameters<typeof fetch>[0], n?: Parameters<typeof fetch>[1]) => globalThis.fetch(i, n));
  const pausas = o.pausasMs ?? [1000, 2000, 4000, 8000, 16000, 30000];
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (input, init) => {
    const ctx = unidadEnCurso.getStore();
    const brazo: Brazo = ctx?.brazo ?? "B";
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const cuerpo = typeof init?.body === "string" ? init.body : "";
    o.presupuesto.comprobarLlamada(peorCasoDeLlamada(cuerpo, o.precio));
    let peticion: Obj | null = null;
    try {
      peticion = obj(JSON.parse(cuerpo)) ?? null;
    } catch {
      peticion = null;
    }
    let intentos = 0;
    let resp: Response | null = null;
    let texto = "";
    for (;;) {
      intentos++;
      resp = await o.semaforo.con(() => base(input, { ...init, signal: AbortSignal.timeout(180_000) }));
      texto = await resp.text();
      if (!REINTENTABLE.has(resp.status) || intentos > pausas.length) break;
      const ra = Number(resp.headers.get("retry-after"));
      const pausa = Math.min(60_000, Math.max(pausas[intentos - 1]!, Number.isFinite(ra) ? ra * 1000 : 0));
      await dormir(pausa * (0.75 + Math.random() * 0.5));
    }
    let respuesta: Obj | null = null;
    try {
      respuesta = obj(JSON.parse(texto)) ?? null;
    } catch {
      respuesta = null;
    }
    const uso = resp.ok ? usoDeRespuesta(o.familia, respuesta) : null;
    const coste = uso ? costeDeUso(uso, o.precio, o.prima) : 0;
    if (uso) o.presupuesto.cargar(brazo, coste);
    ctx?.registro.push({ brazo, unidad: ctx.unidad, url: new URL(url).pathname, status: resp.status, peticion, respuesta, uso, coste, intentos });
    return new Response(resp.ok ? texto : sinSecretos(texto), {
      status: resp.status,
      headers: { "content-type": resp.headers.get("content-type") ?? "application/json" },
    });
  };
}

import { createHash } from "node:crypto";

/**
 * UNA API DE MENSAJES DE ANTHROPIC DE MENTIRA, CON LA CACHÉ DE PREFIJO DE VERDAD.
 *
 * Es un `fetch` para `AnthropicProvider`: lee el cuerpo REAL que construye el
 * adaptador (herramientas, bloques de `system`, mensajes, `cache_control` y su
 * `ttl`) y factura con las reglas de la página oficial de prompt caching,
 * leída el 2026-09-27:
 *
 *  · El prefijo se recorre en orden tools → system → messages, bloque a bloque.
 *  · Se escribe SOLO en los puntos de ruptura, y solo si el prefijo hasta ese
 *    punto llega al mínimo del modelo («no error is returned»: se ignora).
 *  · Cada punto busca hacia atrás como mucho 20 posiciones (contando la suya)
 *    una entrada viva; la lectura es la coincidencia más alta (posición A).
 *  · Facturación con TTL mixtos: lectura A, escritura de 1 h (B − A), escritura
 *    de 5 min (C − B), donde B es el punto de 1 h más alto y C el último punto.
 *  · Cada lectura refresca la entrada; la vida se cuenta desde el inicio de la
 *    petición.
 *
 * Lo que NO modela (y el informe lo dice): la expulsión por presión de memoria
 * del proveedor, el aislamiento por workspace y la concurrencia —una entrada
 * solo se puede leer cuando la primera respuesta ya empezó—. Todas empujan en
 * la misma dirección: menos aciertos de los que da el simulador. Por eso las
 * cifras que salen de aquí son [simulado] y nunca [medido].
 *
 * Los tokens son `ceil(caracteres / 4)` por bloque: no hace falta el
 * tokenizador de Anthropic para comparar DOS colocaciones sobre el mismo texto.
 */

export interface FacturaDeLlamada {
  input: number;
  read: number;
  write5m: number;
  write1h: number;
  output: number;
  /** Los `cache_control` que llevaba el cuerpo, por posición de bloque. */
  puntos: { bloque: number; ttl: "5m" | "1h" }[];
  totalBloques: number;
}

interface Entrada {
  expira: number;
  ttlMs: number;
}

const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;

export class CacheAnthropicSimulada {
  readonly facturas: FacturaDeLlamada[] = [];
  readonly cuerpos: Record<string, unknown>[] = [];
  private readonly entradas = new Map<string, Entrada>();
  /** Si es true, el proveedor «no lee nunca» (otro workspace, expulsión): para probar la verja del contador. */
  sinLecturas = false;
  /**
   * Si se fija, solo se leen entradas de los primeros N bloques: un cable que
   * cambia bytes a partir de ahí (lo que el espejo de la capa no puede ver).
   */
  leerSoloHastaBloque: number | null = null;

  constructor(
    private readonly ahora: () => number,
    private readonly minimo = 1024,
    private readonly salida = 50,
  ) {}

  readonly fetch = (async (_url: unknown, init: { body: string }) => {
    const cuerpo = JSON.parse(init.body) as Record<string, unknown>;
    this.cuerpos.push(cuerpo);
    const f = this.facturar(cuerpo);
    this.facturas.push(f);
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: f.input,
          output_tokens: f.output,
          cache_read_input_tokens: f.read,
          cache_creation_input_tokens: f.write5m + f.write1h,
          cache_creation: { ephemeral_5m_input_tokens: f.write5m, ephemeral_1h_input_tokens: f.write1h },
        },
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  /** Suma de todas las facturas, en tokens. */
  total(): Omit<FacturaDeLlamada, "puntos" | "totalBloques"> {
    return this.facturas.reduce(
      (a, f) => ({
        input: a.input + f.input,
        read: a.read + f.read,
        write5m: a.write5m + f.write5m,
        write1h: a.write1h + f.write1h,
        output: a.output + f.output,
      }),
      { input: 0, read: 0, write5m: 0, write1h: 0, output: 0 },
    );
  }

  private facturar(cuerpo: Record<string, unknown>): FacturaDeLlamada {
    const t = this.ahora();
    type Bloque = { texto: string; marca?: { ttl?: string } };
    const bloques: Bloque[] = [];
    for (const tool of (cuerpo["tools"] as Record<string, unknown>[] | undefined) ?? []) {
      bloques.push({ texto: `tool:${JSON.stringify(tool)}` });
    }
    for (const b of (cuerpo["system"] as { text: string; cache_control?: { ttl?: string } }[] | undefined) ?? []) {
      bloques.push({ texto: `system:${b.text}`, ...(b.cache_control ? { marca: b.cache_control } : {}) });
    }
    const eleccion = JSON.stringify(cuerpo["tool_choice"] ?? null);
    let primero = true;
    for (const m of (cuerpo["messages"] as { role: string; content: { text: string; cache_control?: { ttl?: string } }[] }[]) ?? []) {
      for (const b of m.content) {
        // `tool_choice` invalida los mensajes (no las herramientas ni el sistema).
        const prefijo = primero ? `choice:${eleccion}|` : "";
        primero = false;
        bloques.push({ texto: `${prefijo}${m.role}:${b.text}`, ...(b.cache_control ? { marca: b.cache_control } : {}) });
      }
    }
    const automatica = cuerpo["cache_control"] as { ttl?: string } | undefined;
    if (automatica && bloques.length > 0 && !bloques[bloques.length - 1]!.marca) {
      bloques[bloques.length - 1]!.marca = automatica;
    }

    const modelo = String(cuerpo["model"]);
    const pos: number[] = [];
    const huellas: string[] = [];
    let acumulado = 0;
    let h = createHash("sha256").update(`model:${modelo}`).digest("hex");
    for (const b of bloques) {
      acumulado += Math.ceil(b.texto.length / 4);
      pos.push(acumulado);
      h = createHash("sha256").update(h).update("\u0000").update(b.texto).digest("hex");
      huellas.push(h);
    }
    const total = acumulado;
    const puntos = bloques.flatMap((b, i) =>
      b.marca ? [{ bloque: i, ttl: (b.marca.ttl === "1h" ? "1h" : "5m") as "5m" | "1h" }] : [],
    );

    // A: la coincidencia viva más alta que alcanza algún punto (20 posiciones).
    let A = 0;
    let bloqueA = -1;
    if (!this.sinLecturas) {
      for (const p of puntos) {
        for (let i = p.bloque; i >= 0 && i > p.bloque - 20; i--) {
          if (this.leerSoloHastaBloque != null && i >= this.leerSoloHastaBloque) continue;
          const e = this.entradas.get(huellas[i]!);
          if (e && e.expira > t) {
            if (pos[i]! > A) {
              A = pos[i]!;
              bloqueA = i;
            }
            break;
          }
        }
      }
    }
    if (bloqueA >= 0) {
      const e = this.entradas.get(huellas[bloqueA]!)!;
      e.expira = t + e.ttlMs;
    }

    // Puntos válidos: los que llegan al mínimo.
    const validos = puntos.filter((p) => pos[p.bloque]! >= this.minimo);
    const C = Math.max(A, ...validos.map((p) => pos[p.bloque]!), 0);
    const B = Math.max(A, ...validos.filter((p) => p.ttl === "1h").map((p) => pos[p.bloque]!), 0);
    for (const p of validos) {
      const ttlMs = TTL_MS[p.ttl];
      const e = this.entradas.get(huellas[p.bloque]!);
      if (e && e.expira > t) e.expira = Math.max(e.expira, t + ttlMs);
      else this.entradas.set(huellas[p.bloque]!, { expira: t + ttlMs, ttlMs });
    }

    return {
      input: total - C,
      read: A,
      write1h: Math.max(0, B - A),
      write5m: Math.max(0, C - B),
      output: this.salida,
      puntos,
      totalBloques: bloques.length,
    };
  }
}

/** La factura en dólares con la tabla oficial de Anthropic: 1,25× / 2× / lectura r. */
export function dolares(
  f: Omit<FacturaDeLlamada, "puntos" | "totalBloques">,
  precio: { inputPer1k: number; outputPer1k: number; cachedInputPer1k: number },
): number {
  return (
    (f.input / 1000) * precio.inputPer1k +
    (f.write5m / 1000) * precio.inputPer1k * 1.25 +
    (f.write1h / 1000) * precio.inputPer1k * 2 +
    (f.read / 1000) * precio.cachedInputPer1k +
    (f.output / 1000) * precio.outputPer1k
  );
}

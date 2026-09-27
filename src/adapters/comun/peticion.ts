import { sha256 } from "@bivelio/savings-layer";
import type {
  ChatMessage,
  JsonSchema,
  RequestContext,
  SavingsAdapterLevers,
  SavingsAdapterOptions,
  SavingsRequest,
  SavingsToggles,
  ToolDescriptor,
} from "@bivelio/savings-layer";

// ─── Palancas (D4) ──────────────────────────────────────────────────────────
//
// FORZADAS en cada petición y no configurables: todo lo que reescribe lo que
// manda el framework, más la caché semántica (apagada en tráfico agéntico) y la
// verificación A/B. Con esto el núcleo entrega al puente LOS MISMOS objetos que
// renderizó el adaptador, y el puente lo comprueba igualmente antes de llamar.
//
// Romper la caché de prefijo del proveedor hunde la propuesta: el framework ya
// la aprovecha, y un adaptador que reescribiera el prompt la tiraría. Por eso el
// adaptador solo puede AHORRARSE LA LLAMADA ENTERA (resolvers, caché exacta, una
// petición idéntica en vuelo) o MEDIRLA.
const FORZADAS = {
  router: false,
  compression: false,
  elision: false,
  serialization: false,
  toolDiscovery: false,
  modelCascade: "off",
  outputCodebook: false,
  deferrable: false,
  semanticCache: false,
  verification: false,
} as const satisfies SavingsToggles;

export interface Restricciones {
  /**
   * R7: el formato de salida es JSON o hay una herramienta forzada. Un resolver
   * contestaría con una cifra suelta donde el framework espera un JSON o una
   * llamada a herramienta.
   */
  sinResolvers?: boolean;
  /**
   * Sin reutilizar nada: ni caché exacta ni petición en vuelo. Cuando la huella
   * no se pudo calcular (no hay identidad fiable que separe dos peticiones) o
   * cuando el adaptador no sabe reproducir la respuesta del framework.
   */
  sinReutilizar?: boolean;
}

// Por llamada solo se APAGA: la opción global apaga para todas las llamadas y la
// de la llamada, para esa. Ninguna de las dos enciende lo que la otra apagó.
export function palancas(
  globales: SavingsAdapterLevers | undefined,
  deLaLlamada: SavingsAdapterLevers | undefined,
  r: Restricciones = {},
): SavingsToggles {
  const encendida = (k: keyof SavingsAdapterLevers): boolean =>
    globales?.[k] !== false && deLaLlamada?.[k] !== false;
  return {
    ...FORZADAS,
    exactCache: encendida("exactCache") && r.sinReutilizar !== true,
    singleflight: encendida("singleflight") && r.sinReutilizar !== true,
    deterministicResolvers: encendida("deterministicResolvers") && r.sinResolvers !== true,
  };
}

// ─── Herramientas (D7) ──────────────────────────────────────────────────────
//
// El framework no dice si una herramienta tiene efectos, así que la opción
// segura es suponer que SÍ: una herramienta sin declarar es `write`, y el núcleo
// no cachea ni coalesce una petición que la ofrece («write/destructive tools are
// never cached»). `readOnlyTools` las declara de lectura. Las que ejecuta el
// propio proveedor son siempre `write`: el adaptador no ve lo que hacen.
export function esDeLectura(opciones: SavingsAdapterOptions, nombre: string): boolean {
  const lectura = opciones.readOnlyTools;
  if (typeof lectura === "function") {
    try {
      return lectura(nombre) === true;
    } catch {
      return false;
    }
  }
  return Array.isArray(lectura) ? lectura.includes(nombre) : false;
}

export function herramienta(
  opciones: SavingsAdapterOptions,
  h: { nombre: string; descripcion?: string | undefined; parametros?: unknown; delProveedor?: boolean },
): ToolDescriptor {
  const lectura = h.delProveedor !== true && esDeLectura(opciones, h.nombre);
  return {
    id: h.nombre,
    intents: [],
    risk: lectura ? "read" : "write",
    ...(h.parametros !== undefined && h.parametros !== null && typeof h.parametros === "object"
      ? { parameters: h.parametros as JsonSchema }
      : {}),
    ...(typeof h.descripcion === "string" ? { description: h.descripcion } : {}),
  };
}

// ─── Huella (D5) ────────────────────────────────────────────────────────────
//
// La clave de la caché exacta del núcleo cubre el texto normalizado de cada
// turno, el system, las herramientas (id, riesgo y parámetros), el modelo, la
// temperatura y la semilla. Todo lo demás que manda el framework y puede cambiar
// la respuesta —tope de salida, stops, topP/K, penalizaciones, formato de
// respuesta, toolChoice, opciones del proveedor, partes que no son texto,
// argumentos crudos de las llamadas a herramienta y de sus resultados,
// definiciones completas de herramientas, cabeceras beta— entra aquí, como
// huella, en `context.authorizationScope`.
//
// `authorizationScope` ya forma parte de la clave exacta, de la de vuelo y de la
// identidad semántica: dos peticiones que difieren solo en algo de esto no
// comparten nunca respuesta, y sin tocar la generación de claves del núcleo (ni
// su versión ni las claves de los usuarios actuales).
//
// Lo que NO entra, porque cambia en cada ejecución sin cambiar la petición: ids
// de llamadas a herramienta, señales de cancelación, cabeceras de traza y las
// opciones propias del adaptador. Eso lo quita cada adaptador de su proyección;
// aquí solo se serializa y se resume.

type Binario = Uint8Array;

// Serialización estable de la proyección. Los binarios salen aparte (se resumen
// con SHA-256 nativo: un PDF de 10 MB no puede costar un SHA en JavaScript).
function normalizar(v: unknown, binarios: Binario[], vistos: WeakSet<object>): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) ? v : String(v);
    case "bigint":
      return `${v.toString()}n`;
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
  }
  const o = v as object;
  if (o instanceof Uint8Array) {
    binarios.push(o);
    return { $bytes: binarios.length - 1 };
  }
  if (o instanceof ArrayBuffer) {
    binarios.push(new Uint8Array(o));
    return { $bytes: binarios.length - 1 };
  }
  if (ArrayBuffer.isView(o)) {
    binarios.push(new Uint8Array(o.buffer, o.byteOffset, o.byteLength));
    return { $bytes: binarios.length - 1 };
  }
  if (o instanceof URL) return { $url: o.href };
  if (o instanceof Date) return { $date: Number.isNaN(o.getTime()) ? "invalid" : o.toISOString() };
  if (vistos.has(o)) return "$cycle";
  vistos.add(o);
  try {
    if (Array.isArray(o)) {
      return o.map((x) => {
        const n = normalizar(x, binarios, vistos);
        return n === undefined ? null : n;
      });
    }
    if (o instanceof Map) return { $map: [...o.entries()].map((e) => normalizar(e, binarios, vistos)) };
    if (o instanceof Set) return { $set: [...o.values()].map((e) => normalizar(e, binarios, vistos)) };
    const salida: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      const n = normalizar((o as Record<string, unknown>)[k], binarios, vistos);
      if (n !== undefined) salida[k] = n;
    }
    return salida;
  } finally {
    vistos.delete(o);
  }
}

// Lo único que se usa de WebCrypto (sin depender de los tipos del DOM).
type Digestor = { digest(algoritmo: string, datos: Uint8Array): Promise<ArrayBuffer> };

async function resumen(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: Digestor } }).crypto?.subtle;
  if (subtle) {
    const d = new Uint8Array(await subtle.digest("SHA-256", bytes));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Sin WebCrypto (un runtime muy recortado): el SHA-256 del núcleo, más lento.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return sha256(s);
}

/**
 * La huella de una proyección, o `null` si no se pudo calcular. Con `null` el
 * adaptador apaga la reutilización para esa llamada (sin identidad fiable no se
 * puede separar una petición de otra).
 */
export async function huellaDe(proyeccion: unknown): Promise<string | null> {
  try {
    const binarios: Binario[] = [];
    const texto = JSON.stringify(normalizar(proyeccion, binarios, new WeakSet())) ?? "null";
    const resumenes = await Promise.all(binarios.map(resumen));
    const material = new TextEncoder().encode(`${texto}|${resumenes.join(",")}`);
    return await resumen(material);
  } catch {
    return null;
  }
}

// ─── La petición ────────────────────────────────────────────────────────────

export interface EntradaDePeticion {
  model: string;
  messages: ChatMessage[];
  tools: ToolDescriptor[];
  temperature?: number | undefined;
  seed?: number | undefined;
  /** El contexto del llamante, ya fusionado (el de la llamada gana). */
  context?: RequestContext | undefined;
  /** Palancas que la llamada apaga para sí. */
  savings?: SavingsAdapterLevers | undefined;
  /** La proyección de todo lo que el núcleo no modela (ver Huella). */
  proyeccion: unknown;
  restricciones?: Restricciones;
}

export async function construirPeticion(
  opciones: SavingsAdapterOptions,
  e: EntradaDePeticion,
): Promise<SavingsRequest> {
  const huella = await huellaDe(e.proyeccion);
  const alcance = `${e.context?.authorizationScope ?? "default"}|bvsala-adapter:${huella ?? "none"}`;
  return {
    model: e.model,
    messages: e.messages,
    ...(e.tools.length > 0 ? { tools: e.tools } : {}),
    ...(typeof e.temperature === "number" ? { temperature: e.temperature } : {}),
    ...(typeof e.seed === "number" ? { seed: e.seed } : {}),
    context: { ...(e.context ?? {}), authorizationScope: alcance },
    savings: palancas(opciones.savings, e.savings, {
      ...e.restricciones,
      ...(huella === null ? { sinReutilizar: true } : {}),
    }),
  };
}

/** Fusiona dos contextos: el segundo gana, clave a clave. */
export function fusionarContexto(
  base: RequestContext | undefined,
  encima: RequestContext | undefined,
): RequestContext | undefined {
  if (!base && !encima) return undefined;
  return { ...(base ?? {}), ...(encima ?? {}) };
}

/** Lee `{ context, savings }` de un objeto de opciones por llamada, sin fiarse de su forma. */
export function opcionesDeLlamada(v: unknown): { context?: RequestContext; savings?: SavingsAdapterLevers } {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const salida: { context?: RequestContext; savings?: SavingsAdapterLevers } = {};
  if (o.context && typeof o.context === "object") salida.context = o.context as RequestContext;
  if (o.savings && typeof o.savings === "object") salida.savings = o.savings as SavingsAdapterLevers;
  return salida;
}

/**
 * Anillo 1 · el corpus de tareas agénticas con VERIFICADOR PROGRAMÁTICO.
 *
 * Lo que el plan exige y no existía: `benchmarks/scenarios.ts` tiene cero
 * escenarios con tool_result, y la puerta de S4a es «éxito de TAREA», no
 * parecido de texto. Cada tarea de aquí es un mundo cerrado y determinista:
 *
 *  · un WORKSPACE virtual (ficheros en memoria) generado con PRNG sembrado —
 *    dos generaciones son byte-idénticas, así que las tiradas son
 *    reproducibles sin commitear megas de fixtures;
 *  · HERRAMIENTAS simuladas (leer, listar, buscar, escribir, ejecutar_tests,
 *    entregar) cuyos resultados son gordos a propósito: el dial de la palanca
 *    dispara a 30K tokens de entrada y estas tareas lo cruzan de verdad;
 *  · un VERIFICADOR puro sobre el estado final + la respuesta entregada:
 *    pasa/no-pasa, sin juez y sin opinión.
 *
 * Las tres clases de tool_result del corpus real (S1) están representadas:
 * `log` (48 % de la masa), `codigo` y `otro` (JSON/datos), más tareas mixtas
 * multi-turno. Nada aquí toca la red: la red es del arnés.
 */

// ── PRNG sembrado (mulberry32): determinismo sin dependencias ──

export function prng(semilla: number): () => number {
  let a = semilla >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const eleccion = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const entero = (r: () => number, min: number, max: number): number => min + Math.floor(r() * (max - min + 1));
const hex = (r: () => number, n: number): string =>
  Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(r() * 16)]).join("");

// ── Generadores de contenido gordo ──

const SERVICIOS = ["pagos", "usuarios", "inventario", "correo", "informes", "webhooks"] as const;
const RUTAS = ["/api/pedidos", "/api/clientes", "/api/stock", "/api/facturas", "/api/salud", "/api/eventos"] as const;

/** Un log de aplicación de ~`lineas` líneas (~90 bytes/línea). */
function logDeApp(r: () => number, lineas: number, inserta?: (i: number) => string | null): string {
  const out: string[] = [];
  let t = Date.UTC(2026, 8, 2, 2, 0, 0);
  for (let i = 0; i < lineas; i++) {
    t += entero(r, 200, 4000);
    const extra = inserta?.(i);
    if (extra !== null && extra !== undefined) {
      out.push(extra.replace("{ts}", new Date(t).toISOString()));
      continue;
    }
    const svc = eleccion(r, SERVICIOS);
    const ruta = eleccion(r, RUTAS);
    const ms = entero(r, 3, 900);
    const estado = eleccion(r, [200, 200, 200, 200, 201, 204, 301, 404] as const);
    out.push(
      `${new Date(t).toISOString()} INFO  [${svc}] ${eleccion(r, ["GET", "POST", "PUT"] as const)} ${ruta} rid=req_${hex(r, 8)} status=${estado} dur=${ms}ms`,
    );
  }
  return out.join("\n") + "\n";
}

export type Workspace = Map<string, string>;

export interface EstadoDeTarea {
  ficheros: Workspace;
}

export interface Tarea {
  id: string;
  clase: "log" | "codigo" | "otro" | "mixta";
  /** El encargo, tal cual lo recibe el modelo. */
  enunciado: string;
  /** Contexto de sistema estable de la tarea (sin la sal: esa es del arnés). */
  sistema: string;
  turnosMax: number;
  construir(): EstadoDeTarea;
  /**
   * Simulador de `ejecutar_tests` (si la tarea lo ofrece): salida gorda y
   * determinista calculada del estado ACTUAL del workspace.
   */
  tests?(estado: EstadoDeTarea): { verde: boolean; salida: string };
  /** El veredicto: estado final + respuesta entregada → pasa/no pasa. */
  verificar(estado: EstadoDeTarea, respuesta: string): boolean;
}

const SISTEMA_BASE =
  "Eres un agente de ingeniería trabajando sobre un workspace de ficheros mediante herramientas. " +
  "Lee lo que necesites, actúa, y cuando tengas el resultado entrégalo SIEMPRE con la herramienta `entregar`. " +
  "Sé preciso: el resultado se verifica automáticamente.";

const norm = (s: string): string => s.toLowerCase().replaceAll(/\s+/g, " ").trim();

// ── Las tareas ──

function tareaAguja500(): Tarea {
  const semilla = 11;
  const ridBueno = "req_" + hex(prng(semilla * 7), 8);
  return {
    id: "log-aguja-500",
    clase: "log",
    sistema: SISTEMA_BASE,
    enunciado:
      "En logs/app.log hay exactamente UNA petición que devolvió estado 500 entre las 03:00 y las 04:00 UTC. " +
      "Entrega su rid exacto (empieza por req_).",
    turnosMax: 8,
    construir() {
      const r = prng(semilla);
      const objetivo = entero(r, 400, 900);
      const log = logDeApp(r, 1100, (i) =>
        i === objetivo ? `{ts} ERROR [pagos] POST /api/facturas rid=${ridBueno} status=500 dur=1204ms` : null,
      );
      return { ficheros: new Map([["logs/app.log", log]]) };
    },
    verificar: (_e, respuesta) => respuesta.includes(ridBueno),
  };
}

function tareaReintentos(): Tarea {
  const semilla = 23;
  const cuantos = 13;
  return {
    id: "log-reintentos",
    clase: "log",
    sistema: SISTEMA_BASE,
    enunciado:
      "En logs/worker.log, ¿cuántas líneas de reintento (`retry attempt`) registró exactamente el worker-7? " +
      "Entrega solo el número.",
    turnosMax: 8,
    construir() {
      const r = prng(semilla);
      let puestos = 0;
      const posiciones = new Set<number>();
      while (posiciones.size < cuantos) posiciones.add(entero(r, 10, 1180));
      const log = logDeApp(r, 1200, (i) => {
        if (posiciones.has(i)) {
          puestos++;
          return `{ts} WARN  [worker-7] retry attempt ${puestos} job=job_${hex(r, 6)}`;
        }
        if (i % 97 === 0) return `{ts} WARN  [worker-3] retry attempt 1 job=job_${hex(r, 6)}`;
        return null;
      });
      return { ficheros: new Map([["logs/worker.log", log]]) };
    },
    verificar: (_e, respuesta) => {
      const numeros: string[] = respuesta.match(/\d+/g) ?? [];
      return numeros.includes(String(cuantos));
    },
  };
}

function tareaCommitRoto(): Tarea {
  const semilla = 31;
  const hashRoto = hex(prng(semilla * 3), 10);
  return {
    id: "log-commit-roto",
    clase: "log",
    sistema: SISTEMA_BASE,
    enunciado:
      "ci/tirada.log recoge las ejecuciones de CI en orden cronológico y ci/historial.txt los commits. " +
      "Los tests pasaban y en algún commit empezaron a fallar y ya no volvieron a pasar. Entrega el hash del PRIMER commit con la suite en rojo.",
    turnosMax: 10,
    construir() {
      const r = prng(semilla);
      const hashes = Array.from({ length: 40 }, () => hex(r, 10));
      const idxRoto = 24;
      hashes[idxRoto] = hashRoto;
      const historial = hashes
        .map((h, i) => `${h} feat: cambio ${i} (${eleccion(r, SERVICIOS)})`)
        .join("\n");
      const bloques = hashes.map((h, i) => {
        const verde = i < idxRoto;
        const detalle = logDeApp(r, 22);
        return `=== CI commit ${h} ===\n${detalle}resultado: ${verde ? "PASSED 214/214" : "FAILED 209/214 (5 rojos en facturas)"}\n`;
      });
      return {
        ficheros: new Map([
          ["ci/historial.txt", historial],
          ["ci/tirada.log", bloques.join("\n")],
        ]),
      };
    },
    verificar: (_e, respuesta) => respuesta.includes(hashRoto),
  };
}

function tareaOffByOne(): Tarea {
  const semilla = 41;
  const fichero = "src/paginacion.ts";
  const roto = [
    "export interface Pagina { indice: number; elementos: string[] }",
    "",
    "/** Divide `xs` en páginas de `tam`. Debe incluir TODAS las páginas, la primera también. */",
    "export function paginar(xs: string[], tam: number): Pagina[] {",
    "  const paginas: Pagina[] = [];",
    "  const total = Math.ceil(xs.length / tam);",
    "  for (let i = 1; i < total; i++) {",
    "    paginas.push({ indice: i, elementos: xs.slice(i * tam, (i + 1) * tam) });",
    "  }",
    "  return paginas;",
    "}",
    "",
  ].join("\n");
  const arreglado = (contenido: string): boolean =>
    /for\s*\(\s*let\s+i\s*=\s*0\s*;/.test(contenido) && !/let\s+i\s*=\s*1\s*;/.test(contenido);
  const tests = (estado: EstadoDeTarea): { verde: boolean; salida: string } => {
    const r = prng(semilla + 1);
    const contenido = estado.ficheros.get(fichero) ?? "";
    const verde = arreglado(contenido);
    const ruido = logDeApp(r, 160);
    const salida =
      `> vitest run (simulado)\n${ruido}` +
      (verde
        ? "✓ paginar incluye la primera página\n✓ paginar cubre todos los elementos\nresultado: PASSED 18/18\n"
        : "✗ paginar incluye la primera página — expected indice 0, la primera página no aparece\n✗ paginar cubre todos los elementos — faltan los primeros `tam` elementos\nresultado: FAILED 16/18\n");
    return { verde, salida };
  };
  return {
    id: "codigo-off-by-one",
    clase: "codigo",
    sistema: SISTEMA_BASE,
    enunciado:
      `Los tests de ${fichero} fallan: paginar() se salta la primera página. ` +
      "Arregla el fichero con escribir_fichero, ejecuta los tests hasta verlos en verde y entrega «arreglado».",
    turnosMax: 12,
    construir: () => ({ ficheros: new Map([[fichero, roto]]) }),
    tests,
    verificar: (estado) => tests(estado).verde,
  };
}

function tareaRenombrar(): Tarea {
  const semilla = 43;
  const ficheros = ["src/carrito.ts", "src/factura.ts", "src/resumen.ts", "src/api/cobro.ts"];
  const construir = (): EstadoDeTarea => {
    const r = prng(semilla);
    const fs: Workspace = new Map();
    for (const f of ficheros) {
      const lineas: string[] = [`// ${f}`];
      const usos = entero(r, 2, 4);
      for (let i = 0; i < usos; i++) {
        lineas.push(`export function ayudante${i}(xs: number[]): number {`);
        lineas.push(`  return calcularTotal(xs) + ${entero(r, 1, 9)};`);
        lineas.push("}");
      }
      fs.set(f, lineas.join("\n") + "\n");
    }
    fs.set(
      "src/nucleo.ts",
      "export function calcularTotal(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n",
    );
    return { ficheros: fs };
  };
  const todos = [...ficheros, "src/nucleo.ts"];
  return {
    id: "codigo-renombrar",
    clase: "codigo",
    sistema: SISTEMA_BASE,
    enunciado:
      "Renombra la función calcularTotal a calcularImporte en TODOS los ficheros del workspace " +
      "(definición y llamadas), reescribiéndolos con escribir_fichero. Entrega «hecho» al terminar.",
    turnosMax: 16,
    construir,
    verificar: (estado) =>
      todos.every((f) => {
        const c = estado.ficheros.get(f) ?? "";
        return !c.includes("calcularTotal") && c.includes("calcularImporte");
      }),
  };
}

function tareaQuienLlama(): Tarea {
  const semilla = 47;
  const culpable = "src/cobros.ts";
  return {
    id: "codigo-quien-llama",
    clase: "codigo",
    sistema: SISTEMA_BASE,
    enunciado:
      "Exactamente UN fichero del workspace llama a acunarLicencia con seats mayor que 1. " +
      "Entrega la ruta exacta de ese fichero.",
    turnosMax: 10,
    construir() {
      const r = prng(semilla);
      const fs: Workspace = new Map();
      const rutas = ["src/altas.ts", "src/cobros.ts", "src/renovacion.ts", "src/trial.ts", "src/admin.ts", "src/soporte.ts"];
      for (const ruta of rutas) {
        const relleno = Array.from({ length: entero(r, 25, 60) }, (_, i) => `// lógica auxiliar ${i}: ${hex(r, 12)}`).join("\n");
        const seats = ruta === culpable ? 3 : 1;
        fs.set(ruta, `${relleno}\nexport async function proceso() {\n  await acunarLicencia({ orgId, seats: ${seats} });\n}\n`);
      }
      return { ficheros: fs };
    },
    verificar: (_e, respuesta) => respuesta.includes(culpable),
  };
}

function tareaMayorGasto(): Tarea {
  const semilla = 53;
  let ganador = "";
  const construir = (): EstadoDeTarea => {
    const r = prng(semilla);
    const clientes = Array.from({ length: 320 }, (_, i) => ({
      id: `cli_${hex(r, 6)}`,
      nombre: `Cliente ${i}`,
      pais: eleccion(r, ["ES", "FR", "DE", "PT", "IT", "AD"] as const),
      gastoMensualEur: entero(r, 40, 8_000),
      asientos: entero(r, 1, 40),
    }));
    const top = clientes.reduce((a, b) => (b.gastoMensualEur > a.gastoMensualEur ? b : a));
    top.gastoMensualEur = 9_450; // único máximo, sin empates
    ganador = top.id;
    return { ficheros: new Map([["datos/clientes.json", JSON.stringify(clientes, null, 2) + "\n"]]) };
  };
  return {
    id: "otro-mayor-gasto",
    clase: "otro",
    sistema: SISTEMA_BASE,
    enunciado: "En datos/clientes.json, entrega el id exacto del cliente con mayor gastoMensualEur.",
    turnosMax: 8,
    construir,
    verificar: (_e, respuesta) => ganador !== "" && respuesta.includes(ganador),
  };
}

function tareaTopMargen(): Tarea {
  const semilla = 59;
  let top3: string[] = [];
  const construir = (): EstadoDeTarea => {
    const r = prng(semilla);
    const productos = Array.from({ length: 180 }, (_, i) => {
      const coste = entero(r, 5, 400);
      return {
        sku: `sku_${hex(r, 5)}`,
        nombre: `Producto ${i}`,
        costeEur: coste,
        precioEur: coste + entero(r, 1, 300),
      };
    });
    top3 = [...productos]
      .sort((a, b) => b.precioEur - b.costeEur - (a.precioEur - a.costeEur))
      .slice(0, 3)
      .map((p) => p.sku);
    return { ficheros: new Map([["datos/productos.json", JSON.stringify(productos, null, 2) + "\n"]]) };
  };
  return {
    id: "otro-top-margen",
    clase: "otro",
    sistema: SISTEMA_BASE,
    enunciado:
      "Calcula el margen (precioEur - costeEur) de datos/productos.json y escribe informes/resumen.md " +
      "con los TRES skus de mayor margen en orden descendente (uno por línea). Después entrega «escrito».",
    turnosMax: 10,
    construir,
    verificar: (estado) => {
      const doc = estado.ficheros.get("informes/resumen.md") ?? "";
      const posiciones = top3.map((sku) => doc.indexOf(sku));
      return posiciones.every((p) => p >= 0) && posiciones[0]! < posiciones[1]! && posiciones[1]! < posiciones[2]!;
    },
  };
}

function tareaIvaMalo(): Tarea {
  const semilla = 61;
  const mala = "facturas/factura-3.txt";
  return {
    id: "otro-iva-malo",
    clase: "otro",
    sistema: SISTEMA_BASE,
    enunciado:
      "Hay cinco facturas en facturas/. Exactamente una tiene el IVA (21 % de la base) mal calculado. " +
      "Entrega la ruta exacta de la factura incorrecta.",
    turnosMax: 10,
    construir() {
      const r = prng(semilla);
      const fs: Workspace = new Map();
      for (let n = 1; n <= 5; n++) {
        const base = entero(r, 200, 4_000) + entero(r, 0, 99) / 100;
        const iva = Math.round(base * 21) / 100;
        const ivaEscrito = n === 3 ? Math.round((iva + entero(r, 7, 60)) * 100) / 100 : iva;
        const lineas = Array.from({ length: entero(r, 8, 16) }, (_, i) => `  concepto ${i + 1} … ${entero(r, 5, 500)},00 EUR`);
        fs.set(
          `facturas/factura-${n}.txt`,
          `FACTURA 2026-0${n}\n${lineas.join("\n")}\n  BASE IMPONIBLE: ${base.toFixed(2)} EUR\n  IVA (21%): ${ivaEscrito.toFixed(2)} EUR\n  TOTAL: ${(base + ivaEscrito).toFixed(2)} EUR\n`,
        );
      }
      return { ficheros: fs };
    },
    verificar: (_e, respuesta) => respuesta.includes(mala) || respuesta.includes("factura-3"),
  };
}

function tareaCronParado(): Tarea {
  const semilla = 67;
  return {
    id: "mixta-cron-parado",
    clase: "mixta",
    sistema: SISTEMA_BASE,
    enunciado:
      "El trabajo programado de limpieza no se ejecutó el martes. Investiga config/programador.yaml y " +
      "logs/programador.log y entrega la CLAVE exacta de configuración responsable (formato punto: a.b.c).",
    turnosMax: 10,
    construir() {
      const r = prng(semilla);
      const yaml = [
        "programador:",
        "  zona: Europe/Madrid",
        "  tareas:",
        "    informes:",
        "      cron: '0 6 * * *'",
        "      activo: true",
        "    limpieza:",
        "      cron: '30 4 * * 2'",
        "      activo: false",
        "    respaldo:",
        "      cron: '0 2 * * *'",
        "      activo: true",
        "",
      ].join("\n");
      const log = logDeApp(r, 700, (i) =>
        i % 120 === 0 ? "{ts} INFO  [programador] tarea informes disparada ok" : i % 121 === 0 ? "{ts} INFO  [programador] tarea limpieza OMITIDA (desactivada por configuración)" : null,
      );
      return {
        ficheros: new Map([
          ["config/programador.yaml", yaml],
          ["logs/programador.log", log],
        ]),
      };
    },
    verificar: (_e, respuesta) => {
      const n = norm(respuesta);
      return n.includes("limpieza") && n.includes("activo");
    },
  };
}

function tareaMigrarJson(): Tarea {
  const semilla = 71;
  const rutas = ["datos/tarifa-a.json", "datos/tarifa-b.json", "datos/tarifa-c.json", "datos/tarifa-d.json"];
  const construir = (): EstadoDeTarea => {
    const r = prng(semilla);
    const fs: Workspace = new Map();
    for (const ruta of rutas) {
      const filas = Array.from({ length: entero(r, 20, 40) }, (_, i) => ({
        concepto: `linea-${i}-${hex(r, 4)}`,
        precio: entero(r, 1, 500) + entero(r, 0, 99) / 100,
      }));
      fs.set(ruta, JSON.stringify(filas, null, 2) + "\n");
    }
    return { ficheros: fs };
  };
  return {
    id: "mixta-migrar-json",
    clase: "mixta",
    sistema: SISTEMA_BASE,
    enunciado:
      "Migra los cuatro JSON de datos/: cada objeto debe pasar de `precio` (euros con decimales) a " +
      "`precio_centimos` (entero, euros × 100, redondeado). Reescribe los ficheros y entrega «migrado».",
    turnosMax: 14,
    construir,
    verificar: (estado) => {
      const original = construir();
      return rutas.every((ruta) => {
        const antes = JSON.parse(original.ficheros.get(ruta)!) as { concepto: string; precio: number }[];
        let despues: unknown;
        try {
          despues = JSON.parse(estado.ficheros.get(ruta) ?? "");
        } catch {
          return false;
        }
        if (!Array.isArray(despues) || despues.length !== antes.length) return false;
        return despues.every((fila, i) => {
          const f = fila as { concepto?: string; precio?: unknown; precio_centimos?: unknown };
          return (
            f.concepto === antes[i]!.concepto &&
            f.precio === undefined &&
            f.precio_centimos === Math.round(antes[i]!.precio * 100)
          );
        });
      });
    },
  };
}

function tareaAuditoriaTodos(): Tarea {
  const semilla = 73;
  let esperados: string[] = [];
  const construir = (): EstadoDeTarea => {
    const r = prng(semilla);
    const fs: Workspace = new Map();
    esperados = [];
    for (let n = 0; n < 8; n++) {
      const ruta = `src/modulo-${n}.ts`;
      const lineas: string[] = [];
      const total = entero(r, 30, 70);
      for (let i = 0; i < total; i++) {
        if (r() < 0.06) {
          lineas.push(`// TODO ${hex(r, 6)}: pendiente`);
          esperados.push(`${ruta}:${lineas.length}`);
        } else {
          lineas.push(`const v${i} = "${hex(r, 10)}";`);
        }
      }
      fs.set(ruta, lineas.join("\n") + "\n");
    }
    return { ficheros: fs };
  };
  return {
    id: "mixta-auditoria-todos",
    clase: "mixta",
    sistema: SISTEMA_BASE,
    enunciado:
      "Audita el workspace: entrega la lista completa de comentarios TODO con el formato exacto " +
      "`ruta:linea` (línea empezando en 1), uno por línea, en cualquier orden. No debe faltar ninguno.",
    turnosMax: 16,
    construir,
    verificar: (_e, respuesta) => esperados.length > 0 && esperados.every((p) => respuesta.includes(p)),
  };
}

function tareaCabeceraDeSeguridad(): Tarea {
  const semilla = 79;
  return {
    id: "codigo-cabecera-csp",
    clase: "codigo",
    sistema: SISTEMA_BASE,
    enunciado:
      "servidor/http.ts construye las cabeceras de respuesta. Añade la cabecera `x-content-type-options` con " +
      "valor `nosniff` al objeto CABECERAS (sin tocar las demás), reescribe el fichero y entrega «añadida».",
    turnosMax: 10,
    construir() {
      const r = prng(semilla);
      const relleno = Array.from({ length: 40 }, (_, i) => `// middleware ${i}: ${hex(r, 10)}`).join("\n");
      const codigo = [
        relleno,
        "export const CABECERAS: Record<string, string> = {",
        '  "cache-control": "no-store",',
        '  "x-frame-options": "DENY",',
        "};",
        "",
      ].join("\n");
      return { ficheros: new Map([["servidor/http.ts", codigo]]) };
    },
    verificar: (estado) => {
      const c = estado.ficheros.get("servidor/http.ts") ?? "";
      return (
        /["']x-content-type-options["']\s*:\s*["']nosniff["']/.test(c) &&
        c.includes('"cache-control": "no-store"') &&
        c.includes('"x-frame-options": "DENY"')
      );
    },
  };
}

function tareaEndpointLento(): Tarea {
  const semilla = 83;
  return {
    id: "log-endpoint-lento",
    clase: "log",
    sistema: SISTEMA_BASE,
    enunciado:
      "En logs/acceso.log, un único endpoint tiene una duración media claramente peor que el resto " +
      "(sus dur= superan siempre los 5000ms). Entrega la ruta exacta de ese endpoint.",
    turnosMax: 8,
    construir() {
      const r = prng(semilla);
      const lento = "/api/informes/anual";
      const log = logDeApp(r, 1000, (i) =>
        i % 37 === 0 ? `{ts} INFO  [informes] GET ${lento} rid=req_${hex(r, 8)} status=200 dur=${entero(r, 5200, 9800)}ms` : null,
      );
      return { ficheros: new Map([["logs/acceso.log", log]]) };
    },
    verificar: (_e, respuesta) => respuesta.includes("/api/informes/anual"),
  };
}

/** El corpus del anillo 1, en orden estable. */
export function tareasDelAnillo1(): Tarea[] {
  return [
    tareaAguja500(),
    tareaReintentos(),
    tareaCommitRoto(),
    tareaEndpointLento(),
    tareaOffByOne(),
    tareaRenombrar(),
    tareaQuienLlama(),
    tareaCabeceraDeSeguridad(),
    tareaMayorGasto(),
    tareaTopMargen(),
    tareaIvaMalo(),
    tareaCronParado(),
    tareaMigrarJson(),
    tareaAuditoriaTodos(),
  ];
}

// ── Las herramientas simuladas (deterministas, sin red ni disco) ──

export interface LlamadaHerramienta {
  nombre: string;
  entrada: Record<string, unknown>;
}

export interface ResultadoHerramienta {
  contenido: string;
  esError?: boolean;
  /** La entrega termina la tarea. */
  entrega?: string;
}

export function ejecutarHerramienta(tarea: Tarea, estado: EstadoDeTarea, llamada: LlamadaHerramienta): ResultadoHerramienta {
  const { nombre, entrada } = llamada;
  const ruta = typeof entrada.ruta === "string" ? entrada.ruta : "";
  switch (nombre) {
    case "listar": {
      const rutas = [...estado.ficheros.keys()].sort();
      return { contenido: rutas.join("\n") || "(workspace vacío)" };
    }
    case "leer_fichero": {
      const c = estado.ficheros.get(ruta);
      if (c === undefined) return { contenido: `error: ${ruta} no existe`, esError: true };
      return { contenido: c };
    }
    case "buscar": {
      const patron = typeof entrada.patron === "string" ? entrada.patron : "";
      if (patron === "") return { contenido: "error: patrón vacío", esError: true };
      let re: RegExp;
      try {
        re = new RegExp(patron);
      } catch {
        return { contenido: "error: patrón inválido", esError: true };
      }
      const filas: string[] = [];
      for (const [f, c] of [...estado.ficheros.entries()].sort()) {
        c.split("\n").forEach((linea, i) => {
          if (re.test(linea) && filas.length < 200) filas.push(`${f}:${i + 1}: ${linea}`);
        });
      }
      return { contenido: filas.join("\n") || "(sin coincidencias)" };
    }
    case "escribir_fichero": {
      const contenido = typeof entrada.contenido === "string" ? entrada.contenido : null;
      if (ruta === "" || contenido === null) return { contenido: "error: faltan ruta o contenido", esError: true };
      estado.ficheros.set(ruta, contenido);
      return { contenido: `ok: ${ruta} escrito (${contenido.length} bytes)` };
    }
    case "ejecutar_tests": {
      if (!tarea.tests) return { contenido: "error: esta tarea no tiene tests", esError: true };
      const { salida } = tarea.tests(estado);
      return { contenido: salida };
    }
    case "entregar": {
      const respuesta = typeof entrada.respuesta === "string" ? entrada.respuesta : "";
      return { contenido: "entregado", entrega: respuesta };
    }
    default:
      return { contenido: `error: herramienta desconocida ${nombre}`, esError: true };
  }
}

/** El esquema de herramientas tal como lo espera /v1/messages. */
export function esquemaDeHerramientas(tarea: Tarea): unknown[] {
  const herramientas: unknown[] = [
    {
      name: "listar",
      description: "Lista todas las rutas de fichero del workspace.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "leer_fichero",
      description: "Devuelve el contenido completo de un fichero.",
      input_schema: { type: "object", properties: { ruta: { type: "string" } }, required: ["ruta"] },
    },
    {
      name: "buscar",
      description: "Busca un patrón (regex) en todos los ficheros; devuelve ruta:línea: texto.",
      input_schema: { type: "object", properties: { patron: { type: "string" } }, required: ["patron"] },
    },
    {
      name: "escribir_fichero",
      description: "Reescribe (o crea) un fichero con el contenido dado.",
      input_schema: {
        type: "object",
        properties: { ruta: { type: "string" }, contenido: { type: "string" } },
        required: ["ruta", "contenido"],
      },
    },
    {
      name: "entregar",
      description: "Entrega el resultado final de la tarea y termina.",
      input_schema: { type: "object", properties: { respuesta: { type: "string" } }, required: ["respuesta"] },
    },
  ];
  if (tarea.tests) {
    herramientas.splice(4, 0, {
      name: "ejecutar_tests",
      description: "Ejecuta la suite de tests del workspace y devuelve su salida.",
      input_schema: { type: "object", properties: {}, required: [] },
    });
  }
  return herramientas;
}

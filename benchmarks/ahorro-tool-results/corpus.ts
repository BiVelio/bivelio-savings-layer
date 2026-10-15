/**
 * EL CORPUS SEMBRADO DEL BANCO DE CUATRO BRAZOS (D08 del plan Caveman).
 *
 * Familias del plan, p. 11, las que se pueden juzgar SIN un modelo:
 *
 *  · `json-tablas`: filas con nulos, unicode (también escapado), decimales con
 *    cero final (`12.10`), enteros por encima de 2^53, un valor atípico en
 *    medio, orden significativo y, en una de cada cuatro, una clave duplicada.
 *  · `logs-tests`: salidas de vitest con fallos al principio, en medio o al
 *    final, varios fallos, warnings, stack traces, tests saltados y exit code.
 *  · `sesion-*`: frío/caliente (eso lo pone el banco), sesión larga, fork
 *    (se edita el primer mensaje a mitad), recuperación frecuente, no-op
 *    (salidas pequeñas: nada que ganar) y entrada corta. Están para que haya
 *    casos donde comprimir PIERDE.
 *
 * Cada caso trae su respuesta esperada, calculada AQUÍ desde la verdad del
 * generador (qué tests fallaron, qué literal se escribió), no leyendo el texto
 * con el mismo código que se evalúa. Ese es el oráculo.
 *
 * Familias del plan que NO están (y por qué): código/herramientas y documentos
 * necesitan un modelo que haga la tarea; seguridad/protocolos está cubierta
 * por los tests de D04/D06 (tenant ajeno, policy nueva, handle caducado).
 */

export type Familia =
  | "json-tablas"
  | "logs-tests"
  | "sesion-larga"
  | "sesion-fork"
  | "sesion-recuperacion-frecuente"
  | "sesion-noop"
  | "sesion-corta";

export const FAMILIAS: readonly Familia[] = [
  "json-tablas",
  "logs-tests",
  "sesion-larga",
  "sesion-fork",
  "sesion-recuperacion-frecuente",
  "sesion-noop",
  "sesion-corta",
];

export interface Salida {
  herramienta: string;
  argumentos: Record<string, string>;
  contenido: string;
}

export type Tarea =
  | { tipo: "json-nulos"; salidas: [number]; campo: "nota" }
  | { tipo: "json-literal"; salidas: [number]; fila: number; campo: "importe" | "id" | "sku" }
  | { tipo: "json-maximo"; salidas: [number]; campo: "latencia_ms" }
  | { tipo: "json-duplicada"; salidas: [number]; fila: number; campo: "estado" }
  | { tipo: "log-fallos"; salidas: [number] }
  | { tipo: "log-exit"; salidas: [number] }
  | { tipo: "log-skipped"; salidas: [number] }
  | { tipo: "log-duracion"; salidas: number[]; casos: number[] }
  | { tipo: "ls-cuenta"; salidas: [number] };

export interface Caso {
  id: string;
  familia: Familia;
  salidas: Salida[];
  tarea: Tarea;
  /** La respuesta correcta, como JSON canónico. */
  esperado: string;
  /** Desde la petición que sigue a esta salida (índice), el primer mensaje del usuario está editado. */
  forkEn?: number;
  /** Orden de los brazos en la ejecución (alternado por caso, plan p. 11). */
  orden: "directo" | "inverso";
}

export type Azar = () => number;

/** El mismo mulberry32 que el banco de la cola: determinista y sin dependencias. */
export function azarSembrado(semilla: number): Azar {
  let s = semilla >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const entero = (azar: Azar, min: number, max: number): number => min + Math.floor(azar() * (max - min + 1));
const elegir = <T>(azar: Azar, xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)]!;
const pad = (n: number) => String(n).padStart(4, "0");

// --- JSON ---------------------------------------------------------------------

const SKUS = ["café", "naïve", "日本語", "Ñandú", "😀-emoji", "ascii", "\\u00e9-escapado", "Zürich"];
const DECIMALES = ["10", "00", "5", "25", "90", "01"];

interface VerdadJson {
  texto: string;
  filas: { id: string; sku: string; importe: string; nota: boolean; latencia: number; estado: string[] }[];
}

export function generarJson(azar: Azar, opciones: { filas?: [number, number]; duplicada?: boolean } = {}): VerdadJson {
  const [min, max] = opciones.filas ?? [150, 350];
  const n = entero(azar, min, max);
  const atipica = Math.floor(n / 2) + entero(azar, -5, 5);
  const duplicadaEn = opciones.duplicada ? entero(azar, 10, n - 10) : -1;
  const filas: VerdadJson["filas"] = [];
  const bloques: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = (9007199254740993n + BigInt(i) * 7919n).toString();
    const sku = `"${elegir(azar, SKUS)}-${pad(i)}"`;
    const importe = `${entero(azar, 0, 999)}.${elegir(azar, DECIMALES)}`;
    const nota = azar() < 0.15;
    const latencia = i === atipica ? 98_765 + entero(azar, 0, 999) : entero(azar, 5, 400);
    const estado = i === duplicadaEn ? ['"abierto"', '"cerrado"'] : [elegir(azar, ['"abierto"', '"cerrado"', '"pendiente"'])];
    filas.push({ id, sku, importe, nota, latencia, estado });
    const lineas = [
      `    "id": ${id}`,
      `    "sku": ${sku}`,
      `    "importe": ${importe}`,
      `    "nota": ${nota ? "null" : '"ok"'}`,
      `    "latencia_ms": ${latencia}`,
      ...estado.map((e) => `    "estado": ${e}`),
    ];
    bloques.push(`  {\n${lineas.join(",\n")}\n  }`);
  }
  return { texto: `[\n${bloques.join(",\n")}\n]`, filas };
}

// --- logs de tests -------------------------------------------------------------

type Posicion = "inicio" | "medio" | "fin";

interface VerdadLog {
  texto: string;
  fallos: string[];
  exit: number;
  skipped: number;
  duraciones: Map<number, number>;
  /** Casos en líneas del medio (para preguntas que obligan a recuperar). */
  casosDelMedio: number[];
}

export function generarLog(
  azar: Azar,
  opciones: { lineas?: [number, number]; fallos?: Posicion[]; warnings?: [number, number]; skipped?: [number, number] } = {},
): VerdadLog {
  const [min, max] = opciones.lineas ?? [300, 1200];
  const n = entero(azar, min, max);
  const posiciones = opciones.fallos ?? [];
  const nWarn = entero(azar, ...(opciones.warnings ?? [0, 30]));
  const nSkip = entero(azar, ...(opciones.skipped ?? [0, 8]));
  const lineas: string[] = ["> vitest run", "", " RUN  v2.1.9 /repo", ""];
  const duraciones = new Map<number, number>();
  const especiales = new Map<number, string[]>();
  const fallos: string[] = [];
  posiciones.forEach((pos, k) => {
    const en = pos === "inicio" ? entero(azar, 0, 5) : pos === "fin" ? n - 1 - entero(azar, 0, 3) : Math.floor(n / 2) + entero(azar, -n / 5, n / 5);
    const nombre = `test/fallo-${k}-${pad(en)}.test.ts`;
    fallos.push(nombre);
    especiales.set(en, [
      `FAIL  ${nombre} > ${elegir(azar, ["total con IVA", "redondeo", "fecha UTC", "orden estable"])}`,
      `AssertionError: expected ${entero(azar, 1, 999)} to be ${entero(azar, 1, 999)}`,
      `    at Object.<anonymous> (${nombre}:${entero(azar, 2, 99)}:${entero(azar, 2, 30)})`,
      `    at processTicksAndRejections (node:internal/process/task_queues:95:5)`,
    ]);
  });
  const libres = () => {
    for (;;) {
      const i = entero(azar, 25, n - 25);
      if (!especiales.has(i)) return i;
    }
  };
  for (let k = 0; k < nWarn; k++) especiales.set(libres(), [`WARN  deprecated option "threads" (warning ${k + 1})`]);
  let skipped = 0;
  for (let k = 0; k < nSkip; k++) {
    const i = libres();
    especiales.set(i, [`  ↓ test/caso-${pad(i)}.test.ts [skipped]`]);
    skipped++;
  }
  const casosDelMedio: number[] = [];
  for (let i = 0; i < n; i++) {
    const e = especiales.get(i);
    if (e) {
      lineas.push(...e);
      continue;
    }
    const ms = entero(azar, 1, 999);
    duraciones.set(i, ms);
    if (i > n * 0.3 && i < n * 0.7) casosDelMedio.push(i);
    lineas.push(`  ✓ test/caso-${pad(i)}.test.ts (${ms} ms)`);
  }
  const exit = fallos.length > 0 ? 1 : 0;
  lineas.push(
    "",
    ` Test Files  ${fallos.length} failed | ${n - fallos.length - skipped} passed | ${skipped} skipped (${n})`,
    ` Duration  ${entero(azar, 2, 90)}.${entero(azar, 10, 99)}s`,
    `exit code ${exit}`,
  );
  return { texto: lineas.join("\n"), fallos: [...fallos].sort(), exit, skipped, duraciones, casosDelMedio };
}

// --- ls ------------------------------------------------------------------------

function generarLs(azar: Azar): { texto: string; entradas: number } {
  const n = entero(azar, 3, 12);
  const lineas = [`total ${n * 8}`];
  for (let i = 0; i < n; i++) {
    const dir = azar() < 0.3;
    lineas.push(`${dir ? "drwxr-xr-x" : "-rw-r--r--"}  1 dev  staff  ${entero(azar, 64, 9999)} Oct 15 12:00 ${dir ? "dir" : "fichero"}-${i}${dir ? "" : ".ts"}`);
  }
  return { texto: lineas.join("\n"), entradas: n };
}

// --- casos -----------------------------------------------------------------------

const json = (v: unknown) => JSON.stringify(v);

function tareaJson(azar: Azar, salida: number, v: VerdadJson, duplicada: boolean): { tarea: Tarea; esperado: string } {
  if (duplicada) {
    const fila = v.filas.findIndex((f) => f.estado.length > 1);
    return { tarea: { tipo: "json-duplicada", salidas: [salida], fila, campo: "estado" }, esperado: json(v.filas[fila]!.estado) };
  }
  const tipo = elegir(azar, ["json-nulos", "json-literal", "json-maximo"] as const);
  if (tipo === "json-nulos") {
    return { tarea: { tipo, salidas: [salida], campo: "nota" }, esperado: json(v.filas.filter((f) => f.nota).length) };
  }
  if (tipo === "json-maximo") {
    let mejor = 0;
    v.filas.forEach((f, i) => {
      if (f.latencia > v.filas[mejor]!.latencia) mejor = i;
    });
    return { tarea: { tipo, salidas: [salida], campo: "latencia_ms" }, esperado: json({ fila: mejor, valor: v.filas[mejor]!.latencia }) };
  }
  const campo = elegir(azar, ["importe", "id", "sku"] as const);
  const fila = entero(azar, 0, v.filas.length - 1);
  return { tarea: { tipo, salidas: [salida], fila, campo }, esperado: json(v.filas[fila]![campo]) };
}

function tareaLog(azar: Azar, salida: number, v: VerdadLog): { tarea: Tarea; esperado: string } {
  const tipo = elegir(azar, ["log-fallos", "log-exit", "log-skipped", "log-duracion"] as const);
  if (tipo === "log-fallos") return { tarea: { tipo, salidas: [salida] }, esperado: json(v.fallos) };
  if (tipo === "log-exit") return { tarea: { tipo, salidas: [salida] }, esperado: json(v.exit) };
  if (tipo === "log-skipped") return { tarea: { tipo, salidas: [salida] }, esperado: json(v.skipped) };
  const caso = elegir(azar, v.casosDelMedio);
  return { tarea: { tipo, salidas: [salida], casos: [caso] }, esperado: json([v.duraciones.get(caso)]) };
}

const bash = (cmd: string, contenido: string): Salida => ({ herramienta: "bash", argumentos: { cmd }, contenido });
const posicionesAlAzar = (azar: Azar): Posicion[] =>
  Array.from({ length: entero(azar, 0, 4) }, () => elegir(azar, ["inicio", "medio", "fin"] as const));

function caso(familia: Familia, k: number, azar: Azar): Omit<Caso, "id" | "orden"> {
  switch (familia) {
    case "json-tablas": {
      const duplicada = k % 4 === 3;
      const v = generarJson(azar, { duplicada });
      const t = tareaJson(azar, 1, v, duplicada);
      return { familia, salidas: [bash("ls -la", generarLs(azar).texto), bash("curl -s localhost:8080/api/pedidos", v.texto)], ...t };
    }
    case "logs-tests": {
      const v = generarLog(azar, { fallos: posicionesAlAzar(azar) });
      return { familia, salidas: [bash("ls -la", generarLs(azar).texto), bash("pnpm vitest run", v.texto)], ...tareaLog(azar, 1, v) };
    }
    case "sesion-larga":
    case "sesion-fork": {
      const salidas: Salida[] = [];
      const verdades: ({ log: VerdadLog } | { json: VerdadJson } | { ls: number })[] = [];
      for (let i = 0; i < 8; i++) {
        const r = azar();
        if (r < 0.4) {
          const v = generarLog(azar, { fallos: posicionesAlAzar(azar) });
          salidas.push(bash(`pnpm vitest run --shard ${i}`, v.texto));
          verdades.push({ log: v });
        } else if (r < 0.7) {
          const v = generarJson(azar, { filas: [40, 200] });
          salidas.push(bash(`curl -s localhost:8080/api/lote/${i}`, v.texto));
          verdades.push({ json: v });
        } else {
          const v = generarLs(azar);
          salidas.push(bash(`ls -la dir-${i}`, v.texto));
          verdades.push({ ls: v.entradas });
        }
      }
      const objetivo = entero(azar, 0, 6);
      const v = verdades[objetivo]!;
      const t =
        "log" in v
          ? tareaLog(azar, objetivo, v.log)
          : "json" in v
            ? tareaJson(azar, objetivo, v.json, false)
            : { tarea: { tipo: "ls-cuenta", salidas: [objetivo] } as Tarea, esperado: json(v.ls) };
      return { familia, salidas, ...t, ...(familia === "sesion-fork" ? { forkEn: 4 } : {}) };
    }
    case "sesion-recuperacion-frecuente": {
      const salidas: Salida[] = [];
      const casos: number[] = [];
      const esperado: number[] = [];
      for (let i = 0; i < 4; i++) {
        const v = generarLog(azar, { lineas: [600, 1200], fallos: posicionesAlAzar(azar) });
        salidas.push(bash(`pnpm vitest run --shard ${i}`, v.texto));
        if (i < 3) {
          const c = elegir(azar, v.casosDelMedio);
          casos.push(c);
          esperado.push(v.duraciones.get(c)!);
        }
      }
      return { familia, salidas, tarea: { tipo: "log-duracion", salidas: [0, 1, 2], casos }, esperado: json(esperado) };
    }
    case "sesion-noop": {
      const salidas: Salida[] = [];
      const entradas: number[] = [];
      for (let i = 0; i < 6; i++) {
        const v = generarLs(azar);
        salidas.push(bash(`ls -la dir-${i}`, v.texto));
        entradas.push(v.entradas);
      }
      const objetivo = entero(azar, 0, 5);
      return { familia, salidas, tarea: { tipo: "ls-cuenta", salidas: [objetivo] }, esperado: json(entradas[objetivo]) };
    }
    case "sesion-corta": {
      if (azar() < 0.5) {
        const v = generarLog(azar, { lineas: [60, 200], fallos: posicionesAlAzar(azar), warnings: [0, 3], skipped: [0, 2] });
        return { familia, salidas: [bash("pnpm vitest run", v.texto)], ...tareaLog(azar, 0, v) };
      }
      const v = generarJson(azar, { filas: [8, 30] });
      return { familia, salidas: [bash("curl -s localhost:8080/api/pedidos", v.texto)], ...tareaJson(azar, 0, v, false) };
    }
  }
}

/** El corpus entero: `porFamilia` casos de cada familia, con la semilla dada. */
export function corpus(porFamilia: number, semilla: number): Caso[] {
  const salida: Caso[] = [];
  FAMILIAS.forEach((familia, f) => {
    const azar = azarSembrado(semilla + f * 1009);
    for (let k = 0; k < porFamilia; k++) {
      const c = caso(familia, k, azar);
      salida.push({ id: `${familia}-${pad(k)}`, ...c, orden: k % 2 === 0 ? "directo" : "inverso" });
    }
  });
  return salida;
}

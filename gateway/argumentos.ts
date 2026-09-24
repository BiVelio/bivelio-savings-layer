import { esTerminalConEnvoltorio } from "./envoltorios.js";

/**
 * LA DECISIÓN DEL CLI, como función pura: «ayuda», «versión» o «arrancar».
 *
 * Hasta 0.4.20 vivía inline en bin.ts y solo miraba el PRIMER argumento, así
 * que `bvsala gateway --help` arrancaba el proxy, `bvsala doctor -h` ejecutaba
 * el doctor y `bvsala --version` imprimía la ayuda entera con exit 1 (los tres,
 * hallazgos de la verificación de la 0.4.20). bin.ts es un script con
 * top-level await que arranca cosas al importarse, y por eso no se puede
 * probar: lo que se decide aquí, se prueba aquí (test/gateway-argumentos.test.ts).
 */

const COMANDOS_PROPIOS = ["gateway", "doctor", "skill"] as const;
const PIDE_AYUDA = new Set(["help", "--help", "-h"]);
const PIDE_VERSION = new Set(["version", "--version", "-v"]);

export type Decision =
  | { tipo: "ayuda"; salida: 0 | 1 }
  | { tipo: "version" }
  | { tipo: "arrancar"; comando: string; resto: string[] };

/** @param args `process.argv.slice(2)`: el comando y lo que venga detrás. */
export function decidirArranque(args: readonly string[]): Decision {
  const [comando, ...resto] = args;
  if (comando === undefined || PIDE_AYUDA.has(comando)) return { tipo: "ayuda", salida: 0 };
  if (PIDE_VERSION.has(comando)) return { tipo: "version" };
  // Los envoltorios NO interceptan nada: `bvsala claude --help` tiene que
  // enseñar la ayuda de Claude Code, y `bvsala codex --version` la de Codex.
  // Todo lo que va detrás del terminal es del terminal.
  if (esTerminalConEnvoltorio(comando)) return { tipo: "arrancar", comando, resto };
  if (!(COMANDOS_PROPIOS as readonly string[]).includes(comando)) return { tipo: "ayuda", salida: 1 };
  // Un subcomando propio con -h/--help en cualquier posición es una pregunta,
  // no una orden: se responde ANTES de arrancar nada (ni proxy, ni doctor).
  if (resto.some((a) => PIDE_AYUDA.has(a))) return { tipo: "ayuda", salida: 0 };
  if (resto.some((a) => PIDE_VERSION.has(a))) return { tipo: "version" };
  return { tipo: "arrancar", comando, resto };
}

/**
 * El fallo de arranque del gateway traducido a UNA línea para el probador. El
 * escenario más probable es lanzarlo dos veces (el 8402 por defecto): hasta
 * 0.4.20 moría con la traza cruda de Node («node:net … Error: listen
 * EADDRINUSE: address already in use 127.0.0.1:8402») y ningún mensaje del
 * producto. El puerto se lee del error (el que de verdad falló) y solo si no
 * viene se usa el pedido.
 */
export function mensajeDeFalloDeArranque(err: unknown, comando: string, puertoPedido: number): string {
  const e = (err ?? {}) as { code?: unknown; puerto?: unknown; message?: unknown };
  const puerto = typeof e.puerto === "number" ? e.puerto : puertoPedido;
  if (e.code === "EADDRINUSE") {
    return (
      `port ${puerto} is already in use (another gateway, or a terminal launched earlier?): ` +
      `use --port ${puerto + 1} or stop the other process`
    );
  }
  if (e.code === "EACCES") {
    return (
      `port ${puerto} cannot be opened: permission denied (EACCES; ports below 1024 ` +
      `need privileges): use --port ${Math.max(1024, puerto)} or higher`
    );
  }
  const detalle = err instanceof Error ? err.message : String(err);
  return `could not start the gateway for \`bvsala ${comando}\`: ${detalle}`;
}

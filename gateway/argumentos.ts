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

const COMANDOS_PROPIOS = ["gateway", "doctor", "skill", "init", "mcp"] as const;
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
 * `bvsala <terminal> X` with X one of `--help`, `-h`, `--version` and nothing
 * else: a question for the child terminal, answered with no gateway.
 */
export function isChildInfoRequest(rest: readonly string[]): boolean {
  // Solo estas tres y solas. `-v`, `help` y `version` quedan fuera A PROPÓSITO:
  // en algunos terminales `-v` es verbose y una palabra suelta puede ser un
  // prompt, y lanzarlas sin gateway sería una sesión sin medir ni licencia.
  return rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h" || rest[0] === "--version");
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

// ── LOS NOMBRES EN INGLÉS (decisión del dueño, 2026-09-29) ──
//
// Flags y variables del CLI se escriben en inglés. Los nombres españoles fueron
// alias con aviso en la 0.4.33 y la 0.4.34; en la 0.5 dejan de funcionar. No se
// ignoran en silencio: un flag que desaparece sin decir nada cambia de sentido
// (`--puerto 9000` acabaría en el 8402 por defecto) y una variable ignorada
// apaga una palanca que el cliente cree encendida. Así que el nombre viejo es
// un ERROR que dice el nuevo, y el CLI sale con 1 antes de arrancar nada. Solo
// en los subcomandos propios: lo que va detrás de un terminal envuelto
// (`bvsala claude …`) es del terminal y no se toca.

/** Flag español retirado en la 0.5 → su nombre en inglés. */
export const RETIRED_FLAGS: Readonly<Record<string, string>> = {
  "--puerto": "--port",
  "--proyecto": "--project",
  "--forzar": "--force",
};

/** Variable española retirada en la 0.5 → su nombre en inglés. */
export const RETIRED_ENV_VARS: Readonly<Record<string, string>> = {
  BVSALA_GATEWAY_ESFUERZO: "BVSALA_GATEWAY_EFFORT",
  BVSALA_GATEWAY_MODELO_HERMANO: "BVSALA_GATEWAY_SIBLING_MODEL",
};

/**
 * Los errores por nombre retirado, uno por nombre distinto (vacío si no hay
 * ninguno). Los flags solo cuentan en los subcomandos propios (`flags`
 * vacío para un envoltorio); las variables, solo donde se leen: en lo que
 * arranca el gateway (`gateway` y los envoltorios).
 */
export function retiredNameErrors(
  flags: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  { checkEnv }: { checkEnv: boolean },
): string[] {
  const errores: string[] = [];
  const vistos = new Set<string>();
  for (const a of flags) {
    // `--puerto=9000` también: el nombre es lo que va antes del `=`.
    const nombre = a.split("=")[0]!;
    const ingles = RETIRED_FLAGS[nombre];
    if (ingles === undefined || vistos.has(nombre)) continue;
    vistos.add(nombre);
    errores.push(`[bvsala] ${nombre} was removed in 0.5: use ${ingles}.`);
  }
  if (checkEnv) {
    for (const [espanol, ingles] of Object.entries(RETIRED_ENV_VARS)) {
      if (env[espanol] === undefined) continue;
      errores.push(
        `[bvsala] ${espanol} was removed in 0.5 and is no longer read: rename it to ${ingles} ` +
          `(same values), or unset it.`,
      );
    }
  }
  return errores;
}

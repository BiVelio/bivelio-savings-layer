import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `bvsala` EJECUTADO DE VERDAD, en un proceso aparte: lo que bin.ts imprime,
 * cómo trata las señales y qué argumentos rechaza no se puede probar
 * importándolo (arranca cosas al cargarse). Se lanza el bin COMPILADO
 * (`dist/gateway/bin.js`): desde el fuente no hay clave pública embebida y el
 * gateway no arranca. CI compila antes de probar (`build:all` → `pnpm test`).
 *
 * El entorno se construye DESDE CERO: PATH (con los terminales falsos delante)
 * y un HOME vacío. Heredar el del desarrollador metería su BIVELIO_SERVICE_KEY
 * (y con ella tráfico a savings.bivelio.com), su ~/.bvsala/anillo2.json o su
 * ~/.codex/auth.json en la prueba.
 */
export const RAIZ = join(__dirname, "..", "..");
export const BIN = join(RAIZ, "dist", "gateway", "bin.js");

export function exigirBinCompilado(): void {
  if (!existsSync(BIN)) throw new Error(`${BIN} does not exist: run \`pnpm build\` before this test`);
}

export interface Caja {
  dir: string;
  /** Entorno limpio para el hijo, con `extra` encima. */
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  /** Un terminal falso en el PATH de la caja: un script de Node con este código. */
  terminal: (nombre: string, codigo: string) => void;
  limpiar: () => void;
}

export function cajaLimpia(): Caja {
  const dir = mkdtempSync(join(tmpdir(), "bvsala-proceso-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(bin);
  mkdirSync(home);
  return {
    dir,
    env: (extra = {}) => ({ PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, ...extra }),
    terminal: (nombre, codigo) => {
      const ruta = join(bin, nombre);
      writeFileSync(ruta, `#!${process.execPath}\n${codigo}\n`);
      chmodSync(ruta, 0o755);
    },
    limpiar: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Lanzado {
  hijo: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resuelve con el código y la señal de salida, y el instante (ms desde el lanzamiento). */
  salida: Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>;
  /** Espera a que stdout+stderr contengan `re`; rechaza tras `ms`. */
  esperar: (re: RegExp, ms?: number) => Promise<RegExpMatchArray>;
  /** Mata el grupo entero (limpieza): nunca deja procesos colgados. */
  matar: () => void;
}

/**
 * `node dist/gateway/bin.js …args` en su PROPIO grupo de procesos (`detached`),
 * como el grupo en primer plano de una terminal: `process.kill(-pid, "SIGINT")`
 * es exactamente lo que hace Ctrl-C.
 */
export function lanzar(args: string[], env: NodeJS.ProcessEnv): Lanzado {
  const t0 = Date.now();
  const hijo = spawn(process.execPath, [BIN, ...args], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  hijo.stdout!.on("data", (d) => (out += String(d)));
  hijo.stderr!.on("data", (d) => (err += String(d)));
  const salida = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((resolve) => {
    hijo.on("close", (code, signal) => resolve({ code, signal, ms: Date.now() - t0 }));
  });
  const esperar = (re: RegExp, ms = 15_000): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const tope = setTimeout(() => {
        clearInterval(vigia);
        reject(new Error(`timed out waiting for ${re}\n--- stdout:\n${out}\n--- stderr:\n${err}`));
      }, ms);
      const vigia = setInterval(() => {
        const m = (out + err).match(re);
        if (m) {
          clearTimeout(tope);
          clearInterval(vigia);
          resolve(m);
        }
      }, 20);
    });
  const matar = (): void => {
    try {
      process.kill(-hijo.pid!, "SIGKILL");
    } catch {
      /* ya no está */
    }
  };
  return { hijo, stdout: () => out, stderr: () => err, salida, esperar, matar };
}

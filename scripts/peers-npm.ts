/**
 * ¿INSTALA `npm install @bivelio/savings-layer` EN UN PROYECTO QUE YA TIENE LA
 * ÚLTIMA VERSIÓN DE CADA PEER? (A2-1)
 *
 * Uso (desde la raíz del repo, con `dist/` ya construido):
 *
 *   pnpm peers:npm
 *
 * Los peers del paquete son opcionales (`peerDependenciesMeta`), pero eso solo
 * evita que npm los instale solos: si el proyecto YA tiene una versión fuera del
 * rango declarado, npm (no pnpm, yarn ni bun, que avisan) se niega a instalar con
 * ERESOLVE. Pasó con @anthropic-ai/sdk 1.x y gpt-tokenizer 4, las `latest` del
 * 2026-11-19: la 1.2.1 no se podía instalar con `npm i` en esos proyectos.
 *
 * Lo que hace: `npm pack` del paquete → para cada peer, un proyecto vacío con
 * `dependencies: { <peer>: <su latest en npm> }` → `npm install --dry-run
 * <tarball>`. Falla (sale con 1) si alguno da ERESOLVE. Un proyecto por peer, para
 * que un conflicto entre dos peers ajenos no se confunda con uno nuestro.
 *
 * NECESITA RED (el registro de npm). Sin red no puede comprobar nada: lo dice y
 * sale con 0, para no bloquear a nadie que trabaje sin conexión. No va en la suite
 * de vitest a propósito, por lo mismo que `sala-limpia-del-tarball.test.ts` no
 * instala: meter el registro en cada `pnpm test` son minutos y un test que depende
 * de lo que publiquen otros. Se corre antes de publicar.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ejecutar = promisify(execFile);
const RAIZ = fileURLToPath(new URL("..", import.meta.url));

interface Salida {
  ok: boolean;
  texto: string;
}

async function npm(args: string[], cwd: string, timeoutMs = 180_000): Promise<Salida> {
  try {
    const r = await ejecutar("npm", args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, texto: `${r.stdout}\n${r.stderr}` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, texto: `${err.stdout ?? ""}\n${err.stderr ?? ""}\n${err.message ?? ""}` };
  }
}

const SIN_RED = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network request|getaddrinfo/i;

async function main(): Promise<number> {
  const pkg = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, string>;
  };
  const peers = Object.keys(pkg.peerDependencies ?? {}).sort();
  if (peers.length === 0) {
    console.log("peers:npm · el paquete no declara peers: nada que comprobar");
    return 0;
  }

  // Primero, ¿hay registro? Sin red no se puede decir nada: se salta y se dice.
  const sonda = await npm(["view", peers[0]!, "version"], RAIZ, 30_000);
  if (!sonda.ok) {
    if (SIN_RED.test(sonda.texto)) {
      console.log("peers:npm · SALTADO: sin red (el registro de npm no responde); no se ha comprobado nada");
      return 0;
    }
    console.error(`peers:npm · npm view ${peers[0]} falló:\n${sonda.texto.trim()}`);
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), "bvsala-peers-npm-"));
  try {
    const pack = await npm(["pack", "--silent", "--pack-destination", dir], RAIZ, 120_000);
    if (!pack.ok) {
      console.error(`peers:npm · npm pack falló:\n${pack.texto.trim()}`);
      return 1;
    }
    const tgz = join(dir, pack.texto.trim().split("\n")[0]!.trim());

    const resultados = await Promise.all(
      peers.map(async (peer, i) => {
        const v = await npm(["view", peer, "version"], RAIZ, 60_000);
        if (!v.ok) return { peer, version: "?", estado: SIN_RED.test(v.texto) ? "sin-red" : "error", texto: v.texto };
        const version = v.texto.trim().split("\n")[0]!.trim();
        const proyecto = join(dir, `p${i}`);
        mkdirSync(proyecto);
        writeFileSync(
          join(proyecto, "package.json"),
          JSON.stringify({ name: `peer-${i}`, version: "0.0.0", private: true, dependencies: { [peer]: version } }),
        );
        const r = await npm(
          ["install", "--dry-run", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", tgz],
          proyecto,
        );
        const estado = /ERESOLVE/.test(r.texto) ? "ERESOLVE" : r.ok ? "ok" : SIN_RED.test(r.texto) ? "sin-red" : "error";
        return { peer, version, estado, texto: r.texto };
      }),
    );

    let malos = 0;
    for (const r of resultados) {
      console.log(`peers:npm · ${r.estado.padEnd(8)} ${r.peer}@${r.version}`);
      if (r.estado === "ERESOLVE" || r.estado === "error") {
        malos++;
        console.error(r.texto.split("\n").filter((l) => /ERESOLVE|peer|Found|Could not resolve|error/i.test(l)).slice(0, 12).join("\n"));
      }
    }
    if (resultados.some((r) => r.estado === "sin-red")) {
      console.log("peers:npm · AVISO: algún peer no se pudo comprobar por la red");
    }
    return malos > 0 ? 1 : 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(await main());

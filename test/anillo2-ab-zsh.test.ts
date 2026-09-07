import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * scripts/anillo2-ab.zsh — el A/B de días alternos automático (org propia).
 * Verjas puras: paridad del protocolo, la trampa del alias (zsh expande un
 * alias `claude` DENTRO de `claude() {}` y revienta la definición), y la
 * negativa sin clave de servicio. Sin espía, sin claude, sin red.
 * En un runner sin zsh (CI en ubuntu) se salta con motivo.
 */
const SCRIPT = fileURLToPath(new URL("../scripts/anillo2-ab.zsh", import.meta.url));
const hayZsh = spawnSync("zsh", ["-c", "true"]).status === 0;
const zsh = (codigo: string, env: Record<string, string> = {}) =>
  spawnSync("zsh", ["-c", `source ${SCRIPT}; ${codigo}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });

describe.skipIf(!hayZsh)("anillo2-ab.zsh — el A/B automático", () => {
  it("brazo por paridad del día natural UTC: par = palanca (=1), impar = control (=0)", () => {
    const r = zsh(
      'for d in 2026-09-06 2026-09-07 2026-09-08 2026-09-09 2026-09-30 2026-10-01 2026-10-10; do echo "$d $(bvsala-ab-brazo $d) $(bvsala-ab-bandera $d)"; done',
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      "2026-09-06 palanca 1",
      "2026-09-07 control 0",
      "2026-09-08 palanca 1",
      "2026-09-09 control 0",
      "2026-09-30 palanca 1",
      "2026-10-01 control 0",
      "2026-10-10 palanca 1",
    ]);
  });

  it("los días 08 y 09 no se leen en octal (10#): 08 es par, 09 impar", () => {
    const r = zsh('echo "$(bvsala-ab-brazo 2026-09-08) $(bvsala-ab-brazo 2026-09-09)"');
    expect(r.stdout.trim()).toBe("palanca control");
  });

  it("⛔ la trampa del alias: con `alias claude=…` ya definido, el fichero deja una FUNCIÓN claude", () => {
    const r = spawnSync("zsh", ["-c", `alias claude='bvsala claude'; source ${SCRIPT}; whence -w claude`], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("claude: function");
  });

  it("⛔ sin BIVELIO_SERVICE_KEY se niega a lanzar (la palanca no se armaría: control en silencio)", () => {
    const r = zsh("BVSALA_AB_SECO=1 claude; echo exit=$?", { BIVELIO_SERVICE_KEY: "" });
    expect(r.stderr).toMatch(/falta BIVELIO_SERVICE_KEY/);
    expect(r.stdout).toMatch(/exit=1/);
  });
});

describe.skipIf(!hayZsh)("anillo2-ab.zsh — lo que cazó la revisión del 06-09", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  /** Un «clon» de mentira con el arnés presente y un pnpm que revienta. */
  function laboratorio(): { repo: string; bin: string; limpiar: () => void } {
    const raiz = mkdtempSync(join(tmpdir(), "anillo2-ab-"));
    const repo = join(raiz, "repo");
    mkdirSync(join(repo, "benchmarks", "anillo2"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}");
    writeFileSync(join(repo, "benchmarks", "anillo2", "arnes.ts"), "");
    const bin = join(raiz, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), "#!/bin/sh\necho 'OOM de mentira' >&2\nexit 1\n");
    chmodSync(join(bin, "pnpm"), 0o755);
    writeFileSync(join(bin, "bvsala"), '#!/bin/sh\necho "bvsala-falso $*"\n');
    chmodSync(join(bin, "bvsala"), 0o755);
    return { repo, bin, limpiar: () => rmSync(raiz, { recursive: true, force: true }) };
  }

  it("⛔ sin el clon con el arnés se niega (BVSALA_AB_REPO movido o rama sin anillo 2)", () => {
    const r = zsh("BVSALA_AB_SECO=1 claude; echo exit=$?", { BIVELIO_SERVICE_KEY: "bvk_falsa", BVSALA_AB_REPO: "/no/existe" });
    expect(r.stderr).toMatch(/no es el clon con el arnés/);
    expect(r.stdout).toMatch(/exit=1/);
  });

  it("⛔ un informe que FALLA no se guarda como bueno: queda .fallo con la causa y se reintenta", async () => {
    const lab = laboratorio();
    try {
      const env = { BVSALA_AB_REPO: lab.repo, PATH: `${lab.bin}:${process.env.PATH ?? ""}` };
      const r1 = zsh("bvsala-ab-informes 2026-09-01; echo exit=$?", env);
      expect(r1.stderr + r1.stdout).toMatch(/lanzados en segundo plano/);
      const fallo = join(lab.repo, "benchmarks", "out", "anillo2-noche-2026-09-01.fallo");
      const txt = join(lab.repo, "benchmarks", "out", "anillo2-noche-2026-09-01.txt");
      for (let i = 0; i < 100 && !existsSync(fallo); i++) await new Promise((res) => setTimeout(res, 50));
      expect(existsSync(fallo)).toBe(true);
      expect(existsSync(txt)).toBe(false);
      expect(readFileSync(fallo, "utf8")).toMatch(/rc=[1-9]/);
      expect(readFileSync(fallo, "utf8")).toMatch(/OOM de mentira/);
      // El candado se ha ido: la siguiente sesión avisa del fallo y RELANZA.
      const r2 = zsh("bvsala-ab-informes 2026-09-01", env);
      expect(r2.stderr).toMatch(/FALLARON la última vez: rc=/);
      expect(r2.stderr + r2.stdout).toMatch(/lanzados en segundo plano/);
    } finally {
      await new Promise((res) => setTimeout(res, 300));
      lab.limpiar();
    }
  });

  it("⛔ el ratón huérfano: al lanzar y al salir, la función apaga el seguimiento del ratón del terminal", () => {
    // Claude Code activa DECSET 1000/1006 para su TUI y solo lo apaga si sale
    // limpio. Con un `exec zsh -l` a media sesión queda huérfano y cada
    // movimiento del puntero se vuelca como `^[[<35;44;22M` en la entrada
    // (07-09). El saneado se ejecuta antes y después de `command bvsala claude`.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const src = readFileSync(SCRIPT, "utf8");
    const cuerpo = src.slice(src.indexOf("function claude {"));
    const lanza = cuerpo.indexOf('command bvsala claude "$@"\n  local rc=$?');
    expect(lanza).toBeGreaterThan(0);
    const antes = cuerpo.slice(0, lanza);
    const despues = cuerpo.slice(lanza);
    expect(antes).toContain("bvsala-ab-sanear-terminal");
    expect(despues).toContain("bvsala-ab-sanear-terminal");
    // y la secuencia apaga los CUATRO modos de ratón, no solo uno
    for (const modo of ["1000", "1002", "1003", "1006"]) expect(src).toContain(`?${modo}l`);
  });

  it("el saneado no escribe nada si stdout NO es una terminal (una tubería no recibe escapes)", () => {
    const r = zsh("bvsala-ab-sanear-terminal; echo rc=$?");
    expect(r.stdout).toBe("rc=0\n");
  });

  it("`claude --version` / `--help` / `mcp` pasan de largo sin preflight (ni clave, ni espía)", () => {
    const lab = laboratorio();
    try {
      const r = zsh("claude --version; claude mcp list", { BIVELIO_SERVICE_KEY: "", PATH: `${lab.bin}:${process.env.PATH ?? ""}` });
      expect(r.stdout.trim().split("\n")).toEqual(["bvsala-falso claude --version", "bvsala-falso claude mcp list"]);
      expect(r.stderr).not.toMatch(/falta BIVELIO_SERVICE_KEY/);
    } finally {
      lab.limpiar();
    }
  });

  it("los mensajes [anillo2] no entran en una tubería: con stdout que no es terminal van a stderr", () => {
    const r = zsh("bvsala-ab-di hola-tuberia; echo fin", {});
    expect(r.stdout.trim()).toBe("fin");
    expect(r.stderr.trim()).toBe("hola-tuberia");
  });
});

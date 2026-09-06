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

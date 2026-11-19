import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BIN, cajaLimpia, exigirBinCompilado, type Caja } from "./helpers/bvsala-proceso.js";

/**
 * A2-16 · `bvsala gateway --upsteam openai` arrancaba contra Anthropic, y
 * `-p 9000` o `--Port 9000` en el 8402, sin ningún error. Ahora salen con 1
 * antes de arrancar nada, nombrando el flag y sugiriendo el bueno. Se ejecuta el
 * bin compilado; con el fallo, el gateway arrancaba y el tope de 8 s lo mataba.
 */
describe.skipIf(process.platform === "win32")("A2-16 · flags desconocidos en `gateway` y `doctor`", () => {
  let caja: Caja;
  beforeAll(() => exigirBinCompilado());
  afterEach(() => caja?.limpiar());

  const casos: Array<[string[], string]> = [
    [["gateway", "--upsteam", "openai", "--port", "0"], "unknown option --upsteam (did you mean --upstream?)"],
    [["gateway", "-p", "0"], "unknown option -p (did you mean --port?)"],
    [["gateway", "--Port", "0"], "unknown option --Port (did you mean --port?)"],
    [["doctor", "-p", "9000"], "unknown option -p (did you mean --port?)"],
  ];
  for (const [args, mensaje] of casos) {
    it(`bvsala ${args.join(" ")} → exit 1 sin arrancar nada`, () => {
      caja = cajaLimpia();
      const r = spawnSync(process.execPath, [BIN, ...args], { env: caja.env(), encoding: "utf8", timeout: 8_000 });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(1);
      expect(r.stderr).toContain(mensaje);
      expect(r.stdout + r.stderr).not.toContain("listening on");
    });
  }

  it("las formas buenas siguen funcionando: `doctor --port=9000` imprime recetas para ese puerto", () => {
    caja = cajaLimpia();
    const r = spawnSync(process.execPath, [BIN, "doctor", "--port=9000"], { env: caja.env(), encoding: "utf8", timeout: 15_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("127.0.0.1:9000");
  });
});

import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { BIN, cajaLimpia, exigirBinCompilado, lanzar, type Caja } from "./helpers/bvsala-proceso.js";

/**
 * A2-14, A2-23 y A2-29 · LO QUE VE QUIEN ARRANCA SIN NINGUNA CLAVE.
 *
 * Es lo primero que lee un visitante de Product Hunt en su terminal. Debajo de
 * «COMMUNITY MODE … every local saving lever on» salía «licence channel: OPEN by
 * default (=0 turns the levers off) (TTL tuning ON if your licence includes
 * cache_ttl_tuning; fail-closed)», y con el modelo hermano o el esfuerzo
 * encendidos, «ON if your licence includes …». Sin clave las cuatro palancas las
 * concede el propio gateway (CanalComunitario), gratis: esas líneas pedían una
 * licencia que el usuario no tiene ni necesita, y «(=0 …)» no decía qué variable.
 * `bvsala --help` repetía tres veces que cada palanca «only takes effect if your
 * organization's license carries its feature».
 *
 * Se ejecuta el bin compilado, sin ninguna clave y con un HOME vacío.
 */
const VIEJAS = [/if your licen[cs]e includes/i, /licen[cs]e carries/i, /per-seat licen[cs]e/i, /\(=0 turns/];

describe.skipIf(process.platform === "win32")("A2-14/A2-23/A2-29 · sin clave, ningún texto pide licencia para ahorrar", () => {
  let caja: Caja;
  beforeAll(() => exigirBinCompilado());
  afterEach(() => caja?.limpiar());

  it("el arranque de `bvsala gateway` sin claves: palancas gratis, sin «licence» ni «fail-closed», con la variable entera", async () => {
    caja = cajaLimpia();
    const p = lanzar(
      ["gateway", "--port", "0"],
      caja.env({ BVSALA_GATEWAY_SIBLING_MODEL: "1", BVSALA_GATEWAY_EFFORT: "low" }),
    );
    try {
      await p.esperar(/per-turn effort: .*\n/);
      const texto = p.stdout() + p.stderr();
      expect(texto).toContain("COMMUNITY MODE (open core): no BiVelio keys set - free, zero telemetry, nothing sent to BiVelio");
      // 1.2.4 · el cartel ya no dice que todo está encendido encima de tres OFF.
      expect(texto).not.toMatch(/every local saving lever|savings levers: ON/);
      expect(texto).toContain("savings levers (community mode: free, no key needed): cache TTL tuning is the only one ON by default");
      expect(texto).toContain("on a Claude or ChatGPT subscription this run only measures");
      expect(texto).toContain("BVSALA_GATEWAY_ELISION=0 turns it off");
      expect(texto).toMatch(/sibling model routing: ARMED \([^)]*community mode: free, no key needed\)/);
      expect(texto).toMatch(/per-turn effort: ARMED at "low" \(community mode: free, no key needed\)/);
      for (const re of VIEJAS) expect(texto, String(re)).not.toMatch(re);
      // Las líneas de las palancas no hablan de licencias ni de fail-closed.
      const palancas = texto.split("\n").filter((l) => /savings levers|sibling model routing|per-turn effort/.test(l));
      expect(palancas).toHaveLength(3);
      for (const l of palancas) expect(l).not.toMatch(/licen[cs]e|fail-closed/i);
    } finally {
      p.matar();
    }
  });

  it("`bvsala claude` sin claves dice lo mismo (por stderr)", () => {
    caja = cajaLimpia();
    caja.terminal("claude", "");
    const r = spawnSync(process.execPath, [BIN, "claude", "-p", "hola"], { env: caja.env(), encoding: "utf8", timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("savings levers (community mode: free, no key needed): cache TTL tuning is the only one ON by default");
    expect(r.stderr).not.toMatch(/every local saving lever|savings levers: ON/);
    // Con las tres líneas OFF debajo, la de arriba dice la variable que enciende cada una.
    expect(r.stderr).toContain("opt-in: BVSALA_GATEWAY_SIBLING_MODEL=1, BVSALA_GATEWAY_EFFORT=low|medium");
    for (const re of VIEJAS) expect(r.stderr, String(re)).not.toMatch(re);
  });

  it("`bvsala --help`: las palancas son gratis sin claves; solo con licencia de organización manda la suya", () => {
    const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(r.status).toBe(0);
    for (const re of [...VIEJAS, /only takes effect if your organization's licen[cs]e/i, /toward the fee/i, /commission/i]) {
      expect(r.stdout, String(re)).not.toMatch(re);
    }
    expect(r.stdout).toMatch(/With\s+no BiVelio keys \(COMMUNITY mode\) they are free and need no license\./);
    // Las dos palancas opt-in: gratis sin claves y con la licencia gratuita Measure; las de pago las incluyen.
    expect(r.stdout.match(/Free with\s+no keys and with the free\s+Measure license; a Pro or Team license\s+includes it/g)).toHaveLength(2);
    // 1.2.4 · la clave solo añade la nube: ningún texto dice que una licencia decide qué palancas aplican.
    expect(r.stdout).not.toMatch(/feature list decide|every local (saving )?lever|all local levers|arms every|org entitlements/);
    expect(r.stdout).toMatch(/A BiVelio key only adds the cloud: the free Measure license applies\s+the same levers as no key/);
    // La frase del 8,0 % no describe tráfico de suscripción como factura de API.
    expect(r.stdout).not.toContain("8.0% of the bill");
    expect(r.stdout).toMatch(/at API list prices that surcharge was 8\.0% of the cost/);
  });
});

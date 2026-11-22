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
      expect(texto).toContain("on a Claude or ChatGPT subscription the default lever changes nothing and this run only measures");
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

  // E2E DEL 22-11 · el arranque sin claves decía dos «COMMUNITY MODE (open
  // core)» con textos distintos (el aviso del servidor y el cartel de bin.ts),
  // BVSALA_GATEWAY_COALESCE=1 no tenía línea y BVSALA_GATEWAY_SHADOW=1 sin clave
  // no hacía nada sin decirlo. Ninguna palanca cambia: solo el cartel.
  it("⛔ el cartel sin claves dice COMMUNITY MODE UNA vez, la línea de la guía", async () => {
    caja = cajaLimpia();
    const p = lanzar(["gateway", "--port", "0"], caja.env());
    try {
      await p.esperar(/point your terminal at it.*\n/);
      const texto = p.stdout() + p.stderr();
      const comunitarias = texto.split("\n").filter((l) => l.includes("COMMUNITY MODE"));
      expect(comunitarias, texto).toEqual([
        "[bvsala gateway] COMMUNITY MODE (open core): no BiVelio keys set - free, zero telemetry, nothing sent to BiVelio",
      ]);
      // Lo que decía la otra línea sigue dicho en la de metering.
      expect(texto).toContain("metering: LOCAL ONLY (community mode, no BiVelio service key): every request is measured on this machine");
      expect(texto).not.toMatch(/coalescing|shadow lane/);
    } finally {
      p.matar();
    }
  });

  it("⛔ BVSALA_GATEWAY_COALESCE=1 tiene su línea de arranque; en solo-observar dice que no actúa", async () => {
    caja = cajaLimpia();
    const p = lanzar(["gateway", "--port", "0"], caja.env({ BVSALA_GATEWAY_COALESCE: "1" }));
    try {
      await p.esperar(/point your terminal at it.*\n/);
      expect(p.stdout()).toContain(
        "[bvsala gateway] duplicate-request coalescing: ON (BVSALA_GATEWAY_COALESCE=1, experimental) - a request identical " +
          "to one still in flight (messages, chat/completions, responses, embeddings) gets that request's answer instead " +
          "of a second upstream call; its log line says COALESCED (call avoided)",
      );
    } finally {
      p.matar();
    }
    const q = lanzar(["gateway", "--port", "0"], caja.env({ BVSALA_GATEWAY_COALESCE: "1", BVSALA_GATEWAY_OBSERVE_ONLY: "1" }));
    try {
      await q.esperar(/point your terminal at it.*\n/);
      const texto = q.stdout() + q.stderr();
      expect(texto).toContain("duplicate-request coalescing: OFF in observe-only mode (BVSALA_GATEWAY_COALESCE=1 is ignored");
      expect(texto).not.toContain("duplicate-request coalescing: ON");
    } finally {
      q.matar();
    }
  });

  it("⛔ BVSALA_GATEWAY_SHADOW=1 sin clave: una línea que dice que se ignora y por qué", async () => {
    caja = cajaLimpia();
    const p = lanzar(["gateway", "--port", "0"], caja.env({ BVSALA_GATEWAY_SHADOW: "1" }));
    try {
      await p.esperar(/point your terminal at it.*\n/);
      expect(p.stderr()).toContain(
        "[bvsala gateway] shadow lane: ignored - BVSALA_GATEWAY_SHADOW=1 needs BIVELIO_SERVICE_KEY (its estimates only go " +
          "to the cloud dashboard); nothing else changes",
      );
      // Las palancas, como sin la variable.
      expect(p.stdout()).toContain("savings levers (community mode: free, no key needed): cache TTL tuning is the only one ON by default");
    } finally {
      p.matar();
    }
  });

  it("la pista de arranque para Claude Code a mano lleva ENABLE_TOOL_SEARCH=true, como docs/terminales/claude-code.md", async () => {
    caja = cajaLimpia();
    const p = lanzar(["gateway", "--port", "0"], caja.env());
    try {
      await p.esperar(/point your terminal at it.*\n/);
      const linea = (p.stdout() + p.stderr()).split("\n").find((l) => l.includes("point your terminal at it"))!;
      expect(linea).toMatch(/ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+ claude/);
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

  it("`bvsala --help`: las palancas son gratis sin claves y con Medir; con una licencia de pago, como en la 1.2.3", () => {
    const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(r.status).toBe(0);
    for (const re of [...VIEJAS, /only takes effect if your organization's licen[cs]e/i, /toward the fee/i, /commission/i]) {
      expect(r.stdout, String(re)).not.toMatch(re);
    }
    expect(r.stdout).toMatch(/With\s+no BiVelio keys \(COMMUNITY mode\) they are free and need\s+no license/);
    // 1.2.4 · decisiones del dueño (21-11-2026): Medir = sin clave; con una licencia
    // de pago, el gateway como en la 1.2.3 de pago (cada palanca pide su feature,
    // fail-closed). Una rama previa decía «free on every plan» y concedía las
    // palancas a cualquier licencia; con pago y la nube caída eso encarecía las
    // sesiones con pausas largas. La ayuda dice ahora las dos cosas, sin pedir
    // licencia a quien no tiene clave.
    expect(r.stdout).not.toMatch(/Free on\s+every plan/);
    const plano = r.stdout.replace(/\s+/g, " ");
    for (const feature of ["sibling_model_routing", "per_turn_effort"]) {
      expect(plano).toContain(
        `Free with no keys and with the free Measure license; with a paid license, only if it includes ${feature} (fail-closed), as in 1.2.3.`,
      );
    }
    expect(r.stdout).not.toMatch(/every local (saving )?lever|all local levers|arms every|org entitlements/);
    expect(r.stdout).toMatch(/the free Measure license applies the same levers as no\s+key\. With a Pro, Team or Enterprise license the gateway works as in\s+1\.2\.3/);
    expect(r.stdout).toMatch(/A blocked or lapsed\s+license stops the gateway: it answers 402\./);
    // La frase del 8,0 % no describe tráfico de suscripción como factura de API.
    expect(r.stdout).not.toContain("8.0% of the bill");
    // Verificación final de la 1.2.4: el 99,1 % y el 8,0 % no tenían fuente en el
    // repositorio y describían una regla que el código no aplica («while the
    // session stays warm»). La cifra que queda es la del replay publicado.
    expect(r.stdout).not.toMatch(/surcharge was 8\.0% of the cost|99\.1% of turns|stays warm/);
    expect(r.stdout).toMatch(/it left a net 2\.49% of the list-price bill/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { MockProvider } from "../src/providers/mock.js";
import { SILENCIAR_OBSOLETOS, reiniciarAvisos } from "../src/util/warn-once.js";
import { SILENCIAR_OBSOLETOS as SILENCIAR_OBSOLETOS_CLI } from "../gateway/argumentos.js";

/**
 * LA 0.4.34 AVISA EN LA CONSOLA DE LO QUE LA 0.5 QUITA DE LA CONFIGURACIÓN.
 *
 * El `@deprecated` del `.d.ts` solo lo ve quien compila con tipos; quien pasa
 * la configuración desde JavaScript se enteraría al actualizar.
 * `licensePublicKey` NO HACE NADA en el paquete publicado —y sale del tipo en la
 * 0.5—, así que en ese build avisa una vez por proceso. Silenciable con
 * `silenceWarnings` (todo) o con `BVSALA_SILENCE_DEPRECATIONS=1` (solo lo
 * obsoleto), igual que el alias `semanticCache` de la 0.4.33 y los flags
 * españoles de la CLI.
 *
 * `devUnlicensed` no avisa: su nombre no puede viajar en el bundle publicado
 * (la verja de test/sala-limpia-del-tarball.test.ts), y aquí se fija que no lo
 * haga. Desde el código fuente (tests, banco, ejemplos) `licensePublicKey` SÍ
 * funciona y sigue como vía interna: ahí no se avisa.
 */

let avisos: string[];
beforeEach(() => {
  avisos = [];
  reiniciarAvisos();
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// En el paquete publicado tsup compila `__BV_SALA_ALLOW_DEV_OPEN__` a `false`;
// desde el fuente es una global sin definir.
const publicado = () => vi.stubGlobal("__BV_SALA_ALLOW_DEV_OPEN__", false);
const CLAVE = /`createSavingsLayer\(\{ licensePublicKey \}\)` is deprecated/;
const crear = (extra: Record<string, unknown>) => createSavingsLayer({ provider: new MockProvider(), ...extra } as never);

describe("`licensePublicKey` en el paquete publicado", () => {
  it("avisa UNA vez por proceso, aunque se creen varias capas, y dice qué hacer y cuándo se rompe", () => {
    publicado();
    for (let i = 0; i < 3; i++) crear({ licensePublicKey: "pem" });
    const a = avisos.filter((x) => CLAVE.test(x));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatch(/removed in 0\.5/);
  });

  it("⛔ callado con `silenceWarnings`", () => {
    publicado();
    crear({ licensePublicKey: "pem", silenceWarnings: true });
    expect(avisos).toEqual([]);
  });

  it("⛔ callado con BVSALA_SILENCE_DEPRECATIONS=1 (la misma variable que la CLI)", () => {
    expect(SILENCIAR_OBSOLETOS).toBe(SILENCIAR_OBSOLETOS_CLI);
    publicado();
    vi.stubEnv(SILENCIAR_OBSOLETOS, "1");
    crear({ licensePublicKey: "pem" });
    expect(avisos.filter((a) => CLAVE.test(a))).toEqual([]);
  });

  it("BVSALA_SILENCE_DEPRECATIONS=0 no calla nada", () => {
    publicado();
    vi.stubEnv(SILENCIAR_OBSOLETOS, "0");
    crear({ licensePublicKey: "pem" });
    expect(avisos.filter((a) => CLAVE.test(a))).toHaveLength(1);
  });

  it("sin la opción, ni una palabra", () => {
    publicado();
    crear({});
    expect(avisos.filter((a) => CLAVE.test(a))).toEqual([]);
  });

  it("desde el código fuente funciona y no avisa", () => {
    crear({ licensePublicKey: "pem" });
    expect(avisos.filter((a) => CLAVE.test(a))).toEqual([]);
  });

  it("`devUnlicensed` no avisa: su nombre no puede entrar en el bundle publicado", () => {
    publicado();
    crear({ devUnlicensed: true });
    expect(avisos.filter((a) => a.includes("devUnlicensed"))).toEqual([]);
  });
});

describe("los demás avisos de la 0.5 obedecen la misma variable", () => {
  it("el alias `semanticCache` (0.4.33) calla con BVSALA_SILENCE_DEPRECATIONS=1", () => {
    vi.stubEnv(SILENCIAR_OBSOLETOS, "1");
    crear({ devUnlicensed: true, semanticCache: new InMemorySemanticCache({ embed: () => [1, 0] }) });
    expect(avisos.filter((a) => a.includes("semanticCache"))).toEqual([]);
  });

  it("el `licenseGate` ignorado dice que la opción sale en la 0.5", () => {
    publicado();
    crear({ licenseGate: { isActive: () => true, isEntitled: () => true } });
    expect(avisos.find((a) => a.includes("Ignoring the injected `licenseGate`"))).toMatch(/removed in 0\.5/);
  });
});

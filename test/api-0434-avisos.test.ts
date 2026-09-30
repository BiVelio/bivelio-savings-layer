import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemorySemanticCache } from "../src/cache/semantic.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { MockProvider } from "../src/providers/mock.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * LO QUE LA 0.5 SACÓ DE LA CONFIGURACIÓN, VISTO DESDE JAVASCRIPT.
 *
 * La 0.4.34 avisaba en consola de `licensePublicKey`, `licenseGate` y del alias
 * `semanticCache` antes de quitarlos. En la 0.5 ya no están en
 * `SavingsLayerConfig` (para TypeScript son un error de tipos, y lo vigila
 * test/api-publica-congelada.test.ts contra el `.d.ts`), pero quien configura
 * desde JavaScript todavía puede pasarlos: en el paquete publicado se ignoran y
 * se dice UNA vez, callado con `silenceWarnings`. `BVSALA_SILENCE_DEPRECATIONS`
 * ya no existe: no queda nada obsoleto que avisar, solo lo retirado.
 *
 * `devUnlicensed` no avisa: su nombre no puede viajar en el bundle publicado
 * (la verja de test/sala-limpia-del-tarball.test.ts). Desde el código fuente
 * (tests, banco, ejemplos) las tres siguen funcionando como vía interna
 * (ConfiguracionDesdeElFuente): ahí no se avisa.
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
const CLAVE = /`createSavingsLayer\(\{ licensePublicKey \}\)` was removed in 0\.5 and is ignored/;
const crear = (extra: Record<string, unknown>) => createSavingsLayer({ provider: new MockProvider(), ...extra } as never);

describe("`licensePublicKey` en el paquete publicado (0.5)", () => {
  it("se ignora y avisa UNA vez por proceso, aunque se creen varias capas", () => {
    publicado();
    for (let i = 0; i < 3; i++) crear({ licensePublicKey: "pem" });
    const a = avisos.filter((x) => CLAVE.test(x));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatch(/Delete it from your config/);
  });

  it("⛔ callado con `silenceWarnings`", () => {
    publicado();
    crear({ licensePublicKey: "pem", silenceWarnings: true });
    expect(avisos).toEqual([]);
  });

  it("BVSALA_SILENCE_DEPRECATIONS ya no calla nada: no queda nada obsoleto, solo lo retirado", () => {
    publicado();
    vi.stubEnv("BVSALA_SILENCE_DEPRECATIONS", "1");
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

describe("los otros dos nombres retirados de la configuración", () => {
  it("el alias `semanticCache` se ignora y avisa una vez, callado con `silenceWarnings`", () => {
    crear({ devUnlicensed: true, semanticCache: new InMemorySemanticCache({ embed: () => [1, 0] }) });
    expect(avisos.filter((a) => a.includes("`createSavingsLayer({ semanticCache })` was removed in 0.5"))).toHaveLength(1);
    reiniciarAvisos();
    avisos = [];
    crear({ devUnlicensed: true, silenceWarnings: true, semanticCache: new InMemorySemanticCache({ embed: () => [1, 0] }) });
    expect(avisos).toEqual([]);
  });

  it("el `licenseGate` ignorado dice que la opción se retiró en la 0.5", () => {
    publicado();
    crear({ licenseGate: { isActive: () => true, isEntitled: () => true } });
    expect(avisos.find((a) => a.includes("Ignoring the injected `licenseGate`"))).toMatch(/was removed in 0\.5/);
  });
});

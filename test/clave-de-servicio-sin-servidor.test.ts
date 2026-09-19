import { afterEach, describe, expect, it, vi } from "vitest";
import { createSavingsLayer } from "../src/index.js";
import { MockProvider } from "../src/providers/mock.js";

/**
 * `serviceAccountKey` sin `licenseServerUrl` era un silencio caro: ni metering ni
 * recogida del token renovado, sin una palabra. El panel se quedaba vacío y la
 * licencia moría fail-closed al final del ciclo con la cuota pagada. Ahora se
 * dice una vez, en inglés, con la línea que lo arregla.
 */
describe("clave de servicio sin servidor al que hablar", () => {
  afterEach(() => vi.restoreAllMocks());

  it("avisa una vez y nombra `licenseServerUrl`", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createSavingsLayer({
      provider: new MockProvider(),
      devUnlicensed: true,
      serviceAccountKey: "bvk_placeholder",
    });
    const avisos = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("serviceAccountKey"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("licenseServerUrl");
    expect(avisos[0]).toContain("metering");
  });

  it("calla con `silenceWarnings`, y calla cuando hay a quién hablar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createSavingsLayer({
      provider: new MockProvider(),
      devUnlicensed: true,
      serviceAccountKey: "bvk_placeholder",
      silenceWarnings: true,
    });
    createSavingsLayer({
      provider: new MockProvider(),
      devUnlicensed: true,
      serviceAccountKey: "bvk_placeholder",
      meteringUrl: "https://example.test/api/metering/usage",
      metering: { enabled: true, flushIntervalMs: 60_000 },
    });
    const avisos = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("serviceAccountKey"));
    expect(avisos).toHaveLength(0);
  });
});

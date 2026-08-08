import { describe, it, expect, afterEach, vi } from "vitest";

import { randomId } from "../src/util/id.js";

/**
 * `randomId` no es solo una traza: por defecto es el `request_id` con el que el
 * ingest de facturación deduplica. Si colisiona, se descarta uso legítimo EN
 * SILENCIO. El fallback anterior, sin crypto, era determinista: 256 ids posibles
 * en el mundo. Este test lo blinda.
 */

const realCrypto = globalThis.crypto;
const setCrypto = (v: unknown) => vi.stubGlobal("crypto", v);
afterEach(() => vi.unstubAllGlobals());

describe("unicidad del id de facturación", () => {
  it("100.000 ids con crypto disponible son todos distintos", () => {
    const set = new Set<string>();
    for (let i = 0; i < 100_000; i++) set.add(randomId());
    expect(set.size).toBe(100_000);
  });

  it("SIN crypto en el runtime, siguen siendo únicos (era el bug de 256 valores)", () => {
    setCrypto(undefined);
    const set = new Set<string>();
    for (let i = 0; i < 50_000; i++) set.add(randomId());
    // Con el fallback determinista anterior, size habría sido <= 256.
    expect(set.size).toBe(50_000);
  });

  it("recupera crypto si el runtime lo inicializa DESPUÉS de importar el SDK", () => {
    // El bug de captura al cargar el módulo: si crypto llega tarde, se usaba el
    // fallback para siempre. Ahora se lee en cada llamada.
    setCrypto(undefined);
    const sinCrypto = randomId();
    setCrypto(realCrypto);
    const conCrypto = randomId();
    // El segundo debe ser un UUID v4 real (crypto), no el fallback.
    expect(conCrypto).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(conCrypto).not.toBe(sinCrypto);
  });

  it("mantiene la forma de UUID v4 en el fallback (version y variant)", () => {
    setCrypto(undefined);
    expect(randomId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

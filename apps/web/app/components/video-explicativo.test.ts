import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * LOS VÍDEOS DE LA PORTADA NO SE DESCARGAN AL CARGARLA.
 *
 * Con `autoPlay` en el HTML los cinco MP4 se bajaban enteros en el primer
 * pintado (~3,4 MB de ~4,5 MB, Lighthouse móvil del 02-10-2026), porque el
 * autoplay nativo pasa por encima de `preload`. La comprobación de verdad es
 * de navegador —se hizo con Playwright contra `next start` al escribirlo—;
 * aquí se fija lo que la provoca, para que no vuelva.
 */
const SRC = readFileSync(fileURLToPath(new URL("./VideoExplicativo.tsx", import.meta.url)), "utf8");
const JSX = SRC.slice(SRC.indexOf("<video"));

describe("VideoExplicativo", () => {
  it("no lleva autoPlay en el HTML y sale con preload=none", () => {
    expect(JSX).not.toMatch(/\bautoPlay\b/);
    expect(JSX).toMatch(/preload="none"/);
  });

  it("el observer enciende el autoplay nativo y pide los datos al entrar en la vista", () => {
    expect(SRC).toMatch(/video\.autoplay = true/);
    expect(SRC).toMatch(/video\.preload = "auto"/);
    expect(SRC).toMatch(/video\.pause\(\)/);
  });
});

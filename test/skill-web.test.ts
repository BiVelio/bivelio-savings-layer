import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { SKILL_MD } from "../apps/web/lib/skill/contenido.js";
import { zipDeUnFichero, crc32 } from "../apps/web/lib/skill/zip.js";
import { ANATOMIA_MEDIDA } from "../apps/web/lib/skill/anatomia.js";

/**
 * La superficie web del skill: el SKILL.md embebido que sirve la ruta
 * autenticada, el zip que fabrica, y las cifras medidas que la landing
 * publica. Las tres cosas con verja porque las tres pueden derivar en
 * silencio: el embebido respecto al fichero canónico, el zip respecto al
 * formato que claude.ai acepta, y la anatomía respecto a la aritmética.
 */

const RAIZ = join(new URL(".", import.meta.url).pathname, "..");

describe("el SKILL.md embebido en la web", () => {
  it("⛔ es BYTE-IDÉNTICO al canónico de skills/ — si esto falla, regenerar contenido.ts", () => {
    const canonico = readFileSync(join(RAIZ, "skills", "savings-mode", "SKILL.md"), "utf8");
    expect(SKILL_MD).toBe(canonico);
  });
});

describe("el zip almacenado que sirve /api/skill/descargar", () => {
  const zip = zipDeUnFichero("savings-mode/SKILL.md", SKILL_MD);

  it("lleva el SKILL.md VERBATIM (método almacenado): la deriva se ve sin descomprimir", () => {
    const bytes = Buffer.from(zip);
    expect(bytes.includes(Buffer.from(SKILL_MD, "utf8"))).toBe(true);
    expect(bytes.includes(Buffer.from("savings-mode/SKILL.md", "utf8"))).toBe(true);
  });

  it("tiene la estructura de zip: firmas LFH, directorio central y EOCD", () => {
    const b = Buffer.from(zip);
    expect(b.readUInt32LE(0)).toBe(0x04034b50);
    expect(b.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBe(true);
    expect(b.readUInt32LE(b.length - 22)).toBe(0x06054b50);
  });

  it("un unzip real lo abre y devuelve el contenido exacto", () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-zip-"));
    const ruta = join(dir, "s.zip");
    writeFileSync(ruta, Buffer.from(zip));
    execFileSync("unzip", ["-o", "-q", ruta, "-d", dir]);
    expect(readFileSync(join(dir, "savings-mode", "SKILL.md"), "utf8")).toBe(SKILL_MD);
  });

  it("crc32 contra un vector conocido", () => {
    // CRC-32 de "123456789" = 0xCBF43926 (vector estándar).
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("la anatomía medida que publica la landing", () => {
  it("las tres partidas publicadas cubren casi todo el gasto y no suman más de uno", () => {
    const suma = ANATOMIA_MEDIDA.lecturaCache + ANATOMIA_MEDIDA.escritura1h + ANATOMIA_MEDIDA.salida;
    expect(suma).toBeGreaterThan(0.95); // lo no publicado (entrada suelta, 5m) es residual
    expect(suma).toBeLessThanOrEqual(1.0);
  });
  it("cada fracción es una PROPORCIÓN en (0,1) — el mismo tipo de verja que netSavings", () => {
    for (const v of [ANATOMIA_MEDIDA.lecturaCache, ANATOMIA_MEDIDA.escritura1h, ANATOMIA_MEDIDA.salida]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });
});

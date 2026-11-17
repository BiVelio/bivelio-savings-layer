import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { IMAGEN_AL_COMPARTIR, tarjetaSocial } from "@/i18n/site";

/**
 * TODA PÁGINA PÚBLICA SE COMPARTE CON IMAGEN.
 *
 * POR QUÉ EXISTE. Tras la 0.5.0, pricing, privacy, benchmarks y la guía de
 * migración (37 URL del sitemap) salían en LinkedIn, Slack o X sin imagen y
 * con la tarjeta pequeña. Cada una declaraba su propio objeto `openGraph`, y
 * eso hace que Next deje de heredar la `opengraph-image` del idioma. Nada se
 * ponía rojo: es metadato que falta, no un error.
 *
 * La regla: una página que declara `openGraph` o trae imagen propia (un
 * `opengraph-image.tsx` al lado) o usa `tarjetaSocial`.
 */

const AQUI = fileURLToPath(new URL("./", import.meta.url));

function paginas(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, e.name);
    if (e.isDirectory()) out.push(...paginas(ruta));
    else if (e.name === "page.tsx") out.push(ruta);
  }
  return out;
}

describe("la imagen al compartir", () => {
  it("toda página con openGraph propio lleva imagen y tarjeta grande", () => {
    const conOg = paginas(AQUI).filter((p) => /openGraph\s*:/.test(readFileSync(p, "utf8")));
    expect(conOg.length).toBeGreaterThan(3);
    for (const p of conOg) {
      const src = readFileSync(p, "utf8");
      const imagenPropia = existsSync(join(p, "..", "opengraph-image.tsx")) || /images\s*:/.test(src);
      expect(imagenPropia || /tarjetaSocial\(/.test(src), p).toBe(true);
      expect(src, p).not.toMatch(/card:\s*"summary"/);
    }
  });

  it("tarjetaSocial apunta a la imagen de marca, 1731×909", () => {
    const s = tarjetaSocial("de", "Titel");
    expect(s.openGraph.locale).toBe("de");
    expect(s.openGraph.images[0]).toMatchObject({ width: 1731, height: 909, type: "image/jpeg", alt: "Titel" });
    expect(s.openGraph.images[0].url).toMatch(new RegExp(`${IMAGEN_AL_COMPARTIR.ruta.replace(/[.]/g, "\\.")}$`));
    expect(s.twitter.card).toBe("summary_large_image");
    expect(s.twitter.images[0]).toBe(s.openGraph.images[0].url);
  });

  it("la imagen existe, mide lo que dice y pesa menos de 300 KB (WhatsApp no previsualiza las más pesadas)", () => {
    const buf = readFileSync(join(AQUI, "..", "..", "public", IMAGEN_AL_COMPARTIR.ruta));
    expect(buf.length).toBeLessThan(300 * 1024);
    // Medidas del JPEG: el primer marcador SOF (0xFFC0–0xFFC2) lleva alto y ancho.
    let i = 2;
    while (i < buf.length && !(buf[i] === 0xff && buf[i + 1]! >= 0xc0 && buf[i + 1]! <= 0xc2)) i += 2 + buf.readUInt16BE(i + 2);
    expect({ width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }).toEqual({ width: IMAGEN_AL_COMPARTIR.width, height: IMAGEN_AL_COMPARTIR.height });
  });

  it("la portada usa la misma imagen que el resto, y el PNG de los README sigue publicado", () => {
    const portada = readFileSync(join(AQUI, "page.tsx"), "utf8");
    expect(portada).toMatch(/absolute\(IMAGEN_AL_COMPARTIR\.ruta\)/);
    expect(portada).not.toMatch(/og-image\.png/);
    expect(existsSync(join(AQUI, "..", "..", "public", "brand", "og-image.png"))).toBe(true);
  });
});

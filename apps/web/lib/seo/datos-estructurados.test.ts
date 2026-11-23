import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { URL_DEL_CODIGO } from "@/app/components/sitio";

import { grafoDeLaPortada, serializarJsonLd, type Pregunta } from "./datos-estructurados";

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const en = JSON.parse(readFileSync(`${WEB}messages/en.json`, "utf8"));
const preguntas: Pregunta[] = en.landing.faq.items;
const grafo = grafoDeLaPortada({ locale: "en", descripcion: en.landing.metaDescription, preguntas });
const nodos = grafo["@graph"] as Record<string, unknown>[];
const nodo = (tipo: string) => nodos.find((n) => [n["@type"]].flat().includes(tipo))!;

/** Todas las claves del grafo, a cualquier profundidad. */
function claves(o: unknown, fuera: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((v) => claves(v, fuera));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) fuera.push(k, ...claves(v));
  return fuera;
}

describe("JSON-LD de la portada", () => {
  it("un grafo con el sitio, la organización, el software y las preguntas", () => {
    expect(grafo["@context"]).toBe("https://schema.org");
    for (const t of ["WebSite", "Organization", "SoftwareApplication", "FAQPage"]) expect(nodo(t), t).toBeDefined();
  });

  it("⛔ sin valoraciones ni reseñas: no tenemos, y unas inventadas están prohibidas", () => {
    const todas = claves(grafo);
    for (const k of ["aggregateRating", "review", "reviews", "ratingValue", "reviewCount"]) expect(todas).not.toContain(k);
  });

  it("SoftwareApplication: herramienta de desarrollo, Apache-2.0, motor gratis, repositorio y descargas", () => {
    const s = nodo("SoftwareApplication");
    expect(s.applicationCategory).toBe("DeveloperApplication");
    expect(s.license).toBe("https://www.apache.org/licenses/LICENSE-2.0");
    expect(s.offers).toMatchObject({ "@type": "Offer", price: "0" });
    expect(s.codeRepository).toBe(URL_DEL_CODIGO);
    expect(s.downloadUrl).toEqual(["https://www.npmjs.com/package/@bivelio/savings-layer", "https://pypi.org/project/bivelio-savings-layer/"]);
    expect(s.description).toBe(en.landing.metaDescription);
    // Lo que dice la oferta es la regla de negocio: el motor ahorra sin clave.
    expect(JSON.stringify(s.offers)).toMatch(/free, with no key and no signup/);
  });

  it("Organization: BiVelio Inc, Delaware — lo mismo que dice el pie", () => {
    const o = nodo("Organization");
    expect(o.legalName).toBe("BiVelio Inc");
    expect(o.address).toMatchObject({ addressRegion: "Delaware", addressCountry: "US" });
    expect(en.landing.footer.entity).toMatch(/BiVelio Inc · Delaware \(United States\)/);
  });

  it("FAQPage: cada pregunta y cada respuesta, con el texto exacto que recibe", () => {
    const faq = nodo("FAQPage");
    const entidades = faq.mainEntity as { name: string; acceptedAnswer: { text: string } }[];
    expect(entidades.map((e) => e.name)).toEqual(preguntas.map((p) => p.q));
    expect(entidades.map((e) => e.acceptedAnswer.text)).toEqual(preguntas.map((p) => p.a));
  });

  it("la portada pasa al JSON-LD LA MISMA lista de preguntas que pinta (sin la que solo va en /how-it-works)", () => {
    const pagina = readFileSync(`${WEB}app/[locale]/page.tsx`, "utf8");
    expect(pagina).toMatch(/<DatosEstructurados datos=\{grafoDeLaPortada\(\{[^}]*preguntas: preguntasDeCompra \}\)\} \/>/);
    expect(pagina).toContain("<PreguntasDeCompra preguntas={preguntasDeCompra} />");
    expect(pagina).toContain('t("metaDescription")');
  });

  it("serializado para un <script>: ningún «<» llega crudo", () => {
    const s = serializarJsonLd({ a: "</script><script>alert(1)</script>" });
    expect(s).not.toContain("<");
    expect(JSON.parse(s)).toEqual({ a: "</script><script>alert(1)</script>" });
  });
});

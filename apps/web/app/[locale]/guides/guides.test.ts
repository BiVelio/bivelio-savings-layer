import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { idDeTitulo, leerMarkdown, type Bloque } from "@/lib/guia-migracion/markdown";

import sitemap from "../../sitemap";
import { palabras } from "./articulo";
import { cargarTexto } from "./cargar";
import { GUIAS, urlDeGuia } from "./registry";

/**
 * Las guías (/en/guides): lo que no puede romperse sin que nadie lo note.
 *
 * - La lista del registro y los ficheros de `content/` son el mismo conjunto.
 * - Cada guía tiene entre 1.000 y 2.000 palabras, enlaza el banco publicado y
 *   el repositorio, y sus enlaces internos llevan a guías y anclas que existen.
 * - Ninguna dice que haga falta una clave para ahorrar (el motor abierto ahorra
 *   con todas las palancas sin clave; solo se cobra el Cloud), y todas dicen
 *   que funciona sin clave.
 * - Cada cifra del texto (fuera de los bloques de código) está en la lista de
 *   abajo con su fuente. Una cifra nueva sin fuente rompe el test: no se
 *   publica un número inventado.
 * - El sitemap anuncia el índice y cada guía.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "content");
const ficheros = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const fuente = (slug: string) => readFileSync(join(DIR, `${slug}.md`), "utf8");
const sinCodigo = (s: string) => s.replace(/^```[\s\S]*?^```/gm, "");

/** Cada cifra publicada en prosa, con su fuente. */
const CIFRAS_CON_FUENTE: Record<string, string> = {
  "31.50 %": "README + /benchmarks: reducción agregada en gpt-4o-mini, 30 % de repeticiones exactas (SDK 0.4.31)",
  "25.7 %": "/benchmarks («Translation, no jargon»): límite inferior del intervalo del 31.5 %",
  "36.7 %": "/benchmarks: límite superior del mismo intervalo",
  "30 %": "README: la carga GSM8K con un 30 % de repeticiones exactas",
  "95 %": "intervalos al 95 % (/benchmarks) y el 0 % → 95 % de aciertos de caché del README",
  "0 %": "README: el tráfico que no se repite ahorra cerca de 0 %; el 0 % → 95 % del A/B exploratorio",
  "82.76 %": "README: A/B exploratorio de savings.cachePrefix, claude-haiku-4-5, 20 peticiones por brazo, 1.2.0",
  "20 %": "README: un system largo que cambia en cada petición cuesta cerca de un 20 % más en Anthropic",
  "25 %": "aritmética de la tarifa oficial de Anthropic: escribir a 5 minutos cuesta 1,25 veces la entrada",
  "+166 %": "CHANGELOG 1.2.4: recorte de resultados en un bucle de 60 pasos en DeepSeek, proveedor falso, 1.2.3 y 1.2.4 sin clave",
  "+12.2 %": "CHANGELOG 1.2.4: el mismo bucle en gpt-5",
  "+2.49 %": "/benchmarks#gateway-ttl: neto del replay de la rebaja de TTL",
  "+1.50 %": "/benchmarks#gateway-ttl: intervalo por sesión, límite inferior",
  "+3.57 %": "/benchmarks#gateway-ttl: intervalo por sesión, límite superior",
  "7.2 %": "/benchmarks#gateway-ttl: techo de cualquier política de TTL",
  "90 %": "code.claude.com/docs/en/costs: el 90 % de los usuarios por debajo de 30 $ al día",
  "$13": "code.claude.com/docs/en/costs: media por desarrollador y día activo",
  "$150": "code.claude.com/docs/en/costs: horquilla mensual por desarrollador",
  "$250": "code.claude.com/docs/en/costs: horquilla mensual por desarrollador",
  "$30": "code.claude.com/docs/en/costs: el 90 % por debajo de esto al día",
  "$113.45": "/benchmarks#gateway-ttl: neto del replay en dólares",
  "$4,563.61": "/benchmarks#gateway-ttl: factura a precio de lista de las peticiones simuladas",
  "$0.003": "catálogo 1.2.3 (cachedInputPer1k 3e-6 en deepseek-flash y deepseek-v4-pro) y api-docs.deepseek.com/quick_start/pricing (acierto fuera de punta de deepseek-flash), leído el 2026-11-23",
};

function enlaces(bloques: readonly Bloque[]): string[] {
  const out: string[] = [];
  const enLinea = (c: unknown): void => {
    if (Array.isArray(c)) c.forEach(enLinea);
    else if (c && typeof c === "object") {
      const n = c as { t?: string; href?: string; c?: unknown };
      if (n.t === "enlace" && n.href) out.push(n.href);
      if (n.c) enLinea(n.c);
    }
  };
  const recorrer = (bs: readonly Bloque[]) => {
    for (const b of bs) {
      if (b.t === "titulo" || b.t === "parrafo") enLinea(b.c);
      else if (b.t === "cita") recorrer(b.c);
      else if (b.t === "lista") b.items.forEach(recorrer);
      else if (b.t === "tabla") [b.cabecera, ...b.filas].forEach((f) => f.forEach(enLinea));
    }
  };
  recorrer(bloques);
  return out;
}

function anclas(bloques: readonly Bloque[]): Set<string> {
  return new Set(bloques.flatMap((b) => (b.t === "titulo" ? [b.id] : [])));
}

describe("el registro de las guías", () => {
  it("cada guía del registro tiene su texto, y cada texto está en el registro", () => {
    expect(new Set(ficheros)).toEqual(new Set(GUIAS.map((g) => `${g.slug}.md`)));
  });

  it("slugs únicos y en minúsculas con guiones; fechas ISO; descripciones que caben en un resultado de búsqueda", () => {
    expect(new Set(GUIAS.map((g) => g.slug)).size).toBe(GUIAS.length);
    for (const g of GUIAS) {
      expect(g.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(g.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.description.length, g.slug).toBeLessThanOrEqual(170);
      expect(g.title.length, g.slug).toBeLessThanOrEqual(80);
    }
  });

  it("entre seis y ocho guías", () => {
    expect(GUIAS.length).toBeGreaterThanOrEqual(6);
    expect(GUIAS.length).toBeLessThanOrEqual(8);
  });
});

describe.each(GUIAS.map((g) => g.slug))("la guía %s", (slug) => {
  const texto = fuente(slug);
  const bloques = cargarTexto(slug);

  it("se lee entera: el lector de Markdown da los mismos bloques que el fichero", () => {
    expect(bloques).toEqual(leerMarkdown(texto));
    const vallas = texto.split("\n").filter((l) => /^```/.test(l)).length;
    expect(bloques.filter((b) => b.t === "codigo").length * 2).toBe(vallas);
  });

  it("no trae su propio <h1> (lo pone la página) y cada bloque de código dice su lenguaje", () => {
    expect(bloques.some((b) => b.t === "titulo" && b.nivel === 1)).toBe(false);
    for (const b of bloques) if (b.t === "codigo") expect(b.lenguaje, b.v.slice(0, 40)).not.toBe("");
  });

  it("tiene entre 1.000 y 2.000 palabras", () => {
    const n = palabras(bloques);
    expect(n).toBeGreaterThanOrEqual(1000);
    expect(n).toBeLessThanOrEqual(2000);
  });

  it("enlaza el banco publicado y el repositorio", () => {
    const hrefs = enlaces(bloques);
    expect(hrefs.some((h) => h.startsWith("/en/benchmarks"))).toBe(true);
    expect(hrefs).toContain("https://github.com/BiVelio/bivelio-savings-layer");
  });

  it("sus enlaces internos llevan a guías y anclas que existen", () => {
    for (const href of enlaces(bloques)) {
      if (href.startsWith("#")) expect(anclas(bloques).has(href.slice(1)), href).toBe(true);
      const m = /^\/en\/guides\/([a-z0-9-]+)(?:#(.+))?$/.exec(href);
      if (href.startsWith("/en/guides/")) {
        expect(m, href).not.toBeNull();
        expect(GUIAS.some((g) => g.slug === m![1]), href).toBe(true);
        if (m![2]) expect(anclas(cargarTexto(m![1]!)).has(m![2]), href).toBe(true);
      } else if (href.startsWith("/")) {
        expect(href, "solo rutas que existen en la web").toMatch(/^\/en\/(benchmarks|paper)(#[a-z0-9-]+)?$/);
      }
    }
  });

  it("dice que ahorra sin clave, y nunca que haga falta una clave o una licencia para ahorrar", () => {
    expect(texto).toMatch(/no key/i);
    expect(texto).not.toMatch(/BIVELIO_(LICENSE|SERVICE)_KEY/);
    expect(texto).not.toMatch(/(need|needs|require|requires|required)\s+(a|an|your)?\s*(bivelio\s+)?(license|licence|key|signup|subscription)\s+to\s+save/i);
    expect(texto).not.toMatch(/sign\s*up\s+to\s+(save|start)/i);
  });

  it("cada cifra del texto tiene su fuente en este test", () => {
    const cifras = sinCodigo(texto).match(/[+−-]?\$\d[\d,.]*\d|[+−-]?\d[\d,.]*\s?%/g) ?? [];
    for (const c of cifras) {
      const normal = c.replace(/(\d)%$/, "$1 %");
      expect(Object.keys(CIFRAS_CON_FUENTE), `cifra sin fuente: «${c}»`).toContain(normal);
    }
  });
});

/**
 * Lo que encontró la revisión del PR #620 (2026-11-23), comprobado contra el
 * paquete 1.2.3 y la documentación oficial de cada proveedor. Cada línea fija
 * una frase que fue falsa para que no vuelva.
 */
describe("lo que corrigió la revisión del PR #620", () => {
  it("el envoltorio `qwen` no se vende para modelos Qwen: la ruta es el modo OpenAI de Qwen Code contra el gateway", () => {
    const t = fuente("deepseek-qwen-api-cost-local-gateway");
    expect(t).not.toMatch(/`npx @bivelio\/savings-layer qwen` launches it through the gateway/);
    expect(t).toMatch(/OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8404\/compatible-mode\/v1/);
  });

  it("un stream sin include_usage no se mide en la 1.2.3, y la guía da la salida (BVSALA_GATEWAY_USAGE_INJECT=1)", () => {
    expect(fuente("deepseek-qwen-api-cost-local-gateway")).toMatch(/BVSALA_GATEWAY_USAGE_INJECT=1/);
  });

  it("el catálogo no se describe «a precio de punta»: el acierto de caché de DeepSeek está por debajo", () => {
    expect(fuente("deepseek-qwen-api-cost-local-gateway")).not.toMatch(/priced at the peak rate/);
  });

  it("`reference` solo en las tres API propias (OpenAI, Anthropic, Gemini); DeepSeek es `estimated`", () => {
    for (const slug of ["deduplicate-llm-requests", "verify-llm-savings-against-provider-bill"]) {
      expect(fuente(slug)).toMatch(/OpenAI's, Anthropic's or Google's/);
    }
    expect(fuente("deduplicate-llm-requests")).toMatch(/generativelanguage\.googleapis\.com/);
    expect(fuente("deduplicate-llm-requests")).not.toMatch(/went to the provider's own API/);
  });

  it("Claude Code: la 1.2.3 no avisa de que no ahorra; el modo rápido pasa por el gateway; tool search depende de la versión", () => {
    const t = fuente("claude-code-cost-per-request");
    expect(t).not.toMatch(/saves nothing, and it says so/);
    expect(t).not.toMatch(/fast mode and the WebFetch safety check go straight/);
    expect(t).toMatch(/fast-mode availability check/);
    expect(t).toMatch(/v2\.1\.304/);
  });

  it("OpenAI: las escrituras de caché de GPT-5.6 en adelante se registran y se pagan", () => {
    const t = fuente("reduce-openai-api-costs");
    expect(t).toMatch(/cache_write_tokens/);
    expect(t).toMatch(/1\.25 times/);
    expect(t).not.toMatch(/bill again at full price/);
  });

  it("ninguna página de guías da 404 por idioma: se sirven en inglés bajo cualquier prefijo, con el canonical en /en", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of ["page.tsx", join("[slug]", "page.tsx")]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/locale\s*!==\s*IDIOMA_DE_LAS_GUIAS\)\s*(notFound|return)/);
      expect(src, f).toMatch(/canonical: url, languages: \{ en: url, "x-default": url \}/);
    }
  });
});

describe("el sitemap", () => {
  it("anuncia el índice y cada guía, una sola vez y solo en inglés", () => {
    const urls = sitemap().map((e) => e.url);
    for (const u of [urlDeGuia(), ...GUIAS.map((g) => urlDeGuia(g.slug))]) {
      expect(urls.filter((x) => x === u)).toHaveLength(1);
    }
    expect(urls.some((u) => /\/(?!en\/)[a-z]{2}\/guides/.test(new URL(u).pathname))).toBe(false);
  });

  it("los ids de los títulos son los de GitHub (las anclas que enlazan otras guías)", () => {
    expect(idDeTitulo("Find the byte that breaks your cache")).toBe("find-the-byte-that-breaks-your-cache");
  });
});

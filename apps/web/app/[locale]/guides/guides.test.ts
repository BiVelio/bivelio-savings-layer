import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import { idDeTitulo, leerMarkdown, type Bloque } from "@/lib/guia-migracion/markdown";

import sitemap from "../../sitemap";
import { palabras, rutaSinIdioma } from "./articulo";
import { cargarTexto } from "./cargar";
import { GUIAS, idiomasDe, urlDeGuia } from "./registry";

/**
 * Las guías (/<idioma>/guides), su ORIGINAL inglés: lo que no puede romperse
 * sin que nadie lo note. Las traducciones las vigila traducciones.test.ts.
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
 * - El sitemap anuncia el índice y cada guía en cada idioma traducido.
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
  "20 %": "README (un system que cambia cuesta cerca de un 20 % más en Anthropic) y Model Studio context-cache (aciertos implícitos, típicamente 20 %)",
  "125 %": "alibabacloud.com/help/en/model-studio/context-cache: creación de la caché explícita, típicamente 125 %",
  "80 %": "aritmética: la 1.2.3 tarifa como entrada normal (1×) una escritura que Model Studio cobra a 1,25× (1/1,25 = 80 %); reproducido con un servidor de prueba",
  "10 %": "alibabacloud.com/help/en/model-studio/context-cache: aciertos de la caché explícita, típicamente 10 %; catálogo 1.2.3 de qwen-plus (115e-7 frente a 115e-6)",
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
  "$40": "platform.claude.com/docs/en/build-with-claude/fast-mode: salida en modo rápido de Claude Opus 5.5 ($8 / $40 por MTok)",
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
    expect(t).toMatch(/GW=http:\/\/127\.0\.0\.1:8404\/compatible-mode\/v1\n/);
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

  it("ninguna página de guías da 404 por idioma; canonical propio y los hreflang del registro (los del sitemap)", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of ["page.tsx", join("[slug]", "page.tsx")]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/locale\s*!==\s*IDIOMA_DE_LAS_GUIAS\)\s*(notFound|return)/);
      expect(src, f).not.toMatch(/hayTraduccion\([^)]*\)\)?\s*(notFound|return)/);
      expect(src, f).toMatch(/alternates: \{ canonical: url, languages: alternativasDe\((slug)?\) \}/);
    }
  });
});

/** La tercera revisión del PR #620 (2026-11-23). */
describe("lo que corrigió la tercera revisión del PR #620", () => {
  it("con DASHSCOPE_PROXY_BASE_URL, la 1.2.3 tarifa las escrituras explícitas de Qwen como entrada normal, y la conciliación lo cuenta", () => {
    const t = fuente("deepseek-qwen-api-cost-local-gateway");
    expect(t).toMatch(/The 1\.2\.3 gateway does not read that field: it logs those tokens as ordinary input/);
    const conciliacion = t.slice(t.indexOf("## Check the numbers against your provider"));
    expect(conciliacion).toMatch(/explicit-cache writes as ordinary input/);
  });
});

/** La segunda revisión del PR #620 (2026-11-23). */
describe("lo que corrigió la segunda revisión del PR #620", () => {
  it("el modo rápido: la 1.2.3 lo tarifa como estándar, y la conciliación lo cuenta como causa", () => {
    const t = fuente("claude-code-cost-per-request");
    expect(t).not.toMatch(/metered like any other turn/);
    expect(t).toMatch(/Fast-mode turns are logged at the standard price/);
    expect(t).toMatch(/platform\.claude\.com\/docs\/en\/build-with-claude\/fast-mode/);
    expect(t).toMatch(/3\. \*\*Explain any gap\.\*\*[^\n]*Fast mode/);
  });

  it("Qwen Code por el gateway conserva la caché explícita de DashScope (DASHSCOPE_PROXY_BASE_URL igual al base URL)", () => {
    const t = fuente("deepseek-qwen-api-cost-local-gateway");
    expect(t).toMatch(/OPENAI_BASE_URL="\$GW" DASHSCOPE_PROXY_BASE_URL="\$GW"/);
    expect(t).toMatch(/\*\*Without the variable\*\* there are no explicit writes, but the hits are implicit ones/);
  });

  it("los enlaces internos del texto pierden el /en y siguen el idioma de quien lee", () => {
    expect(rutaSinIdioma("/en/guides/deduplicate-llm-requests")).toBe("/guides/deduplicate-llm-requests");
    expect(rutaSinIdioma("/en/guides/a#b")).toBe("/guides/a#b");
    expect(rutaSinIdioma("/en/benchmarks#savings")).toBe("/benchmarks#savings");
    expect(rutaSinIdioma("/en")).toBe("/");
    expect(rutaSinIdioma("/en#x")).toBe("/#x");
    expect(rutaSinIdioma("/enterprise")).toBe("/enterprise");
    // Las traducciones enlazan con SU prefijo: también se quita (si no, /de/de/…).
    expect(rutaSinIdioma("/de/guides/deduplicate-llm-requests")).toBe("/guides/deduplicate-llm-requests");
    expect(rutaSinIdioma("/vi/benchmarks#savings")).toBe("/benchmarks#savings");
    expect(rutaSinIdioma("/pt")).toBe("/");
    expect(rutaSinIdioma("/idiomas")).toBe("/idiomas");
    expect(rutaSinIdioma("/vienna/x")).toBe("/vienna/x");
    expect(rutaSinIdioma("https://github.com/BiVelio/bivelio-savings-layer")).toBeNull();
    const dir = dirname(fileURLToPath(import.meta.url));
    const bloques = readFileSync(join(dir, "Bloques.tsx"), "utf8");
    expect(bloques).toMatch(/<Link key=\{i\} href=\{ruta\}>/);
  });

  it("la interfaz traducida va en el idioma de la página; solo el texto inglés lleva lang=\"en\"", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of ["page.tsx", join("[slug]", "page.tsx")]) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).toMatch(/<main className="wrap guia-page" lang=\{locale\}>/);
      expect(src, f).not.toMatch(/<Migas[^>]*lang="en"/);
      expect(src, f).not.toMatch(/linkAs=\{Link\}\s*lang="en"/);
    }
  });
});

describe("el sitemap", () => {
  it("anuncia el índice y cada guía en cada idioma en que existen, una sola vez cada URL", () => {
    const urls = sitemap().map((e) => e.url);
    for (const slug of [undefined, ...GUIAS.map((g) => g.slug)]) {
      for (const l of idiomasDe(slug)) expect(urls.filter((x) => x === urlDeGuia(slug, l)), `${l} ${slug ?? "índice"}`).toHaveLength(1);
    }
    // Ninguna URL de guía en un idioma sin traducción (su canonical es /en).
    for (const u of urls) {
      const m = /^\/([a-z]{2})\/guides(?:\/([a-z0-9-]+))?$/.exec(new URL(u).pathname);
      if (m) expect(idiomasDe(m[2]), u).toContain(m[1]);
    }
  });

  it("los ids de los títulos son los de GitHub (las anclas que enlazan otras guías)", () => {
    expect(idDeTitulo("Find the byte that breaks your cache")).toBe("find-the-byte-that-breaks-your-cache");
  });
});

/**
 * El índice /guides como rejilla de tarjetas (dueño, 2026-11-23: «darle un
 * poco de espacio y modernizar el estilo»). Lo que no puede volver atrás sin
 * que nadie lo note: el tema de cada tarjeta en los doce idiomas, un solo
 * enlace por guía con su titular por nombre, la semántica de antes (h2 con su
 * id, `aria-labelledby`, `lang` de la guía, `<time>`) y, en la hoja, el aire
 * bajo el héroe, el enlace estirado con su anillo de foco y la subida al pasar
 * solo sin reduced-motion.
 */
describe("el índice de las guías: la rejilla de tarjetas", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const pagina = readFileSync(join(dir, "page.tsx"), "utf8");
  const lista = pagina.slice(pagina.indexOf('<ul className="guias-lista"'), pagina.indexOf("</ul>"));
  const css = readFileSync(join(dir, "..", "..", "globals.css"), "utf8");
  const slot = css.slice(css.indexOf("/* ==== SLOT ÍNDICE DE GUÍAS ==== */"), css.indexOf("/* ==== FIN SLOT ÍNDICE DE GUÍAS ==== */"));
  const mensajes = (l: string) =>
    (JSON.parse(readFileSync(join(dir, "..", "..", "..", "messages", `${l}.json`), "utf8")) as { guidesPage: Record<string, unknown> })
      .guidesPage;

  it("cada guía tiene su tema, y cada tema su etiqueta en los doce idiomas (ni una de más)", () => {
    const temas = new Set(GUIAS.map((g) => g.tema));
    for (const l of locales) {
      const topics = mensajes(l).topics as Record<string, string>;
      expect(new Set(Object.keys(topics)), l).toEqual(temas);
      for (const t of temas) expect(topics[t]?.trim(), `${l} ${t}`).toBeTruthy();
    }
  });

  it("un solo enlace por tarjeta, el del titular; el «Leer la guía» del pie es solo visual", () => {
    expect(lista.length).toBeGreaterThan(0);
    expect(lista.match(/<Link\b/g)).toHaveLength(1);
    expect(lista).toMatch(/<h2 id=\{`guia-\$\{g\.slug\}`\} className="guia-tarjeta-titulo">\s*<Link href=\{`\/guides\/\$\{g\.slug\}`\}>\{g\.title\}<\/Link>/);
    expect(lista).toMatch(/<span className="guia-tarjeta-leer" aria-hidden="true">/);
    expect(pagina).not.toMatch(/readAria/);
    for (const l of locales) expect(mensajes(l), l).not.toHaveProperty("readAria");
  });

  it("la semántica de antes: cada guía con su titular por nombre, en su idioma, con la fecha y los minutos de lectura", () => {
    expect(lista).toMatch(/<article className="guia-tarjeta" aria-labelledby=\{`guia-\$\{g\.slug\}`\} lang=\{g\.idioma\}>/);
    expect(lista).toMatch(/<time dateTime=\{g\.date\}>\{fechaLegible\(g\.date, lang\)\}<\/time>/);
    // Los mismos minutos que la cabecera de cada guía: el texto que se sirve en ese idioma.
    expect(lista).toMatch(/tg\("minRead", \{ n: minutosDeLectura\(cargarTexto\(g\.slug, locale\)\) \}\)/);
    expect(lista).toMatch(/tg\(`topics\.\$\{g\.tema\}`\)/);
  });

  it("la hoja: aire bajo el héroe, dos columnas que pasan a una, enlace estirado con anillo de foco, subida solo sin reduced-motion", () => {
    expect(slot.length).toBeGreaterThan(0);
    expect(slot).toMatch(/\.guias-indice \{ padding-top: clamp\(40px, 5\.5vw, 72px\); \}/);
    expect(slot).toMatch(/\.guias-lista \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(slot).toMatch(/@media \(max-width: 719\.98px\) \{\s*\.guias-lista \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(slot).toMatch(/\.guia-tarjeta-titulo a::after \{ content: ""; position: absolute; inset: 0;/);
    expect(slot).toMatch(/\.guia-tarjeta-titulo a:focus-visible::after \{ outline: 2px solid var\(--brand\);/);
    // Todo `translate` de la tarjeta vive dentro del bloque sin reduced-motion.
    const sinMovimiento = slot.slice(slot.indexOf("@media (hover: hover) and (prefers-reduced-motion: no-preference)"));
    const conTransform = slot.split("\n").filter((l) => /transform: translate/.test(l));
    expect(conTransform.length).toBeGreaterThan(0);
    for (const l of conTransform) expect(sinMovimiento, l).toContain(l);
  });
});

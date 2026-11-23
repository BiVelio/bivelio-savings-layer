import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import { leerEnLinea, leerMarkdown, type Bloque, type EnLinea } from "@/lib/guia-migracion/markdown";

import { cargarTexto, hayIndiceTraducido, hayTraduccion, metaDelIdioma } from "./cargar";
import { alternativasDe, canonicalDe, GUIAS, guiaEnIdioma, idiomasDe, INDICE, indiceEnIdioma, urlDeGuia } from "./registry";

/**
 * LAS TRADUCCIONES DE LAS GUÍAS (content/<idioma>/): que digan lo mismo que el
 * original inglés, con otras palabras y nada más.
 *
 * Para cada idioma × guía:
 * - la misma estructura (títulos con su nivel, párrafos, listas, tablas, citas)
 *   en el mismo orden;
 * - los mismos bloques de código, byte a byte, y el mismo código en línea;
 * - las mismas cifras (porcentajes, dólares y números con decimales, que
 *   tienen su fuente en guides.test.ts) y ningún número del original perdido;
 * - las mismas URL externas;
 * - los enlaces internos en SU idioma, a guías y anclas que existen en él;
 * - ningún párrafo que se quedó en inglés (heurística);
 * - el «sin clave» del original, y ninguna frase que diga que hace falta una
 *   clave, una licencia o un registro para ahorrar;
 * - titular ≤ 80 y descripción ≤ 160 caracteres en `_meta.json`.
 */

const DIR = join(dirname(fileURLToPath(import.meta.url)), "content");
const TRADUCCIONES = locales.filter((l) => l !== "en");

// ── Recorridos del árbol ──────────────────────────────────────────────────────

/** La forma de un bloque, sin su texto: lo que una traducción no puede cambiar. */
function forma(b: Bloque): unknown {
  switch (b.t) {
    case "titulo":
      return `h${b.nivel}`;
    case "parrafo":
      return "p";
    case "codigo":
      return `code:${b.lenguaje}`;
    case "cita":
      return ["cita", b.c.map(forma)];
    case "lista":
      return [b.ordenada ? `ol:${b.inicio}` : "ul", b.items.map((it) => it.map(forma))];
    case "tabla":
      return ["tabla", b.cabecera.length, b.filas.map((f) => f.length)];
    case "separador":
      return "hr";
  }
}

/** Todos los fragmentos en línea de cada bloque de texto, en orden (títulos, párrafos, celdas). */
function trozos(bs: readonly Bloque[], out: EnLinea[][] = []): EnLinea[][] {
  for (const b of bs) {
    if (b.t === "titulo" || b.t === "parrafo") out.push(b.c);
    else if (b.t === "cita") trozos(b.c, out);
    else if (b.t === "lista") b.items.forEach((it) => trozos(it, out));
    else if (b.t === "tabla") [b.cabecera, ...b.filas].forEach((f) => f.forEach((c) => out.push(c)));
  }
  return out;
}

function codigos(bs: readonly Bloque[], out: string[] = []): string[] {
  for (const b of bs) {
    if (b.t === "codigo") out.push(`${b.lenguaje}\n${b.v}`);
    else if (b.t === "cita") codigos(b.c, out);
    else if (b.t === "lista") b.items.forEach((it) => codigos(it, out));
  }
  return out;
}

function enLinea(c: readonly EnLinea[], f: (n: EnLinea) => void): void {
  for (const n of c) {
    f(n);
    if (n.t === "negrita" || n.t === "cursiva" || n.t === "enlace") enLinea(n.c, f);
  }
}

/** El texto que se lee, SIN el código en línea (que no se traduce). */
function prosa(c: readonly EnLinea[]): string {
  return c.map((n) => (n.t === "texto" ? n.v : n.t === "codigo" ? " " : prosa(n.c))).join("");
}

const codigoEnLinea = (bs: readonly Bloque[]) => {
  const out: string[] = [];
  for (const c of trozos(bs)) enLinea(c, (n) => n.t === "codigo" && out.push(n.v));
  return out.sort();
};

const hrefs = (bs: readonly Bloque[]) => {
  const out: string[] = [];
  for (const c of trozos(bs)) enLinea(c, (n) => n.t === "enlace" && out.push(n.href));
  return out;
};

const anclas = (bs: readonly Bloque[]) => new Set(bs.flatMap((b) => (b.t === "titulo" ? [b.id] : [])));

const cuenta = (xs: readonly string[]) => [...xs].sort();

/** El regex de cifras de guides.test.ts: porcentajes y dólares, que necesitan fuente. */
const CIFRA = /[+−-]?\$\d[\d,.]*\d|[+−-]?\d[\d,.]*\s?%/g;
const DECIMAL = /\d+(?:[.,]\d+)+/g;
const ENTERO = /\d+/g;
const cifrasDe = (bs: readonly Bloque[], rx: RegExp) =>
  cuenta(trozos(bs).flatMap((c) => (prosa(c).match(rx) ?? []).map((x) => x.replace(/\s/g, ""))));

/**
 * Palabras que solo son inglesas (ninguna existe en los otros once idiomas
 * con otro sentido: «is», «of», «die», «was» o «on» quedan fuera). En los
 * párrafos de las traducciones su peso no pasa de 0,03; en nueve de cada diez
 * párrafos ingleses pasa de 0,10.
 */
const SOLO_INGLES = new Set(
  "the and that with you your this are which when what from does not would should there their they have has will were been for if but than then only into about by it's isn't don't".split(
    " ",
  ),
);
function pesoIngles(s: string): [number, number] {
  const w = s.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  return [w.filter((x) => SOLO_INGLES.has(x)).length / Math.max(1, w.length), w.length];
}

/** Cómo dice cada idioma «sin clave» (el «no key» del original). */
const SIN_CLAVE: Record<string, RegExp> = {
  es: /sin clave/i,
  ca: /sense clau/i,
  pt: /sem chave/i,
  fr: /sans clé/i,
  it: /senza chiave/i,
  nl: /zonder (api-)?sleutel|geen sleutel/i,
  de: /ohne (API-)?Schlüssel/i,
  pl: /bez klucza/i,
  tr: /anahtarsız|anahtar olmadan|anahtar gerekmeden/i,
  id: /tanpa kunci/i,
  vi: /không cần khóa/i,
};

/** Lo que nunca puede decir una traducción: que hace falta clave, licencia o registro para ahorrar. */
const CLAVE_PARA_AHORRAR: Record<string, RegExp> = {
  es: /(necesitas?|hace falta|requiere[ns]?|exige)\s+(de\s+)?(una\s+|tu\s+)?(clave|licencia|registro|suscripción)\s+para\s+(ahorrar|empezar)/i,
  ca: /(necessites|cal|requereix)\s+(tenir\s+)?(una\s+)?(clau|llicència|registre|subscripció)\s+per\s+(estalviar|començar)/i,
  pt: /(precisas?|é preciso|requer|exige)\s+(de\s+)?(uma\s+)?(chave|licença|registo|subscrição|assinatura)\s+para\s+(poupar|economizar|começar)/i,
  fr: /(besoin d['’]une?|il faut une?|nécessite une?|exige une?)\s+(clé|licence|inscription|abonnement)\s+pour\s+(économiser|commencer)/i,
  it: /(serve|servono|occorre|richiede|bisogno di)\s+(una\s+)?(chiave|licenza|registrazione|abbonamento)\s+per\s+(risparmiare|iniziare)/i,
  nl: /(sleutel|licentie|aanmelding|abonnement)\s+(nodig|vereist)\s+om\s+te\s+(besparen|beginnen)/i,
  de: /(Schlüssel|Lizenz|Registrierung|Abo)\s+(nötig|erforderlich|brauchst),?\s+um\s+(zu\s+sparen|anzufangen)|(brauchst|benötigst)\s+(du\s+)?(einen?\s+)?(Schlüssel|Lizenz|Registrierung|Abo),?\s+um\s+zu\s+sparen/i,
  pl: /(potrzebujesz|wymaga|trzeba)\s+(\S+\s+)?(klucza|licencji|rejestracji|subskrypcji),?\s+(żeby|aby|by)\s+(oszczędza|zacząć)/i,
  tr: /tasarruf\s+(etmek\s+)?için\s+(bir\s+)?(anahtar|lisans|kayıt|abonelik)\S*\s+(gerek|şart)/i,
  id: /(perlu|butuh|memerlukan|wajib punya)\s+(\S+\s+)?(kunci|lisensi|pendaftaran|langganan)\s+untuk\s+(berhemat|menghemat|mulai)/i,
  vi: /cần\s+(có\s+)?(khóa|giấy phép|đăng ký)[^.]{0,20}(để|mới)\s+(tiết kiệm|bắt đầu)/i,
};

const leer = (l: string, slug: string) => readFileSync(join(DIR, l, `${slug}.md`), "utf8");

// ── Qué hay ───────────────────────────────────────────────────────────────────

describe("las traducciones de las guías: qué hay", () => {
  it("los once idiomas traducidos tienen el índice y las guías del registro (texto y titular)", () => {
    for (const l of TRADUCCIONES) {
      expect(hayIndiceTraducido(l), `${l}: índice`).toBe(true);
      for (const g of GUIAS) expect(hayTraduccion(g.slug, l), `${l}/${g.slug}`).toBe(true);
    }
  });

  it("en cada carpeta solo hay `_meta.json` y guías del registro, y `_meta.json` nombra las mismas que hay", () => {
    const slugs = new Set(GUIAS.map((g) => g.slug));
    for (const l of TRADUCCIONES) {
      if (!existsSync(join(DIR, l))) continue;
      const md = readdirSync(join(DIR, l)).filter((f) => f !== "_meta.json");
      for (const f of md) expect(f.endsWith(".md") && slugs.has(f.slice(0, -3)), `${l}/${f}`).toBe(true);
      const meta = metaDelIdioma(l);
      expect(new Set(Object.keys(meta?.guides ?? {})), l).toEqual(new Set(md.map((f) => f.slice(0, -3))));
    }
  });

  it("titulares ≤ 80 y descripciones ≤ 160 caracteres (índice incluido), traducidos y en NFC", () => {
    for (const l of TRADUCCIONES) {
      const meta = metaDelIdioma(l);
      if (!meta) continue;
      const textos = [...(meta.index ? [["index", meta.index, INDICE] as const] : []), ...GUIAS.flatMap((g) => (meta.guides[g.slug] ? [[g.slug, meta.guides[g.slug]!, g] as const] : []))];
      for (const [que, t, original] of textos) {
        expect([...t.title].length, `${l} ${que}: title`).toBeLessThanOrEqual(80);
        expect([...t.description].length, `${l} ${que}: description`).toBeLessThanOrEqual(160);
        expect(t.title, `${l} ${que}: sin traducir`).not.toBe(original.title);
        expect(t.description, `${l} ${que}: sin traducir`).not.toBe(original.description);
        expect(t.title.normalize("NFC")).toBe(t.title);
        expect(t.description.normalize("NFC")).toBe(t.description);
      }
    }
  });
});

describe("la entradilla del índice en cada idioma (`_meta.json` → index.intro/sources)", () => {
  const enlacesDe = (md: string) => {
    const out: string[] = [];
    enLinea(leerEnLinea(md), (n) => n.t === "enlace" && out.push(n.href));
    return out;
  };

  it("el original dice «no key» y enlaza el banco y el repositorio", () => {
    expect(INDICE.intro).toMatch(/no key/);
    expect(enlacesDe(INDICE.sources)).toEqual(["/en/benchmarks", "https://github.com/BiVelio/bivelio-savings-layer"]);
  });

  it.each(TRADUCCIONES)("%s: traducida, sin clave, y con los enlaces del original en su idioma", (l) => {
    const index = metaDelIdioma(l)?.index;
    expect(index, l).toBeDefined();
    const { intro, sources } = index!;
    expect(intro).not.toBe(INDICE.intro);
    expect(sources).not.toBe(INDICE.sources);
    expect(intro).toMatch(SIN_CLAVE[l]!);
    for (const t of [intro, sources]) {
      expect(t).not.toMatch(CLAVE_PARA_AHORRAR[l]!);
      expect(t.normalize("NFC")).toBe(t);
      expect(pesoIngles(t)[0], t).toBeLessThan(0.1);
    }
    expect(enlacesDe(sources)).toEqual([`/${l}/benchmarks`, "https://github.com/BiVelio/bivelio-savings-layer"]);
  });
});

describe("un idioma sin traducción sirve el original, como antes", () => {
  // «ja» no tiene carpeta en content/: es lo que vería un idioma al que aún
  // no se ha traducido una guía.
  const g = GUIAS[0]!;

  it("el texto, el titular y el idioma declarado son los ingleses, con la nota", () => {
    expect(hayTraduccion(g.slug, "ja")).toBe(false);
    expect(cargarTexto(g.slug, "ja")).toEqual(cargarTexto(g.slug));
    expect(guiaEnIdioma(g, "ja")).toMatchObject({ title: g.title, description: g.description, idioma: "en", enIngles: true });
    expect(guiaEnIdioma(g, "en")).toMatchObject({ idioma: "en", enIngles: false });
    expect(indiceEnIdioma("ja")).toMatchObject({ title: INDICE.title, idioma: "en", enIngles: true });
  });

  it("su canonical es /en y no entra en los hreflang", () => {
    expect(canonicalDe(g.slug, "ja")).toBe(urlDeGuia(g.slug, "en"));
    expect(canonicalDe(undefined, "ja")).toBe(urlDeGuia(undefined, "en"));
    expect(idiomasDe(g.slug)).not.toContain("ja");
    expect(Object.keys(alternativasDe(g.slug))).not.toContain("ja");
  });

  it("con traducción, el canonical es la URL de su idioma", () => {
    for (const l of TRADUCCIONES) if (hayTraduccion(g.slug, l)) expect(canonicalDe(g.slug, l)).toBe(urlDeGuia(g.slug, l));
  });
});

// ── Cada idioma × guía ────────────────────────────────────────────────────────

const PARES = TRADUCCIONES.flatMap((l) => GUIAS.filter((g) => existsSync(join(DIR, l, `${g.slug}.md`))).map((g) => [l, g.slug] as const));

describe.each(PARES)("la guía %s/%s", (l, slug) => {
  const texto = leer(l, slug);
  const tr = leerMarkdown(texto);
  const en = cargarTexto(slug);
  const original = readFileSync(join(DIR, `${slug}.md`), "utf8");

  it("se lee igual que la sirve la página, en NFC y sin <h1> propio", () => {
    expect(cargarTexto(slug, l)).toEqual(tr);
    expect(texto.normalize("NFC")).toBe(texto);
    expect(tr.some((b) => b.t === "titulo" && b.nivel === 1)).toBe(false);
  });

  it("la misma estructura que el original: títulos con su nivel, párrafos, listas, tablas, en el mismo orden", () => {
    expect(tr.map(forma)).toEqual(en.map(forma));
    const titulos = (bs: Bloque[]) => bs.flatMap((b) => (b.t === "titulo" ? [b.nivel] : []));
    expect(titulos(tr)).toEqual(titulos(en));
  });

  it("los mismos bloques de código, byte a byte, y el mismo código en línea", () => {
    expect(codigos(tr)).toEqual(codigos(en));
    const vallas = (s: string) => s.split("\n").filter((x) => /^```/.test(x));
    expect(vallas(texto)).toEqual(vallas(original));
    expect(codigoEnLinea(tr)).toEqual(codigoEnLinea(en));
  });

  it("las mismas cifras: porcentajes, dólares y decimales idénticos, y ningún número del original perdido", () => {
    expect(cifrasDe(tr, CIFRA)).toEqual(cifrasDe(en, CIFRA));
    expect(cifrasDe(tr, DECIMAL)).toEqual(cifrasDe(en, DECIMAL));
    // Enteros: puede haber más (el vietnamita escribe «ngày 23 tháng 11»),
    // nunca menos.
    const suyos = cifrasDe(tr, ENTERO);
    for (const n of cifrasDe(en, ENTERO)) {
      const i = suyos.indexOf(n);
      expect(i, `falta el número ${n}`).toBeGreaterThanOrEqual(0);
      suyos.splice(i, 1);
    }
  });

  it("las mismas URL externas", () => {
    const fuera = (bs: Bloque[]) => cuenta(hrefs(bs).filter((h) => /^https?:\/\//.test(h)));
    expect(fuera(tr)).toEqual(fuera(en));
  });

  it("los enlaces internos van a su idioma, y a guías y anclas que existen en él", () => {
    const dentro = (bs: Bloque[], idioma: string) =>
      cuenta(
        hrefs(bs)
          .filter((h) => h.startsWith("/"))
          .map((h) => {
            expect(h.startsWith(`/${idioma}/`) || h === `/${idioma}`, `${h} no va a /${idioma}`).toBe(true);
            // Sin idioma y, en las guías, sin ancla (el ancla sale del título traducido).
            const sin = h.slice(idioma.length + 1);
            return sin.startsWith("/guides/") ? sin.replace(/#.*$/, "") : sin;
          }),
      );
    expect(dentro(tr, l)).toEqual(dentro(en, "en"));
    for (const h of hrefs(tr)) {
      if (h.startsWith("#")) expect(anclas(tr).has(h.slice(1)), h).toBe(true);
      const m = new RegExp(`^/${l}/guides/([a-z0-9-]+)(?:#(.+))?$`, "u").exec(h);
      if (h.startsWith(`/${l}/guides/`)) {
        expect(m, h).not.toBeNull();
        expect(hayTraduccion(m![1]!, l), h).toBe(true);
        if (m![2]) expect(anclas(cargarTexto(m![1]!, l)).has(m![2]), h).toBe(true);
      } else if (h.startsWith("/")) {
        expect(h, "solo rutas que existen en la web").toMatch(new RegExp(`^/${l}/(benchmarks|paper)(#[a-z0-9-]+)?$`));
      }
    }
  });

  it("ningún párrafo se quedó en inglés", () => {
    const a = trozos(tr).map(prosa);
    const b = trozos(en).map(prosa);
    expect(a.length).toBe(b.length);
    const limpio = (s: string) => s.replace(/\s+/g, " ").trim();
    a.forEach((p, i) => {
      const [peso, palabras] = pesoIngles(p);
      if (palabras >= 5) expect(limpio(p), `idéntico al inglés: «${p.slice(0, 80)}»`).not.toBe(limpio(b[i]!));
      if (palabras >= 8) expect(peso, `¿en inglés?: «${p.slice(0, 80)}»`).toBeLessThan(0.1);
    });
  });

  it("dice que ahorra sin clave, y nunca que haga falta una clave, licencia o registro para ahorrar", () => {
    expect(texto).toMatch(SIN_CLAVE[l]!);
    expect(texto).not.toMatch(CLAVE_PARA_AHORRAR[l]!);
    expect(texto).not.toMatch(/BIVELIO_(LICENSE|SERVICE)_KEY/);
    // Ni en inglés (un resto del original).
    expect(texto).not.toMatch(/(need|needs|require|requires|required)\s+(a|an|your)?\s*(bivelio\s+)?(license|licence|key|signup|subscription)\s+to\s+save/i);
    expect(texto).not.toMatch(/sign\s*up\s+to\s+(save|start)/i);
  });
});

// ── Que la heurística muerde ─────────────────────────────────────────────────

describe("las comprobaciones de las traducciones detectan lo que tienen que detectar", () => {
  it("un párrafo inglés pesa más de 0,10; uno traducido, no", () => {
    const en = cargarTexto("reduce-openai-api-costs");
    const pesos = trozos(en)
      .map(prosa)
      .map(pesoIngles)
      .filter(([, n]) => n >= 8);
    expect(pesos.filter(([p]) => p >= 0.1).length / pesos.length).toBeGreaterThan(0.8);
  });

  it("las frases prohibidas se detectan", () => {
    expect("Necesitas una clave para ahorrar.").toMatch(CLAVE_PARA_AHORRAR.es!);
    expect("Il faut une clé pour économiser.").toMatch(CLAVE_PARA_AHORRAR.fr!);
    expect("Du brauchst einen Schlüssel, um zu sparen.").toMatch(CLAVE_PARA_AHORRAR.de!);
    expect("Tasarruf etmek için anahtar gerekir.").toMatch(CLAVE_PARA_AHORRAR.tr!);
    expect("Anda perlu kunci untuk berhemat.").toMatch(CLAVE_PARA_AHORRAR.id!);
    expect("Bạn cần khóa để tiết kiệm.").toMatch(CLAVE_PARA_AHORRAR.vi!);
  });
});

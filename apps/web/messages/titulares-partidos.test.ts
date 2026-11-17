import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { partirMarca } from "../app/components/campana/Marcado";
import { SEMILLAS_DE_HEROE } from "../app/components/campana/HeroeDeCampana";

/**
 * LOS TITULARES PARTIDOS PARA LA FIRMA DE CAMPAÑA (2026-11-17).
 *
 * El héroe de /benchmarks, /pricing y /how-it-works pinta el titular en dos
 * voces: una línea en negrita (`title`) y un acento en serif cursiva
 * (`titleAccent`) con el marcador cian detrás de `titleMark`. Para eso se
 * PARTIÓ el titular que ya había, sin retraducir ni cambiar una letra.
 *
 * Esta prueba guarda el titular ANTIGUO de cada idioma y exige que
 * `title + " " + titleAccent` siga siendo exactamente ese: quien toque una de
 * las dos mitades tiene que hacerlo a sabiendas (y actualizar aquí la frase
 * entera, que es además la que usan la tarjeta OG y el panel).
 */
const DIR = new URL(".", import.meta.url).pathname;

const TITULARES: Record<string, Record<string, string>> = {
  benchmarksPage: {
    es: "Nuestro banco A/B, abierto. Mídenos.",
    en: "Our A/B bench, in the open. Measure us.",
    ca: "El nostre banc A/B, obert. Mesura'ns.",
    fr: "Notre banc A/B, en public. Mesurez-nous.",
    de: "Unser A/B-Benchmark, offen einsehbar. Messen Sie uns.",
    it: "Il nostro banco di prova A/B, alla luce del sole. Misuraci.",
    pt: "O nosso banco A/B, em aberto. Meça-nos.",
    nl: "Onze A/B-benchmark, in het open. Meet ons.",
    pl: "Nasz test A/B, w pełni jawny. Zmierz nas.",
    tr: "A/B testimiz, açıkta. Bizi ölçün.",
    id: "Uji A/B kami, secara terbuka. Ukur kami.",
    vi: "Bài kiểm tra A/B của chúng tôi, công khai. Hãy đo chúng tôi.",
  },
  pricingPage: {
    es: "Motor open source. Control cloud para tu equipo.",
    en: "Open-source engine. Cloud control for your team.",
    ca: "Motor open source. Control cloud per al teu equip.",
    fr: "Moteur open source. Contrôle cloud pour votre équipe.",
    de: "Open-Source-Engine. Cloud-Kontrolle für dein Team.",
    it: "Motore open source. Controllo cloud per il tuo team.",
    pt: "Motor open source. Controlo cloud para a tua equipa.",
    nl: "Open-source-engine. Cloudcontrole voor je team.",
    pl: "Silnik open source. Kontrola w chmurze dla Twojego zespołu.",
    tr: "Açık kaynak motor. Ekibiniz için bulut kontrolü.",
    id: "Mesin open source. Kendali cloud untuk tim Anda.",
    vi: "Engine mã nguồn mở. Kiểm soát trên cloud cho nhóm của bạn.",
  },
  howItWorks: {
    es: "¿Dónde se instala el ahorro?",
    en: "Where does the saving install?",
    ca: "On s'instal·la l'estalvi?",
    fr: "Où s'installe l'économie ?",
    de: "Wo wird die Ersparnis installiert?",
    it: "Dove si installa il risparmio?",
    pt: "Onde se instala a economia?",
    nl: "Waar wordt de besparing geïnstalleerd?",
    pl: "Gdzie instaluje się oszczędność?",
    tr: "Tasarruf nereye kurulur?",
    id: "Di mana penghematan dipasang?",
    vi: "Khoản tiết kiệm được cài ở đâu?",
  },
};

const LOCALES = ["es", "en", "ca", "fr", "de", "it", "pt", "nl", "pl", "tr", "id", "vi"];

type Titular = { title: string; titleAccent: string; titleMark: string };
const cargar = (loc: string) => JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")) as Record<string, Titular>;

describe("titulares partidos: la frase no cambió", () => {
  for (const [ns, porIdioma] of Object.entries(TITULARES)) {
    it(`${ns}: los doce idiomas están fijados`, () => {
      expect(Object.keys(porIdioma).sort()).toEqual([...LOCALES].sort());
    });
    for (const loc of LOCALES) {
      it(`${ns} (${loc}): title + " " + titleAccent es el titular de siempre`, () => {
        const m = cargar(loc)[ns]!;
        expect(`${m.title} ${m.titleAccent}`).toBe(porIdioma[loc]);
        expect(m.title.trim()).toBe(m.title);
        expect(m.titleAccent.trim()).toBe(m.titleAccent);
        expect(m.title.length).toBeGreaterThan(0);
        expect(m.titleAccent.length).toBeGreaterThan(0);
      });
      it(`${ns} (${loc}): titleMark es un trozo del acento, de palabras enteras`, () => {
        const m = cargar(loc)[ns]!;
        expect(m.titleMark.length).toBeGreaterThan(0);
        expect(m.titleAccent).toContain(m.titleMark);
        // El marcador no parte una palabra: a cada lado hay un borde del acento,
        // un espacio o puntuación (en vietnamita, sílabas enteras).
        const partes = partirMarca(m.titleAccent, m.titleMark);
        expect(partes).not.toBeNull();
        const [antes, marcado, despues] = partes!;
        expect(antes + marcado + despues).toBe(m.titleAccent);
        expect(antes === "" || /\s$/u.test(antes)).toBe(true);
        expect(despues === "" || /^\s/u.test(despues)).toBe(true);
      });
    }
  }
});

describe("quien usaba el titular entero lo sigue recibiendo entero", () => {
  const leer = (ruta: string) => readFileSync(`${DIR}../${ruta}`, "utf8");
  it("la tarjeta OG y el panel de «cómo funciona» unen las dos mitades", () => {
    const union = '`${t("title")} ${t("titleAccent")}`';
    expect(leer("app/[locale]/how-it-works/opengraph-image.tsx")).toContain(union);
    expect(leer("app/[locale]/dashboard/how-it-works/page.tsx")).toContain(union);
  });
  it("cada héroe pinta el acento con su marcador", () => {
    for (const ruta of ["app/components/BancoPublico.tsx", "app/[locale]/pricing/page.tsx"]) {
      expect(leer(ruta)).toContain('<Marcado texto={t("titleAccent")} marca={t("titleMark")} />');
    }
    const hiw = leer("app/[locale]/how-it-works/page.tsx");
    expect(hiw).toContain('acento={t("titleAccent")}');
    expect(hiw).toContain('marca={t("titleMark")}');
  });
  it("el título científico del paper no lleva marcador", () => {
    expect(leer("app/[locale]/paper/page.tsx")).not.toContain("Marcado");
  });
});

describe("la firma en los héroes", () => {
  it("cada página tiene su propia semilla de mosaico (y ninguna es la de la portada)", () => {
    const semillas = Object.values(SEMILLAS_DE_HEROE);
    expect(new Set(semillas).size).toBe(semillas.length);
    const portada = readFileSync(`${DIR}../app/[locale]/page.tsx`, "utf8");
    for (const s of semillas) expect(portada).not.toContain(`semilla={${s}}`);
  });
  it("las clases que usa <HeroeDeCampana> existen en su slot de globals.css", () => {
    const css = readFileSync(`${DIR}../app/globals.css`, "utf8");
    const ini = css.indexOf("/* ==== SLOT CAMPAÑA HÉROES ==== */");
    const fin = css.indexOf("/* ==== FIN SLOT CAMPAÑA HÉROES ==== */");
    expect(ini).toBeGreaterThan(-1);
    expect(fin).toBeGreaterThan(ini);
    const slot = css.slice(ini, fin);
    for (const clase of [".heroe-campana", ".heroe-mosaico"]) expect(slot).toContain(clase);
    // Nada de entradas que oculten el titular: el slot no declara opacidad ni animaciones propias.
    expect(slot).not.toMatch(/opacity\s*:/);
    expect(slot).not.toMatch(/animation(?:-name)?\s*:/);
  });
});

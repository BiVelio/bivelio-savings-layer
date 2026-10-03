import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { LIMITES_MEDIR, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";
import { MEASURE_LIMITS } from "../../../../packages/protocol/src/index";

import { filasDelBancoEnVivo } from "@/app/components/MedidoEnVivo";

import { BANCO_EN_VIVO, GEMINI_EN_EL_SEMANAL, VERSION_GEMINI_NATIVO } from "./banco-en-vivo";

/**
 * LA PORTADA DICE SOLO LO MEDIDO (2026-09-29), EN LOS 12 IDIOMAS.
 *
 * Una auditoría encontró en la web pública cinco afirmaciones que la medición
 * no sostenía o que ya no eran verdad:
 *   1. «With the SDK as you install it from npm, the bill goes down by at least
 *      10%» / «≥ 10.0% less bill»: salía de una tirada sintética con un
 *      compresor que npm no trae. /benchmarks mide ≈ 0 % sin repeticiones.
 *   2. «… enters the commission» en las tarjetas del SDK y del gateway: Pro y
 *      Equipo no llevan comisión (la modalidad con comisión está cerrada).
 *   3. «Compatible with … Gemini»: sugería medido lo que no lo está.
 *   4. Medir (gratis) sin sus límites ni la versión mínima del paquete.
 *   5. Las cifras del skill (68,2 / 19,6 / 11,6 %) sin informe publicado.
 * Esta verja impide que vuelvan, en cualquier idioma.
 */

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const LOCALES = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"] as const;
type Loc = (typeof LOCALES)[number];

type Plano = Record<string, string>;
function aplanar(o: unknown, p = ""): Plano {
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).reduce<Plano>(
      (acc, [k, v]) => Object.assign(acc, aplanar(v, p ? `${p}.${k}` : k)),
      {},
    );
  }
  return { [p]: String(o) };
}
const crudo = (loc: Loc) => JSON.parse(readFileSync(join(WEB, "messages", `${loc}.json`), "utf8")) as Record<string, unknown>;
const cargar = (loc: Loc): Plano => aplanar(crudo(loc));
const fuente = (rel: string) => readFileSync(join(WEB, rel), "utf8");
/** El fuente sin comentarios: lo que se comprueba es el código, no lo que se cuenta de él. */
const codigo = (rel: string) =>
  fuente(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Las superficies públicas: la portada, «cómo funciona», /pricing y el alta. */
const PUBLICAS = ["landing.", "howItWorks.", "pricingPage.", "auth."];
const publicas = (d: Plano) => Object.entries(d).filter(([k]) => PUBLICAS.some((p) => k.startsWith(p)));
/** Y el panel (2026-09-29): la web ENTERA dice solo lo medido, dentro y fuera. */
const PANEL = ["dashboard.", "app."];
const conPanel = (d: Plano) => Object.entries(d).filter(([k]) => [...PUBLICAS, ...PANEL].some((p) => k.startsWith(p)));

/**
 * «Al menos un 10 %» en cada idioma, tal como lo decía la portada, y la fórmula
 * genérica «al menos {piso}». Más el «≥ 10» en cualquier escritura.
 */
const AL_MENOS: Record<Loc, RegExp> = {
  en: /at least (\{piso\}|10\b)/i,
  es: /al menos (un )?(\{piso\}|10\b)/i,
  ca: /(com a mínim|almenys) (un )?(\{piso\}|10\b)/i,
  de: /(mindestens|um mindestens) (\{piso\}|10\b)/i,
  fr: /(au moins|d'au moins) (\{piso\}|10\b)/i,
  id: /(setidaknya|sedikitnya|paling sedikit) (\{piso\}|10\b)/i,
  it: /(almeno|di almeno) (il |del )?(\{piso\}|10\b)/i,
  nl: /(minstens|ten minste|minimaal) (\{piso\}|10\b)/i,
  pl: /(co najmniej|o co najmniej) (\{piso\}|10\b)/i,
  pt: /(pelo menos|no mínimo) (\{piso\}|10\b)/i,
  tr: /(en az) (%?\{piso\}|%?10\b)/i,
  vi: /(ít nhất) (\{piso\}|10\b)/i,
};
const DIEZ = /≥\s*%?\s*10(?:[.,]0)?\s*%?|\{piso\}/;

/** «Entra en la comisión» y sus hermanas, tal como lo decían las tarjetas en cada idioma. */
const ENTRA_EN_LA_COMISION: Record<Loc, RegExp> = {
  en: /enters? (the|your) commission|enter the commission/i,
  es: /entra en (la|tu) comisión|En la comisión solo entra/i,
  ca: /entra a la (teva )?comissió|A la comissió només hi entra/i,
  de: /in die Provision ein|in Ihre Provision ein|In die Provision geht/i,
  fr: /entre (jamais )?dans (la|votre) commission/i,
  id: /masuk (ke )?komisi/i,
  it: /entra (mai )?nella (tua )?commissione|Nella commissione entra/i,
  nl: /telt (nooit )?mee voor (de|je) commissie/i,
  pl: /(wchodzi|wchodzą) do (Twojej )?prowizji|Do prowizji wchodzą/i,
  pt: /entra na (tua )?comissão|Na comissão só entra/i,
  tr: /komisyon(a|unuza) (da )?(yalnızca .* )?gir/i,
  vi: /tính vào hoa hồng/i,
};

/** La palabra «comisión» en cada idioma. */
const COMISION: Record<Loc, RegExp> = {
  en: /commission/i,
  es: /comisi[oó]n/i,
  ca: /comissi[oó]/i,
  de: /Provision/i,
  fr: /commission/i,
  id: /komisi/i,
  it: /commission/i,
  nl: /commissie/i,
  pl: /prowizj/i,
  pt: /comiss[aã]o/i,
  tr: /komisyon/i,
  vi: /hoa hồng/i,
};
/**
 * Donde la comisión no pinta nada: lo que la portada dice del producto. La
 * comisión solo puede aparecer al hablar de planes (Medir «nunca comisión»,
 * Pro/Equipo «sin comisión», la modalidad antigua para quien la conserva).
 */
const SIN_COMISION = [
  "landing.hero.",
  "landing.enVivo.",
  "landing.offers.",
  "landing.devs.",
  "landing.step2.",
  "landing.cascade.",
  "landing.ledgersHead.",
  "howItWorks.",
];

describe("⛔ nunca más «al menos un 10 %» ni «entra en la comisión»", () => {
  for (const loc of LOCALES) {
    it(`${loc}: ni la web pública ni el panel prometen «al menos {piso}» / «≥ 10 %»`, () => {
      const malos = conPanel(cargar(loc))
        .filter(([, v]) => AL_MENOS[loc].test(v) || DIEZ.test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(malos).toEqual([]);
    });

    // /pricing queda fuera a propósito: sus condiciones de la modalidad antigua
    // (cerrada a clientes nuevos) SÍ dicen qué entra en la comisión de quien la
    // conserva. La portada, «cómo funciona» y el alta, no.
    it(`${loc}: ni la portada, ni «cómo funciona», ni el alta dicen que el ahorro «entra en la comisión»`, () => {
      const malos = publicas(cargar(loc))
        .filter(([k]) => !k.startsWith("pricingPage."))
        .filter(([, v]) => ENTRA_EN_LA_COMISION[loc].test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(malos).toEqual([]);
    });

    it(`${loc}: la portada no habla de comisión al describir el producto (Pro y Equipo no la llevan)`, () => {
      const malos = Object.entries(cargar(loc))
        .filter(([k]) => SIN_COMISION.some((p) => k.startsWith(p)))
        .filter(([, v]) => COMISION[loc].test(v))
        .map(([k]) => k);
      expect(malos).toEqual([]);
    });

    it(`${loc}: la portada ya no trae el titular de la tirada sintética ni su recibo`, () => {
      const d = crudo(loc) as { landing: Record<string, Record<string, unknown>> };
      expect(d.landing.hero!.proofs).toBeUndefined();
      expect(d.landing.hero!.proofSdkPendiente).toBeUndefined();
      expect(d.landing.step2!.plainSdkPendiente).toBeUndefined();
      expect(d.landing.recibo).toBeUndefined();
    });
  }

  it("las verjas de arriba cazan las frases viejas (si no, no protegen nada)", () => {
    expect(AL_MENOS.en.test("With the SDK as you install it from npm, the bill goes down by at least {piso}.")).toBe(true);
    expect(AL_MENOS.es.test("la factura baja al menos un {piso}")).toBe(true);
    expect(DIEZ.test("≥ 10.0%")).toBe(true);
    expect(DIEZ.test("≥ %10,0")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.en.test("only what your provider's counter confirms enters the commission.")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.es.test("solo lo que confirma el contador de tu proveedor entra en la comisión.")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.tr.test("komisyona da yalnızca sağlayıcınızın sayacının doğruladığı girer.")).toBe(true);
    expect(ENTRA_EN_LA_COMISION.vi.test("mới tính vào hoa hồng.")).toBe(true);
  });
});

describe("el código de la portada y de «cómo funciona» no lee la tirada sintética", () => {
  const FICHEROS = [
    "app/[locale]/page.tsx",
    "app/components/HowItWorks.tsx",
    "app/[locale]/how-it-works/opengraph-image.tsx",
  ];
  for (const rel of FICHEROS) {
    it(`⛔ ${rel}: sin ab-live.json, sin sueloPublicable, sin ANATOMIA_MEDIDA`, () => {
      const src = codigo(rel);
      expect(src).not.toMatch(/ab-live|sueloPublicable|PROMESA_DEL_TITULAR|ANATOMIA_MEDIDA/);
    });
  }

  it("la portada construye lo medido desde BANCO_EN_VIVO, sin la fila «sin repeticiones ≈ 0» (dueño, 2026-10-02)", () => {
    const filas = codigo("app/components/MedidoEnVivo.tsx");
    expect(filas).toMatch(/from "@\/lib\/portada\/banco-en-vivo"/);
    expect(filas).toContain('t("enVivo.conRepeticiones"');
    expect(filas).toContain('t("enVivo.anthropic"');
    const portada = codigo("app/[locale]/page.tsx");
    expect(portada).toContain("filasDelBancoEnVivo(t, locale)");
    // La portada no pide la fila del cero, ni formatea un cero, ni pasa {cero}.
    expect(portada).not.toMatch(/sinRepeticiones|format\(0\)|\bcero\b/);
  });
});

describe("el panel: la cifra del banco en vivo y el dinero del cliente, nunca el «≥ 10 %» de la tirada sintética", () => {
  function fuentes(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(join(WEB, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) fuentes(rel, acc);
      else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) acc.push(rel);
    }
    return acc;
  }
  const TODAS = [...fuentes("app"), ...fuentes("lib")];

  it("⛔ PROMESA_DEL_TITULAR y sueloPublicable no existen en ningún fuente de la web", () => {
    expect(TODAS.length).toBeGreaterThan(100);
    expect(TODAS.filter((rel) => /PROMESA_DEL_TITULAR|sueloPublicable/.test(codigo(rel)))).toEqual([]);
  });

  it("⛔ ningún componente escribe un «≥ 10 %» a mano", () => {
    expect(TODAS.filter((rel) => DIEZ.test(codigo(rel)))).toEqual([]);
  });

  it("/dashboard/proof abre con el banco en vivo y el dinero del cliente, y etiqueta la tirada sintética", () => {
    const src = codigo("app/[locale]/dashboard/proof/page.tsx");
    const pos = ["filasDelBancoEnVivo(tl, locale, { sinRepeticiones: true })", 't.rich("proof.tuDinero"', 't("proof.sinteticaTitulo")', "<ReferenceModeBadge", "<NetSavingsCIBand"].map((x) =>
      src.indexOf(x),
    );
    for (const p of pos) expect(p).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("la banda del intervalo no pinta nada de una tirada que no midió lo instalado", () => {
    const src = codigo("app/[locale]/dashboard/components/NetSavingsCIBand.tsx");
    expect(src).toContain("if (!midioElSdkInstalado(ab)) return null;");
  });

  it("las baldosas vacías del panel no enseñan una «ref» de la tirada sintética", () => {
    const src = codigo("app/[locale]/dashboard/components/LiveLedgerTiles.tsx");
    expect(src).not.toMatch(/AbArtifact|ab-live|fantasmaDeReferencia|ref \$\{/);
    expect(src).toContain('t("liveLedgerTiles.ghostAwaiting")');
  });

  for (const loc of LOCALES) {
    it(`${loc}: la insignia llama «sintética» a la tirada y dice que no es una promesa; la baldosa no lleva {ref}`, () => {
      const d = cargar(loc);
      expect(d["dashboard.referenceModeBadge.sdkPendiente"], loc).toBeTruthy();
      expect(d["dashboard.proof.sinteticaTitulo"], loc).toBeTruthy();
      expect(d["dashboard.proof.tuDinero"], loc).toMatch(/<overview>.+<\/overview>/);
      expect(d["dashboard.liveLedgerTiles.ghostAwaiting"], loc).not.toContain("{ref}");
      expect(d["dashboard.netSavingsCIBand.captionSdkPendiente"], loc).toBeUndefined();
    });
  }
  it("en/es: «synthetic» / «sintética» y «not a promise» / «no son una promesa»", () => {
    expect(cargar("en")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/^Synthetic run/);
    expect(cargar("en")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/not a promise/);
    expect(cargar("es")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/^Tirada sintética/);
    expect(cargar("es")["dashboard.referenceModeBadge.sdkPendiente"]).toMatch(/no son una promesa/);
  });
});

/**
 * LA PORTADA NO PROMETE RECORTAR EL TEXTO (2026-09-30). Los vídeos «paja/magro»
 * decían que la verja quita el relleno y que «el paquete llega a la nube mucho
 * más pequeño», y el primer vídeo explicativo que Savings «deja pasar solo lo
 * necesario». No está medido: en el banco A/B en vivo y en el semanal el ahorro
 * del SDK instalado sale de las peticiones repetidas servidas sin llamar al
 * proveedor; el compresor de la tirada sintética es solo del banco y el paquete
 * no lo trae.
 */
/** «Deja pasar solo lo necesario», tal como lo decía explica.pasos[0].body en cada idioma. */
const SOLO_LO_NECESARIO: Record<Loc, RegExp> = {
  en: /lets? through only what'?s needed|only what'?s needed/i,
  es: /deja pasar solo lo necesario/i,
  ca: /deixa passar només el necessari/i,
  de: /lässt nur durch, was nötig ist/i,
  fr: /ne laisse passer que le nécessaire/i,
  id: /hanya meloloskan yang diperlukan/i,
  it: /lascia passare solo il necessario/i,
  nl: /laat alleen door wat nodig is/i,
  pl: /przepuszcza tylko to, co potrzebne/i,
  pt: /deixa passar só o necessário/i,
  tr: /yalnızca gerekli olanı geçirir/i,
  vi: /chỉ cho qua những gì cần thiết/i,
};
/** «El paquete llega mucho más pequeño» / «quita el relleno», como lo decían los vídeos «paja/magro». */
const RECORTA: Record<Loc, RegExp> = {
  en: /much smaller|carries padding|removes it before you pay/i,
  es: /mucho más pequeño|va con paja|la quita antes de pagar/i,
  ca: /molt més petit|porta palla|la treu abans de pagar/i,
  de: /viel kleiner|trägt die Sendung Füllung|entfernt das Tor/i,
  fr: /bien plus petit|porte du rembourrage|le portique le retire/i,
  id: /jauh lebih kecil|membawa isian|gerbang membuangnya/i,
  it: /molto più piccolo|porta paglia|il varco la toglie/i,
  nl: /veel kleiner|draagt de zending opvulling|haalt de poort die eruit/i,
  pl: /znacznie mniejsza|niesie wypełniacz|bramka usuwa go/i,
  pt: /muito mais pequeno|leva palha|o portão tira-a/i,
  tr: /çok daha küçük|dolgu taşıyorsa|kapı ödemeden önce onu çıkarır/i,
  vi: /nhỏ hơn nhiều|có phần độn|cổng sẽ bỏ nó/i,
};

describe("⛔ la portada no promete recortar el texto de entrada", () => {
  for (const loc of LOCALES) {
    it(`${loc}: fuera las claves de los vídeos «paja/magro» y la frase del «≈ 0 %» que quedó debajo (2026-10-02)`, () => {
      const d = crudo(loc) as { landing: Record<string, unknown> };
      expect(d.landing.trabajos, loc).toBeUndefined();
    });

    it(`${loc}: ni la portada ni «cómo funciona» dicen que el paquete llega más pequeño`, () => {
      const malos = Object.entries(cargar(loc))
        .filter(([k]) => k.startsWith("landing.") || k.startsWith("howItWorks."))
        .filter(([, v]) => RECORTA[loc].test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(malos).toEqual([]);
    });

    it(`${loc}: el primer vídeo explicativo dice lo medido, no «deja pasar solo lo necesario»`, () => {
      const body = cargar(loc)["landing.explica.pasos.0.body"];
      expect(body, loc).toBeTruthy();
      expect(body, loc).not.toMatch(SOLO_LO_NECESARIO[loc]);
      expect(Object.values(cargar(loc)).filter((v) => SOLO_LO_NECESARIO[loc].test(v)), loc).toEqual([]);
    });
  }

  it("en/es: el primer vídeo habla de la petición ya vista que se responde sin llamar al proveedor", () => {
    expect(cargar("en")["landing.explica.pasos.0.body"]).toMatch(/already seen and verified is answered without calling the provider/);
    expect(cargar("es")["landing.explica.pasos.0.body"]).toMatch(/ya ha visto y verificado se responde sin volver a llamar al proveedor/);
  });

  it("⛔ la portada no referencia los vídeos «paja/magro» ni sus claves, y los ficheros ya no existen", () => {
    const src = codigo("app/[locale]/page.tsx");
    expect(src).not.toMatch(/trabajos-paja|trabajos-magro|pajaTitle|pajaBody|magroTitle|magroBody/);
    expect(src).not.toContain("trabajos.caption");
    const videos = readdirSync(join(WEB, "public", "videos"));
    expect(videos.filter((f) => /^trabajos-(paja|magro)\./.test(f))).toEqual([]);
  });

  it("las verjas de arriba cazan las frases viejas (si no, no protegen nada)", () => {
    expect(SOLO_LO_NECESARIO.en.test("Savings stands in the middle of that path and lets through only what's needed")).toBe(true);
    expect(SOLO_LO_NECESARIO.es.test("Savings se pone en medio del camino y deja pasar solo lo necesario")).toBe(true);
    expect(SOLO_LO_NECESARIO.vi.test("Savings đứng giữa con đường đó và chỉ cho qua những gì cần thiết")).toBe(true);
    expect(RECORTA.en.test("the parcel reaches the cloud much smaller")).toBe(true);
    expect(RECORTA.es.test("el paquete llega a la nube mucho más pequeño")).toBe(true);
    expect(RECORTA.tr.test("paket buluta çok daha küçük ulaşır")).toBe(true);
  });
});

describe("la calculadora de comisión, retirada: ni componente ni claves", () => {
  for (const loc of LOCALES) {
    it(`${loc}: sin landing.calculadora ni landing.formula`, () => {
      const d = crudo(loc) as { landing: Record<string, unknown> };
      expect(d.landing.calculadora).toBeUndefined();
      expect(d.landing.formula).toBeUndefined();
    });
  }
});

/**
 * GEMINI: COMPATIBLE ≠ MEDIDO, Y LO MEDIDO CON SU INFORME (2026-10-01).
 *
 * El primer banco semanal en vivo con Gemini por su API nativa midió Gemini
 * 3.8 Flash en las cuatro baterías sin ningún fallo de la capa ni negativas
 * cacheadas o acreditadas; Gemini 3.1 Pro quedó «no medible» por la cuota del
 * proveedor (250 peticiones al día). Desde #448 sus baterías van en dos
 * jornadas, y dos bancos PARCIALES limitados a él (2026-10-01 y 2026-10-02)
 * midieron las cuatro, cada una una vez, con el mismo resultado. La nota lo
 * dice así — sin cifra de ahorro, porque esos bancos no la miden — y esta verja
 * exige que los informes lo sostengan: no se puede llamar «medido» a un modelo
 * sin sus celdas medidas.
 */
const RAIZ_REPO = join(WEB, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const BATERIAS_SEMANAL = ["gsm8k", "bfcl", "xstest", "mt-bench"];

describe("Gemini: compatible ≠ medido; lo medido, con su informe", () => {
  const G = GEMINI_EN_EL_SEMANAL;
  const inf: J = JSON.parse(readFileSync(join(RAIZ_REPO, G.informe), "utf8"));
  const celdas = (modelo: string): J[] => (inf.resultados as J[]).filter((c) => c.modelo === modelo);
  const medida = (c: J) => c.estado === "medida" && c.medicion?.estado === "medido";

  it("el informe es una tirada EN VIVO del banco semanal, de ese día, y la más reciente publicada", () => {
    expect(inf.modo).toBe("vivo");
    expect(String(inf.inicio).slice(0, 10)).toBe(G.fecha);
    const dir = join(RAIZ_REPO, "docs", "benchmarks");
    const inicios = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(dir, d.name)).filter((f) => /^banco-semanal.*\.json$/.test(f)).map((f) => join(dir, d.name, f)))
      .map((f) => JSON.parse(readFileSync(f, "utf8")) as J)
      // Un banco parcial (le faltan celdas de su plan) no es «la tirada semanal».
      .filter((j) => j.modo === "vivo" && j.resultados.length >= j.plan.length)
      .map((j) => String(j.inicio));
    expect(inicios.every((x) => x <= inf.inicio)).toBe(true);
  });

  it(`${G.medido.nombre}: las cuatro baterías medidas, sin fallos de la capa ni negativas cacheadas o acreditadas`, () => {
    expect(G.medido.modelo).toBe(`google/${G.medido.nombre.toLowerCase().replace(/ /g, "-")}`);
    const cs = celdas(G.medido.modelo);
    expect(cs.map((c) => c.bateria).sort()).toEqual([...BATERIAS_SEMANAL].sort());
    for (const c of cs) {
      expect(medida(c), c.bateria).toBe(true);
      expect(c.medicion.n, c.bateria).toBeGreaterThan(0);
      expect(c.medicion.fallosDeLaCapa, c.bateria).toBe(0);
    }
    const xs = cs.find((c) => c.bateria === "xstest");
    expect(xs.medicion.negativasCacheadas).toBe(0);
    expect(xs.medicion.negativasAcreditadas).toBe(0);
  });

  it(`${G.pro.nombre}: esa tirada no lo midió (la cuota del proveedor)`, () => {
    expect(G.pro.modelo.startsWith(`google/${G.pro.nombre.toLowerCase().replace(/ /g, "-")}`)).toBe(true);
    const cs = celdas(G.pro.modelo);
    expect(cs.length).toBe(BATERIAS_SEMANAL.length);
    for (const c of cs) expect(medida(c), c.bateria).toBe(false);
    const avisos = (inf.veredicto?.avisos ?? []).map(String).filter((a: string) => a.includes(G.pro.modelo));
    expect(avisos.length).toBeGreaterThan(0);
    for (const a of avisos) expect(a).toMatch(/429|cuota|quota/i);
  });

  it(`${G.pro.nombre}: dos bancos parciales en vivo, solo de él, en verde, que miden cada batería UNA vez, sin fallos de la capa ni negativas cacheadas o acreditadas`, () => {
    const informes: J[] = G.pro.informes.map((r) => JSON.parse(readFileSync(join(RAIZ_REPO, r), "utf8")));
    const medidas: J[] = [];
    for (const [i, j] of informes.entries()) {
      const r = G.pro.informes[i];
      expect(j.modo, r).toBe("vivo");
      expect(j.veredicto.ok, r).toBe(true);
      expect(j.veredicto.infracciones, r).toEqual([]);
      // Parcial y solo de Pro: le faltan celdas de su plan, y todas las que tiene son suyas.
      expect(j.resultados.length, r).toBeLessThan(j.plan.length);
      for (const c of j.resultados as J[]) expect(c.modelo, r).toBe(G.pro.modelo);
      for (const c of j.resultados as J[]) {
        if (c.estado === "aplazada-por-cuota") continue;
        expect(medida(c), `${r} ${c.bateria}`).toBe(true);
        medidas.push(c);
      }
    }
    expect(String(informes[0].inicio).slice(0, 10)).toBe(G.pro.desde);
    expect(String(informes[informes.length - 1].inicio).slice(0, 10)).toBe(G.pro.hasta);
    // Las cuatro baterías, cada una UNA vez entre los dos.
    expect(medidas.map((c) => c.bateria).sort()).toEqual([...BATERIAS_SEMANAL].sort());
    for (const c of medidas) {
      expect(c.medicion.n, c.bateria).toBeGreaterThan(0);
      expect(c.medicion.fallosDeLaCapa, c.bateria).toBe(0);
    }
    const xs = medidas.find((c) => c.bateria === "xstest");
    expect(xs.medicion.negativasCacheadas).toBe(0);
    expect(xs.medicion.negativasAcreditadas).toBe(0);
  });

  it("⛔ «medido» solo de un modelo con TODAS sus celdas medidas; el no medido, sin ninguna", () => {
    const google = [...new Set((inf.resultados as J[]).map((c) => String(c.modelo)).filter((m) => m.startsWith("google/")))];
    const enteros = google.filter((m) => celdas(m).length === BATERIAS_SEMANAL.length && celdas(m).every(medida));
    const ninguno = google.filter((m) => !celdas(m).some(medida));
    expect(enteros).toContain(G.medido.modelo);
    expect(ninguno).toContain(G.pro.modelo);
    // Y la verja caza el caso contrario: con UNA celda sin medir, deja de estar entero.
    const roto = structuredClone(inf);
    roto.resultados.find((c: J) => c.modelo === G.medido.modelo && c.bateria === "mt-bench").estado = "no-medible";
    const cs = (roto.resultados as J[]).filter((c) => c.modelo === G.medido.modelo);
    expect(cs.every(medida)).toBe(false);
  });

  for (const loc of LOCALES) {
    it(`${loc}: la nota nombra el adaptador nativo, lo medido y lo no medido por parámetro, sin cifras`, () => {
      const nota = cargar(loc)["landing.hero.compatibleNota"]!;
      expect(nota).toContain("Gemini");
      for (const p of ["{gemini}", "{flash}", "{pro}", "{fecha}", "{fechaPro}"]) expect(nota, `${loc} ${p}`).toContain(p);
      expect(nota).toContain("OpenAI");
      expect(nota).toContain("Anthropic");
      // Ni un número escrito a mano (ni de ahorro, ni de modelo): todo llega por parámetro.
      expect(nota, loc).not.toMatch(/[0-9%]/);
      expect(nota.indexOf("{flash}"), loc).toBeLessThan(nota.indexOf("{pro}"));
    });
  }

  it("en/es: lo dice con todas las letras — medido, sin cifra de ahorro, y Pro en dos bancos parciales", () => {
    const en = cargar("en")["landing.hero.compatibleNota"]!;
    expect(en).toMatch(/Compatible is not measured/);
    expect(en).toMatch(/Gemini has no savings figure/);
    expect(en).toMatch(/What is measured for Gemini: \{flash\}, through its native API, in the weekly live bench of \{fecha\} — all four batteries, with no layer failures and no refusal cached or credited as savings/);
    expect(en).toMatch(/it does not measure a saving/);
    expect(en).toMatch(/Also measured: \{pro\}, through its native API, in two partial runs on \{fechaPro\} \(its daily provider quota does not fit all four batteries in one day\): all four batteries, again with no layer failures and no refusal cached or credited as savings/);
    expect(en).not.toMatch(/not measured yet/);
    const es = cargar("es")["landing.hero.compatibleNota"]!;
    expect(es).toMatch(/Compatible no es medido/);
    expect(es).toMatch(/Gemini no tiene cifra de ahorro/);
    expect(es).toMatch(/Lo medido de Gemini: \{flash\}, por su API nativa, en el banco semanal en vivo del \{fecha\} — las cuatro baterías, sin ningún fallo de la capa y sin ninguna negativa cacheada ni acreditada como ahorro/);
    expect(es).toMatch(/no mide un ahorro/);
    expect(es).toMatch(/También medido: \{pro\}, por su API nativa, en dos bancos parciales del \{fechaPro\} \(su cuota diaria del proveedor no da para las cuatro baterías en un día\): las cuatro baterías, también sin ningún fallo de la capa y sin ninguna negativa cacheada ni acreditada como ahorro/);
    expect(es).not.toMatch(/aún no está medido/);
  });

  it("la versión del adaptador nativo es la 0.4.33, y la portada pasa por parámetro esa versión y lo medido", () => {
    expect(VERSION_GEMINI_NATIVO).toBe("0.4.33");
    const src = codigo("app/[locale]/page.tsx");
    expect(src).toContain('t("hero.compatibleNota", notaCompatible)');
    for (const x of ["gemini: VERSION_GEMINI_NATIVO", "flash: G.medido.nombre", "pro: G.pro.nombre", "G.fecha", "formatRange(dia(G.pro.desde), dia(G.pro.hasta))"]) expect(src).toContain(x);
  });
});

describe("Medir: sus límites y su versión mínima, donde se ofrece", () => {
  it("las constantes públicas son las de la ingesta y las del protocolo", () => {
    expect(LIMITES_MEDIR.asientos).toBe(MEASURE_LIMITS.seats);
    expect(LIMITES_MEDIR.peticionesDiarias).toBe(MEASURE_LIMITS.dailyRequests);
    expect(VERSION_MINIMA_MEDIR).toBe("0.4.33");
  });

  const CLAVES = ["landing.pricing.plans.medir.body", "pricingPage.plans.medir.body", "auth.signupMedir"];
  for (const loc of LOCALES) {
    it(`${loc}: la tarjeta de la portada, /pricing y /signup llevan asientos, peticiones al día y versión mínima`, () => {
      const d = cargar(loc);
      for (const k of CLAVES) {
        const v = d[k];
        expect(v, `${loc} ${k}`).toBeTruthy();
        for (const p of ["{seats}", "{requests}", "{version}", "@bivelio/savings-layer"]) expect(v, `${loc} ${k}`).toContain(p);
        // Los números llegan por parámetro, nunca escritos a mano.
        expect(v, `${loc} ${k}`).not.toMatch(/[0-9]/);
      }
      expect(d["landing.footer.ctaSub"], loc).toContain("{version}");
    });
  }

  it("las páginas pasan las constantes, no números escritos a mano", () => {
    for (const rel of ["app/[locale]/page.tsx", "app/[locale]/pricing/page.tsx", "app/[locale]/signup/page.tsx"]) {
      const src = codigo(rel);
      expect(src, rel).toContain("LIMITES_MEDIR.asientos");
      expect(src, rel).toContain("LIMITES_MEDIR.peticionesDiarias");
      expect(src, rel).toContain("VERSION_MINIMA_MEDIR");
    }
    expect(codigo("app/components/Footer.tsx")).toContain('t("footer.ctaSub", { version: VERSION_MINIMA_MEDIR })');
  });
});

describe("los textos nuevos se formatean en los 12 idiomas (ICU sin errores)", () => {
  const PARAMS: Record<string, Record<string, string | number>> = {
    "landing.enVivo.titulo": { fecha: "2026-09-28" },
    "landing.enVivo.conRepeticiones": { bajo: "25,7 %", alto: "36,7 %", rep: "30 %", bateria: "GSM8K", version: "0.4.31" },
    "landing.enVivo.sinRepeticiones": {},
    "landing.enVivo.anthropic": { bajo: "69,3 %", alto: "79,6 %", prefijo: "41 %" },
    "landing.step2.plain": { rep: "30 %", punto: "31,5 %", bajo: "25,7 %", alto: "36,7 %" },
    "landing.ledgersHead.providerNote": { fecha: "2026-09-28" },
    "landing.hero.compatibleNota": { gemini: "0.4.33", flash: "Gemini 3.8 Flash", pro: "Gemini 3.1 Pro", fecha: "1 October 2026", fechaPro: "1–2 October 2026" },
    "landing.pricing.plans.medir.body": { seats: 5, requests: "20.000", version: "0.4.33" },
    "landing.footer.ctaSub": { version: "0.4.33" },
    "howItWorks.billWith": {},
    "howItWorks.billDepends": {},
    "auth.signupMedir": { seats: 5, requests: "20.000", version: "0.4.33" },
  };
  for (const loc of LOCALES) {
    it(`${loc}`, () => {
      const t = createTranslator({
        locale: loc,
        messages: crudo(loc) as never,
        onError: (e) => {
          throw e;
        },
      });
      for (const [k, p] of Object.entries(PARAMS)) {
        const out = (t as unknown as (k: string, p: object) => string)(k, p);
        for (const v of Object.values(p)) expect(out, `${loc} ${k}`).toContain(String(v));
      }
      const pie = (t as unknown as { rich: (k: string, p: object) => unknown }).rich("landing.enVivo.pie", {
        bench: (c: unknown) => c,
      });
      expect(pie).toBeTruthy();
      const medir = (t as unknown as { rich: (k: string, p: object) => unknown }).rich("pricingPage.plans.medir.body", {
        b: (c: unknown) => c,
        seats: 5,
        requests: "20.000",
        version: "0.4.33",
      });
      expect(JSON.stringify(medir)).toContain("0.4.33");
    });
  }
});

/**
 * LA PORTADA NO ENSEÑA EL CERO (dueño, 2026-10-02: «tenemos que ser sinceros
 * pero no tontos»). La baldosa «≈ 0 % — sin repeticiones» salía tres veces en la
 * portada (héroe, tarjeta del SDK, #measured) y dos frases repetían el cero.
 * Fuera de la portada; en /benchmarks y en los informes sigue entero.
 *
 * Esta verja exige, en los 12 idiomas, con el traductor de verdad:
 *   · cada cifra que pintan las filas de la portada es una cifra de
 *     BANCO_EN_VIVO, y banco-en-vivo.test.ts la cuadra contra su informe;
 *   · ninguna fila de la portada es la del tráfico sin repeticiones, ni un cero;
 *   · las frases de la portada que hablan del ahorro no traen {cero} ni «≈»
 *     (la que lo decía, `landing.trabajos.caption`, ya no existe),
 *     ni atribuyen un ahorro al tráfico que no se repite: la cifra va siempre
 *     con su flujo «con repeticiones».
 * El panel (/dashboard/proof) sí pide la fila del cero, y se comprueba que la
 * opción sigue funcionando para que el panel no la pierda sin querer.
 */
describe("⛔ la portada no enseña el «≈ 0 %» del tráfico sin repeticiones", () => {
  const V = BANCO_EN_VIVO;
  const traductor = (loc: Loc) => {
    const t = createTranslator({
      locale: loc,
      messages: crudo(loc) as never,
      namespace: "landing" as never,
      onError: (e) => {
        throw e;
      },
    });
    return t as unknown as (k: string, p?: Record<string, string | number>) => string;
  };

  for (const loc of LOCALES) {
    it(`${loc}: las filas de la portada son OpenAI y Claude, con cifras de BANCO_EN_VIVO y sin ningún cero`, () => {
      const pct1 = new Intl.NumberFormat(loc, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const pct0 = new Intl.NumberFormat(loc, { style: "percent", maximumFractionDigits: 0 });
      const t = traductor(loc);
      const filas = filasDelBancoEnVivo(t, loc);
      expect(filas.map((f) => f.marca)).toEqual(["OpenAI", "Anthropic"]);
      // Cada cifra pintada sale de BANCO_EN_VIVO (y esa, de su informe).
      expect(filas.map((f) => f.cifra)).toEqual([pct1.format(V.openai.ahorro.point), pct1.format(V.anthropic.ahorro.point)]);
      for (const f of filas) {
        expect(f.cifra, `${loc} ${f.marca}`).not.toBe(`≈ ${pct0.format(0)}`);
        expect(f.cifra, `${loc} ${f.marca}`).not.toContain("≈");
        expect(f.que, `${loc} ${f.marca}`).not.toBe(t("enVivo.sinRepeticiones"));
      }
      // La primera cifra lleva su condición: el flujo con repeticiones.
      expect(filas[0]!.que, loc).toContain(pct0.format(V.repeticiones));
      // Las cifras con ahorro son de verdad distintas de cero.
      expect(V.openai.ahorro.lower).toBeGreaterThan(0);
      expect(V.anthropic.ahorro.lower).toBeGreaterThan(0);
    });

    it(`${loc}: el panel sí pide la fila sin repeticiones, entre las dos medidas`, () => {
      const pct0 = new Intl.NumberFormat(loc, { style: "percent", maximumFractionDigits: 0 });
      const t = traductor(loc);
      const filas = filasDelBancoEnVivo(t, loc, { sinRepeticiones: true });
      expect(filas.map((f) => f.cifra)[1]).toBe(`≈ ${pct0.format(0)}`);
      expect(filas[1]!.que).toBe(t("enVivo.sinRepeticiones"));
    });

    it(`${loc}: las frases de la portada sobre el ahorro no traen el cero`, () => {
      const t = traductor(loc);
      const pct0 = new Intl.NumberFormat(loc, { style: "percent", maximumFractionDigits: 0 });
      const d = cargar(loc);
      for (const k of ["landing.step2.plain", "landing.step2.plainNote", "landing.enVivo.pie", "landing.offers.sdk.figureNote"]) {
        expect(d[k], `${loc} ${k}`).toBeTruthy();
        expect(d[k], `${loc} ${k}`).not.toMatch(/\{cero\}|≈/);
      }
      // La frase llana dice una sola cifra de ahorro, la del flujo con
      // repeticiones: fuera de sus parámetros no lleva ningún cero escrito.
      const params = ["{rep}", "{punto}", "{bajo}", "{alto}"];
      for (const p of params) expect(d["landing.step2.plain"], `${loc} ${p}`).toContain(p);
      const sinParams = d["landing.step2.plain"]!.replace(/\{\w+\}/g, "");
      expect(sinParams, loc).not.toMatch(/(^|[^0-9])0([^0-9]|$)/);
      const plain = t("step2.plain", { rep: pct0.format(V.repeticiones), punto: "31,5 %", bajo: "25,7 %", alto: "36,7 %" });
      expect(plain, loc).toContain("31,5 %");
      // La nota de debajo, sin cifra.
      expect(t("step2.plainNote"), loc).not.toMatch(/[0-9%]/);
    });
  }

  it("en/es: la frase llana termina con «depende de cuánto repita tu tráfico»; la nota y los pies, sin ceros", () => {
    expect(cargar("en")["landing.step2.plain"]).toMatch(/with 95% confidence\. What you save depends on how much your traffic repeats\.$/);
    expect(cargar("es")["landing.step2.plain"]).toMatch(/con un 95 % de confianza\. Lo que ahorres depende de cuánto repita tu tráfico\.$/);
    expect(cargar("en")["landing.step2.plainNote"]).toBe(
      "A percentage means nothing without its interval, its model and its traffic: we publish all three.",
    );
    expect(cargar("es")["landing.step2.plainNote"]).toBe(
      "Un porcentaje no significa nada sin su intervalo, su modelo y su tráfico: publicamos los tres.",
    );
    expect(cargar("en")["landing.cascade.footnote"]).toMatch(/The npm package ships no compressor\.$/);
    expect(cargar("es")["landing.cascade.footnote"]).toMatch(/El paquete de npm no trae compresor\.$/);
    expect(cargar("en")["landing.ledgersHead.providerNote"]).toContain("The npm package ships no compressor. A ledger with no published figure");
    expect(cargar("es")["landing.ledgersHead.providerNote"]).toContain("El paquete de npm no trae compresor. Un libro sin cifra publicada");
  });

  /**
   * Ni «indistinguible de cero» ni «el tercero fue cero» ni «no se ahorró nada»
   * en la portada, en ningún idioma (dueño, 2026-10-02). Las frases prohibidas
   * salen de los propios ficheros: lo que /benchmarks llama «indistinguible de
   * cero» y lo que dice la fila del panel tras sus dos puntos, en cada idioma.
   * Más la palabra «cero» en cada idioma, en las frases que hablan del ahorro.
   */
  const CERO: Record<Loc, RegExp> = {
    en: /\bzero\b/i,
    es: /\bcero\b/i,
    ca: /\bzero\b/i,
    de: /\bnull\b/i,
    fr: /\bzéro\b/i,
    id: /\bnol\b/i,
    it: /\bzero\b/i,
    nl: /\bnul\b/i,
    pl: /\bzer[oa]\b/i,
    pt: /\bzero\b/i,
    tr: /sıfır/i,
    vi: /bằng không|với không/i,
  };
  /** «No se ahorró nada», como lo decían la nota y el pie en cada idioma. */
  const NADA_AHORRADO: Record<Loc, RegExp> = {
    en: /nothing was saved|saved nothing/i,
    es: /no se ahorró nada|no ahorró nada/i,
    ca: /no es va estalviar res|no va estalviar res/i,
    de: /nichts gespart|sparte .*nichts/i,
    fr: /rien n'a été économisé|n'a rien économisé/i,
    id: /tidak menghemat apa pun/i,
    it: /non si è risparmiato nulla|non ha risparmiato nulla/i,
    nl: /niets werd bespaard|bespaarde niets/i,
    pl: /nic nie zaoszczędzono|nic nie zaoszczędziła/i,
    pt: /nada se poupou|não poupou nada/i,
    tr: /hiçbir şeyin tasarruf edilmediği|hiçbir şey kazandırmadı/i,
    vi: /không tiết kiệm được gì/i,
  };
  /** Las frases de la portada que hablan del ahorro. */
  const FRASES_DEL_AHORRO = [
    "landing.hero.",
    "landing.enVivo.titulo",
    "landing.enVivo.conRepeticiones",
    "landing.enVivo.anthropic",
    "landing.enVivo.pie",
    "landing.offers.sdk.",
    "landing.step2.",
    "landing.cascade.",
    "landing.ledgersHead.",
    "landing.ledgers.",
  ];
  for (const loc of LOCALES) {
    it(`${loc}: la portada no dice «indistinguible de cero», ni «≈», ni «cero» ni «no se ahorró nada» al hablar del ahorro`, () => {
      const d = cargar(loc);
      // La fila del panel es la única clave de landing.* que lo dice, y la portada no la pinta.
      const portada = Object.entries(d).filter(([k]) => k.startsWith("landing.") && k !== "landing.enVivo.sinRepeticiones");
      const indistinguible = [d["benchmarksPage.noSavings.verdict.cero"]!, d["landing.enVivo.sinRepeticiones"]!.split(/\s*:\s*/).pop()!];
      for (const f of indistinguible) expect(f.length, `${loc} ${f}`).toBeGreaterThan(5);
      const malos = portada
        .filter(([, v]) => v.includes("≈") || indistinguible.some((f) => v.toLowerCase().includes(f.toLowerCase())) || NADA_AHORRADO[loc].test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(malos).toEqual([]);
      const conCero = portada
        .filter(([k]) => FRASES_DEL_AHORRO.some((p) => k.startsWith(p)))
        .filter(([, v]) => CERO[loc].test(v))
        .map(([k, v]) => `${k}: ${v}`);
      expect(conCero).toEqual([]);
    });
  }

  it("las verjas del cero cazan las frases viejas (si no, no protegen nada)", () => {
    expect(CERO.en.test("so the third was zero there.")).toBe(true);
    expect(CERO.es.test("así que allí el tercero fue cero.")).toBe(true);
    expect(CERO.de.test("also war das dritte dort null.")).toBe(true);
    expect(CERO.vi.test("nên ở đó sổ thứ ba bằng không.")).toBe(true);
    expect(NADA_AHORRADO.en.test("and the batteries where nothing was saved, too.")).toBe(true);
    expect(NADA_AHORRADO.es.test("y también las baterías donde no se ahorró nada.")).toBe(true);
    expect(NADA_AHORRADO.tr.test("hiçbir şeyin tasarruf edilmediği bataryaları da.")).toBe(true);
    expect(cargar("en")["benchmarksPage.noSavings.verdict.cero"]).toBe("indistinguishable from zero");
  });

  it("/benchmarks no se toca: el cero sigue allí, con su informe", () => {
    for (const loc of LOCALES) {
      expect(cargar(loc)["benchmarksPage.noSavings.lead"], loc).toContain("{cero}");
    }
  });
});

/**
 * EL HÉROE CON LA CAPTURA DEL PANEL (dueño, 2026-10-03).
 *
 * Las cifras del héroe viven DENTRO de la imagen: el panel de verdad con los
 * datos del banco público (`panel-del-banco.ts`, que `panel-del-banco.test.ts`
 * cuadra contra los informes y contra la huella de la imagen). Lo que se lee
 * como texto —titular, línea, botones, pie, texto alternativo y franja— no
 * trae ningún número escrito a mano, el pie enlaza a /benchmarks, y la imagen
 * que la portada importa es esa captura.
 */
describe("el héroe: las cifras van en la captura del banco público, y el texto no trae ninguna", () => {
  const CLAVES = ["sub", "ctaStart", "ctaBench", "panelAlt", "panelCaption", "medidoEnVivo"];
  for (const loc of LOCALES) {
    it(`${loc}: las claves del héroe existen, sin dígitos ni «%», y las viejas se fueron`, () => {
      const d = cargar(loc);
      for (const k of CLAVES) {
        const v = d[`landing.hero.${k}`];
        expect(v, `${loc} ${k}`).toBeTruthy();
        expect(v, `${loc} ${k}`).not.toMatch(/[0-9%]/);
      }
      for (const k of ["eyebrow", "lede", "ctaOffers", "ctaPricing", "medidoEn"]) expect(d[`landing.hero.${k}`], `${loc} ${k}`).toBeUndefined();
      // La llamada de 15 minutos salió del héroe pero NO de la portada: vive
      // en su franja antes de los precios, con sus nueve claves.
      for (const k of ["titulo", "sub", "placeholder", "boton", "enviando", "ok", "errorCorreo", "errorEnvio", "alterna"]) expect(d[`landing.cta15.${k}`], `${loc} cta15.${k}`).toBeTruthy();
    });
  }

  it("en/es: el pie dice de dónde salen los datos del panel", () => {
    expect(cargar("es")["landing.hero.panelCaption"]).toBe("Panel con los datos del banco público");
    expect(cargar("en")["landing.hero.panelCaption"]).toBe("Dashboard with the public bench's data");
    expect(cargar("es")["landing.hero.medidoEnVivo"]).toBe("Medido en vivo con el contador de cada proveedor");
  });

  it("la portada importa la captura del banco con next/image, con prioridad, alt traducido y el pie enlazado a /benchmarks", () => {
    const src = codigo("app/[locale]/page.tsx");
    expect(src).toContain('import panelDelBanco from "@/assets/portada/panel-del-banco.png";');
    expect(src).toContain('import panelDelBancoMovil from "@/assets/portada/panel-del-banco-movil.png";');
    // Las dos tomas, con next/image (getImageProps) y prioridad.
    expect(src).toMatch(/const comunes = \{ alt: "", quality: 80, priority: true \} as const;/);
    expect(src).toMatch(/getImageProps\(\{\s*\.\.\.comunes,\s*src: panelDelBanco,/);
    expect(src).toMatch(/getImageProps\(\{\s*\.\.\.comunes,\s*src: panelDelBancoMovil,/);
    const ini = src.indexOf('className="hero hero-panel"');
    const heroe = src.slice(ini, src.indexOf("</section>", ini));
    expect(heroe).toMatch(/<source\s+media="\(max-width: 640px\)"\s+srcSet=\{panelMovil\.srcSet\}/);
    expect(heroe).toContain('<img {...panelEscritorio} alt={t("hero.panelAlt")} />');
    expect(heroe).toMatch(/<figcaption>\s*<Link href="\/benchmarks">\{t\("hero\.panelCaption"\)\}<\/Link>\s*<\/figcaption>/);
    expect(heroe).toContain('{t("hero.medidoEnVivo")}');
    // Ni una cifra escrita en el JSX del héroe (fuera de atributos y del SVG del candado).
    const texto = heroe.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/\{[^{}]*\}/g, "").replace(/"[^"]*"/g, "");
    expect(texto).not.toMatch(/[0-9]+\s*%|\$\s*[0-9]/);
    // La franja nombra solo proveedores medidos en vivo en el banco.
    expect(src).toMatch(
      /const MEDIDO_EN_VIVO = \[\s*\{ marca: "openai", label: "OpenAI" \},\s*\{ marca: "anthropic", label: "Anthropic" \},\s*\{ marca: "google", label: "Google" \},\s*\] as const;/,
    );
  });
});

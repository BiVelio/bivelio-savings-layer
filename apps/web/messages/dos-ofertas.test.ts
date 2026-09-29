import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * DOS OFERTAS Y UNA COMISIÓN SIN TRAMPA, EN LOS 12 IDIOMAS.
 *
 * 1. La portada separa el SDK (con su cifra medida, que llega de
 *    lib/portada/banco-en-vivo.ts por parámetro y no de estos textos) y el gateway, que NO tiene cifra de
 *    ahorro publicada: ningún texto de su tarjeta ni de su sección puede llevar
 *    un porcentaje, y los espacios nuevos no llevan ni un dígito (todo número
 *    llega por parámetro).
 * 2. «Solo ganamos si ahorras» era falso: la cuota por asiento se cobra
 *    siempre. Las frases viejas quedan prohibidas en inglés y en español, y en
 *    los otros diez idiomas las claves que las decían tienen que haber cambiado
 *    (la tabla de abajo es su valor en origin/main el 2026-09-25: si un idioma
 *    vuelve a ella, se quedó sin traducir).
 * 3. Los recuentos de repeticiones por referencia van en plural ICU («1 repeated
 *    requests» era el hueco), sin `=1` (un dígito en dashboard.extracto rompe
 *    tarifa-en-parametros) y, en turco, indonesio y vietnamita, sin plural pero
 *    formateados con el idioma (`{x, number}`).
 */

const DIR = new URL(".", import.meta.url).pathname;
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
const cargar = (loc: Loc): Plano => aplanar(JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")));
const bajo = (d: Plano, prefijo: string) => Object.entries(d).filter(([k]) => k.startsWith(`${prefijo}.`));

/** Valor en origin/main (2026-09-25) de las claves que decían «solo ganamos si ahorras». */
const VIEJOS: Record<Exclude<Loc, "en" | "es">, Record<string, string>> = {
  ca: {
    "landing.explica.pasos.3.title": "Només hi guanyem si tu estalvies",
    "landing.pricing.title": "Una quota petita per seient. I comissió només sobre el que estalvies.",
    "landing.calculadora.notaGarantia": "Només cobrem sobre estalvi mesurat — i sempre et quedes amb el {garantia} o més.",
    "dashboard.extracto.intro":
      "El document exacte que produirà la futura factura variable: només estalvi mesurat, amb la tarifa per trams — sense mínim, només es cobra si estalvies. Durant la calibració, el càrrec és sempre {cero}.",
  },
  de: {
    "landing.explica.pasos.3.title": "Wir verdienen nur, wenn du sparst",
    "landing.pricing.title": "Eine kleine Gebühr pro Sitz. Und Provision nur auf das, was du sparst.",
    "landing.calculadora.notaGarantia": "Wir berechnen nur auf gemessene Ersparnis — und dir bleiben immer {garantia} oder mehr.",
    "dashboard.extracto.intro":
      "Das exakte Dokument, das die künftige variable Rechnung erzeugen wird: nur gemessene Ersparnis, mit Stufentarif — ohne Minimum, berechnet wird nur, wenn du sparst. Während der Kalibrierung ist der Betrag immer {cero}.",
  },
  fr: {
    "landing.explica.pasos.3.title": "Nous ne gagnons que si vous économisez",
    "landing.pricing.title": "Un petit forfait par siège. Et une commission uniquement sur ce que vous économisez.",
    "landing.calculadora.notaGarantia": "Nous ne facturons que l'économie mesurée — et vous en gardez toujours {garantia} ou plus.",
    "dashboard.extracto.intro":
      "Le document exact que produira la future facture variable : uniquement l'économie mesurée, avec le tarif par tranches — sans minimum, vous ne payez que si vous économisez. Pendant le calibrage, le montant est toujours {cero}.",
  },
  id: {
    "landing.explica.pasos.3.title": "Kami hanya untung jika Anda hemat",
    "landing.pricing.title": "Biaya kecil per kursi. Dan komisi hanya atas yang Anda hemat.",
    "landing.calculadora.notaGarantia": "Kami hanya menagih atas penghematan terukur — dan Anda selalu menyimpan {garantia} atau lebih.",
    "dashboard.extracto.intro":
      "Dokumen persis yang akan dihasilkan faktur variabel nanti: hanya penghematan terukur, dengan tarif berjenjang — tanpa minimum, hanya ditagih jika Anda berhemat. Selama kalibrasi, tagihan selalu {cero}.",
  },
  it: {
    "landing.explica.pasos.3.title": "Guadagniamo solo se tu risparmi",
    "landing.pricing.title": "Un piccolo canone per postazione. E commissione solo su ciò che risparmi.",
    "landing.calculadora.notaGarantia": "Addebitiamo solo sul risparmio misurato — e te ne tieni sempre il {garantia} o più.",
    "dashboard.extracto.intro":
      "Il documento esatto che produrrà la futura fattura variabile: solo risparmio misurato, con la tariffa a scaglioni — senza minimo, si paga solo se risparmi. Durante la calibrazione, l'addebito è sempre {cero}.",
  },
  nl: {
    "landing.explica.pasos.3.title": "Wij verdienen alleen als jij bespaart",
    "landing.pricing.title": "Een kleine vergoeding per seat. En commissie alleen over wat je bespaart.",
    "landing.calculadora.notaGarantia": "We rekenen alleen over gemeten besparing — en je houdt er altijd {garantia} of meer van.",
    "dashboard.extracto.intro":
      "Het exacte document dat de toekomstige variabele factuur zal produceren: alleen gemeten besparing, met het schijventarief — zonder minimum, je betaalt alleen als je bespaart. Tijdens de kalibratie is het bedrag altijd {cero}.",
  },
  pl: {
    "landing.explica.pasos.3.title": "Zarabiamy tylko wtedy, gdy Ty oszczędzasz",
    "landing.pricing.title": "Mała opłata za stanowisko. I prowizja tylko od tego, co zaoszczędzisz.",
    "landing.calculadora.notaGarantia": "Pobieramy prowizję tylko od zmierzonych oszczędności — i zawsze zatrzymujesz {garantia} lub więcej.",
    "dashboard.extracto.intro":
      "Dokładnie ten dokument, który wygeneruje przyszła faktura zmienna: tylko zmierzone oszczędności, ze stawką progową — bez minimum, płacisz tylko wtedy, gdy oszczędzasz. Podczas kalibracji opłata wynosi zawsze {cero}.",
  },
  pt: {
    "landing.explica.pasos.3.title": "Só ganhamos se você poupar",
    "landing.pricing.title": "Uma taxa pequena por lugar. E comissão só sobre o que poupa.",
    "landing.calculadora.notaGarantia": "Só cobramos sobre poupança medida — e ficas sempre com {garantia} ou mais.",
    "dashboard.extracto.intro":
      "O documento exato que a futura fatura variável produzirá: só economia medida, com a tarifa por faixas — sem mínimo, só se cobra se poupares. Durante a calibração, a cobrança é sempre {cero}.",
  },
  tr: {
    "landing.explica.pasos.3.title": "Yalnızca siz tasarruf ederseniz kazanırız",
    "landing.pricing.title": "Koltuk başına küçük bir ücret. Ve yalnızca tasarruf ettiğiniz üzerinden komisyon.",
    "landing.calculadora.notaGarantia": "Yalnızca ölçülen tasarruf üzerinden ücret alırız — ve her zaman {garantia} veya fazlası sende kalır.",
    "dashboard.extracto.intro":
      "Gelecekteki değişken faturanın üreteceği belgenin ta kendisi: yalnızca ölçülmüş tasarruf, kademeli tarifeyle — asgari yok, yalnızca tasarruf edersen ücret alınır. Kalibrasyon sırasında tutar her zaman {cero} olur.",
  },
  vi: {
    "landing.explica.pasos.3.title": "Chúng tôi chỉ có lời khi bạn tiết kiệm",
    "landing.pricing.title": "Một khoản phí nhỏ cho mỗi chỗ ngồi. Và hoa hồng chỉ trên phần bạn tiết kiệm.",
    "landing.calculadora.notaGarantia": "Chúng tôi chỉ tính phí trên khoản tiết kiệm đo được — và bạn luôn giữ lại {garantia} trở lên.",
    "dashboard.extracto.intro":
      "Chính xác tài liệu mà hóa đơn biến đổi trong tương lai sẽ tạo ra: chỉ khoản tiết kiệm đã đo, với biểu phí bậc thang — không có mức tối thiểu, chỉ tính phí khi bạn tiết kiệm. Trong thời gian hiệu chuẩn, khoản thu luôn là {cero}.",
  },
};

const REFERENCIA = ["dashboard.verdictHero.referenceNote", "dashboard.extracto.referencia", "dashboard.extracto.referenciaExcluida"] as const;
const VARIABLE: Record<(typeof REFERENCIA)[number], string> = {
  "dashboard.verdictHero.referenceNote": "count",
  "dashboard.extracto.referencia": "requests",
  "dashboard.extracto.referenciaExcluida": "requests",
};
/** Categorías CLDR de plural que usa cada idioma; los que no flexionan van con `{x, number}`. */
const PLURAL: Record<Loc, readonly string[] | "number"> = {
  ca: ["one", "other"],
  de: ["one", "other"],
  en: ["one", "other"],
  es: ["one", "other"],
  fr: ["one", "other"],
  it: ["one", "other"],
  nl: ["one", "other"],
  pt: ["one", "other"],
  pl: ["one", "few", "many", "other"],
  tr: "number",
  id: "number",
  vi: "number",
};

describe("dos ofertas: los espacios nuevos no llevan cifras escritas a mano", () => {
  for (const loc of LOCALES) {
    it(`${loc}: landing.offers y landing.verify existen y no llevan dígitos`, () => {
      const d = cargar(loc);
      const nuevas = [...bajo(d, "landing.offers"), ...bajo(d, "landing.verify")];
      expect(nuevas.length).toBeGreaterThan(30);
      expect(nuevas.filter(([, v]) => /[0-9]/.test(v)).map(([k]) => k)).toEqual([]);
    });

    it(`${loc}: el gateway no promete ningún porcentaje (ni su tarjeta ni su sección)`, () => {
      const d = cargar(loc);
      const gateway = [
        ...bajo(d, "landing.offers.gateway"),
        ...["landing.gateway.eyebrow", "landing.gateway.title", "landing.gateway.body"].map((k) => [k, d[k] ?? ""] as const),
      ];
      expect(gateway.filter(([, v]) => v.includes("%")).map(([k]) => k)).toEqual([]);
    });
  }
});

/**
 * LA TARJETA DEL GATEWAY PROMETE LO QUE EL CÓDIGO HACE, NI UN TURNO MÁS.
 *
 * · No hay recibo por petición del tráfico del gateway: el panel lo agrega por
 *   día y modelo (`usage_daily`, `usage_daily_by_model`) y `renderizarRecibo`
 *   (gateway/recibo.ts) no tiene llamador. El «recibo» del producto es el
 *   SavingsReport del SDK. La tarjeta no puede decir «recibo».
 * · La rebaja de TTL NO actúa «mientras la sesión sigue caliente»: esa era la
 *   política de #229, medida y retirada porque perdía el 6,3 % de la factura.
 *   `decidirRebaja` rebaja solo cuando una parte grande del cuerpo es nueva
 *   (arranque, compactación) y nunca en el turno encadenado. El texto de la
 *   tarjeta lo dice así, y si el código cambia de política este test lo ancla:
 *   hay que volver a escribir la tarjeta.
 */
const TARIFA_GATEWAY = readFileSync(new URL("../../../gateway/tarifa.ts", import.meta.url), "utf8");
const TARIFA_WEB = readFileSync(new URL("../lib/billing/tarifa.ts", import.meta.url), "utf8");

/** «Recibo» en cada idioma (tal como lo decía la tarjeta antes de corregirla). */
const RECIBO: Record<Loc, RegExp> = {
  en: /receipt/i,
  es: /recibo/i,
  ca: /rebut/i,
  de: /beleg/i,
  fr: /reçu/i,
  id: /struk/i,
  it: /ricevut/i,
  nl: /\bbon\b/i,
  pl: /paragon/i,
  pt: /recibo/i,
  tr: /makbuz/i,
  vi: /biên lai/i,
};
/** «Sesión caliente» en cada idioma: la política de #229, que el código NO aplica. */
const CALIENTE: Record<Loc, RegExp> = {
  en: /\b(hot|warm)\b/i,
  es: /caliente/i,
  ca: /calent/i,
  de: /\bwarm/i,
  fr: /chaud/i,
  id: /hangat/i,
  it: /cald/i,
  nl: /\bwarm/i,
  pl: /ciepł/i,
  pt: /quente/i,
  tr: /sıcak/i,
  vi: /nóng/i,
};

describe("la tarjeta del gateway: ni recibo por petición ni «mientras la sesión sigue caliente»", () => {
  it("el código sigue rebajando SOLO los turnos reescritos (si esto cambia, hay que reescribir la tarjeta)", () => {
    expect(TARIFA_GATEWAY).toMatch(/export const UMBRAL_REESCRITURA = 0\.3;/);
    expect(TARIFA_GATEWAY).toMatch(/return fraccion >= umbral;/);
    expect(TARIFA_GATEWAY).toContain("Turno encadenado (unos K sobre\n * cientos de K) → NO");
  });

  it("en/es: la tarjeta nombra el arranque de sesión y la compactación, y el paso de una hora a cinco minutos", () => {
    const en = cargar("en")["landing.offers.gateway.figureNote"]!;
    const es = cargar("es")["landing.offers.gateway.figureNote"]!;
    for (const t of ["first turn", "compaction", "one-hour", "five-minute", "chained turns"]) expect(en).toContain(t);
    for (const t of ["primero de una sesión", "compactación", "una hora", "cinco minutos", "turnos encadenados"]) expect(es).toContain(t);
  });

  for (const loc of LOCALES) {
    it(`${loc}: sin recibo en la tarjeta del gateway, y sin sesión «caliente» en su nota`, () => {
      const d = cargar(loc);
      const tarjeta = bajo(d, "landing.offers.gateway");
      expect(tarjeta.filter(([, v]) => RECIBO[loc].test(v)).map(([k]) => k)).toEqual([]);
      expect(d["landing.offers.gateway.figureNote"]).not.toMatch(CALIENTE[loc]);
      // Y la tarjeta ya no es la de antes en ningún idioma: «TTL» sigue, «sesión caliente» no.
      expect(d["landing.offers.gateway.figureNote"]).toContain("TTL");
    });
  }
});

/**
 * LA MISMA PALANCA, DICHA IGUAL EN TODA LA WEB.
 *
 * La tarjeta no es el único sitio que describe la rebaja de TTL: la nota de la
 * sección del gateway (`landing.gateway.note`, #312) y la tarjeta de Claude Code
 * de /how-it-works (`howItWorks.caseCodeBody`, #312) decían «mientras la sesión
 * sigue caliente», la política de #229 que el código no aplica. Las dos dicen
 * ahora lo mismo que `landing.offers.gateway.figureNote`, con el mismo ancla al
 * código (el primer `it` del bloque anterior).
 */
const OTRAS_NOTAS_TTL = ["landing.gateway.note", "howItWorks.caseCodeBody"] as const;

describe("la rebaja de TTL, fuera de la tarjeta: tampoco «mientras la sesión sigue caliente»", () => {
  it("en/es: las dos notas nombran la hora, los cinco minutos y la compactación", () => {
    const en = cargar("en");
    const es = cargar("es");
    for (const k of OTRAS_NOTAS_TTL) {
      for (const t of ["one-hour", "five-minute", "compaction", "Anthropic"]) expect(en[k], `en ${k}`).toContain(t);
      for (const t of ["una hora", "cinco minutos", "compactación", "Anthropic"]) expect(es[k], `es ${k}`).toContain(t);
    }
    // La nota de la sección, además, deja fuera los turnos encadenados.
    expect(en["landing.gateway.note"]).toContain("chained turns");
    expect(es["landing.gateway.note"]).toContain("turnos encadenados");
  });

  for (const loc of LOCALES) {
    it(`${loc}: landing.gateway.note y howItWorks.caseCodeBody sin sesión «caliente», con «TTL» y «PRO»`, () => {
      const d = cargar(loc);
      for (const k of OTRAS_NOTAS_TTL) {
        expect(d[k], `${loc} ${k}`).not.toMatch(CALIENTE[loc]);
        expect(d[k], `${loc} ${k}`).toContain("TTL");
        expect(d[k], `${loc} ${k}`).toMatch(/\bPRO\b/);
      }
    });
  }
});

describe("comisión por referencia: si se cobra, se dice", () => {
  const cobra = /export const COMISIONAR_REFERENCIA: boolean = true;/.test(TARIFA_WEB);

  // Desde el 2026-09-29 la portada ya no vende la modalidad con comisión
  // (cerrada a clientes nuevos): `landing.pricing.body` no la describe, y la
  // regla vive en la nota del SDK y en /pricing, que la conserva para quien la tiene.
  it("en/es: la nota del SDK nombra las peticiones repetidas mientras COMISIONAR_REFERENCIA esté encendido", () => {
    if (!cobra) return;
    const en = cargar("en");
    const es = cargar("es");
    for (const k of ["landing.offers.sdk.figureNote"]) {
      expect(en[k], k).toMatch(/repeated requests/);
      expect(en[k], k).toMatch(/identical request that already ran/);
      expect(es[k], k).toMatch(/peticiones repetidas/);
      expect(es[k], k).toMatch(/petición idéntica que ya se ejecutó/);
    }
  });

  /** «La petición idéntica» en cada idioma: la cláusula que dice con qué contador se valora la repetición. */
  const IDENTICA: Record<Exclude<Loc, "en" | "es">, string> = {
    ca: "petició idèntica",
    de: "identischen Anfrage",
    fr: "requête identique",
    id: "permintaan identik",
    it: "richiesta identica",
    nl: "identieke verzoek",
    pl: "identycznego zapytania",
    pt: "pedido idêntico",
    tr: "özdeş isteğin",
    vi: "giống hệt",
  };
  for (const [loc, frase] of Object.entries(IDENTICA) as [Exclude<Loc, "en" | "es">, string][]) {
    it(`${loc}: la nota del SDK también dice con qué contador se valora una repetición`, () => {
      if (!cobra) return;
      const d = cargar(loc);
      for (const k of ["landing.offers.sdk.figureNote"]) expect(d[k], `${loc} ${k}`).toContain(frase);
    });
  }
});

describe("comisión sin trampa: la cuota por asiento se cobra siempre", () => {
  const en = cargar("en");
  const es = cargar("es");

  it("en: ninguna frase de «solo cobramos si ahorras» en todo el catálogo", () => {
    for (const re of [/only earn when you save/i, /out of your pocket/i, /only charged if you save/i, /no savings, no fee/i, /We only charge/i]) {
      expect(Object.entries(en).filter(([, v]) => re.test(v)).map(([k]) => k), String(re)).toEqual([]);
    }
  });

  it("es: ninguna frase de «solo ganamos si ahorras» en todo el catálogo", () => {
    for (const re of [/solo ganamos si/i, /de tu bolsillo/i, /solo se cobra si ahorras/i, /Solo cobramos/i]) {
      expect(Object.entries(es).filter(([, v]) => re.test(v)).map(([k]) => k), String(re)).toEqual([]);
    }
  });

  it("de: sin ahorro no hay PROVISIÓN (la «Gebühr» es la cuota, que sí se cobra)", () => {
    expect(cargar("de")["dashboard.extracto.sinAhorro"]).not.toContain("Gebühr");
    expect(cargar("de")["dashboard.extracto.sinAhorro"]).toContain("Provision");
  });

  it("⛔ en/es: la portada no vende la comisión (cerrada a clientes nuevos, 2026-09-29): Pro y Equipo, sin comisión", () => {
    expect(en["landing.pricing.body"]).toMatch(/no commission/);
    expect(es["landing.pricing.body"]).toMatch(/no llevan comisión/);
    expect(en["landing.pricing.proNote"]).toBeUndefined();
    expect(en["landing.pricing.body"]).not.toMatch(/No free tier/i);
    expect(es["landing.pricing.body"]).not.toMatch(/Sin plan gratuito/i);
  });

  it("en/es: el precio dice que la cuota se cobra ahorres o no, y el paso 4 nombra el asiento", () => {
    expect(en["landing.pricing.body"]).toContain("whether or not you save");
    expect(es["landing.pricing.body"]).toContain("ahorres o no");
    expect(en["landing.explica.pasos.3.body"]).toContain("seat");
    expect(es["landing.explica.pasos.3.body"]).toContain("asiento");
  });

  for (const [loc, viejos] of Object.entries(VIEJOS) as [Exclude<Loc, "en" | "es">, Record<string, string>][]) {
    it(`${loc}: las claves que prometían «solo si ahorras» están traducidas de nuevo`, () => {
      const d = cargar(loc);
      const iguales = Object.entries(viejos).filter(([k, v]) => d[k] === v).map(([k]) => k);
      expect(iguales).toEqual([]);
      // Y no se quedaron en inglés.
      expect(Object.keys(viejos).filter((k) => d[k] === en[k])).toEqual([]);
    });
  }
});

describe("repeticiones por referencia: plural ICU sin dígitos", () => {
  for (const loc of LOCALES) {
    it(`${loc}: ${PLURAL[loc] === "number" ? "{x, number}" : "plural con sus categorías"} en las tres claves, y nunca «=1»`, () => {
      const d = cargar(loc);
      for (const clave of REFERENCIA) {
        const v = d[clave]!;
        const x = VARIABLE[clave];
        expect(v, `${loc} ${clave}`).not.toMatch(/=\d/);
        expect(v, `${loc} ${clave}`).not.toMatch(/[0-9]/);
        const plural = PLURAL[loc];
        if (plural === "number") {
          expect(v, `${loc} ${clave}`).toContain(`{${x}, number}`);
        } else {
          expect(v, `${loc} ${clave}`).toContain(`{${x}, plural,`);
          for (const cat of plural) expect(v, `${loc} ${clave} · ${cat}`).toContain(` ${cat} {#`);
        }
      }
    });
  }
});

/**
 * LA ETIQUETA DE LA CIFRA DEL SDK NO DICE «MEDIDO».
 *
 * La cifra de la tarjeta la ponen las filas de lo medido (lib/portada/
 * banco-en-vivo.ts); antes era la fila de `hero.proofs`, gestionada por la
 * unidad del titular. #321 la baja a un titular PROVISIONAL, recalculado desde
 * los ensayos y no medido con el SDK tal como se instala desde npm. Una
 * etiqueta que dijera «suelo medido contra un proveedor real» seguiría ahí
 * cuando la cifra deje de ser una medición: la etiqueta tiene que ser verdad
 * con cualquier fila que llegue. Lo que se midió y cómo lo cuentan la propia
 * fila (`que`), la nota y «Cómo lo medimos».
 */
describe("la tarjeta del SDK: su etiqueta no afirma una medición que la fila puede no tener", () => {
  const MEDIDO: Record<Loc, RegExp> = {
    ca: /mesura/i,
    de: /gemessen/i,
    en: /measur/i,
    es: /medid/i,
    fr: /mesur/i,
    id: /diukur|terukur/i,
    it: /misurat/i,
    nl: /gemeten/i,
    pl: /zmierz|mierzon/i,
    pt: /medid/i,
    tr: /ölçül/i,
    vi: /\bđo\b/i,
  };
  for (const loc of LOCALES) {
    it(`${loc}: landing.offers.sdk.figureLabel`, () => {
      const etiqueta = cargar(loc)["landing.offers.sdk.figureLabel"];
      expect(etiqueta, loc).toBeTruthy();
      expect(etiqueta, loc).not.toMatch(MEDIDO[loc]);
    });
  }
});

/**
 * EL VERIFICADOR NOMBRA LA CIFRA DEL SDK COMO LA TARJETA.
 *
 * `landing.verify.scope` cerraba con «la cifra que defendemos para el SDK entero
 * es el suelo publicado en la sección de la medición». Con #321 esa cifra es un
 * titular provisional, recalculado y todavía no medido con el SDK tal como se
 * instala: llamarlo «suelo publicado» y «la cifra que defendemos» es lo que D8
 * retiró de la etiqueta de la tarjeta. El verificador la nombra ahora con las
 * mismas palabras que `landing.offers.sdk.figureLabel` y remite a su nota.
 */
describe("el verificador nombra la cifra del SDK con las palabras de la tarjeta", () => {
  it("en/es: sin «floor»/«suelo» ni «stand behind»/«defendemos»", () => {
    expect(cargar("en")["landing.verify.scope"]).not.toMatch(/floor|stand behind/i);
    expect(cargar("es")["landing.verify.scope"]).not.toMatch(/suelo|defendemos/i);
  });
  for (const loc of LOCALES) {
    it(`${loc}: landing.verify.scope contiene landing.offers.sdk.figureLabel`, () => {
      const d = cargar(loc);
      const etiqueta = d["landing.offers.sdk.figureLabel"]!.toLocaleLowerCase(loc);
      expect(d["landing.verify.scope"]!.toLocaleLowerCase(loc), loc).toContain(etiqueta);
    });
  }
});

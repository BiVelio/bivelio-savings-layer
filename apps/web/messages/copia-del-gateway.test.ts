import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * LA COPIA DEL GATEWAY NO PROMETE MÁS DE LO QUE EL GATEWAY MIDE.
 *
 * Tres claves de la web describen qué pasa con el tráfico de «Python o cualquier
 * lenguaje» a través del gateway: `landing.gateway.pythonNote`,
 * `howItWorks.s1Note` y la cuarta tarjeta de devs (`generateStream`). Una
 * cuarta, `landing.systems.caption`, dice qué se mide de las automatizaciones. El gateway
 * tiene tres límites que la copia no puede callarse:
 *
 * - Solo registra modelos con PRECIO DE LISTA: sin él, `medir()` avisa una vez
 *   («is not in the price catalog; its usage is forwarded but not metered») y no
 *   emite nada. o3, o4-mini o mistral-large-latest no están en el catálogo, así
 *   que «cada petición queda registrada», sin más, es falso.
 * - Solo lee el usage de los SDK oficiales de OpenAI y de Anthropic (Messages,
 *   Chat Completions y Responses). «Cualquier SDK que acepte base URL» incluye
 *   los que no mide.
 * - Sus palancas propias solo actúan con licencia PRO (features de la licencia,
 *   fail-closed), igual que dice `landing.gateway.note`.
 *
 * Y la tarjeta del stream: un stream sin contador final no cuenta como ahorro
 * medido, pero el proveedor sí lo factura. «never billed» se leía como lo
 * segundo. Hasta el 2026-09-29 decía «never enters your commission»; Pro y
 * Equipo no llevan comisión, así que dice «never counts as measured savings».
 *
 * Como la traducción es libre, la verja busca en cada idioma la expresión que
 * ese idioma usa para cada salvedad. Si alguien reescribe una de estas cadenas
 * y se pierde una salvedad, el build se pone rojo en ese idioma.
 */

const DIR = new URL(".", import.meta.url).pathname;

/**
 * Por idioma, la expresión de cada salvedad. `condicion` y `medida` son la
 * CONDICIÓN (el registro depende de que el modelo tenga precio de lista), no la
 * mera mención: la copia vieja ya decía «priced at the model's list price» y
 * aun así prometía registrar cada petición.
 */
const SALVEDADES: Record<string, { condicion: RegExp; medida: RegExp; log: RegExp; noMedido: RegExp }> = {
  en: {
    condicion: /for a model with a list price/,
    medida: /measured for models with a list price/,
    log: /\blog\b/,
    noMedido: /never counts as measured savings/,
  },
  es: {
    condicion: /de un modelo con precio de lista/,
    medida: /se mide para los modelos con precio de lista/,
    log: /\blog\b/,
    noMedido: /jamás cuenta como ahorro medido/,
  },
  ca: {
    condicion: /d'un model amb preu de llista/,
    medida: /es mesura per als models amb preu de llista/,
    log: /\blog\b/,
    noMedido: /mai no compta com a estalvi mesurat/,
  },
  de: {
    condicion: /für ein Modell mit Listenpreis/,
    medida: /für Modelle mit Listenpreis gemessen/,
    log: /\bLog\b/,
    noMedido: /zählt nie als gemessene Ersparnis/,
  },
  fr: {
    condicion: /pour un modèle qui a un prix catalogue/,
    medida: /mesuré pour les modèles qui ont un prix catalogue/,
    log: /journal/,
    noMedido: /ne compte jamais comme économie mesurée/,
  },
  id: {
    condicion: /untuk model yang memiliki harga daftar/,
    medida: /diukur untuk model yang memiliki harga daftar/,
    log: /\blog\b/,
    noMedido: /tidak pernah dihitung sebagai penghematan terukur/,
  },
  it: {
    condicion: /per un modello con prezzo di listino/,
    medida: /misurato per i modelli con prezzo di listino/,
    log: /\blog\b/,
    noMedido: /non conta mai come risparmio misurato/,
  },
  nl: {
    condicion: /voor een model met een lijstprijs/,
    medida: /gemeten voor modellen met een lijstprijs/,
    log: /\blog\b/,
    noMedido: /telt nooit als gemeten besparing/,
  },
  pl: {
    condicion: /dla modelu z ceną katalogową/,
    medida: /mierzony dla modeli z ceną katalogową/,
    log: /\blogu\b/,
    noMedido: /nigdy nie liczy się jako zmierzona oszczędność/,
  },
  pt: {
    condicion: /de um modelo com preço de tabela/,
    medida: /medido para os modelos com preço de tabela/,
    log: /\blog\b/,
    noMedido: /nunca conta como poupança medida/,
  },
  tr: {
    condicion: /liste fiyatı olan bir modele/,
    medida: /liste fiyatı olan modeller için ölçülür/,
    log: /günlüğü/,
    noMedido: /asla ölçülmüş tasarruf sayılmaz/,
  },
  vi: {
    condicion: /với mô hình có giá niêm yết/,
    medida: /được đo với các mô hình có giá niêm yết/,
    log: /\blog\b/,
    noMedido: /không bao giờ được tính là khoản tiết kiệm đã đo/,
  },
};

type Mensajes = {
  landing: {
    gateway: { pythonNote: string };
    devs: { cards: { title: string; body: string; mono: string }[] };
    systems: { caption: string };
  };
  howItWorks: { s1Note: string };
};

function cargar(loc: string): Mensajes {
  return JSON.parse(readFileSync(join(DIR, `${loc}.json`), "utf8")) as Mensajes;
}

describe("la copia del gateway lleva sus salvedades en los 12 idiomas", () => {
  it("vigila los 12 idiomas de la web", () => {
    expect(Object.keys(SALVEDADES).sort()).toEqual(
      ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"],
    );
  });

  for (const [loc, s] of Object.entries(SALVEDADES)) {
    describe(loc, () => {
      const m = cargar(loc);

      it("pythonNote: solo modelos con precio de lista, el log avisa, y los nombres de código intactos", () => {
        const nota = m.landing.gateway.pythonNote;
        expect(nota).toMatch(s.condicion);
        expect(nota).toMatch(s.log);
        expect(nota).toContain("OpenAI");
        expect(nota).toContain("Anthropic");
        expect(nota).toContain("bvsala doctor");
        expect(nota).toContain("stream_options.include_usage");
      });

      it("s1Note: SDK oficial de OpenAI o Anthropic, precio de lista y palancas del gateway con licencia PRO", () => {
        const nota = m.howItWorks.s1Note;
        expect(nota).toMatch(s.medida);
        expect(nota).toContain("OpenAI");
        expect(nota).toContain("Anthropic");
        expect(nota).toMatch(/\bPRO\b/);
      });

      // El pie de los logos de sistemas (Salesforce, Zapier, n8n…) decía «si llama
      // a la API de tu proveedor con tu clave, se mide». El SDK es para Node.js y
      // el gateway solo registra, con el SDK oficial de OpenAI o de Anthropic,
      // los modelos con precio de lista: la frase lleva las dos condiciones.
      it("systems.caption: el SDK en Node.js y el gateway con SDK oficial y precio de lista", () => {
        const pie = m.landing.systems.caption;
        expect(pie).toMatch(s.condicion);
        for (const nombre of ["Node.js", "OpenAI", "Anthropic"]) expect(pie).toContain(nombre);
      });

      it("tarjeta 4: el stream sin contador no cuenta como ahorro medido; nombres de código intactos", () => {
        const tarjeta = m.landing.devs.cards[3];
        expect(tarjeta).toBeDefined();
        expect(tarjeta!.mono).toBe("layer.generateStream(request)");
        for (const nombre of ["generateStream()", "SavingsReport", "generate()"]) {
          expect(tarjeta!.body).toContain(nombre);
        }
        expect(tarjeta!.body).toMatch(s.noMedido);
      });
    });
  }
});

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 2026-11-21 · AUDITORÍA DE MEDIOS ANTES DEL LANZAMIENTO: la web decía cosas que
 * la licencia, el código o la propia web desmienten. Cada bloque fija un grupo
 * (mXX) con la frase vieja de cada idioma, para que no vuelva por una
 * traducción a mano o por copiar un texto antiguo:
 *
 *   m08 · /privacy decía que el gateway local envía registros «siempre». Sin
 *         clave no envía nada (gateway/servidor.ts crea el emisor solo con
 *         `serviceAccountKey`; LICENSE-CLOUD.md §5(b)).
 *   m09 · /pricing y /privacy decían que rige «la LICENSE» y enlazaban la
 *         Apache-2.0; el alta no decía qué condiciones se aceptan.
 *   m15 · el panel avisaba en ámbar «la palanca no ha actuado… escribe a
 *         soporte» en el caso normal, y hablaba de «desbloquear el SDK».
 *   m18 · la skill savings-mode «estira tus topes» como hecho, sin medición.
 *   m19 · «Cómo funciona» pedía exportar la clave para medir Claude Code.
 */

const DIR = new URL(".", import.meta.url).pathname;
const leerApp = (ruta: string) => readFileSync(fileURLToPath(new URL(`../${ruta}`, import.meta.url)), "utf8");

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

const LOCALES = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();
const cargar = (loc: string): Plano => aplanar(JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")));
const en = cargar("en");

/** Comprueba, idioma a idioma, que la clave ya no lleva la frase vieja. */
function sinLaFraseVieja(clave: string, viejas: Record<string, string>) {
  it(`${clave}: ningún idioma conserva la frase vieja`, () => {
    expect(Object.keys(viejas).sort()).toEqual(LOCALES);
    const conVieja = LOCALES.filter((loc) => (cargar(loc)[clave] ?? "").includes(viejas[loc]!));
    expect(conVieja).toEqual([]);
  });
}

describe("medios coherentes (auditoría de lanzamiento, nov-2026)", () => {
  it("están los 12 locales (si falta alguno, este test no protege nada)", () => {
    expect(LOCALES).toEqual(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]);
  });

  describe("m08 · /privacy: sin clave, el gateway no envía nada", () => {
    it("en: el gateway envía solo con clave de cuenta de servicio, y sin clave nada", () => {
      expect(en["privacyPage.usage.when"]).toContain("the local gateway only when you configure a service-account key");
      expect(en["privacyPage.usage.when"]).toContain("With no BiVelio key, neither sends anything to BiVelio.");
    });
    sinLaFraseVieja("privacyPage.usage.when", {
      ca: "el gateway local, sempre",
      de: "das lokale Gateway immer",
      en: "the local gateway always does",
      es: "el gateway local, siempre",
      fr: "le gateway local, toujours",
      id: "gateway lokal selalu mengirimnya",
      it: "il gateway locale, sempre",
      nl: "de lokale gateway doet dat altijd",
      pl: "lokalny gateway robi to zawsze",
      pt: "o gateway local envia sempre",
      tr: "yerel gateway ise her zaman gönderir",
      vi: "gateway cục bộ thì luôn gửi",
    });
  });

  describe("m09 · rigen las condiciones de la nube, y el alta lo dice", () => {
    it("/pricing y /privacy enlazan LICENSE-CLOUD.md (main de GitHub), no la LICENSE Apache-2.0", () => {
      const fuente = leerApp("app/components/LegalGoverns.tsx");
      expect(fuente).toContain(
        'LICENSE_CLOUD_URL = "https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md"',
      );
      expect(fuente).toContain("<a href={LICENSE_CLOUD_URL}");
      expect(fuente).not.toMatch(/savings-layer\/LICENSE"/);
    });

    it("en los 12 idiomas, el enlace de `governs` nombra LICENSE-CLOUD.md", () => {
      const sinCloud = LOCALES.flatMap((loc) => {
        const d = cargar(loc);
        return ["pricingPage.governs", "privacyPage.governs"]
          .filter((k) => !/<license>[^<]*LICENSE-CLOUD\.md[^<]*<\/license>/.test(d[k] ?? ""))
          .map((k) => `${loc}: ${k}`);
      });
      expect(sinCloud).toEqual([]);
    });

    it("bajo el botón de alta: condiciones de la nube y política de privacidad, con sus enlaces", () => {
      const form = leerApp("app/components/AuthForm.tsx");
      expect(form).toMatch(/mode === "signup" \? \(\s*<p className="auth-alt acc-olvido">\s*\{t\.rich\("signupLegal"/);
      expect(form).toContain("<a href={LICENSE_CLOUD_URL}");
      expect(form).toContain('<a href={corporateUrl("/privacy", locale)}');
      const sinEtiquetas = LOCALES.filter((loc) => {
        const v = cargar(loc)["auth.signupLegal"] ?? "";
        return !/<terms>[^<]+<\/terms>/.test(v) || !/<privacy>[^<]+<\/privacy>/.test(v);
      });
      expect(sinEtiquetas).toEqual([]);
      expect(en["auth.signupLegal"]).toBe(
        "By creating an account you accept the <terms>Savings Cloud terms</terms> and the <privacy>privacy policy</privacy>.",
      );
    });
  });

  describe("m15 · el panel no trata el caso normal como una avería, ni la licencia como un candado", () => {
    it("el aviso ámbar: «gasto medido pero sin ahorro», sin mandar a soporte en ningún idioma", () => {
      expect(en["dashboard.gatewayVersion.title"]).toBe("Some machines measured spend but no savings in the last 7 days");
      expect(en["dashboard.gatewayVersion.noLever"]).toContain("That is expected when");
      expect(en["dashboard.gatewayVersion.noLever"]).toContain("when the machine only measures");
      const aSoporte = LOCALES.filter((loc) => cargar(loc)["dashboard.gatewayVersion.noLever"]!.includes("support@"));
      expect(aSoporte).toEqual([]);
    });

    // No nombra el plan Measure ni afirma cómo funciona: «solo mide».
    it("el aviso no nombra Measure ni el modo sombra", () => {
      const conMeasure = LOCALES.filter((loc) => {
        const d = cargar(loc);
        // «Measure» es el nombre del plan (en mayúscula); «measured»/«measures» no cuentan.
        const aviso = `${d["dashboard.gatewayVersion.title"]} ${d["dashboard.gatewayVersion.noLever"]}`;
        return /\bMeasure\b/.test(aviso) || /shadow|sombra/i.test(aviso);
      });
      expect(conMeasure).toEqual([]);
    });

    sinLaFraseVieja("dashboard.migrar05.note", {
      ca: "La darrera versió és la 0.5",
      de: "Die neueste Version ist 0.5",
      en: "The latest version is 0.5",
      es: "La última versión es la 0.5",
      fr: "La dernière version est la 0.5",
      id: "Versi terbaru adalah 0.5",
      it: "L'ultima versione è la 0.5",
      nl: "De nieuwste versie is 0.5",
      pl: "Najnowsza wersja to 0.5",
      pt: "A versão mais recente é a 0.5",
      tr: "En son sürüm 0.5'tir",
      vi: "Phiên bản mới nhất là 0.5",
    });

    sinLaFraseVieja("dashboard.trialKeyButton.pasteHint", {
      ca: "desbloquejar",
      de: "freizuschalten",
      en: "unlock",
      es: "desbloquear",
      fr: "débloquer",
      id: "membuka SDK",
      it: "sbloccare",
      nl: "ontgrendelen",
      pl: "odblokować",
      pt: "desbloquear",
      tr: "SDK'yı açmak",
      vi: "mở khóa",
    });

    it("licencia caducada y nota final: quitar las claves vuelve al modo Community, en los 12 idiomas", () => {
      const sinSalida = LOCALES.flatMap((loc) => {
        const d = cargar(loc);
        return ["dashboard.billingState.expiredBody", "dashboard.installLicensePanel.finalNote"]
          .filter((k) => !/Community|COMMUNITY/.test(d[k] ?? ""))
          .map((k) => `${loc}: ${k}`);
      });
      expect(sinSalida).toEqual([]);
      expect(en["dashboard.billingState.expiredBody"]).not.toContain("the SDK has stopped");
    });
  });

  describe("m18 · la skill no promete un efecto que nadie ha medido", () => {
    it("en: el titular dice que el efecto aún no está medido", () => {
      expect(en["landing.skill.title"]).toBe("A skill built to stretch your subscription caps — effect not measured yet");
      expect(en["dashboard.projectorVerifier.onlyChatBody"]).toContain("its effect is not measured yet");
    });
    sinLaFraseVieja("landing.skill.body", {
      ca: "el que es paga amb Savings",
      de: "wofür man Savings bezahlt",
      en: "what you pay Savings for",
      es: "lo que se paga con Savings",
      fr: "ce que l'on paie avec Savings",
      id: "yang dibayar ke Savings",
      it: "ciò che si paga con Savings",
      nl: "waar je Savings voor betaalt",
      pl: "w Savings płaci się",
      pt: "o que se paga com o Savings",
      tr: "Savings ile ödediğin",
      vi: "điều bạn trả cho Savings",
    });
  });

  describe("m19 · medir Claude Code no pide ninguna clave", () => {
    it("en: sin clave; la clave de servicio, solo para ver el gasto en el panel", () => {
      expect(en["landing.gateway.body"]).toContain("with no changes to your code and no key: start your agent through bvsala.");
      expect(en["landing.gateway.body"]).toContain("Add a service key only if you want the spend in your Savings Cloud dashboard.");
    });
    sinLaFraseVieja("landing.gateway.body", {
      ca: "exportes la teva clau",
      de: "Du exportierst deinen Service-Schlüssel",
      en: "export your service key",
      es: "exportas tu clave",
      fr: "vous exportez votre clé",
      id: "ekspor kunci layanan",
      it: "esporti la tua chiave",
      nl: "je exporteert je service-sleutel",
      pl: "eksportujesz swój klucz",
      pt: "exportas a tua chave",
      tr: "dışa aktarır",
      vi: "bạn xuất khóa dịch vụ",
    });
  });
});

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { cuentaCompartidaConLaSuite } from "./cuenta-compartida";

/**
 * Las tres frases que prometen «la misma cuenta que en Shield/Privacy» solo
 * mientras sea verdad (BVSALA_CUENTA_PROPIA, apagado por defecto).
 */

const WEB = new URL("../../", import.meta.url);
const leer = (f: string) => readFileSync(new URL(f, WEB), "utf8");
const IDIOMAS = ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"];

describe("cuentaCompartidaConLaSuite", () => {
  it("apagado (hoy): compartida — las frases se ven como siempre", () => {
    expect(cuentaCompartidaConLaSuite({})).toBe(true);
    for (const v of ["", " ", "0", "true", "si"]) expect(cuentaCompartidaConLaSuite({ BVSALA_CUENTA_PROPIA: v }), v).toBe(true);
  });

  it("encendido solo con «1»", () => {
    expect(cuentaCompartidaConLaSuite({ BVSALA_CUENTA_PROPIA: "1" })).toBe(false);
    expect(cuentaCompartidaConLaSuite({ BVSALA_CUENTA_PROPIA: " 1 " })).toBe(false);
  });

  it("las tres pantallas preguntan antes de prometer la cuenta compartida", () => {
    expect(leer("app/[locale]/signup/page.tsx")).toContain('cuentaCompartidaConLaSuite() ? <p className="acc-nota">{t("signupSsoNote")}</p> : null');
    expect(leer("app/[locale]/dashboard/account/page.tsx")).toContain('entradilla={cuentaCompartidaConLaSuite() ? t("account.intro") : undefined}');
    expect(leer("app/[locale]/dashboard/components/AccountPlanStrip.tsx")).toContain(
      'cuentaCompartidaConLaSuite() ? t("accountPlanStrip.personalNote") : t("accountPlanStrip.personalNoteSinSuite")',
    );
  });

  it("la nota «Personal» sin la suite es, en cada idioma, la primera frase de la de siempre", () => {
    for (const l of IDIOMAS) {
      const m = JSON.parse(leer(`messages/${l}.json`)) as { dashboard: { accountPlanStrip: Record<string, string> } };
      const { personalNote, personalNoteSinSuite } = m.dashboard.accountPlanStrip;
      expect(personalNoteSinSuite, l).toBeTruthy();
      expect(personalNote!.startsWith(personalNoteSinSuite!), l).toBe(true);
      expect(personalNoteSinSuite, l).not.toMatch(/suite|Suite|pakiecie|paket|bộ sản phẩm/);
    }
  });
});

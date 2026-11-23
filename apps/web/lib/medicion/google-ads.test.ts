import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import config from "../../next.config.mjs";
import { ID_GOOGLE_ADS, referenteParaGoogle, ubicacionParaGoogle, urlPermiteGoogleAds } from "./google-ads";

/**
 * A GOOGLE NO LE LLEGA NI UN TOKEN NI UN CÓDIGO (revisión del PR #618).
 *
 * gtag mandaba la URL entera de cada página y de la anterior: el token de una
 * invitación (`/es/invitacion/bvi_…`) y el `?code=` de la nueva contraseña.
 * Lo que se mide en Chrome contra el build está en lib/medicion/google-ads.ts;
 * aquí se fija lo que lo evita.
 */

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const leer = (ruta: string) => readFileSync(join(WEB, ruta), "utf8");
const O = "https://savings.bivelio.com";

describe("dónde se carga gtag", () => {
  it("en las páginas de siempre, con o sin query de la web", () => {
    for (const ruta of [
      "/es",
      "/en/pricing?gclid=abc123",
      "/es/signup",
      "/es/signup?next=%2Fes%2Fdashboard%3Fplan%3Dpro",
      "/es/signup/success?next=%2Fes%2Fdashboard",
      "/es/login?error=enlace_usado",
      "/es/dashboard?range=30d",
    ]) {
      expect(urlPermiteGoogleAds(O + ruta), ruta).toBe(true);
    }
  });

  it("nunca con un token o un código en la URL, ni en un 404", () => {
    for (const ruta of [
      "/es/invitacion/bvi_9f2c1e0b7a",
      "/es/reset-password",
      "/es/reset-password?code=abc",
      "/es/alguien@example.com",
      "/es/k=v&z=1",
      "/es/dashboard?code=abc",
      "/es/dashboard?token_hash=abc&type=signup",
      "/es#access_token=abc&refresh_token=def",
      // El enlace «Iniciar sesión» de la invitación lleva el token en `next`.
      "/es/login?next=%2Fes%2Finvitacion%2Fbvi_9f2c1e0b7a",
      "/es/signup?next=/es/invitacion/bvi_9f2c1e0b7a",
      "/es/login?next=%2Fes%2Freset-password",
    ]) {
      expect(urlPermiteGoogleAds(O + ruta), ruta).toBe(false);
    }
    expect(urlPermiteGoogleAds("no es una url")).toBe(false);
  });

  it("el enlace de la invitación a /login es de los que vetan (AceptarInvitacion)", () => {
    const fuente = leer("app/[locale]/invitacion/[token]/AceptarInvitacion.tsx");
    expect(fuente).toMatch(/login\?next=\$\{encodeURIComponent\(`\/\$\{locale\}\/invitacion\//);
    const enlace = `/es/login?next=${encodeURIComponent(`/es/invitacion/${encodeURIComponent("bvi_x")}`)}`;
    expect(urlPermiteGoogleAds(O + enlace)).toBe(false);
  });
});

describe("lo que se le da", () => {
  it("page_location sin query, sin fragmento y sin token", () => {
    expect(ubicacionParaGoogle(`${O}/es/pricing?gclid=abc&secreto=x#planes`)).toBe(`${O}/es/pricing`);
    expect(ubicacionParaGoogle(`${O}/es/invitacion/bvi_9f2c1e0b7a`)).toBe(`${O}/es/invitacion/[token]`);
    expect(ubicacionParaGoogle(`${O}/es/alguien@example.com`)).toBe(`${O}/es/[...rest]`);
  });

  it("page_referrer: de este sitio, limpio; de otro, solo el origen; sin anterior, vacío", () => {
    expect(referenteParaGoogle(`${O}/es/invitacion/bvi_9f2c1e0b7a`, O)).toBe(`${O}/es/invitacion/[token]`);
    expect(referenteParaGoogle(`${O}/`, O)).toBe(`${O}/`);
    expect(referenteParaGoogle("https://www.google.com/search?q=bv-sala", O)).toBe("https://www.google.com/");
    expect(referenteParaGoogle("", O)).toBe("");
  });

  it("la página anterior es solo el origen en todo el sitio (Referrer-Policy: strict-origin)", async () => {
    const reglas = await (config as { headers: () => Promise<{ headers: { key: string; value: string }[] }[]> }).headers();
    const politica = reglas[0]!.headers.find((h) => h.key === "Referrer-Policy");
    expect(politica?.value).toBe("strict-origin");
  });
});

describe("el montaje", () => {
  const layout = leer("app/[locale]/layout.tsx");

  it("el layout ya no lleva gtag en línea: lo pone EtiquetaGoogleAds, antes que la página", () => {
    expect(layout).not.toMatch(/gtag\(|googletagmanager/);
    const etiqueta = layout.indexOf("<EtiquetaGoogleAds />");
    expect(etiqueta).toBeGreaterThan(-1);
    // Antes que {children}: su efecto define window.gtag antes que ConversionRegistro.
    expect(etiqueta).toBeLessThan(layout.indexOf("{children}"));
  });

  it("un solo id de Google Ads: el de la etiqueta es el de la conversión", () => {
    expect(leer("app/components/ConversionRegistro.tsx")).toContain(`send_to: "${ID_GOOGLE_ADS}/`);
    expect(leer("app/components/EtiquetaGoogleAds.tsx")).toMatch(/googletagmanager\.com\/gtag\/js\?id=\$\{ID_GOOGLE_ADS\}/);
  });
});

describe("/privacy lo cuenta, en los 12 idiomas", () => {
  it("la etiqueta de Google Ads, sus cookies y su fila del resumen", async () => {
    const { locales } = await import("@/i18n/config");
    for (const l of locales) {
      const pp = (
        JSON.parse(leer(`messages/${l}.json`)) as {
          privacyPage: { website: { ads: string; adsData: string }; overview: { ads: { destination: string } } };
        }
      ).privacyPage;
      expect(pp.website.ads, l).toContain("<b>Google Ads</b>");
      expect(pp.website.ads, l).toContain("_gcl_au");
      expect(pp.website.adsData.length, l).toBeGreaterThan(0);
      expect(pp.overview.ads.destination, l).toBe("Google");
    }
    const pagina = leer("app/[locale]/privacy/page.tsx");
    expect(pagina).toContain('t.rich("website.ads"');
    expect(pagina).toContain('t("website.adsData")');
    expect(pagina).toContain('{ clave: "ads", ancla: "website" }');
  });
});

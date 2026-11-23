import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import config from "../../next.config.mjs";
import {
  ID_GOOGLE_ADS,
  PARAMETROS_QUE_SE_QUEDAN,
  RUTAS_CON_GOOGLE_ADS,
  referenteParaGoogle,
  ubicacionParaGoogle,
  urlPermiteGoogleAds,
  urlSinParametrosSobrantes,
  urlVetaLaVisita,
} from "./google-ads";

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

describe("dónde corre gtag", () => {
  it("solo en las páginas públicas sin formularios y en la confirmación del alta", () => {
    for (const ruta of [
      "/es",
      "/en/pricing?gclid=abc123",
      "/es/how-it-works#install-sdk",
      "/de/benchmarks",
      "/es/paper",
      "/es/privacy",
      "/en/migrate-to-0.5",
      "/es/signup/success?next=%2Fes%2Fdashboard",
    ]) {
      expect(urlPermiteGoogleAds(O + ruta), ruta).toBe(true);
    }
  });

  it("nunca donde hay formularios con tu correo (alta, acceso, contraseña, invitación, panel) ni en un 404", () => {
    for (const ruta of [
      "/es/signup",
      "/es/signup?next=%2Fes%2Fdashboard%3Fplan%3Dpro",
      "/es/login",
      "/es/login?error=enlace_usado",
      "/es/reset-password",
      "/es/invitacion/bvi_9f2c1e0b7a",
      "/es/dashboard",
      "/es/dashboard/team",
      "/es/kit",
      "/es/captura-panel",
      "/es/alguien@example.com",
    ]) {
      expect(urlPermiteGoogleAds(O + ruta), ruta).toBe(false);
    }
  });

  it("nunca con un token o un código en la URL; esas URL y los 404 vetan el resto de la visita", () => {
    for (const ruta of [
      "/es/invitacion/bvi_9f2c1e0b7a",
      "/es/reset-password",
      "/es/reset-password?code=abc",
      "/es/alguien@example.com",
      "/es/k=v&z=1",
      "/es/pricing?code=abc",
      "/es/pricing?token_hash=abc&type=signup",
      "/es#access_token=abc&refresh_token=def",
      // El enlace «Iniciar sesión» de la invitación lleva el token en `next`.
      "/es/login?next=%2Fes%2Finvitacion%2Fbvi_9f2c1e0b7a",
      "/es/signup?next=/es/invitacion/bvi_9f2c1e0b7a",
      "/es/signup/success?next=%2Fes%2Finvitacion%2Fbvi_9f2c1e0b7a",
      "/es/login?next=%2Fes%2Freset-password",
    ]) {
      expect(urlVetaLaVisita(O + ruta), ruta).toBe(true);
      expect(urlPermiteGoogleAds(O + ruta), ruta).toBe(false);
    }
    for (const ruta of ["/es", "/es/pricing?gclid=x", "/es/signup", "/es/dashboard?range=30d"]) {
      expect(urlVetaLaVisita(O + ruta), ruta).toBe(false);
    }
  });

  it("una URL que no se puede leer no tira nada: no se carga y veta (revisión 2, «Application error»)", () => {
    for (const ruta of ["/es/pricing?x=//", "/es?ref=//x:99999", "/es/signup/success#a=//[", "/es?next=//%", "/es?a=//[::1"]) {
      expect(() => urlPermiteGoogleAds(O + ruta), ruta).not.toThrow();
      expect(() => urlVetaLaVisita(O + ruta), ruta).not.toThrow();
      expect(() => urlSinParametrosSobrantes(O + ruta), ruta).not.toThrow();
      expect(urlPermiteGoogleAds(O + ruta), ruta).toBe(false);
    }
    for (const basura of ["no es una url", "", "http://[", "https://savings.bivelio.com/%E0%A4%A"]) {
      expect(() => urlPermiteGoogleAds(basura)).not.toThrow();
      expect(() => referenteParaGoogle(basura, O)).not.toThrow();
      expect(() => ubicacionParaGoogle(basura)).not.toThrow();
    }
  });
});

describe("los parámetros que gtag llega a ver", () => {
  it("antes de cargarlo, la barra se queda solo con lo que la web usa", () => {
    expect(urlSinParametrosSobrantes(`${O}/es/pricing?email=ana%40example.com&utm_source=boletin&fbclid=x#planes`)).toBe("/es/pricing#planes");
    expect(urlSinParametrosSobrantes(`${O}/en/pricing?gclid=Cj0KCQ-abc_123&utm_medium=cpc`)).toBe("/en/pricing?gclid=Cj0KCQ-abc_123");
    expect(urlSinParametrosSobrantes(`${O}/es/signup/success?next=%2Fes%2Fdashboard%3Fplan%3Dpro&email=a%40b.c`)).toBe(
      "/es/signup/success?next=%2Fes%2Fdashboard%3Fplan%3Dpro",
    );
    // Un `next` con más de lo que hace falta pierde lo que sobra; uno ajeno, entero.
    expect(urlSinParametrosSobrantes(`${O}/es/signup/success?next=%2Fes%2Fdashboard%3Femail%3Da%2540b.c`)).toBe("/es/signup/success?next=%2Fes%2Fdashboard");
    expect(urlSinParametrosSobrantes(`${O}/es/signup/success?next=https%3A%2F%2Fevil.example%2F`)).toBe("/es/signup/success");
    expect(urlSinParametrosSobrantes(`${O}/es/pricing?plan=pro`)).toBeNull();
    expect(urlSinParametrosSobrantes(`${O}/es/pricing?plan=ana%40example.com`)).toBe("/es/pricing");
    expect(urlSinParametrosSobrantes(`${O}/es/pricing`)).toBeNull();
  });

  it("se quedan todos los que leen las páginas donde corre gtag", () => {
    // Las páginas permitidas y lo que leen de la query (servidor y cliente).
    const leidos = new Set<string>();
    for (const f of ["app/[locale]/page.tsx", "app/[locale]/how-it-works/page.tsx", "app/[locale]/pricing/page.tsx", "app/[locale]/benchmarks/page.tsx", "app/[locale]/paper/page.tsx", "app/[locale]/privacy/page.tsx", "app/[locale]/migrate-to-0.5/page.tsx", "app/[locale]/signup/success/page.tsx"]) {
      const src = leer(f);
      for (const m of src.matchAll(/searchParams\??\.get\("(\w+)"\)/g)) leidos.add(m[1]!);
      for (const m of src.matchAll(/searchParams: Promise<\{([^}]*)\}>/g)) for (const k of m[1]!.matchAll(/(\w+)\?:/g)) leidos.add(k[1]!);
    }
    expect([...leidos].sort()).toEqual(["next", "plan"]);
    for (const p of leidos) expect(PARAMETROS_QUE_SE_QUEDAN as readonly string[]).toContain(p);
    expect([...RUTAS_CON_GOOGLE_ADS].sort()).toEqual(
      ["/[locale]", "/[locale]/benchmarks", "/[locale]/how-it-works", "/[locale]/migrate-to-0.5", "/[locale]/paper", "/[locale]/pricing", "/[locale]/privacy", "/[locale]/signup/success"].sort(),
    );
  });

  it("la etiqueta limpia la barra ANTES de definir gtag, da la página solo con set y no puede lanzar", () => {
    const src = leer("app/components/EtiquetaGoogleAds.tsx");
    expect(src.indexOf("history.replaceState(history.state")).toBeLessThan(src.indexOf("w.gtag = function gtag()"));
    // La página va solo en `set` (el `page_location` de `config` se quedaría pegado a la primera).
    expect(src).toContain('w.gtag("config", ID_GOOGLE_ADS);');
    expect(src).not.toMatch(/w\.gtag\("config", ID_GOOGLE_ADS, /);
    expect(src).toContain('sessionStorage.setItem(CLAVE_DEL_VETO, "1")');
    // Los dos efectos van enteros dentro de try/catch.
    expect(src.match(/try \{/g)!.length).toBeGreaterThanOrEqual(4);
  });
});

describe("la invitación", () => {
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
      // El correo escrito en una página con gtag (la reserva de llamada de la portada) puede salir con hash: se dice.
      expect(pp.website.adsData, l).toContain("{hash}");
      expect(pp.overview.ads.destination, l).toBe("Google");
    }
    const pagina = leer("app/[locale]/privacy/page.tsx");
    expect(pagina).toContain('t.rich("website.ads"');
    expect(pagina).toContain(`t("website.adsData", { hash: "SHA-256" })`);
    expect(pagina).toContain('{ clave: "ads", ancla: "website" }');
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import {
  CONSENTIMIENTO_CONCEDIDO,
  CONSENTIMIENTO_POR_DEFECTO,
  CONSENTIMIENTO_RETIRADO,
  COOKIE_CONSENTIMIENTO,
  DIAS_DE_VALIDEZ,
  borradosDeCookie,
  cookieDeConsentimiento,
  cookiesDeGoogleAds,
  leerEleccion,
  valorDeConsentimiento,
} from "./consentimiento";

/**
 * EL CONSENTIMIENTO DE COOKIES DE PUBLICIDAD (decisión del dueño, 23-11).
 * Sin «Aceptar», Google Ads no se carga; la elección se guarda seis meses con
 * solo su valor y su fecha; retirarla borra las `_gcl_*` de este dominio.
 */

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const leer = (ruta: string) => readFileSync(join(WEB, ruta), "utf8");
const HOY = new Date("2026-11-23T10:00:00Z");
const diasDespues = (n: number) => new Date(HOY.getTime() + n * 86_400_000);

describe("la cookie de la elección", () => {
  it("guarda solo la elección y la fecha, y se vuelve a leer", () => {
    expect(valorDeConsentimiento("granted", HOY)).toBe("granted.2026-11-23");
    expect(leerEleccion(`a=1; ${COOKIE_CONSENTIMIENTO}=granted.2026-11-23; b=2`, HOY)).toBe("granted");
    expect(leerEleccion(`${COOKIE_CONSENTIMIENTO}=denied.2026-11-23`, HOY)).toBe("denied");
  });

  it("sin cookie, con un valor raro, de otra cookie o con fecha futura: no hay elección (se pregunta)", () => {
    for (const cookies of [
      "",
      "a=1",
      `${COOKIE_CONSENTIMIENTO}=yes`,
      `${COOKIE_CONSENTIMIENTO}=granted`,
      `${COOKIE_CONSENTIMIENTO}=granted.2026-13-45`,
      `x${COOKIE_CONSENTIMIENTO}=granted.2026-11-23`,
      `${COOKIE_CONSENTIMIENTO}=granted.2027-01-01`,
    ]) {
      expect(leerEleccion(cookies, HOY), cookies).toBeNull();
    }
  });

  it("dura unos seis meses: pasado el plazo se vuelve a preguntar", () => {
    expect(DIAS_DE_VALIDEZ).toBeGreaterThanOrEqual(180);
    expect(DIAS_DE_VALIDEZ).toBeLessThanOrEqual(365);
    const valor = `${COOKIE_CONSENTIMIENTO}=${valorDeConsentimiento("granted", HOY)}`;
    expect(leerEleccion(valor, diasDespues(DIAS_DE_VALIDEZ - 1))).toBe("granted");
    expect(leerEleccion(valor, diasDespues(DIAS_DE_VALIDEZ + 1))).toBeNull();
  });

  it("es propia, de todo el sitio, con caducidad y SameSite; Secure en https", () => {
    const c = cookieDeConsentimiento("denied", HOY, true);
    expect(c).toBe(`${COOKIE_CONSENTIMIENTO}=denied.2026-11-23; Path=/; Max-Age=${DIAS_DE_VALIDEZ * 86_400}; SameSite=Lax; Secure`);
    expect(c).not.toMatch(/Domain=/);
    expect(cookieDeConsentimiento("denied", HOY, false)).not.toMatch(/Secure/);
  });
});

describe("retirar el consentimiento", () => {
  it("encuentra las cookies de Google Ads y solo esas", () => {
    expect(cookiesDeGoogleAds("_gcl_au=1.1.x; bv_consent=granted.2026-11-23; _gcl_aw=GCL.1.y; NEXT_LOCALE=es; _gcl_ls=z; _ga=GA1")).toEqual([
      "_gcl_au",
      "_gcl_aw",
      "_gcl_ls",
    ]);
  });

  it("las borra en el host y en sus dominios padre (gtag guarda _gcl_au en .bivelio.com)", () => {
    expect(borradosDeCookie("_gcl_au", "savings.bivelio.com")).toEqual([
      "_gcl_au=; Path=/; Max-Age=0",
      "_gcl_au=; Path=/; Max-Age=0; Domain=savings.bivelio.com",
      "_gcl_au=; Path=/; Max-Age=0; Domain=bivelio.com",
    ]);
    expect(borradosDeCookie("_gcl_au", "localhost")).toEqual(["_gcl_au=; Path=/; Max-Age=0"]);
    expect(borradosDeCookie("_gcl_au", "127.0.0.1")).toEqual(["_gcl_au=; Path=/; Max-Age=0"]);
  });
});

describe("Consent Mode", () => {
  it("por defecto todo denegado; «Aceptar» concede la publicidad y nada de analítica; «Rechazar» la deniega", () => {
    expect(Object.values(CONSENTIMIENTO_POR_DEFECTO).every((v) => v === "denied")).toBe(true);
    expect(Object.keys(CONSENTIMIENTO_POR_DEFECTO).sort()).toEqual(["ad_personalization", "ad_storage", "ad_user_data", "analytics_storage"]);
    expect(CONSENTIMIENTO_CONCEDIDO).toEqual({ ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" });
    expect(Object.values(CONSENTIMIENTO_RETIRADO).every((v) => v === "denied")).toBe(true);
  });

  it("gtag solo se define con «Aceptar», y el consentimiento va antes que cualquier otra orden", () => {
    const src = leer("app/components/EtiquetaGoogleAds.tsx");
    const guarda = src.indexOf('consentimiento !== "granted" ||');
    const define = src.indexOf("w.gtag = function gtag()");
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(define);
    // Las órdenes de la inicialización, buscadas a partir de la definición (antes
    // está el `set` de cuando gtag ya estaba cargado).
    const orden = ['"consent", "default"', '"consent", "update"', '"js"', '"set"', '"config"'].map((o) => src.indexOf(`w.gtag(${o}`, define));
    expect(orden.every((i) => i > define)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    // El <Script> de gtag.js solo se pinta tras esa inicialización.
    expect(src).toMatch(/return cargar \? <Script/);
  });

  it("la conversión del alta solo se dispara con «Aceptar»", () => {
    const src = leer("app/components/ConversionRegistro.tsx");
    const guarda = src.indexOf('if (consentimiento !== "granted") return;');
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(src.indexOf('"conversion"'));
    expect(src).toContain("[idTransaccion, consentimiento]");
  });
});

describe("el aviso", () => {
  const aviso = leer("app/components/AvisoCookies.tsx");

  it("«Aceptar» y «Rechazar» pesan lo mismo, y no hay casillas", () => {
    const botones = [...aviso.matchAll(/<button type="button" className="([^"]+)"/g)].map((m) => m[1]);
    expect(botones).toEqual(["btn ghost", "btn ghost"]);
    expect(aviso).not.toMatch(/<input|type="checkbox"|defaultChecked/);
    expect(aviso).toContain('href="/privacy#website"');
  });

  it("se monta una vez en el layout, y «Ajustes de cookies» está en el pie y en /privacy", () => {
    expect(leer("app/[locale]/layout.tsx").match(/<AvisoCookies\b/g)).toHaveLength(1);
    expect(leer("app/components/Footer.tsx")).toMatch(/<AjustesCookies [^>]*texto=\{t\("footer\.cookieSettings"\)\}/);
    expect(leer("app/[locale]/privacy/page.tsx")).toMatch(/<AjustesCookies [^>]*texto=\{t\("website\.settings"\)\}/);
  });

  it("sus textos, el del pie y los de /privacy existen en los 12 idiomas y nombran Google Ads", () => {
    for (const l of locales) {
      const m = JSON.parse(leer(`messages/${l}.json`)) as {
        cookieBanner: Record<"title" | "body" | "accept" | "reject" | "privacy", string>;
        landing: { footer: { cookieSettings: string } };
        privacyPage: { website: { ads: string; consent: string; settings: string } };
      };
      for (const k of ["title", "body", "accept", "reject", "privacy"] as const) expect(m.cookieBanner[k], `${l} ${k}`).toBeTruthy();
      expect(m.cookieBanner.body, l).toContain("Google Ads");
      expect(m.landing.footer.cookieSettings, l).toBeTruthy();
      expect(m.privacyPage.website.consent, l).toContain(COOKIE_CONSENTIMIENTO);
      expect(m.privacyPage.website.settings, l).toBe(m.landing.footer.cookieSettings);
    }
  });
});

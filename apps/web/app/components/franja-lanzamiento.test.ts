import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it } from "vitest";

import { AnnouncementBar } from "./AnnouncementBar";
import {
  FIN_CAMPANA,
  LANZAMIENTO,
  RETRASO_MAXIMO,
  URL_PRODUCT_HUNT,
  alcanzables,
  atado,
  elegirVariante,
  esperaHastaLaFrontera,
  fechaDelLanzamiento,
  laMasAvanzada,
  siguienteFrontera,
} from "./franja-lanzamiento";

/**
 * LA FRANJA DE PRODUCT HUNT (lanzamiento del 22-11-2026).
 *
 * La franja cambia sola a las 9:00 de Andorra del domingo, sin despliegue, y
 * vuelve a la de BiVelio una semana después. Aquí se prueban las fronteras al
 * milisegundo, el temporizador que las cruza, que el render de servidor no
 * dependa del reloj del cliente, los textos de los 12 idiomas y el contraste
 * del coral de PH.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

describe("elegirVariante: las tres ventanas", () => {
  it("el lanzamiento es el domingo 22 a las 9:00 de Andorra = 08:00Z = 00:00 PT", () => {
    expect(new Date(LANZAMIENTO).toISOString()).toBe("2026-11-22T08:00:00.000Z");
    expect(new Date(FIN_CAMPANA).toISOString()).toBe("2026-11-29T08:00:00.000Z");
    const hora = (tz: string) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(LANZAMIENTO);
    expect(hora("Europe/Andorra")).toBe("Sunday 09:00");
    expect(hora("America/Los_Angeles")).toBe("Sunday 00:00");
  });

  it("antes del lanzamiento, aviso; hoy (18-11) también", () => {
    expect(elegirVariante(Date.UTC(2026, 10, 18, 12))).toBe("aviso");
    expect(elegirVariante(0)).toBe("aviso");
    expect(elegirVariante(LANZAMIENTO - 1)).toBe("aviso");
  });

  it("la frontera del lanzamiento pertenece a la ventana que empieza", () => {
    expect(elegirVariante(LANZAMIENTO)).toBe("en-vivo");
    expect(elegirVariante(new Date("2026-11-22T08:00:00Z"))).toBe("en-vivo");
    expect(elegirVariante(LANZAMIENTO + 3 * DIA)).toBe("en-vivo");
    expect(elegirVariante(FIN_CAMPANA - 1)).toBe("en-vivo");
  });

  it("desde el 29 a las 08:00Z, la franja de BiVelio de siempre", () => {
    expect(elegirVariante(FIN_CAMPANA)).toBe("bivelio");
    expect(elegirVariante(FIN_CAMPANA + 365 * DIA)).toBe("bivelio");
  });

  it("un reloj roto no deja anunciando un lanzamiento", () => {
    expect(elegirVariante(Number.NaN)).toBe("bivelio");
    expect(elegirVariante(new Date("no es una fecha"))).toBe("bivelio");
    expect(siguienteFrontera(Number.NaN)).toBeNull();
    expect(esperaHastaLaFrontera(Number.NaN)).toBeNull();
  });
});

describe("el temporizador cruza la frontera justo", () => {
  it("la siguiente frontera es estrictamente posterior", () => {
    expect(siguienteFrontera(LANZAMIENTO - 1)).toBe(LANZAMIENTO);
    expect(siguienteFrontera(LANZAMIENTO)).toBe(FIN_CAMPANA);
    expect(siguienteFrontera(FIN_CAMPANA - 1)).toBe(FIN_CAMPANA);
    expect(siguienteFrontera(FIN_CAMPANA)).toBeNull();
  });

  it("la espera cae 1 ms DENTRO de la ventana nueva", () => {
    for (const ahora of [LANZAMIENTO - 5 * MIN, LANZAMIENTO - 1, FIN_CAMPANA - HORA]) {
      const espera = esperaHastaLaFrontera(ahora)!;
      expect(elegirVariante(ahora + espera)).not.toBe(elegirVariante(ahora));
      expect(elegirVariante(ahora + espera - 2)).toBe(elegirVariante(ahora));
    }
    expect(esperaHastaLaFrontera(FIN_CAMPANA)).toBeNull();
  });

  it("nunca pasa del máximo de setTimeout (si no, dispararía al instante)", () => {
    const hace40Dias = LANZAMIENTO - 40 * DIA;
    expect(esperaHastaLaFrontera(hace40Dias)).toBe(RETRASO_MAXIMO);
    // Al dispararse antes de tiempo, la reevaluación sigue en «aviso» y reprograma.
    expect(elegirVariante(hace40Dias + RETRASO_MAXIMO)).toBe("aviso");
  });
});

describe("el render del servidor no depende del reloj del cliente", () => {
  it("la variante nunca retrocede de la del build", () => {
    expect(laMasAvanzada("en-vivo", "aviso")).toBe("en-vivo");
    expect(laMasAvanzada("aviso", "en-vivo")).toBe("en-vivo");
    expect(laMasAvanzada("bivelio", "aviso")).toBe("bivelio");
  });

  it("solo se apilan las variantes que aún pueden llegar", () => {
    expect(alcanzables("aviso")).toEqual(["aviso", "en-vivo", "bivelio"]);
    expect(alcanzables("en-vivo")).toEqual(["en-vivo", "bivelio"]);
    expect(alcanzables("bivelio")).toEqual(["bivelio"]);
  });

  const en = JSON.parse(readFileSync(new URL("../../messages/en.json", import.meta.url), "utf8"));
  const pinta = (props: Parameters<typeof AnnouncementBar>[0]) =>
    renderToString(
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en as AbstractIntlMessages,
        timeZone: "UTC",
        children: createElement(AnnouncementBar, props),
      }),
    );

  it("antes del lanzamiento: el aviso visible, las otras dos apiladas e invisibles", () => {
    const html = pinta({ inicial: "aviso", fecha: fechaDelLanzamiento("en") });
    expect(html).toContain('class="announce announce--ph"');
    expect(html).toContain('data-variante="aviso"');
    expect(html).toContain(atado("We launch on Product Hunt on Sunday, November 22 — get notified"));
    expect(html).toContain(atado("Savings Layer is live on Product Hunt — support us"));
    expect(html).toContain("Savings Layer is part of the BiVelio platform");
    expect(html.match(/data-oculta="true"/g)).toHaveLength(2);
    expect(html).toContain(URL_PRODUCT_HUNT.replace(/&/g, "&amp;"));
    expect(html).toContain('target="_blank" rel="noopener"');
    expect(html).toContain("(opens in a new tab)");
    // El botón de cerrar sigue ahí, con su nombre.
    expect(html).toMatch(/<button[^>]*class="announce-close"[^>]*aria-label="Close"/);
  });

  it("después de la campaña la franja es la de siempre: sin rastro de Product Hunt", () => {
    const html = pinta({ inicial: "bivelio" });
    expect(html).toContain('class="announce"');
    expect(html).not.toMatch(/Product.Hunt/);
    expect(html).not.toContain("data-oculta");
    expect(html).toContain('href="https://bivelio.com/en"');
  });

  it("sin props (otro montaje) se comporta como antes", () => {
    expect(pinta({})).toBe(pinta({ inicial: "bivelio" }));
  });
});

describe("los cortes de línea en móvil", () => {
  it("«Product Hunt» no se parte y la raya no abre línea", () => {
    expect(atado("Savings Layer ya está en Product Hunt — apóyanos")).toBe("Savings Layer ya está en Product\u00A0Hunt\u00A0— apóyanos");
    expect(atado("Wir starten am X auf Product Hunt – lass dich erinnern")).toBe("Wir starten am X auf Product\u00A0Hunt\u00A0– lass dich erinnern");
  });
});

describe("el enlace", () => {
  it("lleva los UTM de la web, no los de LinkedIn ni X", () => {
    const u = new URL(URL_PRODUCT_HUNT);
    expect(u.origin + u.pathname).toBe("https://www.producthunt.com/products/bivelio-savings-layer");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      utm_source: "savings-site",
      utm_medium: "announcement-bar",
      utm_campaign: "launch",
    });
    expect(URL_PRODUCT_HUNT).not.toMatch(/linkedin|twitter/i);
  });
});

describe("los textos, en los 12 idiomas", () => {
  const DIR = fileURLToPath(new URL("../../messages/", import.meta.url));
  const locales = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  const nav = (loc: string) => JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")).nav as Record<string, string>;

  it("son los 12", () => expect(locales.sort()).toEqual(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]));

  it.each(locales)("%s: los dos textos existen, nombran Product Hunt sin traducirlo, y el aviso lleva la fecha", (loc) => {
    const n = nav(loc);
    expect(n.announcePhSoon).toContain("Product Hunt");
    expect(n.announcePhLive).toContain("Product Hunt");
    expect(n.announcePhSoon).toContain("{date}");
    expect(n.announcePhLive).not.toContain("{");
    expect(n.newTab).toBeTruthy();
  });

  it.each(locales)("%s: la fecha sale con el domingo en su idioma y el día 22", (loc) => {
    const fecha = fechaDelLanzamiento(loc);
    const domingo = new Intl.DateTimeFormat(loc, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 10, 22, 12));
    expect(fecha.toLowerCase()).toContain(domingo.toLowerCase());
    expect(fecha).toContain("22");
  });

  it("la fecha en algunos idiomas, tal cual", () => {
    expect(fechaDelLanzamiento("en")).toBe("Sunday, November 22");
    expect(fechaDelLanzamiento("es")).toBe("domingo, 22 de noviembre");
    expect(fechaDelLanzamiento("de")).toBe("Sonntag, 22. November");
  });
});

describe("el coral de Product Hunt se lee", () => {
  const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  const contraste = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const regla = css.match(/\.announce--ph\s*\{([^}]*)\}/)![1]!;
  const fondo = rgb(regla.match(/background:\s*(#[0-9A-Fa-f]{6})/)![1]!);
  const texto = rgb(regla.match(/(?:^|;)\s*color:\s*(#[0-9A-Fa-f]{6})/)![1]!);

  it("es el coral de PH y el blanco no pasaría AA", () => {
    expect(fondo).toEqual(rgb("#FF6154"));
    expect(contraste(fondo, [255, 255, 255])).toBeLessThan(3);
  });

  it("el texto tinta pasa AA en texto normal (≥ 4,5:1; da 6,33:1)", () => {
    expect(contraste(fondo, texto)).toBeGreaterThanOrEqual(4.5);
    expect(contraste(fondo, texto).toFixed(2)).toBe("6.33");
  });

  it("la ✕ semitransparente queda ≥ 3:1 sobre el coral", () => {
    const m = css.match(/\.announce--ph \.announce-close\s*\{\s*color:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)!;
    const [r, g, b, a] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    const mezcla = [r, g, b].map((c, i) => c * a + fondo[i]! * (1 - a));
    expect(contraste(fondo, mezcla)).toBeGreaterThanOrEqual(3);
  });
});

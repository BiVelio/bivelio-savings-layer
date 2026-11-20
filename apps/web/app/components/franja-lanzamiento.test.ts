import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLATAFORMAS, fechasDeAviso, finDeTodas, plataforma } from "@/lib/plataformas-de-lanzamiento";

import { AnnouncementBar } from "./AnnouncementBar";
import {
  CLAVE_HOJA_PREVIA,
  FIN_CAMPANA,
  LANZAMIENTO,
  VARIANTES,
  fechaAtada,
  guionPrevio,
  partirCola,
  hojaDelGuion,
  programarFranja,
  retirarHojaPrevia,
  type Variante,
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
 * LA FRANJA DURANTE EL LANZAMIENTO (desde el 22-11-2026).
 *
 * Las tres ventanas de Product Hunt (aviso, en vivo dos semanas, BiVelio), sus
 * fronteras al milisegundo y el temporizador que las cruza; lo que pinta la
 * franja en el servidor con las plataformas del registro; los cortes de línea
 * y el guion previo de la insignia. El reparto al azar entre la franja y la
 * tarjeta se prueba en lib/plataformas-de-lanzamiento.test.ts.
 */

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

describe("elegirVariante: las tres ventanas", () => {
  it("el lanzamiento es el domingo 22 a las 9:00 de Andorra = 08:00Z = 00:00 PT", () => {
    expect(new Date(LANZAMIENTO).toISOString()).toBe("2026-11-22T08:00:00.000Z");
    // Dos semanas justas (decisión del dueño, 20-11): hasta el domingo 6 de diciembre.
    expect(new Date(FIN_CAMPANA).toISOString()).toBe("2026-12-06T08:00:00.000Z");
    expect(FIN_CAMPANA - LANZAMIENTO).toBe(14 * 24 * 60 * 60 * 1000);
    // Las fechas son las del registro de plataformas.
    expect([LANZAMIENTO, FIN_CAMPANA]).toEqual([plataforma("product-hunt")!.desde, plataforma("product-hunt")!.hasta]);
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

  it("desde el 6-12 a las 08:00Z, la franja de BiVelio de siempre", () => {
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

  const HOY = Date.UTC(2026, 10, 20, 12);
  const enlaces = (html: string) => [...html.matchAll(/<a ([^>]*)>/g)].map((m) => m[1]!);

  it("antes del lanzamiento: una pieza por plataforma y estado que aún puede tocar, y la de BiVelio; solo una visible", () => {
    const html = pinta({ construido: HOY, fechas: fechasDeAviso(HOY, "en") });
    // El reparto del servidor (sin azar): la primera del registro, en la franja.
    expect(html).toContain('class="announce announce--lz"');
    expect(html).toContain('data-variante="product-hunt:antes"');
    expect(html).toContain('style="--lz-fondo:#FF6154;--lz-texto:#0F1218"');
    expect(html.match(/data-lz="[^"]+"/g)).toEqual(['data-lz="product-hunt:antes"', 'data-lz="product-hunt:durante"', 'data-lz="devhunt:durante"']);
    expect(html).toContain(atado(`We're launching on Product Hunt ${fechaAtada("Sunday, November 22")} — get `).replace("'", "&#x27;"));
    expect(html).toContain(atado("Savings Layer is live on Product Hunt — support "));
    expect(html).toContain("Savings Layer is live on DevHunt\u00A0— support ");
    expect(html).toContain("Savings Layer is part of the BiVelio platform");
    // Cuatro enlaces apilados, uno visible: los otros tres, fuera del foco y del árbol accesible.
    const as = enlaces(html);
    expect(as).toHaveLength(4);
    expect(as.filter((a) => a.includes('data-oculta="true"') && a.includes('aria-hidden="true"'))).toHaveLength(3);
    expect(as.find((a) => !a.includes("data-oculta"))).toContain('data-lz="product-hunt:antes"');
    // La última palabra y la flecha van juntas, sin poder partir.
    expect(html).toMatch(/get <span class="announce-cola">notified(<!-- -->)?\u00A0<svg/);
    expect(html).toContain(URL_PRODUCT_HUNT.replace(/&/g, "&amp;"));
    expect(html).toContain('href="https://devhunt.org/tool/bivelio-savings-layer"');
    expect(html).toContain('target="_blank" rel="noopener"');
    expect(html).toContain("(opens in a new tab)");
    // El botón de cerrar sigue ahí, con su nombre.
    expect(html).toMatch(/<button[^>]*class="announce-close"[^>]*aria-label="Close"/);
  });

  it("durante la campaña: el «avísame» de Product Hunt ya no está en la pila", () => {
    const html = pinta({ construido: LANZAMIENTO + DIA, fechas: {} });
    expect(html.match(/data-lz="[^"]+"/g)).toEqual(['data-lz="product-hunt:durante"', 'data-lz="devhunt:durante"']);
    expect(html).toContain('data-variante="product-hunt:durante"');
    expect(html).not.toContain("get notified");
  });

  it("cada plataforma lleva su icono, sus trazos tal cual", () => {
    const html = pinta({ construido: HOY, fechas: fechasDeAviso(HOY, "en") });
    for (const p of PLATAFORMAS) {
      expect(html).toContain(`viewBox="${p.icono.viewBox}"`);
      for (const d of p.icono.trazos) expect(html).toContain(`d="${d}"`);
    }
    expect(html.match(/class="announce-voto"/g)).toHaveLength(3);
  });

  it("después de la campaña la franja es la de siempre: sin rastro de las plataformas", () => {
    const html = pinta({ construido: finDeTodas() });
    expect(html).toContain('class="announce"');
    expect(html).not.toMatch(/Product.Hunt|DevHunt/);
    expect(html).not.toContain("data-oculta");
    expect(html).not.toContain("data-lz=");
    expect(html).not.toContain("style=");
    expect(html).toContain('data-variante="bivelio"');
    expect(html).toContain('href="https://bivelio.com/en"');
    expect(enlaces(html)).toHaveLength(1);
  });

  it("sin props (otro montaje) se comporta como antes", () => {
    expect(pinta({})).toBe(pinta({ construido: finDeTodas() + 365 * DIA }));
  });

  it("la ✕ recuerda el cierre en la pestaña (sessionStorage) y la franja no cambia bajo el cursor", () => {
    const fuente = readFileSync(fileURLToPath(new URL("./AnnouncementBar.tsx", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(fuente).toContain("window.sessionStorage.setItem(CLAVE_FRANJA_CERRADA, \"1\")");
    expect(fuente).toContain("window.sessionStorage.getItem(CLAVE_FRANJA_CERRADA) === \"1\"");
    expect(fuente).not.toContain("localStorage");
    expect(fuente).toContain("onMouseEnter={retener(true)}");
    expect(fuente).toContain("onFocus={retener(true)}");
    // El primer render es el del servidor: la rotación se lee con useSyncExternalStore.
    expect(fuente).toContain("useSyncExternalStore(suscribirRotacion, leerRotacion, leerRotacionEnServidor)");
  });
});

describe("los cortes de línea en móvil", () => {
  it("los nombres de plataforma con espacios no se parten: salen del registro", () => {
    for (const p of PLATAFORMAS) {
      const pegado = p.nombre.replace(/ /g, "\u00A0");
      expect(atado(`Find us on ${p.nombre}`)).toBe(`Find us on ${pegado}`);
    }
  });

  it("«Product Hunt» no se parte y la raya no abre línea", () => {
    expect(atado("Savings Layer ya está en Product Hunt — apóyanos")).toBe("Savings Layer ya está en Product\u00A0Hunt\u00A0— apóyanos");
    expect(atado("Wir starten am X auf Product Hunt – lass dich erinnern")).toBe("Wir starten am X auf Product\u00A0Hunt\u00A0– lass dich erinnern");
  });
});

describe("la fecha no se parte entre el número y el mes", () => {
  it("el día va pegado al mes; el día de la semana puede quedarse en la línea de antes", () => {
    expect(fechaAtada("domingo, 22 de noviembre")).toBe("domingo, 22\u00A0de\u00A0noviembre");
    expect(fechaAtada("niedziela, 22 listopada")).toBe("niedziela, 22\u00A0listopada");
    expect(fechaAtada("Chủ Nhật, 22 tháng 11")).toBe("Chủ Nhật, 22\u00A0tháng\u00A011");
    expect(fechaAtada("domenica 22 novembre")).toBe("domenica 22\u00A0novembre");
    expect(fechaAtada("Sonntag, 22. November")).toBe("Sonntag, 22.\u00A0November");
    expect(fechaAtada("22 Kasım Pazar")).toBe("22\u00A0Kasım\u00A0Pazar");
    expect(fechaAtada("Sunday, November 22")).toBe("Sunday, November\u00A022");
    expect(fechaAtada("sin número")).toBe("sin número");
  });

  it.each(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"])("%s: nada puede partir entre el número y el mes", (loc) => {
    const f = fechaAtada(fechaDelLanzamiento(loc));
    expect(f).not.toMatch(/\d\.? /);
    expect(f).not.toMatch(/ \d+$/);
    expect(f.slice(f.search(/\d/))).not.toContain(" ");
  });
});

describe("la flecha no se queda sola en la última línea", () => {
  it("parte por el último espacio normal (los de no separación no cuentan)", () => {
    expect(partirCola("Savings Layer ja és a Product\u00A0Hunt\u00A0— dona'ns suport")).toEqual([
      "Savings Layer ja és a Product\u00A0Hunt\u00A0— dona'ns ",
      "suport",
    ]);
    expect(partirCola("sola")).toEqual(["", "sola"]);
  });

  it("la cola no parte: white-space nowrap en globals.css", () => {
    const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.announce-cola\s*\{\s*white-space:\s*nowrap;?\s*\}/);
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

describe("la fecha del lanzamiento, en los 12 idiomas", () => {
  const DIR = fileURLToPath(new URL("../../messages/", import.meta.url));
  const locales = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

  it("son los 12", () => expect(locales.sort()).toEqual(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]));

  it.each(locales)("%s: la fecha sale con el domingo en su idioma y el día 22", (loc) => {
    const fecha = fechaDelLanzamiento(loc);
    const domingo = new Intl.DateTimeFormat(loc, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 10, 22, 12));
    expect(fecha.toLowerCase()).toContain(domingo.toLowerCase());
    expect(fecha).toContain("22");
    // La que viaja a la franja es la misma.
    expect(fechasDeAviso(Date.UTC(2026, 10, 20), loc)).toEqual({ "product-hunt": fecha });
  });

  it("la fecha en algunos idiomas, tal cual", () => {
    expect(fechaDelLanzamiento("en")).toBe("Sunday, November 22");
    expect(fechaDelLanzamiento("es")).toBe("domingo, 22 de noviembre");
    expect(fechaDelLanzamiento("de")).toBe("Sonntag, 22. November");
  });
});

describe("la franja toma el color de la plataforma", () => {
  const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("fondo y texto salen de las variables que pone el componente", () => {
    expect(css).toMatch(/\.announce--lz\s*\{\s*background:\s*var\(--lz-fondo\);\s*color:\s*var\(--lz-texto\);\s*\}/);
    expect(css).toMatch(/\.announce--lz a\s*\{\s*color:\s*var\(--lz-texto\);/);
    expect(css).toMatch(/\.announce--lz a:focus-visible, \.announce--lz \.announce-close:focus-visible\s*\{\s*outline-color:\s*var\(--lz-texto\);/);
    // La ✕ al 72 % del color del texto (≥ 3:1: lo mide la prueba del registro).
    expect(css).toMatch(/\.announce--lz \.announce-close\s*\{\s*color:\s*color-mix\(in srgb, var\(--lz-texto\) 72%, transparent\);/);
    expect(css).not.toContain("announce--ph");
  });

  it("el cambio de plataforma se funde, y con movimiento reducido no se anima", () => {
    expect(css).toMatch(/\.announce\s*\{\s*transition:\s*background-color [^;]+, color [^;]+;\s*\}/);
    expect(css).toMatch(/\.announce-pila > \[data-oculta\]\s*\{\s*opacity:\s*0;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.announce, \.announce-pila > \*, \.announce-pila > \[data-oculta\]\s*\{\s*transition:\s*none;/);
    // Las que no tocan siguen sin verse ni enfocarse.
    expect(css).toMatch(/\.announce-pila > \[data-oculta\]\s*\{\s*visibility:\s*hidden;\s*\}/);
  });
});

describe("el motor del cliente (programarFranja), con relojes falsos", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const reloj = () => ({
    ahora: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });

  it("dispara justo al cruzar la frontera de las 08:00Z, y no antes", () => {
    vi.setSystemTime(LANZAMIENTO - 3_000);
    const vistas: Variante[] = [];
    const franja = programarFranja("aviso", (v) => vistas.push(v), reloj());
    expect(franja.variante()).toBe("aviso");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3_000);
    expect(vistas).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(vistas).toEqual(["en-vivo"]);
    expect(franja.variante()).toBe("en-vivo");
    // Y deja programada la siguiente, la del 29.
    expect(vi.getTimerCount()).toBe(1);
    franja.cancelar();
  });

  it("encadena la espera por encima del máximo de setTimeout y llega al 6 de diciembre", () => {
    vi.setSystemTime(Date.UTC(2026, 9, 1));
    const vistas: Variante[] = [];
    const franja = programarFranja("aviso", (v) => vistas.push(v), reloj());
    vi.advanceTimersByTime(FIN_CAMPANA - Date.UTC(2026, 9, 1) + 1);
    expect(vistas).toEqual(["en-vivo", "bivelio"]);
    // Con la de BiVelio ya no queda nada programado.
    expect(vi.getTimerCount()).toBe(0);
    franja.cancelar();
  });

  it("al montar con un build viejo, corrige en el acto", () => {
    vi.setSystemTime(LANZAMIENTO + DIA);
    const vistas: Variante[] = [];
    const franja = programarFranja("aviso", (v) => vistas.push(v), reloj());
    expect(vistas).toEqual(["en-vivo"]);
    expect(franja.variante()).toBe("en-vivo");
    franja.cancelar();
  });

  it("un reloj atrasado no devuelve la franja a una ventana que ya pasó", () => {
    vi.setSystemTime(LANZAMIENTO - DIA);
    const vistas: Variante[] = [];
    const enVivo = programarFranja("en-vivo", (v) => vistas.push(v), reloj());
    expect(enVivo.variante()).toBe("en-vivo");
    vi.advanceTimersByTime(DIA + 1);
    enVivo.reevaluar();
    expect(vistas).toEqual([]);
    expect(enVivo.variante()).toBe("en-vivo");
    enVivo.cancelar();

    const bivelio = programarFranja("bivelio", (v) => vistas.push(v), reloj());
    expect(bivelio.variante()).toBe("bivelio");
    expect(vi.getTimerCount()).toBe(0);
    bivelio.cancelar();
    expect(vistas).toEqual([]);
  });

  it("reevaluar (al volver a la pestaña) no deja dos temporizadores", () => {
    vi.setSystemTime(LANZAMIENTO - HORA);
    const franja = programarFranja("aviso", () => {}, reloj());
    franja.reevaluar();
    franja.reevaluar();
    expect(vi.getTimerCount()).toBe(1);
    franja.cancelar();
  });

  it("cancelar (al desmontar) limpia el temporizador y ya no avisa", () => {
    vi.setSystemTime(LANZAMIENTO - 1_000);
    const vistas: Variante[] = [];
    const franja = programarFranja("aviso", (v) => vistas.push(v), reloj());
    franja.cancelar();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    franja.reevaluar();
    expect(vistas).toEqual([]);
  });
});

describe("el primer pintado de la insignia en las páginas sin ISR (guion previo)", () => {
  /** Ejecuta el guion como lo haría el navegador, con un reloj y un documento falsos. */
  const ejecutar = (guion: string, ahora: number, { sinHojas = false } = {}) => {
    class Hoja {
      css = "";
      constructor() {
        if (sinHojas) throw new TypeError("Illegal constructor");
      }
      replaceSync(css: string) {
        this.css = css;
      }
    }
    const previa = { css: "otra" };
    const doc = { adoptedStyleSheets: [previa] as unknown[] };
    const win: Record<string, unknown> = {};
    new Function("Date", "document", "CSSStyleSheet", "window", guion)({ now: () => ahora }, doc, Hoja, win);
    const puestas = doc.adoptedStyleSheets.filter((h) => h !== previa) as { css: string }[];
    return { doc, win, previa, css: puestas.map((h) => h.css) };
  };

  const instantes = [0, LANZAMIENTO - 1, LANZAMIENTO, LANZAMIENTO + DIA, FIN_CAMPANA - 1, FIN_CAMPANA, FIN_CAMPANA + 30 * DIA, NaN];

  it.each(["aviso", "en-vivo"] as const)("build en «%s»: en cada frontera pinta lo mismo que elegirá el cliente", (inicial) => {
    const guion = guionPrevio(inicial)!;
    for (const t of instantes) {
      const toca = laMasAvanzada(inicial, elegirVariante(t));
      const { css } = ejecutar(guion, t);
      // La hoja de la insignia de Product Hunt (la franja y la tarjeta van en el guion del registro).
      expect(css, new Date(t).toString()).toEqual(toca === inicial ? [] : [hojaDelGuion(inicial, toca)]);
    }
  });

  it("después de la campaña no hay guion: la página es la de siempre", () => {
    expect(guionPrevio("bivelio")).toBeNull();
  });

  it("la hoja solo toca la insignia; nada que cierre la etiqueta <script> ni abra un comentario HTML", () => {
    expect(hojaDelGuion("aviso", "aviso")).toBe("");
    expect(hojaDelGuion("en-vivo", "aviso")).toBe("");
    for (const [de, a] of [["aviso", "en-vivo"], ["aviso", "bivelio"], ["en-vivo", "bivelio"]] as const) {
      expect(hojaDelGuion(de, a)).toMatch(/^(\.ph-insignia\[data-ph(-espera)?="(heroe|pie)"\]\{display:(block|none)\})+$/);
    }
    for (const v of VARIANTES) expect(guionPrevio(v) ?? "").not.toMatch(/<\/|<!--|announce/);
  });

  it("sin hojas construidas (navegador viejo) no rompe nada: se corrige al hidratar", () => {
    const { css, win } = ejecutar(guionPrevio("aviso")!, LANZAMIENTO + DIA, { sinHojas: true });
    expect(css).toEqual([]);
    expect(win[CLAVE_HOJA_PREVIA]).toBeUndefined();
  });

  it("al montar, el componente retira la hoja del guion y deja las demás", () => {
    const { doc, win, previa } = ejecutar(guionPrevio("aviso")!, FIN_CAMPANA + DIA);
    expect(doc.adoptedStyleSheets).toHaveLength(2);
    retirarHojaPrevia(doc as unknown as { adoptedStyleSheets: CSSStyleSheet[] }, win);
    expect(doc.adoptedStyleSheets).toEqual([previa]);
    expect(win[CLAVE_HOJA_PREVIA]).toBeUndefined();
    // Sin hoja que retirar, no hace nada.
    retirarHojaPrevia(doc as unknown as { adoptedStyleSheets: CSSStyleSheet[] }, win);
    expect(doc.adoptedStyleSheets).toEqual([previa]);
  });
});

describe("qué páginas congelan la variante del build", () => {
  const RAIZ = fileURLToPath(new URL("../[locale]/", import.meta.url));
  const fuentes = (dir: string) =>
    readdirSync(`${RAIZ}${dir}`)
      .filter((f) => /^(page|layout)\.tsx$/.test(f))
      .map((f) => readFileSync(`${RAIZ}${dir}/${f}`, "utf8"))
      .join("\n");
  const rutas = readdirSync(RAIZ, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("[") && !d.name.startsWith("captura") && d.name !== "components")
    .map((d) => d.name)
    .filter((d) => readdirSync(`${RAIZ}${d}`).includes("page.tsx"));
  const conIsr = (d: string) => /export const revalidate = \d+/.test(fuentes(d));
  const dinamica = (d: string) => /export const dynamic = "force-dynamic"/.test(fuentes(d));

  it("solo la portada y precios se regeneran; las demás públicas llevan el HTML del despliegue", () => {
    expect(/export const revalidate = 3600/.test(readFileSync(`${RAIZ}page.tsx`, "utf8"))).toBe(true);
    expect(conIsr("pricing")).toBe(true);
    const congeladas = rutas.filter((d) => !conIsr(d) && !dinamica(d));
    // Si alguna de estas pasa a tener ISR, mejor; si aparece otra sin él, el
    // guion previo la cubre igual (va en NavBar, que monta el layout).
    expect(congeladas).toEqual(expect.arrayContaining(["benchmarks", "how-it-works", "migrate-to-0.5", "paper", "privacy"]));
  });

  it("por eso NavBar emite los dos guiones ANTES de la franja, con el mismo reloj que le pasa", () => {
    const nav = readFileSync(fileURLToPath(new URL("./NavBar.tsx", import.meta.url)), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const guion = nav.indexOf("<script dangerouslySetInnerHTML={{ __html: guion }} />");
    const insignia = nav.indexOf("<script dangerouslySetInnerHTML={{ __html: guionInsignia }} />");
    const franja = nav.indexOf("<AnnouncementBar construido={construido}");
    expect(guion).toBeGreaterThan(-1);
    expect(insignia).toBeGreaterThan(guion);
    expect(franja).toBeGreaterThan(insignia);
    expect(nav).toContain("const construido = Date.now();");
    expect(nav).toContain("guionDeLanzamiento(construido)");
    expect(nav).toContain("guionPrevio(elegirVariante(construido))");
  });
});

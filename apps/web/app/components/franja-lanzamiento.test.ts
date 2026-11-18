import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnnouncementBar } from "./AnnouncementBar";
import {
  CLAVE_HOJA_PREVIA,
  DESHACER_PH,
  FIN_CAMPANA,
  LANZAMIENTO,
  VARIANTES,
  fechaAtada,
  guionPrevio,
  partirCola,
  hojaPrevia,
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
    expect(html).toContain(atado(`We're launching on Product Hunt ${fechaAtada("Sunday, November 22")} — get `).replace("'", "&#x27;"));
    expect(html).toContain(atado("Savings Layer is live on Product Hunt — support "));
    expect(html).toContain("Savings Layer is part of the BiVelio platform");
    expect(html.match(/data-oculta="true"/g)).toHaveLength(2);
    expect(html.match(/data-v="(aviso|en-vivo|bivelio)"/g)).toEqual(['data-v="aviso"', 'data-v="en-vivo"', 'data-v="bivelio"']);
    // La última palabra y la flecha van juntas, sin poder partir.
    expect(html).toMatch(/get <span class="announce-cola">notified(<!-- -->)?\u00A0<svg/);
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
    expect(html).not.toContain("data-v=");
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

  it("encadena la espera por encima del máximo de setTimeout y llega al 29", () => {
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

describe("el primer pintado de las páginas sin ISR (guion previo)", () => {
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
      // La hoja de la franja más la de la insignia y la tarjeta de Product Hunt.
      expect(css, new Date(t).toString()).toEqual(toca === inicial ? [] : [hojaDelGuion(inicial, toca)]);
      if (toca !== inicial) expect(css[0]!.startsWith(hojaPrevia(inicial, toca))).toBe(true);
    }
  });

  it("después de la campaña no hay guion: la página es la de siempre", () => {
    expect(guionPrevio("bivelio")).toBeNull();
  });

  it("la hoja esconde lo que ya pasó, enseña lo que toca y deshace el coral solo para BiVelio", () => {
    expect(hojaPrevia("aviso", "aviso")).toBe("");
    expect(hojaPrevia("en-vivo", "aviso")).toBe("");
    expect(hojaPrevia("aviso", "en-vivo")).toBe(
      '.announce-pila>[data-v="aviso"]{display:none}.announce-pila>[data-v="en-vivo"]{visibility:visible}',
    );
    const aBivelio = hojaPrevia("aviso", "bivelio");
    expect(aBivelio).toContain('[data-v="aviso"]{display:none}');
    expect(aBivelio).toContain('[data-v="en-vivo"]{display:none}');
    expect(aBivelio).toContain('[data-v="bivelio"]{visibility:visible}');
    expect(aBivelio).toContain(DESHACER_PH);
    // Nada que cierre la etiqueta <script> ni abra un comentario HTML.
    for (const v of VARIANTES) expect(guionPrevio(v) ?? "").not.toMatch(/<\/|<!--/);
  });

  it("deshace el coral con los mismos colores de la franja de BiVelio en globals.css", () => {
    const css = readFileSync(fileURLToPath(new URL("../globals.css", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, "");
    const cuerpo = (sel: string) => css.match(new RegExp(`(?:^|\\})${sel.replace(/[.]/g, "\\.")}\\{([^}]*)\\}`))![1]!;
    const deshacer = DESHACER_PH.replace(/\s+/g, "");
    expect(cuerpo(".announce")).toContain("background:var(--ink)");
    expect(cuerpo(".announce")).toContain("color:#fff");
    expect(deshacer).toContain(".announce--ph{background:var(--ink);color:#fff}");
    const enlace = cuerpo(".announcea").match(/(?:^|;)color:([^;]+)/)![1]!;
    expect(deshacer).toContain(`.announce--pha{color:${enlace};`);
    const cerrar = cuerpo(".announce-close").match(/(?:^|;)color:([^;]+)/)![1]!;
    expect(deshacer).toContain(`.announce--ph.announce-close{color:${cerrar}}`);
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

  it("por eso NavBar emite el guion previo ANTES de la franja", () => {
    const nav = readFileSync(fileURLToPath(new URL("./NavBar.tsx", import.meta.url)), "utf8").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const guion = nav.indexOf("<script dangerouslySetInnerHTML={{ __html: guion }} />");
    const franja = nav.indexOf("<AnnouncementBar inicial={inicial}");
    expect(guion).toBeGreaterThan(-1);
    expect(franja).toBeGreaterThan(guion);
    expect(nav).toContain("guionPrevio(inicial)");
  });
});

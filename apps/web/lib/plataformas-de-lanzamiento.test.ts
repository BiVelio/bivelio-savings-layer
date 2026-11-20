import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it } from "vitest";

import { crearRotacion } from "../app/components/rotacion-lanzamiento";
import {
  CLAVE_FRANJA_CERRADA,
  CLAVE_LANZAMIENTO,
  PLATAFORMAS,
  barajar,
  esOrdenValido,
  estadoDe,
  fechasDeAviso,
  filasDe,
  finDeTodas,
  fronteras,
  guionDeLanzamiento,
  nombreAtado,
  ordenPorDefecto,
  piezasDeFranja,
  piezasDeTarjeta,
  plataforma,
  repartir,
  repartoDelServidor,
  retirarHojaDeLanzamiento,
  siguienteFronteraDe,
  textoDe,
  textosDeTarjeta,
  type Plataforma,
  type Traductor,
} from "./plataformas-de-lanzamiento";

/**
 * EL REGISTRO DE PLATAFORMAS DE LANZAMIENTO Y SU REPARTO.
 *
 * La franja de arriba y la tarjeta del final de la portada enseñan las
 * plataformas del registro: al azar en cada carga, una en cada hueco y nunca
 * la misma. Aquí se prueban las fechas (dos semanas desde el 22-11), el
 * reparto con 1, 2 y N plataformas, que el guion en línea pinte lo mismo que
 * calcularán los componentes, los textos en los 12 idiomas y lo que exige el
 * registro a cada entrada (para que añadir una no rompa nada en silencio).
 */

const DIA = 24 * 60 * 60 * 1000;
const WEB = fileURLToPath(new URL("../", import.meta.url));
const LANZAMIENTO = Date.UTC(2026, 10, 22, 8);
const FIN = Date.UTC(2026, 11, 6, 8);
const HOY = Date.UTC(2026, 10, 20, 12);
const PH = plataforma("product-hunt")!;
const DH = plataforma("devhunt")!;

/** Una plataforma inventada, para probar con N. */
const inventada = (id: string, extra: Partial<Plataforma> = {}): Plataforma => ({
  id,
  nombre: id.toUpperCase(),
  ficha: { franja: `https://example.com/${id}`, tarjeta: `https://example.com/${id}` },
  desde: LANZAMIENTO,
  hasta: FIN,
  aviso: false,
  color: { fondo: "#000000", texto: "#FFFFFF", realce: "#111111" },
  icono: { viewBox: "0 0 1 1", trazos: ["M0 0h1v1z"] },
  ...extra,
});

describe("el registro", () => {
  it("Product Hunt y DevHunt, por este orden (la primera es la de la franja sin JavaScript)", () => {
    expect(PLATAFORMAS.map((p) => p.id)).toEqual(["product-hunt", "devhunt"]);
    expect(ordenPorDefecto()).toEqual(["product-hunt", "devhunt"]);
  });

  it("Product Hunt: del domingo 22-11 a las 08:00Z al domingo 6-12 a las 08:00Z, con aviso previo", () => {
    expect(new Date(PH.desde).toISOString()).toBe("2026-11-22T08:00:00.000Z");
    expect(new Date(PH.hasta).toISOString()).toBe("2026-12-06T08:00:00.000Z");
    expect(PH.hasta - PH.desde).toBe(14 * DIA);
    expect(PH.aviso).toBe(true);
  });

  it("DevHunt: ya publicada, sin aviso previo, y acaba con Product Hunt", () => {
    expect(DH.desde).toBeLessThan(HOY);
    expect(DH.hasta).toBe(PH.hasta);
    expect(DH.aviso).toBe(false);
    expect(DH.ficha.franja).toBe("https://devhunt.org/tool/bivelio-savings-layer");
    expect(finDeTodas()).toBe(FIN);
  });

  it("los enlaces de Product Hunt llevan los UTM de la web, no los de LinkedIn ni X", () => {
    const u = new URL(PH.ficha.franja);
    expect(u.origin + u.pathname).toBe("https://www.producthunt.com/products/bivelio-savings-layer");
    expect(Object.fromEntries(u.searchParams)).toEqual({ utm_source: "savings-site", utm_medium: "announcement-bar", utm_campaign: "launch" });
    expect(PH.ficha.tarjeta).toBe("https://www.producthunt.com/products/bivelio-savings-layer?embed=true&utm_source=embed&utm_medium=post_embed");
    for (const p of PLATAFORMAS) expect(p.ficha.franja + p.ficha.tarjeta).not.toMatch(/linkedin|twitter/i);
  });

  describe.each(PLATAFORMAS.map((p) => [p.id, p] as const))("lo que se le pide a cada entrada: %s", (_id, p) => {
    const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
    const contraste = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x! + 0.05) / (y! + 0.05);
    };

    it("id para atributos y claves, único; nombre; fichas https", () => {
      expect(p.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(PLATAFORMAS.filter((x) => x.id === p.id)).toHaveLength(1);
      expect(p.nombre.trim()).toBe(p.nombre);
      expect(p.nombre.length).toBeGreaterThan(1);
      for (const url of [p.ficha.franja, p.ficha.tarjeta]) expect(new URL(url).protocol).toBe("https:");
    });

    it("fechas en orden", () => {
      expect(Number.isFinite(p.desde) && Number.isFinite(p.hasta)).toBe(true);
      expect(p.hasta).toBeGreaterThan(p.desde);
    });

    it("colores en hexadecimal; el texto pasa AA sobre el fondo y sobre el realce, y la ✕ al 72 % queda ≥ 3:1", () => {
      for (const c of Object.values(p.color)) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
      const [fondo, texto, realce] = [rgb(p.color.fondo), rgb(p.color.texto), rgb(p.color.realce)];
      expect(contraste(fondo, texto)).toBeGreaterThanOrEqual(4.5);
      expect(contraste(realce, texto)).toBeGreaterThanOrEqual(4.5);
      const cerrar = texto.map((c, i) => c * 0.72 + fondo[i]! * 0.28);
      expect(contraste(fondo, cerrar)).toBeGreaterThanOrEqual(3);
    });

    it("el icono son trazos SVG, sin nada más", () => {
      expect(p.icono.viewBox).toMatch(/^0 0 \d+ \d+$/);
      expect(p.icono.trazos.length).toBeGreaterThan(0);
      for (const d of p.icono.trazos) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
    });

    it("si da insignia, el SVG está en public/, mide lo que dice y no ejecuta ni pide nada", () => {
      if (!p.insignia) return;
      for (const ruta of [p.insignia.claro, p.insignia.oscuro].filter((x): x is string => Boolean(x))) {
        expect(ruta).toMatch(/^\/brand\/[a-z0-9-]+\.svg$/);
        const svg = readFileSync(`${WEB}public${ruta}`, "utf8");
        expect(svg).toContain(`width="${p.insignia.width}" height="${p.insignia.height}"`);
        expect(svg).not.toMatch(/<script|<foreignObject|<image|<use|\son[a-z]+=|href=|url\(|@import|<style/i);
        expect(statSync(`${WEB}public${ruta}`).size).toBeLessThan(20_000);
      }
      expect(new URL(p.insignia.origen).protocol).toBe("https:");
    });
  });

  it("el coral de Product Hunt: el blanco no pasaría AA; con tinta da 6,33:1", () => {
    expect(PH.color).toEqual({ fondo: "#FF6154", texto: "#0F1218", realce: "#FF7366" });
  });
});

describe("el estado de cada plataforma en el tiempo", () => {
  it("Product Hunt: antes (avísame), durante dos semanas, después", () => {
    expect(estadoDe(PH, HOY)).toBe("antes");
    expect(estadoDe(PH, LANZAMIENTO - 1)).toBe("antes");
    expect(estadoDe(PH, LANZAMIENTO)).toBe("durante");
    expect(estadoDe(PH, Date.UTC(2026, 10, 29, 8))).toBe("durante");
    expect(estadoDe(PH, FIN - 1)).toBe("durante");
    expect(estadoDe(PH, FIN)).toBe("despues");
  });

  it("DevHunt: durante desde ya, hasta el mismo final", () => {
    expect(estadoDe(DH, HOY)).toBe("durante");
    expect(estadoDe(DH, FIN - 1)).toBe("durante");
    expect(estadoDe(DH, FIN)).toBe("despues");
  });

  it("sin aviso previo, una plataforma no se enseña hasta que abre", () => {
    const p = inventada("x", { desde: LANZAMIENTO + 3 * DIA });
    expect(estadoDe(p, LANZAMIENTO)).toBeNull();
    expect(estadoDe(p, LANZAMIENTO + 3 * DIA)).toBe("durante");
  });

  it("un reloj roto no deja anunciando nada", () => {
    for (const p of PLATAFORMAS) expect(estadoDe(p, Number.NaN)).toBe("despues");
    expect(siguienteFronteraDe(Number.NaN)).toBeNull();
    expect(repartoDelServidor(Number.NaN).franja).toBeNull();
  });

  it("las fronteras salen del registro, ordenadas y sin repetir", () => {
    expect(fronteras()).toEqual([DH.desde, LANZAMIENTO, FIN]);
    expect(siguienteFronteraDe(HOY)).toBe(LANZAMIENTO);
    expect(siguienteFronteraDe(LANZAMIENTO)).toBe(FIN);
    expect(siguienteFronteraDe(FIN)).toBeNull();
  });

  it("qué piezas lleva el HTML según cuándo se renderizó", () => {
    expect(piezasDeFranja(HOY).map((p) => `${p.id}:${p.estado}`)).toEqual(["product-hunt:antes", "product-hunt:durante", "devhunt:durante"]);
    expect(piezasDeFranja(LANZAMIENTO).map((p) => `${p.id}:${p.estado}`)).toEqual(["product-hunt:durante", "devhunt:durante"]);
    expect(piezasDeFranja(FIN)).toEqual([]);
    expect(piezasDeFranja(Number.NaN)).toEqual([]);
    // La tarjeta conserva todas las plataformas, también después de la campaña.
    expect(piezasDeTarjeta(HOY)).toEqual([{ id: "product-hunt", conAviso: true }, { id: "devhunt", conAviso: false }]);
    expect(piezasDeTarjeta(FIN + DIA)).toEqual([{ id: "product-hunt", conAviso: false }, { id: "devhunt", conAviso: false }]);
  });
});

describe("el reparto: la franja y la tarjeta nunca enseñan la misma", () => {
  const F = filasDe();
  const r = (t: number, orden: string[], k = 0) => repartir(F, t, t, orden, k);

  it("sin azar (el HTML del servidor): Product Hunt en la franja y DevHunt en la tarjeta", () => {
    expect(repartoDelServidor(HOY)).toMatchObject({ franja: "product-hunt", estadoFranja: "antes", tarjeta: "devhunt", boton: "vivo" });
    expect(repartoDelServidor(LANZAMIENTO)).toMatchObject({ franja: "product-hunt", estadoFranja: "durante", tarjeta: "devhunt" });
  });

  it("con el otro orden, al revés: DevHunt arriba y Product Hunt en la tarjeta (antes del domingo, con «avísame»)", () => {
    expect(r(HOY, ["devhunt", "product-hunt"])).toMatchObject({ franja: "devhunt", estadoFranja: "durante", tarjeta: "product-hunt", boton: "antes" });
    expect(r(LANZAMIENTO, ["devhunt", "product-hunt"])).toMatchObject({ franja: "devhunt", tarjeta: "product-hunt", boton: "vivo" });
  });

  it("al avanzar el carrusel, la franja toma la que la tarjeta suelta: Product Hunt siempre a la vista", () => {
    for (const orden of [["product-hunt", "devhunt"], ["devhunt", "product-hunt"]]) {
      for (let k = -4; k <= 9; k++) {
        const x = r(LANZAMIENTO + DIA, orden, k);
        expect(x.franja).not.toBe(x.tarjeta);
        expect([x.franja, x.tarjeta]).toContain("product-hunt");
        if (k > -4) expect(x.franja).toBe(r(LANZAMIENTO + DIA, orden, k - 1).tarjeta);
      }
    }
  });

  it("después de la campaña: la franja vuelve a ser la de BiVelio y la tarjeta sigue con las dos", () => {
    const x = r(FIN, ["devhunt", "product-hunt"]);
    expect(x.franja).toBeNull();
    expect(x.enTarjeta).toEqual(["devhunt", "product-hunt"]);
    expect(x.tarjeta).toBe("product-hunt");
    expect(x.boton).toBe("vivo");
    expect(x.hojaFranja).toContain(".announce-pila>:not([data-lz]){visibility:visible;opacity:1}");
    expect(x.hojaFranja).toContain(".announce{background:#0F1218;color:#fff}");
  });

  it.each([1, 2, 3, 4, 5, 7])("con %i plataformas: en cada paso la tarjeta las recorre todas y la franja es otra", (n) => {
    const lista = Array.from({ length: n }, (_, i) => inventada(`p${i}`));
    const filas = filasDe(lista);
    for (let semilla = 0; semilla < 6; semilla++) {
      let s = semilla + 1;
      const orden = barajar(ordenPorDefecto(lista), () => (s = (s * 16807) % 2147483647) / 2147483647);
      expect(esOrdenValido(orden, lista)).toBe(true);
      const vistas = new Set<string>();
      for (let k = 0; k < n; k++) {
        const x = repartir(filas, LANZAMIENTO, LANZAMIENTO, orden, k);
        vistas.add(x.tarjeta!);
        if (n === 1) expect(x.franja).toBe(x.tarjeta);
        else {
          expect(x.franja).not.toBe(x.tarjeta);
          expect(x.franja).toBe(repartir(filas, LANZAMIENTO, LANZAMIENTO, orden, k - 1).tarjeta);
        }
      }
      expect(vistas.size).toBe(n);
      // Y vuelve a empezar.
      expect(repartir(filas, LANZAMIENTO, LANZAMIENTO, orden, n).tarjeta).toBe(repartir(filas, LANZAMIENTO, LANZAMIENTO, orden, 0).tarjeta);
    }
  });

  it("con fechas distintas: la franja salta las que ya acabaron; la tarjeta las conserva", () => {
    const lista = [inventada("a"), inventada("b", { hasta: LANZAMIENTO + 2 * DIA }), inventada("c", { desde: LANZAMIENTO + 5 * DIA })];
    const filas = filasDe(lista);
    const t = LANZAMIENTO + 3 * DIA; // b acabó; c aún no abrió (sin aviso: no se enseña)
    const x0 = repartir(filas, t, t, ["a", "b", "c"], 0);
    expect(x0.enTarjeta).toEqual(["a", "b"]);
    expect(x0).toMatchObject({ tarjeta: "b", franja: "a" });
    // La tarjeta en «a»: la anterior (b) ya acabó, así que la franja no tiene otra que «a».
    expect(repartir(filas, t, t, ["a", "b", "c"], 1)).toMatchObject({ tarjeta: "a", franja: "a" });
    const t2 = LANZAMIENTO + 6 * DIA; // c ya abrió
    expect(repartir(filas, t2, t2, ["a", "b", "c"], 0).enTarjeta).toEqual(["a", "b", "c"]);
    expect(repartir(filas, t2, t2, ["a", "b", "c"], 1)).toMatchObject({ tarjeta: "c", franja: "a" });
  });

  it("barajar: una permutación, sin tocar la original; salen los dos órdenes", () => {
    const ids = ordenPorDefecto();
    expect(barajar(ids, () => 0.9)).toEqual(["product-hunt", "devhunt"]);
    expect(barajar(ids, () => 0.1)).toEqual(["devhunt", "product-hunt"]);
    expect(ids).toEqual(["product-hunt", "devhunt"]);
    expect(esOrdenValido(["devhunt"])).toBe(false);
    expect(esOrdenValido(["devhunt", "devhunt"])).toBe(false);
    expect(esOrdenValido(["devhunt", "otra"])).toBe(false);
    expect(esOrdenValido(undefined)).toBe(false);
  });
});

describe("el guion en línea: el reparto al azar antes del primer pintado", () => {
  /** Ejecuta el guion como lo haría el navegador, con reloj, azar, almacenamiento y documento falsos. */
  const ejecutar = (guion: string, ahora: number, azar: number, { cerrada = false, sinHojas = false, sinAlmacen = false } = {}) => {
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
    const almacen = {
      getItem: (k: string) => {
        if (sinAlmacen) throw new Error("SecurityError");
        return cerrada && k === CLAVE_FRANJA_CERRADA ? "1" : null;
      },
    };
    new Function("Date", "Math", "document", "CSSStyleSheet", "window", "sessionStorage", guion)(
      { now: () => ahora },
      { random: () => azar, floor: Math.floor },
      doc,
      Hoja,
      win,
      almacen,
    );
    const dejado = win[CLAVE_LANZAMIENTO] as { o: string[]; f: { css: string }; t: { css: string } } | undefined;
    return { doc, win, previa, dejado };
  };

  const instantes = [HOY, LANZAMIENTO - 1, LANZAMIENTO, LANZAMIENTO + DIA, FIN - 1, FIN, FIN + 30 * DIA];

  it.each([HOY, LANZAMIENTO + DIA])("HTML renderizado en %i: en cada instante y con cada azar, pinta lo que calcularán los componentes", (construido) => {
    const guion = guionDeLanzamiento(construido)!;
    for (const t of instantes.filter((x) => x >= construido)) {
      for (const azar of [0.1, 0.9]) {
        const { dejado, doc } = ejecutar(guion, t, azar);
        const orden = barajar(ordenPorDefecto(), () => azar);
        const esperado = repartir(filasDe(), construido, t, orden, 0);
        expect(dejado!.o).toEqual(orden);
        expect(dejado!.f.css).toBe(esperado.hojaFranja);
        expect(dejado!.t.css).toBe(esperado.hojaTarjeta);
        expect(doc.adoptedStyleSheets).toHaveLength(3);
      }
    }
  });

  it("las dos combinaciones salen, según el azar de la carga", () => {
    const guion = guionDeLanzamiento(HOY)!;
    const a = ejecutar(guion, LANZAMIENTO + DIA, 0.9).dejado!;
    const b = ejecutar(guion, LANZAMIENTO + DIA, 0.1).dejado!;
    expect(a.f.css).toContain('.announce-pila>[data-lz="product-hunt:durante"]{visibility:visible;opacity:1}');
    expect(a.f.css).toContain(".announce{background:#FF6154;color:#0F1218}");
    expect(a.t.css).toContain('.lz-diapo[data-lz-d="devhunt"]>*{visibility:visible;opacity:1;transform:none}');
    expect(b.f.css).toContain('.announce-pila>[data-lz="devhunt:durante"]{visibility:visible;opacity:1}');
    expect(b.f.css).toContain(".announce{background:#0F172A;color:#F8FAFC}");
    expect(b.t.css).toContain('.lz-diapo[data-lz-d="product-hunt"]>*{visibility:visible;opacity:1;transform:none}');
  });

  it("un HTML de antes del lanzamiento, abierto después: el «avísame» sale de la pila y el botón dice «échale un vistazo»", () => {
    const { f, t } = ejecutar(guionDeLanzamiento(HOY)!, LANZAMIENTO + DIA, 0.1).dejado!;
    expect(f.css).toContain('.announce-pila>[data-lz="product-hunt:antes"]{display:none}');
    expect(t.css).toContain('.lz-diapo[data-lz-d="product-hunt"] [data-lz-b="antes"]{visibility:hidden}');
    expect(t.css).toContain('.lz-diapo[data-lz-d="product-hunt"] [data-lz-b="vivo"]{visibility:inherit}');
    // Y abierto todavía antes, nada de eso.
    const antes = ejecutar(guionDeLanzamiento(HOY)!, HOY + 1, 0.1).dejado!;
    expect(antes.f.css).not.toContain("display:none");
    expect(antes.t.css).not.toContain("data-lz-b");
  });

  it("la franja cerrada en esta pestaña sigue cerrada al recargar, sin salto: se esconde antes de pintar", () => {
    const guion = guionDeLanzamiento(HOY)!;
    expect(ejecutar(guion, HOY, 0.9, { cerrada: true }).dejado!.f.css).toMatch(/\.announce\{display:none\}$/);
    expect(ejecutar(guion, HOY, 0.9).dejado!.f.css).not.toContain(".announce{display:none}");
    // Sin almacenamiento (modo privado estricto) no rompe: la franja se ve.
    expect(ejecutar(guion, HOY, 0.9, { sinAlmacen: true }).dejado!.f.css).not.toContain(".announce{display:none}");
    expect(guion).toContain(`sessionStorage.getItem("${CLAVE_FRANJA_CERRADA}")`);
    expect(guion).not.toContain("localStorage");
  });

  it("después de la campaña: el guion ya no toca la franja (sigue barajando la tarjeta)", () => {
    const guion = guionDeLanzamiento(FIN + DIA)!;
    const { dejado } = ejecutar(guion, FIN + 2 * DIA, 0.1);
    expect(dejado!.f.css).toBe("");
    expect(dejado!.t.css).toContain('.lz-diapo[data-lz-d="product-hunt"]>*{visibility:visible');
    // Con una sola plataforma y la campaña acabada no hay nada que repartir: sin guion.
    expect(guionDeLanzamiento(FIN + DIA, [PH])).toBeNull();
  });

  it("sin hojas construidas (navegador viejo) no rompe nada: se corrige al hidratar", () => {
    const { dejado, doc, previa } = ejecutar(guionDeLanzamiento(HOY)!, HOY, 0.5, { sinHojas: true });
    expect(dejado).toBeUndefined();
    expect(doc.adoptedStyleSheets).toEqual([previa]);
  });

  it("no lleva nada que cierre la etiqueta <script> ni abra un comentario HTML, ni depende de nada de fuera", () => {
    const guion = guionDeLanzamiento(HOY)!;
    expect(guion).not.toMatch(/<\/|<!--/);
    // `repartir` viaja con su código fuente: no puede nombrar módulos ni funciones auxiliares del compilador.
    expect(guion).not.toMatch(/require\(|import\(|__vite|__webpack|_slicedToArray|_toConsumableArray|__spread/);
    expect(guion.length).toBeLessThan(6_000);
  });

  it("cada componente retira SU hoja al montar y deja las demás", () => {
    const { doc, win, previa, dejado } = ejecutar(guionDeLanzamiento(HOY)!, HOY, 0.5);
    const d = doc as unknown as { adoptedStyleSheets: CSSStyleSheet[] };
    retirarHojaDeLanzamiento("f", d, win);
    expect(doc.adoptedStyleSheets).toEqual([previa, dejado!.t]);
    retirarHojaDeLanzamiento("f", d, win);
    retirarHojaDeLanzamiento("t", d, win);
    expect(doc.adoptedStyleSheets).toEqual([previa]);
    // El orden de la carga se queda: lo lee la rotación.
    expect((win[CLAVE_LANZAMIENTO] as { o: string[] }).o).toHaveLength(2);
    retirarHojaDeLanzamiento("t", d, {});
  });
});

describe("la rotación de la carga (la que comparten la franja y la tarjeta)", () => {
  const entorno = (t0: number, extra: Partial<Parameters<typeof crearRotacion>[0]> = {}) => {
    let ahora = t0;
    const pendientes: { fn: () => void; a: number; id: number }[] = [];
    let n = 0;
    const e = {
      ahora: () => ahora,
      azar: () => 0.9,
      setTimeout: (fn: () => void, ms: number) => (pendientes.push({ fn, a: ahora + ms, id: ++n }), n),
      clearTimeout: (id: unknown) => {
        const i = pendientes.findIndex((p) => p.id === id);
        if (i >= 0) pendientes.splice(i, 1);
      },
      ...extra,
    };
    const avanzarA = (t: number) => {
      for (;;) {
        const sig = pendientes.filter((p) => p.a <= t).sort((x, y) => x.a - y.a)[0];
        if (!sig) break;
        pendientes.splice(pendientes.indexOf(sig), 1);
        ahora = sig.a;
        sig.fn();
      }
      ahora = t;
    };
    return { e, avanzarA, pendientes, poner: (t: number) => (ahora = t) };
  };

  it("recoge el orden que dejó el guion; si no es válido, baraja", () => {
    expect(crearRotacion(entorno(HOY, { ordenDelGuion: () => ["devhunt", "product-hunt"] }).e).leer().orden).toEqual(["devhunt", "product-hunt"]);
    expect(crearRotacion(entorno(HOY, { ordenDelGuion: () => ["devhunt"] }).e).leer().orden).toEqual(["product-hunt", "devhunt"]);
    expect(crearRotacion(entorno(HOY, { azar: () => 0.1 }).e).leer().orden).toEqual(["devhunt", "product-hunt"]);
  });

  it("avanzar e ir a una plataforma mueven la tarjeta, y la franja con ella", () => {
    const rot = crearRotacion(entorno(LANZAMIENTO + DIA).e);
    let avisos = 0;
    rot.suscribir(() => avisos++);
    expect(rot.reparto()).toMatchObject({ franja: "product-hunt", tarjeta: "devhunt" });
    rot.avanzar();
    expect(rot.reparto()).toMatchObject({ franja: "devhunt", tarjeta: "product-hunt" });
    rot.irA("devhunt");
    expect(rot.reparto()).toMatchObject({ franja: "product-hunt", tarjeta: "devhunt" });
    expect(avisos).toBe(2);
    // Ir a la que ya está, o a una que no existe, no hace nada.
    rot.irA("devhunt");
    rot.irA("otra");
    expect(avisos).toBe(2);
  });

  it("cruza sola las fronteras con la pestaña abierta: el lanzamiento y el final", () => {
    const { e, avanzarA, pendientes } = entorno(HOY);
    const rot = crearRotacion(e);
    expect(rot.reparto()).toMatchObject({ franja: "product-hunt", estadoFranja: "antes" });
    avanzarA(LANZAMIENTO - 1);
    expect(rot.reparto().estadoFranja).toBe("antes");
    avanzarA(LANZAMIENTO + 1);
    expect(rot.reparto().estadoFranja).toBe("durante");
    avanzarA(FIN + 1);
    expect(rot.reparto().franja).toBeNull();
    // Sin más fronteras, nada programado.
    expect(pendientes).toHaveLength(0);
    // Las piezas de la pila son las de la carga: `t0` no se mueve.
    expect(rot.leer().t0).toBe(HOY);
  });

  it("un reloj atrasado o roto no devuelve una ventana que ya pasó", () => {
    const { e, poner } = entorno(LANZAMIENTO + DIA);
    const rot = crearRotacion(e);
    poner(HOY);
    rot.reevaluar();
    expect(rot.leer().t).toBe(LANZAMIENTO + DIA);
    poner(Number.NaN);
    rot.reevaluar();
    expect(rot.leer().t).toBe(LANZAMIENTO + DIA);
  });

  it("retener (ratón o foco en la franja o en la tarjeta) y soltar", () => {
    const rot = crearRotacion(entorno(HOY).e);
    expect(rot.retenida()).toBe(false);
    rot.retener("franja", true);
    rot.retener("tarjeta", true);
    rot.retener("franja", false);
    expect(rot.retenida()).toBe(true);
    rot.retener("tarjeta", false);
    expect(rot.retenida()).toBe(false);
  });

  it("con N plataformas, dar la vuelta entera devuelve al principio", () => {
    const lista = ["a", "b", "c", "d"].map((id) => inventada(id));
    const rot = crearRotacion(entorno(LANZAMIENTO).e, lista);
    const inicio = rot.reparto();
    const vistas = [inicio.tarjeta];
    for (let i = 0; i < 3; i++) {
      rot.avanzar();
      const x = rot.reparto();
      expect(x.franja).toBe(vistas.at(-1));
      vistas.push(x.tarjeta);
    }
    expect(new Set(vistas).size).toBe(4);
    rot.avanzar();
    expect(rot.reparto()).toMatchObject({ tarjeta: inicio.tarjeta, franja: inicio.franja });
  });
});

describe("los textos, en los 12 idiomas", () => {
  const DIR = `${WEB}messages/`;
  const locales = readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  const mensajes = (loc: string) => JSON.parse(readFileSync(`${DIR}${loc}.json`, "utf8")) as AbstractIntlMessages & { nav: Record<string, string>; landing: { launch: Record<string, string> } };
  const traductor = (loc: string, namespace: string) => createTranslator({ locale: loc, messages: mensajes(loc), namespace }) as unknown as Traductor;

  it("son los 12", () => expect(locales).toEqual(["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]));

  it.each(locales)("%s: las plantillas existen, llevan {platform} y ninguna nombra una plataforma concreta", (loc) => {
    const m = mensajes(loc);
    expect(Object.keys(m.landing.launch).sort()).toEqual(["carousel", "kicker", "live", "notify", "pause", "play", "show", "tagline"]);
    for (const texto of [m.nav.launchSoon, m.nav.launchLive, m.landing.launch.kicker, m.landing.launch.notify, m.landing.launch.live, m.landing.launch.show]) {
      expect(texto).toContain("{platform}");
      for (const p of PLATAFORMAS) expect(texto).not.toContain(p.nombre);
    }
    expect(m.nav.launchSoon).toContain("{date}");
    expect(m.nav.launchLive).not.toContain("{date}");
    expect(m.landing.launch.tagline).toMatch(/LLM/);
    for (const k of ["carousel", "pause", "play", "tagline"]) expect(m.landing.launch[k]).not.toContain("{");
    expect(m.landing.launch.pause).not.toBe(m.landing.launch.play);
    // Las claves de antes, atadas a Product Hunt, ya no existen.
    expect(m.nav).not.toHaveProperty("announcePhSoon");
    expect(m.nav).not.toHaveProperty("announcePhLive");
    expect(m.landing).not.toHaveProperty("productHunt");
    expect(m.nav.newTab).toBeTruthy();
  });

  it.each(locales)("%s: cada plataforma del registro sale con su nombre en la franja y en la tarjeta, sin claves que falten", (loc) => {
    const nav = traductor(loc, "nav");
    const tl = traductor(loc, "landing.launch");
    const fechas = fechasDeAviso(HOY, loc);
    const tarjeta = textosDeTarjeta(tl, nav("newTab"));
    expect(Object.keys(tarjeta.porPlataforma)).toEqual(PLATAFORMAS.map((p) => p.id));
    for (const p of PLATAFORMAS) {
      const franja = [textoDe(nav, "launchLive", p), textoDe(nav, "launchSoon", p, { date: fechas[p.id] ?? "X" })];
      const t = tarjeta.porPlataforma[p.id]!;
      for (const texto of [...franja, t.kicker, t.aviso, t.vivo, t.ver]) {
        expect(texto).toContain(p.nombre);
        expect(texto).not.toMatch(/[{}]|launch\.|nav\./);
      }
      // Cortos: caben en el botón sin que la tarjeta crezca.
      for (const texto of [t.aviso, t.vivo]) expect(texto.length, `${loc} ${p.id}`).toBeLessThanOrEqual(40);
    }
    expect(tarjeta.lema).toBe(mensajes(loc).landing.launch.tagline);
    for (const texto of [tarjeta.carrusel, tarjeta.pausar, tarjeta.reanudar]) expect(texto.length).toBeGreaterThan(3);
  });

  it("en inglés y en español, tal cual", () => {
    const en = textosDeTarjeta(traductor("en", "landing.launch"), "(opens in a new tab)");
    expect(en.lema).toBe("Cut LLM costs with an open-source savings layer");
    expect(en.porPlataforma["product-hunt"]).toEqual({ kicker: "Find us on Product Hunt", aviso: "Get notified on Product Hunt", vivo: "Check it out on Product Hunt", ver: "Show Product Hunt" });
    expect(en.porPlataforma.devhunt).toEqual({ kicker: "Find us on DevHunt", aviso: "Get notified on DevHunt", vivo: "Check it out on DevHunt", ver: "Show DevHunt" });
    expect(textoDe(traductor("es", "nav"), "launchLive", DH)).toBe("Savings Layer ya está en DevHunt — apóyanos");
    expect(textoDe(traductor("es", "nav"), "launchSoon", PH, { date: "domingo, 22 de noviembre" })).toBe("Lanzamos en Product Hunt el domingo, 22 de noviembre — recibe el aviso");
  });

  it("una clave propia de la plataforma (`clave_<id>`) gana a la plantilla", () => {
    const t = Object.assign((clave: string, v?: Record<string, string>) => `${clave}:${v?.platform}`, { has: (clave: string) => clave === "launchLive_devhunt" }) as Traductor;
    expect(textoDe(t, "launchLive", DH)).toBe("launchLive_devhunt:DevHunt");
    expect(textoDe(t, "launchLive", PH)).toBe("launchLive:Product Hunt");
  });

  it("el nombre con espacios no se parte", () => {
    expect(nombreAtado("Product Hunt")).toBe("Product Hunt");
    expect(nombreAtado("DevHunt")).toBe("DevHunt");
  });
});

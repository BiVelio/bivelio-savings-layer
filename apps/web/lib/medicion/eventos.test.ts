import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import {
  ATRIBUTO_ZONA,
  EVENTOS,
  RUTAS,
  RUTAS_DE_VERCEL,
  destinoExterno,
  donde,
  gestorDelComando,
  paginaDe,
  planDelAlta,
  urlSinDatos,
  zonaDe,
  type NodoMedible,
} from "./eventos";

/**
 * LA MEDICIÓN DE LA WEB CUENTA LO QUE DICE, Y NADA MÁS.
 *
 * Lo que se fija aquí: que cada comando de instalación escrito en la web se
 * reconoce (si no, sus copias no cuentan y nadie lo nota), que ningún valor de
 * un evento puede salir de lo que escribe el visitante, que la URL sale limpia,
 * que no se pasa del límite de propiedades del plan Pro de Vercel y que la
 * página de privacidad lo cuenta en los 12 idiomas.
 */

const WEB = fileURLToPath(new URL("../../", import.meta.url));
const leer = (ruta: string) => readFileSync(join(WEB, ruta), "utf8");

function ficheros(dir: string, filtro: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const nombre of readdirSync(join(WEB, dir))) {
    if (nombre === "node_modules" || nombre === ".next") continue;
    const ruta = join(dir, nombre);
    if (statSync(join(WEB, ruta)).isDirectory()) out.push(...ficheros(ruta, filtro));
    else if (filtro(ruta)) out.push(ruta);
  }
  return out;
}

const fuentes = () => [...ficheros("app", (f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts")), ...ficheros("lib", (f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"))];

describe("qué comando se copió", () => {
  it("reconoce cada comando de instalación que enseña la web", () => {
    expect(gestorDelComando("npm i -g @bivelio/savings-layer\nbvsala claude")).toBe("npm");
    expect(gestorDelComando("npx @bivelio/savings-layer@latest init")).toBe("npx");
    expect(gestorDelComando("npx -y @bivelio/savings-layer skill --codex")).toBe("npx");
    expect(gestorDelComando("npm install @bivelio/savings-layer@latest")).toBe("npm");
    expect(gestorDelComando("# 1 · Install\npnpm add @bivelio/savings-layer\n\nconst layer = createSavingsLayer({ provider });")).toBe("pnpm");
    expect(gestorDelComando("pip install bivelio-savings-layer")).toBe("pip");
    expect(gestorDelComando("$ yarn add @bivelio/savings-layer")).toBe("yarn");
    expect(gestorDelComando("uv add bivelio-savings-layer")).toBe("uv");
    expect(gestorDelComando("pipx install bivelio-savings-layer")).toBe("pipx");
  });

  it("lo que no instala BV-SALA no cuenta", () => {
    for (const texto of [
      "bvsala claude",
      "export BIVELIO_SERVICE_KEY=",
      '$env:BIVELIO_SERVICE_KEY = ""',
      "@bivelio/savings-layer",
      "npm i lodash",
      "# npm i -g @bivelio/savings-layer",
      "const layer = createSavingsLayer({ provider });",
      "",
    ]) {
      expect(gestorDelComando(texto), texto).toBeNull();
    }
  });

  it("todo comando de instalación escrito en el código o en los mensajes se reconoce", () => {
    // Literales entre comillas de app/ y lib/, y el contenido de <code> en los mensajes.
    const textos: string[] = [];
    for (const f of fuentes()) {
      for (const m of leer(f).matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
        try {
          textos.push(JSON.parse(`"${m[1]}"`) as string);
        } catch {
          /* no es un literal JSON válido: no es un comando */
        }
      }
    }
    for (const m of leer("messages/en.json").matchAll(/<code>(.*?)<\/code>/g)) textos.push(m[1]!);

    const comandos = textos
      .flatMap((t) => t.split("\n"))
      .map((l) => l.trim())
      .filter((l) => /^(?:npx|npm|pnpm|yarn|bunx?|pipx?|pip3|python3? -m pip|uv|poetry)\s/.test(l) && /savings-layer/.test(l));
    // Los de siempre: el gateway (npm -g), el SDK (pnpm add), init (npx), el skill (npx) y Python (pip).
    expect(comandos.length).toBeGreaterThanOrEqual(5);
    expect(comandos.filter((c) => gestorDelComando(c) === null)).toEqual([]);
  });
});

describe("adónde sale un enlace", () => {
  it("GitHub, npm y PyPI, con o sin www", () => {
    expect(destinoExterno("https://github.com/BiVelio/bivelio-savings-layer")).toBe("github");
    expect(destinoExterno("https://github.com/BiVelio")).toBe("github");
    expect(destinoExterno("https://www.npmjs.com/package/@bivelio/savings-layer")).toBe("npm");
    expect(destinoExterno("https://pypi.org/project/bivelio-savings-layer/")).toBe("pypi");
  });

  it("nada más: ni otros hosts, ni hosts que solo empiezan igual, ni rutas propias", () => {
    for (const href of [
      "https://www.linkedin.com/company/bivelio/",
      "https://bivelio.com/es/privacy",
      "https://github.com.example.org/x",
      "https://savings.bivelio.com/es/pricing",
      "/pricing",
      "mailto:privacy@bivelio.com",
      "javascript:void(0)",
    ]) {
      expect(destinoExterno(href), href).toBeNull();
    }
  });
});

describe("el paso al alta", () => {
  const origen = "https://savings.bivelio.com";
  it("con y sin idioma, y el plan sale del destino `next` (el contrato de /pricing)", () => {
    expect(planDelAlta("https://savings.bivelio.com/es/signup", origen)).toBe("measure");
    expect(planDelAlta("/signup", origen)).toBe("measure");
    expect(planDelAlta("/en/signup?next=%2Fen%2Fdashboard%3Fplan%3Dpro", origen)).toBe("pro");
    expect(planDelAlta("/de/signup?next=%2Fde%2Fdashboard%3Fplan%3Dequipo", origen)).toBe("team");
  });

  it("no es un alta: la página de éxito, el login, otro sitio", () => {
    expect(planDelAlta("/es/signup/success", origen)).toBeNull();
    expect(planDelAlta("/es/login", origen)).toBeNull();
    expect(planDelAlta("https://app.example.org/signup", origen)).toBeNull();
  });
});

describe("la página y la URL que salen", () => {
  it("RUTAS son exactamente las páginas de app/[locale] (salvo el 404 comodín)", () => {
    const paginas = ficheros("app/[locale]", (f) => f.endsWith("page.tsx"))
      .map((f) => relative("app/[locale]", f).replace(/\/?page\.tsx$/, ""))
      .filter((r) => !r.startsWith("[...rest]"))
      .sort();
    expect([...RUTAS].sort()).toEqual(paginas);
  });

  it("el nombre de la página no depende del idioma ni de los segmentos dinámicos", () => {
    expect(paginaDe("/es")).toBe("home");
    expect(paginaDe("/")).toBe("home");
    expect(paginaDe("/id")).toBe("home");
    expect(paginaDe("/en/how-it-works")).toBe("how-it-works");
    expect(paginaDe("/fr/pricing/")).toBe("pricing");
    expect(paginaDe("/es/dashboard/install")).toBe("dashboard/install");
    expect(paginaDe("/es/invitacion/9f2c1e0b7a")).toBe("invitacion");
    expect(paginaDe("/es/alguien@example.com")).toBe("other");
  });

  it("la URL sale sin query ni fragmento, sin token y sin la ruta de un 404", () => {
    const o = "https://savings.bivelio.com";
    expect(urlSinDatos(`${o}/es/pricing?gclid=abc#plans`)).toBe(`${o}/es/pricing`);
    expect(urlSinDatos(`${o}/en/signup?next=%2Fen%2Fdashboard%3Fplan%3Dpro`)).toBe(`${o}/en/signup`);
    expect(urlSinDatos(`${o}/es/reset-password?code=xyz`)).toBe(`${o}/es/reset-password`);
    expect(urlSinDatos(`${o}/es/invitacion/9f2c1e0b7a`)).toBe(`${o}/es/invitacion/[token]`);
    expect(urlSinDatos(`${o}/es/alguien@example.com`)).toBe(`${o}/es/[...rest]`);
    expect(urlSinDatos(`${o}/es`)).toBe(`${o}/es`);
    expect(urlSinDatos(`${o}/`)).toBe(`${o}/`);
    expect(urlSinDatos("no es una url")).toBeNull();
  });

  it("todo idioma de la web se reconoce como idioma", () => {
    for (const l of locales) expect(paginaDe(`/${l}/privacy`), l).toBe("privacy");
  });
});

describe("la zona", () => {
  function nodo(tagName: string, attrs: Record<string, string> = {}, padre: NodoMedible | null = null): NodoMedible {
    return { tagName, id: attrs.id ?? "", getAttribute: (n) => attrs[n] ?? null, parentElement: padre };
  }

  it("manda la marca explícita; luego el pie, la cabecera y el id de la sección", () => {
    const main = nodo("MAIN", { id: "contenido" }, nodo("BODY"));
    const seccion = nodo("SECTION", { id: "install-gateway" }, main);
    expect(zonaDe(nodo("BUTTON", {}, nodo("DIV", { [ATRIBUTO_ZONA]: "sdk" }, seccion)))).toBe("sdk");
    expect(zonaDe(nodo("A", {}, nodo("DIV", {}, seccion)))).toBe("install-gateway");
    expect(zonaDe(nodo("A", {}, nodo("FOOTER", {}, nodo("BODY"))))).toBe("footer");
    expect(zonaDe(nodo("A", {}, nodo("NAV", {}, nodo("HEADER"))))).toBe("nav");
    // `<main id="contenido">` del panel: es `main`, no su id.
    expect(zonaDe(nodo("A", {}, main))).toBe("main");
    expect(zonaDe(null)).toBe("main");
  });

  it("un id generado o con datos no es una zona: se sigue subiendo", () => {
    const seccion = nodo("SECTION", { id: "skill" }, nodo("MAIN"));
    expect(zonaDe(nodo("PRE", {}, nodo("DIV", { id: "«r3»-so" }, seccion)))).toBe("skill");
    expect(zonaDe(nodo("PRE", {}, nodo("DIV", { id: "org-4f1a9c" }, seccion)))).toBe("skill");
    expect(zonaDe(nodo("PRE", {}, nodo("DIV", { [ATRIBUTO_ZONA]: "Alguien@Example" }, seccion)))).toBe("skill");
  });

  it("cada `data-medir-zona` escrita en el código tiene forma de nombre", () => {
    const zonas = fuentes().flatMap((f) => [...leer(f).matchAll(/data-medir-zona="([^"]*)"/g)].map((m) => m[1]!));
    expect(zonas.length).toBeGreaterThanOrEqual(5);
    for (const z of zonas) expect(zonaDe(nodo("DIV", { [ATRIBUTO_ZONA]: z })), z).toBe(z);
  });

  it("«dónde» es página/zona", () => {
    expect(donde("/es", nodo("BUTTON", {}, nodo("DIV", { [ATRIBUTO_ZONA]: "gateway" })))).toBe("home/gateway");
  });
});

describe("los eventos", () => {
  const medir = leer("lib/medicion/medir.ts");

  it("son tres, con nombre de menos de 255 caracteres (el límite de Vercel)", () => {
    expect(Object.keys(EVENTOS).sort()).toEqual(["alta", "copia", "salida"]);
    for (const nombre of Object.values(EVENTOS)) expect(nombre.length).toBeLessThan(255);
  });

  it("cada envío lleva dos propiedades como mucho (el límite del plan Pro) y todos los eventos se envían", () => {
    const envios = [...medir.matchAll(/enviar\(EVENTOS\.(\w+),\s*\{([^}]*)\}\)/g)];
    expect(new Set(envios.map((m) => m[1])).size).toBe(Object.keys(EVENTOS).length);
    for (const [, evento, props] of envios) {
      // Las claves del objeto literal, abreviadas (`plan`) o no (`where: …`): se
      // parte por las comas de primer nivel; las de una llamada de dentro no cuentan.
      const claves: string[] = [];
      let prof = 0;
      let trozo = "";
      for (const c of `${props},`) {
        if (c === "(") prof++;
        if (c === ")") prof--;
        if (c === "," && prof === 0) {
          if (trozo.trim()) claves.push(trozo.trim().split(":")[0]!.trim());
          trozo = "";
        } else trozo += c;
      }
      expect(claves.length, evento).toBeLessThanOrEqual(2);
    }
  });

  it("solo se llama a track(): nunca a identify ni a group, lo único del script de Vercel que guarda algo en el navegador", () => {
    for (const f of fuentes()) {
      expect(leer(f), f).not.toMatch(/\bva\s*\(\s*["'](?:identify|group|reset)["']/);
    }
  });
});

describe("dónde se monta y por dónde sale", () => {
  it("una sola vez, en el layout del idioma", () => {
    const usos = fuentes().filter((f) => /<MedicionWeb\b/.test(leer(f)));
    expect(usos).toEqual(["app/[locale]/layout.tsx"]);
  });

  it("el script y los envíos van a /_vercel/insights: mismo origen y fuera del middleware", () => {
    for (const ruta of Object.values(RUTAS_DE_VERCEL)) expect(ruta).toMatch(/^\/_vercel\/insights\//);
    expect(leer("middleware.ts")).toMatch(/_vercel\|/);
  });
});

describe("la página de privacidad lo cuenta", () => {
  it("en los 12 idiomas, nombrando Vercel Web Analytics", () => {
    for (const l of locales) {
      const pp = (JSON.parse(leer(`messages/${l}.json`)) as { privacyPage: { website: { body: string }; overview: { website: { destination: string } } } }).privacyPage;
      expect(pp.website.body, l).toContain("<b>Vercel Web Analytics</b>");
      expect(pp.overview.website.destination, l).toBe("Vercel Web Analytics");
    }
  });

  it("la página pinta la sección y la fila del resumen", () => {
    const pagina = leer("app/[locale]/privacy/page.tsx");
    expect(pagina).toContain('t.rich("website.body"');
    expect(pagina).toContain('{ clave: "website", ancla: "website" }');
  });
});

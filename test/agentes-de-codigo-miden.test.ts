import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A2-9 · CON UN AGENTE DE CÓDIGO, EL GATEWAY MIDE; LA REBAJA DE TTL AHORRA SOLO
 * SI EL CLIENTE PAGA POR TOKEN Y PIDE LA CACHÉ DE UNA HORA.
 *
 * La primera pantalla del README ponía `npx @bivelio/savings-layer claude` junto a
 * «install it and it saves», y la tarjeta «Gateway» de la web se dirige a quien
 * usa Claude Code con clave de API. Con la configuración por defecto, la única
 * palanca encendida del gateway es la rebaja de TTL (1h → 5m), y:
 *
 *  · solo reescribe marcas `cache_control` con `ttl: "1h"` (gateway/tarifa.ts);
 *  · no toca el tráfico de suscripción (gateway/servidor.ts, `!suscripcion`);
 *  · Claude Code con clave de API pide 5 minutos salvo que se elija la hora
 *    (`promptCacheTtl`), según su documentación oficial
 *    (https://code.claude.com/docs/en/prompt-caching.md, «Which TTL each request gets»).
 *
 * Así que con `bvsala claude` el gateway mide, y casi nunca tiene nada que rebajar.
 * El SDK sí ahorra sin configurar nada. Estos textos dicen eso, y si el código
 * cambia de política, la última prueba obliga a reescribirlos.
 */

const RAIZ = fileURLToPath(new URL("../", import.meta.url));
const leer = (r: string) => readFileSync(`${RAIZ}${r}`, "utf8");
const plano = (t: string) => t.replace(/\s+/g, " ");

const readme = leer("README.md");
const primeraPantalla = plano(readme.slice(0, readme.indexOf("### How it saves")));

const MENSAJES = `${RAIZ}apps/web/messages/`;
const LOCALES = readdirSync(MENSAJES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -5))
  .sort();
const cargar = (loc: string) => JSON.parse(readFileSync(`${MENSAJES}${loc}.json`, "utf8"));

/** En cada idioma: «paga por token» y «la caché de una hora». */
const CONDICION: Record<string, { porToken: RegExp; unaHora: RegExp }> = {
  en: { porToken: /pays per token/, unaHora: /one-hour cache/ },
  es: { porToken: /paga por token/, unaHora: /caché de una hora/ },
  ca: { porToken: /paga per token/, unaHora: /memòria cau d'una hora/ },
  de: { porToken: /pro Token zahlt/, unaHora: /einstündigen Cache/ },
  fr: { porToken: /paie au token/, unaHora: /cache d'une heure/ },
  it: { porToken: /paga a token/, unaHora: /cache di un'ora/ },
  pt: { porToken: /paga por token/, unaHora: /cache de uma hora/ },
  nl: { porToken: /per token betaalt/, unaHora: /cache van een uur/ },
  pl: { porToken: /płaci za tokeny/, unaHora: /godzinną pamięć podręczną/ },
  tr: { porToken: /token başına ödüyor/, unaHora: /bir saatlik önbelle[kğ]/ }, // «önbelleği»: la k se suaviza
  id: { porToken: /membayar per token/, unaHora: /cache satu jam/ },
  vi: { porToken: /trả theo token/, unaHora: /bộ nhớ đệm một giờ/ },
};

/** Las claves de la web que dicen qué hace el gateway con un agente de código. */
const CLAVES = {
  tarjeta: (d: any) => d.howItWorks.ways.gateway.p3 as string,
  notaDeLaCifra: (d: any) => d.landing.offers.gateway.figureNote as string,
  notaDelGateway: (d: any) => d.landing.gateway.note as string,
  tarjetaClaudeCode: (d: any) => d.howItWorks.caseCodeBody as string,
};

describe("A2-9 · README: «it saves» va con el SDK; con agentes de código, el gateway mide", () => {
  it("la primera pantalla dice «install it and it saves» del SDK, y de nadie más", () => {
    // Frase a frase dentro de los párrafos y viñetas (no del bloque de código).
    const prosa = readme
      .slice(0, readme.indexOf("### How it saves"))
      .replace(/```[\s\S]*?```/g, "\n\n")
      .split(/\n\s*\n|\n- /)
      .map(plano);
    const frases = prosa.flatMap((p) => p.split(/(?<=\.)\s/));
    const conAhorra = frases.filter((f) => /\bit saves\b/.test(f));
    expect(conAhorra.length, "falta «install it and it saves»").toBeGreaterThan(0);
    for (const f of conAhorra) expect(f, f).toMatch(/\bSDK\b/);
  });

  it("la primera pantalla dice que con agentes de código el gateway mide, y cuándo ahorra la rebaja de TTL", () => {
    expect(primeraPantalla).toMatch(/coding agent[^.]*gateway measures/);
    expect(primeraPantalla).toMatch(/TTL[^.]*only when your client pays per token and asks for the one-hour cache/);
    // La línea de `npx … claude` ya no se presenta como ahorro.
    expect(primeraPantalla).toMatch(/npx @bivelio\/savings-layer claude +# or meter Claude Code/);
  });

  it("la sección del gateway dice qué pide Claude Code con clave de API y cómo pedir la hora", () => {
    const r = plano(readme);
    expect(r).toContain("Claude Code on an API key asks for five minutes unless you set `promptCacheTtl` to `1h`");
    expect(r).toContain("the TTL lever leaves Claude Max/Pro traffic untouched");
  });
});

describe("A2-9 · web: la tarjeta Gateway y las notas que dicen lo mismo, en los 12 idiomas", () => {
  it("están los 12 idiomas", () => {
    expect(Object.keys(CONDICION).sort()).toEqual(LOCALES);
  });

  for (const loc of LOCALES) {
    it(`${loc}: la rebaja de TTL va con su condición (pago por token y caché de una hora)`, () => {
      const d = cargar(loc);
      const { porToken, unaHora } = CONDICION[loc]!;
      for (const [nombre, clave] of Object.entries(CLAVES)) {
        const t = clave(d);
        expect(t, `${loc} ${nombre}`).toMatch(unaHora);
        // La tarjeta de Claude Code ya habla de «clave de API» y «factura por tokens».
        if (nombre !== "tarjetaClaudeCode") expect(t, `${loc} ${nombre}`).toMatch(porToken);
      }
    });
  }

  it("en/es: dicen que Claude Code con clave de API pide cinco minutos y que entonces el gateway mide", () => {
    const en = cargar("en");
    const es = cargar("es");
    expect(CLAVES.notaDeLaCifra(en)).toContain("Claude Code on an API key asks for the five-minute one unless you change it");
    expect(CLAVES.notaDelGateway(en)).toContain("and then the gateway only measures");
    expect(CLAVES.tarjetaClaudeCode(en)).toContain("by default the gateway only measures");
    expect(CLAVES.notaDeLaCifra(es)).toContain("Claude Code con clave de API pide la de cinco minutos si no lo cambias");
    expect(CLAVES.notaDelGateway(es)).toContain("y entonces el gateway solo mide");
    expect(CLAVES.tarjetaClaudeCode(es)).toContain("por defecto el gateway solo mide");
  });
});

describe("A2-9 · lo que viaja DENTRO del paquete npm dice lo mismo que el README", () => {
  // docs/terminales va en `files` de package.json y el --help es lo primero que lee
  // quien instala: prometían ahorro con Claude Code y clave de API, sin condición,
  // mientras el README ya decía que por defecto el gateway mide.
  it("la guía de Claude Code no dice que con clave de API «las palancas ahorran dinero» sin más", () => {
    const guia = plano(leer("docs/terminales/claude-code.md"));
    // Las guías viajan en inglés desde la auditoría de medios (m30): las mismas
    // tres afirmaciones, en el idioma en que se publican.
    expect(guia).not.toMatch(/las palancas ahorran dinero|the levers save money/i);
    expect(guia).toMatch(/By default the gateway \*\*measures\*\* there/);
    expect(guia).toMatch(/only saves if Claude Code asks for the one-hour cache/);
    expect(guia).toContain("on an API key it asks for the five-minute one unless you set `promptCacheTtl` to `1h`");
    // m30 · el párrafo del log ya no dice que Claude Code «escribe caché a 1 h»
    // sin más, que contradecía lo de arriba: el `(1h …)` solo sale si se pide.
    expect(guia).not.toMatch(/Claude Code escribe caché a 1 h|Claude Code writes (the )?cache at (1 h|one hour)/i);
    expect(guia).toContain("On an API key with the default configuration Claude Code asks for the five-minute cache");
  });

  it("la guía de Claude Code no se contradice con su log: el «(1h …)» es parte de cache↑, y con API key pide 5 min", () => {
    // Arriba decía que con API key Claude Code pide la caché de 5 min y abajo que
    // «Claude Code escribe caché a 1 h», con un ejemplo imposible: cache↑0 (1h 49268).
    // En gateway/servidor.ts el paréntesis es la parte de 1 h DENTRO del total escrito.
    const crudo = leer("docs/terminales/claude-code.md");
    const guia = plano(crudo);
    expect(guia).not.toMatch(/Claude Code escribe caché a 1 h/);
    const ejemplos = [...crudo.matchAll(/cache↑(\d+)(?: \(1h (\d+)\))?/g)];
    expect(ejemplos.length).toBeGreaterThan(0);
    for (const [texto, total, unaHora] of ejemplos) {
      if (unaHora !== undefined) expect(Number(unaHora), texto).toBeLessThanOrEqual(Number(total));
    }
    expect(leer("gateway/servidor.ts")).toContain("cache↑${medido.tokens.cacheEscrita}`");
  });

  it("la guía general de terminales pone la condición junto a «la palanca por defecto»", () => {
    const guia = plano(leer("docs/terminales/README.md"));
    expect(guia).toMatch(/default lever[^]*?It only has something to lower when the client pays per token and asks for the one-hour cache/);
    expect(guia).toContain("Claude Code on an API key asks for the five-minute one unless you set `promptCacheTtl` to `1h`, so out of the box the gateway only measures");
  });

  it("el --help de bvsala pone la condición en cache_ttl_tuning", () => {
    const ayuda = plano(leer("gateway/bin.ts"));
    expect(ayuda).toMatch(/cache_ttl_tuning — [^]*?Claude Code on an API key asks for 5m unless you set promptCacheTtl to 1h, and then the gateway only measures\./);
  });
});

describe("A2-9 · el código sigue haciendo lo que dicen los textos", () => {
  it("la rebaja solo reescribe marcas de una hora, y nunca el tráfico de suscripción", () => {
    expect(leer("gateway/tarifa.ts")).toContain('if (marca.ttl === "1h") {');
    // (1.2.4: `canal` ya no puede ser null —con una licencia Medir concede como el
    // modo comunitario—, así que el `!` desapareció. La condición es la misma.)
    expect(leer("gateway/servidor.ts")).toMatch(/!suscripcion &&\s*canal\.tiene\("cache_ttl_tuning"\)/);
  });

  it("el resto de palancas del gateway siguen apagadas por defecto (los diales, a mano)", () => {
    expect(leer("gateway/servidor.ts")).toContain("opts.dialesElision === true &&");
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DIAS_ACTIVOS_PARA_CONTAR_ASIENTO, MAX_ASIENTOS } from "@/lib/billing/asientos";
import { MINIMO_FACTURABLE_EUR } from "@/lib/billing/facturacion";
import {
  COMISIONAR_ELISION_SUELO,
  COMISIONAR_REFERENCIA,
  GARANTIA_NETA_RATIO,
  MONEDA_DE_LA_COMISION,
  REGLA_REFERENCIA,
  TRAMOS,
} from "@/lib/billing/tarifa";
import { formatearPrecio } from "@/lib/format/precio";
import { ETIQUETAS_DE_BASIS } from "@/lib/metering/usage";
import { PRECIO_RESPALDO } from "@/lib/stripe/pricing";

import { etiquetasComisionables, etiquetasSinComision, terminosDePrecio } from "./precios-publicados";

/**
 * LA «PUBLISHED PRICING» LEE LAS CONSTANTES QUE COBRAN — y nadie puede escribir
 * una cifra a mano en ella.
 *
 * La LICENSE §6 no lleva ni un número: remite a /pricing. Si esa página
 * copiara una cifra, el contrato quedaría atado a un texto que nadie
 * sincroniza con el código — la receta con la que la web llegó a anunciar
 * dólares mientras Stripe cobraba euros. Aquí:
 *   · cada valor que pinta la página sale de tarifa.ts, facturacion.ts,
 *     asientos.ts, la lista blanca del ingest y el Price de Stripe;
 *   · la página y su módulo no tienen literales numéricos (un dígito a mano
 *     pone la suite en rojo), y los mensajes `pricingPage.*` tampoco
 *     (tarifa-en-parametros.test.ts);
 *   · la única cifra que vive en SQL (los días activos de un asiento) está
 *     atada a la migración que la aplica.
 */

const leerApp = (ruta: string) => readFileSync(fileURLToPath(new URL(`../../${ruta}`, import.meta.url)), "utf8");

/**
 * Los literales numéricos de un fuente TS/TSX, sin comentarios ni imports.
 * `<h2>` no cuenta (el dígito va pegado a una letra) y `0` tampoco: es
 * aritmética (un acumulador, un índice), no un precio.
 */
function literalesNumericos(fuente: string, permitir: RegExp[] = []): string[] {
  let s = fuente
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
  for (const r of permitir) s = s.replace(r, "");
  return [...s.matchAll(/(?<![\w$.#-])\d[\d_.]*/g)].map((m) => m[0]).filter((n) => n !== "0");
}

describe("el detector de cifras a mano funciona (si no, esta verja no protege nada)", () => {
  it("caza un precio, un tipo y un umbral escritos a mano", () => {
    expect(literalesNumericos(`const x = 4; const y = 0.1; t("a", { hasta: 1_000 });`)).toEqual(["4", "0.1", "1_000"]);
    expect(literalesNumericos(`<h2 id="seat">{t("x")}</h2>; let i = 0; // 39 €`)).toEqual([]);
  });
});

describe("⛔ /pricing no escribe ni una cifra", () => {
  it("la página: ningún literal numérico (salvo la caché ISR, que Next exige literal)", () => {
    const pagina = leerApp("app/[locale]/pricing/page.tsx");
    expect(pagina).toContain("terminosDePrecio(locale, await preciosDelPlan())");
    expect(literalesNumericos(pagina, [/export const revalidate = \d+;/])).toEqual([]);
  });

  it("su módulo: ningún literal numérico fuera de las opciones de formato", () => {
    const modulo = leerApp("lib/legal/precios-publicados.ts");
    expect(literalesNumericos(modulo, [/(?:minimum|maximum)FractionDigits:\s*\d+/g])).toEqual([]);
  });

  it("/privacy tampoco: los plazos de retención llegan por parámetro", () => {
    expect(literalesNumericos(leerApp("app/[locale]/privacy/page.tsx"))).toEqual([]);
  });
});

describe("cada valor de /pricing sale de la constante que cobra", () => {
  const locale = "en";
  const p = terminosDePrecio(locale, PRECIO_RESPALDO);
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });

  it("la cuota por asiento es la del Price (mensual y anual) y su moneda", () => {
    expect(p.mensual).toBe(formatearPrecio(locale, PRECIO_RESPALDO.monthly));
    expect(p.anual).toBe(formatearPrecio(locale, PRECIO_RESPALDO.yearly));
    expect(p.monedaCuota).toBe(PRECIO_RESPALDO.monthly.currency.toUpperCase());
  });

  it("los tramos son TRAMOS, uno a uno, y el último no tiene techo", () => {
    expect(p.tramos.map((t) => t.tipo)).toEqual(TRAMOS.map((t) => pct.format(t.tipo)));
    expect(p.tramos[0]!.forma).toBe("hasta");
    expect(p.tramos[p.tramos.length - 1]!.forma).toBe("desde");
    expect(p.tipoMaximo).toBe(pct.format(Math.max(...TRAMOS.map((t) => t.tipo))));
    expect(p.garantia).toBe(pct.format(GARANTIA_NETA_RATIO));
    expect(p.monedaComision).toBe(MONEDA_DE_LA_COMISION);
    // Cada umbral finito aparece, formateado, en su fila.
    const umbral = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: MONEDA_DE_LA_COMISION,
      maximumFractionDigits: 0,
    });
    const finitos = TRAMOS.filter((t) => Number.isFinite(t.hastaEur)).map((t) => umbral.format(t.hastaEur));
    expect(p.tramos.filter((t) => t.hasta !== "").map((t) => t.hasta)).toEqual(finitos);
  });

  it("el mínimo facturable, el tope de asientos y los días activos son las constantes", () => {
    expect(p.minimoFacturable).toBe(
      new Intl.NumberFormat(locale, { style: "currency", currency: MONEDA_DE_LA_COMISION, minimumFractionDigits: 2 }).format(
        MINIMO_FACTURABLE_EUR,
      ),
    );
    expect(p.maxAsientos).toBe(new Intl.NumberFormat(locale).format(MAX_ASIENTOS));
    expect(p.diasActivos).toBe(String(DIAS_ACTIVOS_PARA_CONTAR_ASIENTO));
  });

  it("⛔ lo comisionable va por las etiquetas y los interruptores de tarifa.ts, no por un texto", () => {
    expect(etiquetasComisionables()).toEqual(COMISIONAR_REFERENCIA ? ["measured", "reference"] : ["measured"]);
    const nunca = etiquetasSinComision();
    expect([...etiquetasComisionables(), ...nunca].sort()).toEqual([...ETIQUETAS_DE_BASIS].sort());
    for (const e of ["estimated", "shadow", "unmeasured"]) expect(nunca).toContain(e);
    expect(p.reglaReferencia).toBe(COMISIONAR_REFERENCIA ? REGLA_REFERENCIA.version : null);
    expect(p.elisionFueraDeLaBase).toBe(!COMISIONAR_ELISION_SUELO);
  });
});

describe("⛔ el asiento que publica /pricing es el que cuenta el SQL", () => {
  it("DIAS_ACTIVOS_PARA_CONTAR_ASIENTO es el `having count(distinct day) >= N` de bvsala.billable_seats, y excluye CI", () => {
    const dir = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
    const cabecera = "create or replace function bvsala.billable_seats(";
    const ultima = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes(cabecera))
      .pop();
    expect(ultima, "ninguna migración define bvsala.billable_seats").toBeTruthy();
    const sql = readFileSync(`${dir}${ultima}`, "utf8");
    const cuerpo = sql.slice(sql.indexOf(cabecera), sql.indexOf("$$;", sql.indexOf(cabecera)));
    expect(cuerpo).toMatch(/not is_ci/);
    const m = /having count\(distinct day\) >= (\d+)/.exec(cuerpo);
    expect(m, "billable_seats perdió su umbral de días").not.toBeNull();
    expect(Number(m![1])).toBe(DIAS_ACTIVOS_PARA_CONTAR_ASIENTO);
  });

  it("el tope de asientos es el que aplica el checkout", () => {
    expect(leerApp("app/api/stripe/checkout/route.ts")).toMatch(/maximum: MAX_ASIENTOS/);
  });

  it("el ciclo del asiento es el de la suscripción: el checkout no lo ancla a un día fijo (seat.cycle)", () => {
    // /pricing dice que la cuota se cobra por cada ciclo mensual o anual de la
    // suscripción, contado desde el día en que empieza. Eso es lo que hace
    // Stripe mientras el checkout no fije `billing_cycle_anchor`; si alguien lo
    // fija (p. ej. al día 1), seat.cycle deja de ser verdad en los doce idiomas.
    expect(leerApp("app/api/stripe/checkout/route.ts")).not.toMatch(/billing_cycle_anchor/);
  });

  it("la comisión va en su propia factura, aparte de la cuota (statement.body)", () => {
    const facturar = leerApp("app/api/cron/facturar-extractos/route.ts");
    expect(facturar).toMatch(/stripe\.invoices\.create\(/);
    expect(facturar).toMatch(/pending_invoice_items_behavior: "exclude"/);
  });
});

describe("⛔ las páginas no afirman qué dice la LICENSE que enlazan", () => {
  /**
   * `LegalGoverns.LICENSE_URL` enlaza la LICENSE de la ÚLTIMA versión publicada
   * en npm, y esa puede ser anterior a estas páginas: la web se despliega al
   * fusionar en main y la LICENSE nueva llega con la release siguiente. El
   * 2026-09-26 servía la de la 0.4.24, sin §6 de tarifas y sin remitir a
   * /pricing ni a /privacy, mientras las dos páginas decían «The LICENSE refers
   * to this page…». Regla: la única frase que nombra la LICENSE es `governs`
   * («…the LICENSE and the BiVelio Terms govern»), que es verdad con cualquier
   * versión. «LICENSE» no se traduce en ningún idioma, así que la verja vale
   * para los doce.
   */
  const LOCALES = ["es", "en", "ca", "de", "fr", "it", "nl", "pl", "pt", "tr", "id", "vi"];

  function hojas(o: unknown, p = ""): [string, string][] {
    if (typeof o === "string") return [[p, o]];
    if (o !== null && typeof o === "object") {
      return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => hojas(v, p ? `${p}.${k}` : k));
    }
    return [];
  }

  for (const loc of LOCALES) {
    it(`${loc}: en pricingPage y privacyPage solo «governs» nombra la LICENSE`, () => {
      const cat = JSON.parse(leerApp(`messages/${loc}.json`)) as Record<string, unknown>;
      for (const ns of ["pricingPage", "privacyPage"]) {
        const conLicencia = hojas(cat[ns], ns)
          .filter(([, v]) => v.includes("LICENSE"))
          .map(([k]) => k);
        expect(conLicencia, `${loc}: ${ns}`).toEqual([`${ns}.governs`]);
      }
    });
  }

  it("las dos páginas pintan `governs` con el enlace a la LICENSE", () => {
    for (const ruta of ["app/[locale]/pricing/page.tsx", "app/[locale]/privacy/page.tsx"]) {
      expect(leerApp(ruta)).toContain('t.rich("governs", etiquetasQueRigen(locale))');
    }
  });
});

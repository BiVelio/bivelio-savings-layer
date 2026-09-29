import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * El precio que anuncia el README tiene que ser el que se cobra.
 *
 * POR QUÉ EXISTE: el README es la portada del paquete en npm, y durante días anunció
 * "$4 / seat / month … USD" mientras Stripe cobraba EUR en modo real. Nadie se enteró
 * porque **no había ni un solo test que cubriera precios** — se podía cambiar la moneda
 * sin romper nada verde. Este test ancla el documento a la constante de respaldo, que a
 * su vez espeja el Price de Stripe.
 *
 * Si algún día cambia el precio: se cambia en Stripe, se actualiza el respaldo de
 * `apps/web/lib/billing/planes.ts`, y este test obliga a actualizar también el README.
 *
 * Desde el 2026-09-29 el precio que se anuncia es el de Pro (`PRECIOS_DE_LOS_PLANES`):
 * la modalidad con comisión (`PRECIO_RESPALDO`, 4 €/39 €) está cerrada a clientes nuevos.
 */

const RESPALDO = new URL("../apps/web/lib/billing/planes.ts", import.meta.url);
const README = new URL("../README.md", import.meta.url);

/** Lee los importes del respaldo sin importar el módulo (arrastra `next/cache`). */
function respaldoDelCodigo(): { mensual: number; anual: number; moneda: string } {
  const src = readFileSync(RESPALDO, "utf8");
  const bloque = src.slice(src.indexOf("export const PRECIOS_DE_LOS_PLANES"));
  const importes = [...bloque.matchAll(/asientoCentimos:\s*([\d_]+)/g)].map((m) => Number(m[1]!.replace(/_/g, "")));
  const moneda = /currency:\s*"([a-z]+)"/.exec(bloque)?.[1] ?? "";
  return { mensual: importes[0]!, anual: importes[1]!, moneda };
}

const SIMBOLO: Record<string, string> = { eur: "€", usd: "$", gbp: "£" };

describe("el README anuncia el precio que de verdad se cobra", () => {
  const { mensual, anual, moneda } = respaldoDelCodigo();
  const readme = readFileSync(README, "utf8");
  const simbolo = SIMBOLO[moneda] ?? moneda.toUpperCase();

  it("el respaldo se puede leer (si no, este test no protege nada)", () => {
    expect(mensual).toBeGreaterThan(0);
    expect(anual).toBeGreaterThan(0);
    expect(moneda).toMatch(/^[a-z]{3}$/);
  });

  it("usa el símbolo de la moneda real, y ningún otro", () => {
    expect(readme).toContain(`${simbolo}${mensual / 100} / seat / month`);
    expect(readme).toContain(`${simbolo}${anual / 100} / seat /`);
    for (const [codigo, otro] of Object.entries(SIMBOLO)) {
      if (codigo === moneda) continue;
      expect(
        readme.includes(`${otro}${mensual / 100} / seat`),
        `el README sigue anunciando ${otro} y se cobra en ${moneda.toUpperCase()}`,
      ).toBe(false);
    }
  });

  it("nombra la moneda explícitamente", () => {
    expect(readme).toContain(moneda.toUpperCase());
  });
});

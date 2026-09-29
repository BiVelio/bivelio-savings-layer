import type { AbArtifact } from "@/app/[locale]/dashboard/data";

/**
 * LO QUE LA WEB PUEDE PRESENTAR COMO «LO QUE OBTIENES», cuando el artefacto
 * publicado se midió con una pieza que el paquete de npm no trae.
 * ---------------------------------------------------------------------------
 * El artefacto del 2026-09-12 (≥ 23,2 % frente a B0) se midió con el compresor
 * del banco inyectado en la capa, y npm solo lleva `noopCompressor`. El titular
 * ya se bajó a lo que sostiene el paquete (cifra-del-heroe.test.ts y
 * test/titular-como-se-instala.test.ts), pero el recibo del héroe, la frase
 * llana del paso 2, la banda del intervalo, las tarjetas por libro, la factura
 * de ejemplo de «cómo funciona» y su tarjeta social seguían leyendo el suelo
 * del artefacto sin más: la misma portada decía ≥ 23,2 % arriba y el titular
 * más abajo, y «$100 → $77» junto a «esa caja verde es un paquete de npm».
 *
 * La regla, en un solo sitio: mientras el artefacto no declare
 * `sdk.asShipped: true`,
 *   · ninguna superficie presenta su suelo, su punto ni su intervalo como lo
 *     que el cliente obtiene. Hasta el 2026-09-29 se enseñaba en su lugar el
 *     titular de la portada (un «≥ 10 %», `PROMESA_DEL_TITULAR`); desde ese día
 *     ni la portada ni el panel lo publican: lo medido es el banco en vivo
 *     (lib/portada/banco-en-vivo.ts) y, en el panel, el dinero del cliente;
 *   · la tirada se enseña solo como explicación del mecanismo, etiquetada como
 *     sintética (ReferenceModeBadge), y NetSavingsCIBand no pinta cifra;
 *   · los libros y escenarios cuyo ahorro salió de esa pieza no se anuncian.
 *
 * Con un artefacto `asShipped: true` todo esto se apaga solo: mandan sus
 * cifras medidas.
 */

/**
 * Palancas cuyo ahorro en el banco depende de una pieza que npm NO trae. Espejo
 * de `benchmarks/titular-como-se-instala.ts` (un test exige que coincidan).
 */
export const PALANCAS_QUE_NPM_NO_TRAE: readonly string[] = ["compression"];

type ArtefactoLeido = Pick<AbArtifact, "sdk" | "scenarios" | "ledgers" | "levers" | "aggregate">;

/** ¿La tirada publicada midió el SDK tal como se instala desde npm? Sin sello, no. */
export function midioElSdkInstalado(ab: Pick<AbArtifact, "sdk">): boolean {
  return ab.sdk?.asShipped === true;
}

/** Escenarios cuyo ahorro salió de una pieza que npm no trae (vacío si la tirada midió lo instalado). */
export function escenariosConPiezaDelBanco(ab: Omit<ArtefactoLeido, "aggregate">): Set<string> {
  const out = new Set<string>();
  if (midioElSdkInstalado(ab)) return out;
  for (const s of ab.scenarios ?? []) {
    const p = s.palanca;
    if (p && PALANCAS_QUE_NPM_NO_TRAE.includes(p.palanca) && p.ejercitada === true) out.add(s.name);
  }
  for (const l of ab.levers?.exercised ?? []) {
    if (l.escenario && PALANCAS_QUE_NPM_NO_TRAE.includes(l.palanca)) out.add(l.escenario);
  }
  return out;
}

/** Libros contables que agregan alguno de esos escenarios: su cifra mezcla lo que npm entrega con lo que no. */
export function librosConPiezaDelBanco(ab: Omit<ArtefactoLeido, "aggregate">): Set<string> {
  const esc = escenariosConPiezaDelBanco(ab);
  const out = new Set<string>();
  if (esc.size === 0) return out;
  for (const s of ab.scenarios ?? []) if (esc.has(s.name)) out.add(s.ledger);
  for (const l of ab.ledgers ?? []) if ((l.scenarios ?? []).some((n) => esc.has(n))) out.add(l.ledger);
  return out;
}

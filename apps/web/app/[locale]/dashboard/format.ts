/** Shared, honest formatters for the cockpit. */
export const pct = (n: number): string => (n >= 0 ? "" : "−") + Math.abs(n * 100).toFixed(1) + "%";
export const pct0 = (n: number): string => (n >= 0 ? "" : "−") + Math.abs(n * 100).toFixed(0) + "%";
export function money(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2).replace(/\.00$/, "") + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  if (a > 0 && a < 0.01) return "$" + n.toFixed(6);
  return "$" + n.toFixed(2);
}
/** Dinero con signo: «−» tipográfico delante de un importe negativo, nunca «$-». */
export const moneySigned = (n: number): string => (n < 0 ? "−" : "") + money(Math.abs(n));
// Separador de millares FIJO (coma), no `toLocaleString()` sin locale. Ese
// dependía del idioma del runtime: el servidor lo pintaba "1,212" y el navegador
// en español "1.212", y esa diferencia de TEXTO rompía la hidratación de React
// (error #418) en el ScenarioTable. Un formato determinista lo cierra: mismo
// texto en servidor y en cliente, siempre.
export const intfmt = (n: number): string =>
  Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
// Etiqueta compacta para barras de gráfico donde el número exacto va en el
// tooltip: millones a "16,1M", miles a "18k", y por debajo de 10.000 el número
// entero con comas (un recuento pequeño se lee mejor exacto que "2,6k"). Usa la
// coma decimal por ser el panel del dueño; el separador de millares sigue fijo.
export const compact = (n: number): string => {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(/\.0$/, "").replace(".", ",") + "M";
  if (a >= 1e4) return s + Math.round(a / 1e3) + "k";
  return intfmt(n);
};
/** Ledger display names shared between reference and live rails. */
export const LEDGER_LABEL: Record<string, string> = {
  avoided_calls: "avoided_calls",
  eliminated_tokens: "eliminated_tokens",
  compressed_tokens: "compressed_tokens",
  provider_cached_tokens: "provider_cached_tokens",
  output_restriction: "output_restriction",
};
// Los cinco libros mayores se pintan con la rampa de la marca (brand · mint ·
// ui · amber · deep). Antes dos de ellos eran hexes del modo oscuro (#6B8AFA,
// #43D6B2) escritos a mano: sobre fondo claro ya no pegaban con nada.
export const LEDGER_COLOR: Record<string, string> = {
  avoided_calls: "var(--brand)",
  eliminated_tokens: "var(--mint)",
  compressed_tokens: "var(--ui)",
  output_restriction: "var(--amber)",
  provider_cached_tokens: "var(--deep)",
};

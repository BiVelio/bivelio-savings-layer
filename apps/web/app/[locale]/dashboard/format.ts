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
export const intfmt = (n: number): string => Math.round(n).toLocaleString();
/** Ledger display names shared between reference and live rails. */
export const LEDGER_LABEL: Record<string, string> = {
  avoided_calls: "avoided_calls",
  eliminated_tokens: "eliminated_tokens",
  compressed_tokens: "compressed_tokens",
  provider_cached_tokens: "provider_cached_tokens",
  output_restriction: "output_restriction",
};
export const LEDGER_COLOR: Record<string, string> = {
  avoided_calls: "var(--accent)",
  eliminated_tokens: "var(--success)",
  compressed_tokens: "#6B8AFA",
  output_restriction: "var(--warn)",
  provider_cached_tokens: "#43D6B2",
};

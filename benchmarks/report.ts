import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Write a benchmark result as JSON to benchmarks/out/<name>.json. This is the
 * machine-readable form of the demo/ablation — the same data that later feeds
 * the dashboard and the "verify your savings" page. The out/ directory is
 * gitignored (results are reproducible by re-running the harness).
 */
const here = dirname(fileURLToPath(import.meta.url));
// `BVSALA_AB_OUT_DIR` existe para las verjas en seco: una tirada MOCK lanzada
// por un test escribe en un directorio temporal y no pisa `benchmarks/out/`.
const outDir = process.env.BVSALA_AB_OUT_DIR || join(here, "out");

export function writeReport(name: string, data: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

/**
 * Write rows as CSV so a reviewer can recompute the statistics independently —
 * the raw paired trials behind an A/B savings claim, not just the summary.
 */
export function writeCsv(
  name: string,
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${name}.csv`);
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(","));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

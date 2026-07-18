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
const outDir = join(here, "out");

export function writeReport(name: string, data: unknown): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

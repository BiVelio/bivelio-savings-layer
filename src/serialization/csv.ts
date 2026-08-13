import type { Serializer } from "./types.js";
import { uniformColumns } from "./compact-rows.js";

/**
 * CSV serializer — only valid for genuinely tabular data (a uniform array of
 * flat objects). CSV can be marginally smaller than the compact rows on pure tables, but it
 * does NOT preserve the JSON data model in general, so `supports()` is strict.
 */
export const csvSerializer: Serializer = {
  format: "csv",
  supports(value: unknown): boolean {
    return Array.isArray(value) && uniformColumns(value) !== null;
  },
  encode(value: unknown): string {
    const arr = value as Record<string, unknown>[];
    const columns = uniformColumns(arr)!;
    const header = columns.map(csvCell).join(",");
    const rows = arr.map((obj) =>
      columns.map((c) => csvCell(obj[c])).join(","),
    );
    return [header, ...rows].join("\n");
  },
  instruction(): string {
    return "Data is CSV: first line is the header row; each subsequent line is one record.";
  },
};

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

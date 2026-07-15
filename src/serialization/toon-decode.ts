/**
 * TOON decoder for the subset emitted by {@link encodeToon}.
 *
 * Supports: scalar fields, nested objects, empty arrays, inline scalar arrays
 * (`key[N]: a,b,c`) and tabular object arrays (`key[N]{c1,c2}:` + rows). This
 * covers the cases the format selector actually chooses TOON for, and makes the
 * JSON<->TOON round-trip deterministic and testable. List-form arrays of nested
 * objects are intentionally out of scope for decoding (the selector never picks
 * TOON for those, since JSON wins there anyway).
 */
export interface ToonDecodeOptions {
  delimiter?: "," | "\t";
  indent?: string;
}

interface Line {
  indent: number;
  content: string;
}

export function decodeToon(
  text: string,
  options: ToonDecodeOptions = {},
): unknown {
  const delimiter = options.delimiter ?? ",";
  const indentUnit = options.indent ?? "  ";
  const raw = text.split("\n").filter((l) => l.trim().length > 0);
  const lines: Line[] = raw.map((l) => ({
    indent: indentOf(l, indentUnit),
    content: l.slice(indentWidth(l, indentUnit)),
  }));
  const [obj] = parseObject(lines, 0, 0, delimiter);
  return obj;
}

function indentWidth(line: string, unit: string): number {
  let i = 0;
  while (line.startsWith(unit, i)) i += unit.length;
  return i;
}

function indentOf(line: string, unit: string): number {
  return indentWidth(line, unit) / unit.length;
}

function parseObject(
  lines: Line[],
  start: number,
  indent: number,
  delimiter: string,
): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      // Should have been consumed by a child parser.
      i++;
      continue;
    }

    const parsed = parseKeyLine(line.content, delimiter);
    if (!parsed) {
      i++;
      continue;
    }
    const { key, kind } = parsed;

    if (kind.type === "scalar") {
      obj[key] = kind.value;
      i++;
    } else if (kind.type === "inlineArray") {
      obj[key] = kind.values;
      i++;
    } else if (kind.type === "emptyArray") {
      obj[key] = [];
      i++;
    } else if (kind.type === "table") {
      const rows: Record<string, unknown>[] = [];
      i++;
      for (let r = 0; r < kind.count && i < lines.length; r++, i++) {
        const row = lines[i]!;
        if (row.indent !== indent + 1) break;
        const cells = splitCells(row.content, delimiter);
        const record: Record<string, unknown> = {};
        kind.columns.forEach((col, idx) => {
          record[col] = decodeScalar(cells[idx] ?? "null");
        });
        rows.push(record);
      }
      obj[key] = rows;
    } else {
      // Nested object.
      const [child, next] = parseObject(lines, i + 1, indent + 1, delimiter);
      obj[key] = child;
      i = next;
    }
  }
  return [obj, i];
}

type LineKind =
  | { type: "scalar"; value: unknown }
  | { type: "inlineArray"; values: unknown[] }
  | { type: "emptyArray" }
  | { type: "table"; count: number; columns: string[] }
  | { type: "object" };

function parseKeyLine(
  content: string,
  delimiter: string,
): { key: string; kind: LineKind } | null {
  // key[N]{cols}:
  const table = content.match(/^([^[:]+)\[(\d+)\]\{(.*)\}:\s*$/);
  if (table) {
    return {
      key: unquoteKey(table[1]!),
      kind: {
        type: "table",
        count: Number(table[2]),
        columns: splitCells(table[3]!, delimiter),
      },
    };
  }
  // key[N]: rest
  const arr = content.match(/^([^[:]+)\[(\d+)\]:\s*(.*)$/);
  if (arr) {
    const count = Number(arr[2]);
    const rest = arr[3]!;
    if (count === 0 || rest.trim() === "") {
      return { key: unquoteKey(arr[1]!), kind: { type: "emptyArray" } };
    }
    return {
      key: unquoteKey(arr[1]!),
      kind: {
        type: "inlineArray",
        values: splitCells(rest, delimiter).map(decodeScalar),
      },
    };
  }
  // key: value  OR  key:
  const kv = content.match(/^([^:]+):\s*(.*)$/);
  if (kv) {
    const key = unquoteKey(kv[1]!);
    const value = kv[2]!;
    if (value === "") return { key, kind: { type: "object" } };
    return { key, kind: { type: "scalar", value: decodeScalar(value) } };
  }
  return null;
}

function splitCells(row: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((c) => c.trim());
}

function decodeScalar(raw: string): unknown {
  const wasQuoted = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2;
  if (wasQuoted) return raw.slice(1, -1).replace(/""/g, '"');
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  return raw;
}

function unquoteKey(key: string): string {
  const k = key.trim();
  if (k.startsWith('"') && k.endsWith('"')) {
    return k.slice(1, -1).replace(/""/g, '"');
  }
  return k;
}

import type { CsvValue } from "./tipos.js";

// El escritor CSV de los exportadores (RFC 4180: https://www.rfc-editor.org/rfc/rfc4180).
//
// Decisiones, todas por lo que piden los consumidores:
//  · CRLF entre registros, también tras el último (la RFC lo permite).
//  · null/undefined → campo VACÍO sin comillas, y la cadena vacía → `""`. Así
//    se distinguen: FOCUS pide null para lo ausente, nunca un placeholder.
//  · Números en decimal PLANO, sin exponente: `5e-7` se escribe `0.0000005`.
//    FOCUS admite notación científica pero no con `+` en el exponente, y
//    muchas hojas de cálculo la leen como texto. Hasta 10 decimales, la misma
//    precisión que `roundUsd` (tokenizer/accounting.ts): más sería inventar
//    dígitos y menos tiraría dinero que el informe sí trae.
//  · `-0` se escribe `0`; un negativo de verdad conserva su signo.

const DECIMALES = 10;

/** Un número en decimal plano, con hasta 10 decimales y sin exponente. */
export function formatearDecimal(n: number): string {
  if (!Number.isFinite(n)) {
    throw new TypeError(`[bvsala] cannot write a non-finite number (${String(n)}) as a decimal`);
  }
  // toFixed deja de dar decimal plano a partir de 1e21; ahí el valor ya es un
  // entero en coma flotante y BigInt lo escribe sin exponente.
  if (Math.abs(n) >= 1e21) return BigInt(Math.round(n)).toString();
  const s = n.toFixed(DECIMALES).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

function campo(v: CsvValue, columna: string): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new TypeError(`[bvsala] toCsv: column "${columna}" holds a non-finite number`);
    }
    return formatearDecimal(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  // Un objeto (las `dimensions` de una fila de la serie, un array) saldría como
  // «[object Object]» sin avisar: mejor un TypeError que un CSV que miente.
  if (typeof v !== "string") {
    throw new TypeError(
      `[bvsala] toCsv: column "${columna}" holds a ${typeof v}; write strings, numbers, booleans or null ` +
        "(flatten objects such as a series row's `dimensions` into their own columns first)",
    );
  }
  const s = v;
  return s === "" || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows to RFC 4180 CSV: CRLF line breaks, quoted fields where needed, null as
 * an empty field and numbers as plain decimals (no exponent, at most 10
 * decimal places). The header is `options.columns` or the keys of the rows in
 * first-seen order. `toCsv([])` is an empty string; with `columns` it is the
 * header alone. A value that is not a string, number, boolean or null throws a
 * TypeError: map each row to flat columns first.
 */
export function toCsv(
  rows: readonly Readonly<Record<string, CsvValue>>[],
  options?: { columns?: readonly string[] },
): string {
  let columnas: readonly string[];
  if (options?.columns) {
    columnas = options.columns;
  } else {
    if (rows.length === 0) return "";
    const vistas = new Set<string>();
    for (const fila of rows) for (const k of Object.keys(fila)) vistas.add(k);
    columnas = [...vistas];
  }
  const lineas = [columnas.map((c) => campo(c, c)).join(",")];
  for (const fila of rows) lineas.push(columnas.map((c) => campo(fila[c], c)).join(","));
  return lineas.map((l) => `${l}\r\n`).join("");
}

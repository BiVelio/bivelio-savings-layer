/**
 * Comparación NUMÉRICA de versiones «gateway/0.4.16», «sdk/0.10.0-beta.1» o
 * «0.4.16» a secas. Nunca lexicográfica: «0.10.0» > «0.4.16», que es justo lo
 * que una comparación de cadenas hace mal. El mismo criterio que
 * `bvsala.semver_key` en la migración 0024 (tres enteros, sufijo ignorado).
 */

const PATRON = /^(?:(gateway|sdk)\/)?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-[0-9A-Za-z.-]{1,16})?$/;

export interface VersionParseada {
  superficie: "gateway" | "sdk" | null;
  partes: [number, number, number];
}

/** `null` si el texto no casa: aquí no se lanza, igual que en SQL. */
export function parsearVersion(v: string | null | undefined): VersionParseada | null {
  if (!v) return null;
  const m = PATRON.exec(v.trim());
  if (!m) return null;
  return {
    superficie: (m[1] as "gateway" | "sdk" | undefined) ?? null,
    partes: [Number(m[2]), Number(m[3]), Number(m[4])],
  };
}

/**
 * <0 si a < b, 0 si iguales, >0 si a > b. Solo compara los tres enteros: el
 * prefijo de superficie y el sufijo «-pre» no cuentan. Lanza si alguna no casa
 * — quien llama ya la ha validado (viene de la BD, sellada por el servidor).
 */
export function compararVersiones(a: string, b: string): number {
  const pa = parsearVersion(a);
  const pb = parsearVersion(b);
  if (!pa || !pb) throw new Error(`compararVersiones: versión no válida (${a} vs ${b})`);
  for (let i = 0; i < 3; i++) {
    const d = pa.partes[i]! - pb.partes[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** La superficie que declara el prefijo, o null si no lo lleva / no casa. */
export function superficieDe(v: string | null | undefined): "gateway" | "sdk" | null {
  return parsearVersion(v)?.superficie ?? null;
}

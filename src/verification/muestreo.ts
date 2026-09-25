import { sha256 } from "../canonicalization/canonicalize.js";

// ¿Entra esta petición en la muestra de verificación? (D6)
//
// Bernoulli por `requestId`, NO por contenido. Con un hash del contenido las
// repeticiones formarían clústeres perfectamente correlados (todas dentro o
// todas fuera) y el intervalo del panel sería falso. El `requestId` es un UUID
// aleatorio por petición; con `generateId` inyectado, el resultado es
// reproducible en los tests. Mismo esquema que `enLaMuestra` de la cascada
// (52 bits exactos en un double) con su propia sal.
export function enLaMuestraDeVerificacion(requestId: string, tasa: number): boolean {
  if (!(tasa > 0)) return false;
  if (tasa >= 1) return true;
  const digest = sha256(`${requestId}:verification-sample`);
  const trozo = Number.parseInt(digest.slice(0, 13), 16);
  return trozo / 2 ** 52 < tasa;
}

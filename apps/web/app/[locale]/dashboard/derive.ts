/**
 * Derivaciones puras del panel.
 *
 * Viven aparte de `data.ts` a propósito: ese fichero importa `next-intl/server`
 * y clientes de Supabase, así que no se puede cargar desde vitest. Aquí no hay
 * más que aritmética y fechas, de modo que la lógica que decide QUÉ AFIRMA el
 * panel sí se puede probar. Hasta ahora `apps/web/**` no estaba en ningún glob
 * de vitest.config.ts: el dashboard entero llegó a producción con cobertura
 * CERO.
 */

export type LicenseStatus = "active" | "grace" | "expired" | "revoked";

export interface LicenseRow {
  expires_at?: string;
  grace_days?: number;
  revoked?: boolean;
}

/**
 * Estado real de una licencia, con la misma semántica que aplica el SDK en
 * `src/license/verify.ts` (revocada > expirada > gracia). Si las dos se separan,
 * el panel acabará afirmando algo que el SDK no respalda.
 */
export function deriveLicenseStatus(row: LicenseRow | null, nowMs: number): LicenseStatus | null {
  // `null` no es "desconocido": es AUSENCIA MEDIDA. No hay licencia, y eso es un
  // hecho, no una laguna. Quien llama decide cómo contarlo.
  if (!row || !row.expires_at) return null;
  if (row.revoked) return "revoked";

  const expira = Date.parse(row.expires_at);
  if (Number.isNaN(expira)) return null;
  if (nowMs <= expira) return "active";

  const gracia = (row.grace_days ?? 0) * 86_400_000;
  return nowMs <= expira + gracia ? "grace" : "expired";
}

/**
 * De TODAS las licencias de la org, la que describe su situación real.
 *
 * POR QUÉ NO BASTA CON PEDIR LA MÁS NUEVA. La consulta filtraba `revoked = false`
 * antes de mirar, así que una org con la licencia revocada no devolvía ninguna
 * fila: el panel la trataba como "esta org nunca tuvo licencia" y no enseñaba
 * absolutamente nada. El peor estado en que puede estar un cliente —le hemos
 * cortado el servicio a propósito— era el único sin una sola palabra en pantalla,
 * y `deriveLicenseStatus` nunca podía devolver "revoked" aunque supiera hacerlo.
 *
 * Regla: si hay CUALQUIER licencia viva (vigente o en gracia), esa manda — una
 * revocación antigua seguida de una reemisión es un cliente sano. Solo cuando no
 * queda ninguna viva se informa del peor motivo, y ahí una revocación explica más
 * que una caducidad.
 */
export function elegirLicencia(
  rows: LicenseRow[],
  nowMs: number,
): { status: LicenseStatus; row: LicenseRow } | null {
  const conEstado = rows
    .map((row) => ({ row, status: deriveLicenseStatus(row, nowMs) }))
    .filter((x): x is { row: LicenseRow; status: LicenseStatus } => x.status !== null);
  if (conEstado.length === 0) return null;

  const viva = conEstado.find((x) => x.status === "active") ?? conEstado.find((x) => x.status === "grace");
  if (viva) return viva;

  return conEstado.find((x) => x.status === "revoked") ?? conEstado[0];
}

/** Lo que el titular de ahorro puede decir con lo que de verdad se ha medido. */
export type Verdict =
  | { kind: "empty" }                          // no hay tráfico medido
  | { kind: "unpriced" }                       // hay tráfico, pero sin baseline con el que comparar
  | {
      kind: "measured";
      net: number;
      saved: number;
      tone: "pos" | "neg";
      /**
       * La parte COMPROBABLE contra la factura del proveedor: solo peticiones
       * cuyo baseline se reconstruyó desde su contador (basis "measured"). El
       * resto son llamadas evitadas, donde el baseline es necesariamente
       * estimado porque la llamada nunca ocurrió.
       *
       * `null` cuando no hay ninguna medida. Se expone aparte a propósito: el
       * titular mezclaba las dos y enseñaba, por ejemplo, un 80% cuando lo
       * verificable era un 40%.
       */
      measured: { net: number; saved: number; share: number } | null;
    };

export interface FilaUso {
  requests: number;
  baselineCost: number;
  actualCost: number;
  measuredRequests?: number;
  measuredBaselineCost?: number;
  measuredActualCost?: number;
  baselineInputTokens?: number;
  actualInputTokens?: number;
  baselineOutputTokens?: number;
  actualOutputTokens?: number;
}

/**
 * Cuántos tokens se gastaron y cuántos se ahorraron.
 *
 *   "unavailable" — la base no trae los contadores (proyecto por detrás de la
 *                   migración 0015). NO es cero: es que no se sabe, y decir cero
 *                   sería afirmar "no ahorraste nada" sobre datos que no tenemos.
 *   "empty"       — no hay tráfico. Cero legítimo.
 *   "ok"          — hay cifras.
 */
export type TokenTotals =
  | { kind: "unavailable" }
  | { kind: "empty" }
  | {
      kind: "ok";
      /** Lo que el cliente pagó de verdad, entrada + salida. */
      spent: number;
      /** baseline − actual, sumando los dos ejes. Puede salir NEGATIVO. */
      saved: number;
      /** Desglose, porque el ahorro de salida casi siempre es 0 y hay que poder verlo. */
      savedInput: number;
      savedOutput: number;
      /** Fracción sobre el baseline, para acompañar al valor absoluto. */
      fraction: number;
      tone: "pos" | "neg";
    };

export function deriveTokens(usage: FilaUso[]): TokenTotals {
  // Basta con que UNA fila traiga los contadores: las columnas son de la tabla,
  // así que o están para todas o no están para ninguna. Se comprueba con `some`
  // y no con la primera fila por si la ventana arranca en un día sin tráfico.
  const hay = usage.some((r) => r.baselineInputTokens !== undefined);
  if (!hay) return { kind: "unavailable" };
  if (usage.length === 0) return { kind: "empty" };

  const suma = (f: (r: FilaUso) => number) => usage.reduce((n, r) => n + f(r), 0);
  const bIn = suma((r) => r.baselineInputTokens ?? 0);
  const aIn = suma((r) => r.actualInputTokens ?? 0);
  const bOut = suma((r) => r.baselineOutputTokens ?? 0);
  const aOut = suma((r) => r.actualOutputTokens ?? 0);

  const spent = aIn + aOut;
  const baseline = bIn + bOut;
  // Sin baseline no hay con qué comparar: es tráfico que el proveedor no tarifó
  // o filas de un SDK anterior. Se trata como vacío en vez de publicar un 100%.
  if (!(baseline > 0) && spent === 0) return { kind: "empty" };

  const savedInput = bIn - aIn;
  const savedOutput = bOut - aOut;
  const saved = savedInput + savedOutput;

  return {
    kind: "ok",
    spent,
    saved,
    savedInput,
    savedOutput,
    fraction: baseline > 0 ? saved / baseline : 0,
    // Mismo criterio que `deriveVerdict`: una pérdida no se pinta en verde.
    tone: saved < 0 ? "neg" : "pos",
  };
}

/**
 * El titular era `net = baseline > 0 ? 1 - actual/baseline : 0` y se pintaba con
 * la clase `pos` fija. Dos mentiras en una línea: con filas medidas pero
 * baseline 0 salía "0.0%" en verde —un cero fabricado— y una pérdida real
 * (actual > baseline) también salía en verde.
 */
export function deriveVerdict(usage: FilaUso[]): Verdict {
  if (usage.length === 0) return { kind: "empty" };
  const suma = (f: (r: FilaUso) => number) => usage.reduce((n, r) => n + f(r), 0);

  const baseline = suma((r) => r.baselineCost);
  const actual = suma((r) => r.actualCost);
  if (!(baseline > 0)) return { kind: "unpriced" };
  const net = 1 - actual / baseline;

  const mBase = suma((r) => r.measuredBaselineCost ?? 0);
  const mAct = suma((r) => r.measuredActualCost ?? 0);
  const peticiones = suma((r) => r.requests);
  const mReq = suma((r) => r.measuredRequests ?? 0);

  return {
    kind: "measured",
    net,
    saved: baseline - actual,
    tone: net < 0 ? "neg" : "pos",
    measured:
      mBase > 0
        ? { net: 1 - mAct / mBase, saved: mBase - mAct, share: peticiones > 0 ? mReq / peticiones : 0 }
        : null,
  };
}

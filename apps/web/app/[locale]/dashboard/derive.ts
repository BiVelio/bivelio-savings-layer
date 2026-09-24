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

import { COMISIONAR_REFERENCIA } from "@/lib/billing/tarifa";

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

/**
 * Lo que el titular de ahorro puede decir.
 *
 * LA JERARQUÍA SE INVIRTIÓ EL 2026-09-10, y ese es el arreglo. Hasta entonces el
 * campo grande era el TOTAL —medido más estimado más sin medir— y lo medido
 * colgaba de un campo opcional. Encima de ese total el panel escribía «Tu ahorro
 * · medido», que es falso por construcción: dos de los tres sumandos no están
 * medidos. Es el mismo fallo que la portada tenía con su titular, y se arregló
 * el mismo día.
 *
 * Ahora el titular ES lo medido: la parte reconstruida desde el contador del
 * proveedor, la única que el cliente puede cotejar con su factura. El total pasa
 * a `total`, como contexto, y solo cuando difiere de lo medido — si todo el
 * tráfico está medido no hay nada que añadir y vale `null`.
 *
 * El momento se eligió a propósito: hoy las dos cifras coinciden al céntimo
 * ($50,905003, el 1,1756 %) porque todo el tráfico entra por el gateway y el
 * gateway nunca degrada a estimado (no quita tokens, cambia precios). Arreglar
 * el rótulo cuando el número no se mueve evita que el primer cliente del SDK vea
 * caer su titular sin que nada se lo explique.
 */
export type Verdict =
  | { kind: "empty" }                          // no hay tráfico
  | { kind: "unpriced" }                       // hay tráfico, pero sin baseline con el que comparar
  | {
      /** Hay baseline pero NADA medido: el titular no puede caer al total. */
      kind: "sin_medir";
      requests: number;
    }
  | {
      kind: "measured";
      /**
       * LO MEDIDO. Comprobable contra el contador del proveedor: el de la propia
       * petición y, bajo COMISIONAR_REFERENCIA, el de la petición idéntica que ya
       * corrió (medido por referencia, 0029). Es el titular.
       */
      net: number;
      saved: number;
      tone: "pos" | "neg";
      /** Qué fracción de las peticiones está medida, por su contador o por referencia (1 = todas). */
      share: number;
      /**
       * La parte del titular medida POR REFERENCIA: repeticiones servidas sin
       * llamar al proveedor, valoradas con el contador de la idéntica que corrió.
       * `null` sin peticiones de referencia (o sin las columnas de 0029).
       */
      byReference: { requests: number; saved: number } | null;
      /**
       * El TOTAL, que incluye lo estimado y lo no medido. Contexto, jamás el
       * titular. `null` cuando coincide con lo medido, o sea cuando no hay nada
       * extra que contar.
       */
      total: { net: number; saved: number } | null;
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
  /** El carril sombra (0021). Hipotético: jamás entra en el Verdict ni en los tokens. */
  shadowRequests?: number;
  shadowBaselineCost?: number;
  shadowActualCost?: number;
  /**
   * El carril del borrado del proveedor (0025). Conteo del proveedor, precio
   * suelo nuestro: jamás entra en el Verdict ni en los tokens.
   */
  eliminatedInputTokens?: number;
  eliminatedFloorCost?: number;
  eliminatedCreditedRequests?: number;
  /**
   * El carril medido por referencia (0029). Entra en el Verdict bajo
   * COMISIONAR_REFERENCIA; jamás en los tokens (deriveTokens no cambia).
   */
  referenceRequests?: number;
  referenceBaselineCost?: number;
  referenceActualCost?: number;
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
  // VACÍO ANTES QUE «SIN COLUMNAS». Con cero filas, `some` es false por
  // definición, y durante semanas eso hizo que TODO cliente recién registrado
  // —sin una sola petición— leyera «falta aplicar la migración 0015» en su
  // primera pantalla (2026-09-12). Cero filas es «sin tráfico», que es un cero
  // legítimo, y no dice nada de las columnas de la tabla.
  if (usage.length === 0) return { kind: "empty" };
  // Basta con que UNA fila traiga los contadores: las columnas son de la tabla,
  // así que o están para todas o no están para ninguna. Se comprueba con `some`
  // y no con la primera fila por si la ventana arranca en un día sin tráfico.
  const hay = usage.some((r) => r.baselineInputTokens !== undefined);
  if (!hay) return { kind: "unavailable" };

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
/**
 * El carril SOMBRA, con derivador PROPIO — a propósito fuera de `deriveVerdict`
 * y de `deriveTokens`: la sombra es hipotética (qué habría ahorrado la elisión
 * v0, medido en sombra por el gateway) y mezclarla con el titular sería
 * inventarse el ahorro. La doctrina completa vive en la migración 0021.
 *
 *   "none" — sin datos de sombra (gateway sin la bandera, o columnas ausentes).
 *            No se pinta nada: una tarjeta vacía prometería una palanca que el
 *            cliente no tiene encendida.
 *   "ok"   — hay turnos simulados. `net` puede ser NEGATIVO (una política puede
 *            perder dinero; v2 lo demostró) y entonces va en rojo — este carril
 *            existe para decir la verdad ANTES de encender nada.
 */
export type Sombra =
  | { kind: "none" }
  | { kind: "ok"; net: number; savedUsd: number; requests: number; tone: "pos" | "neg" };

export function deriveSombra(usage: FilaUso[]): Sombra {
  const suma = (f: (r: FilaUso) => number) => usage.reduce((n, r) => n + f(r), 0);
  const requests = suma((r) => r.shadowRequests ?? 0);
  const base = suma((r) => r.shadowBaselineCost ?? 0);
  const actual = suma((r) => r.shadowActualCost ?? 0);
  if (requests <= 0 || !(base > 0)) return { kind: "none" };
  const savedUsd = base - actual;
  return { kind: "ok", net: savedUsd / base, savedUsd, requests, tone: savedUsd < 0 ? "neg" : "pos" };
}

/**
 * El carril del BORRADO DEL PROVEEDOR (0025), con derivador PROPIO — fuera de
 * `deriveVerdict`, de `deriveTokens` y de `deriveSombra`. Es el conteo que el
 * proveedor devuelve en `applied_edits` cuando NUESTROS diales cambiaron la
 * petición, valorado al precio SUELO de lectura de caché.
 *
 *   "none" — ninguna petición acreditada (gateway sin la palanca, columnas
 *            ausentes, o tráfico donde nuestros diales no borraron nada). No se
 *            pinta: una tarjeta vacía prometería una palanca que no ha actuado.
 *   "ok"   — hay acreditadas. `floorUsd` VIAJA al componente pero NO SE PINTA:
 *            el suelo es el BRUTO del turno (lectura evitada) sin restar la
 *            invalidación de prefijo del mismo corte, y la evidencia congelada
 *            da opus-4-8 NETO negativo. Un dólar que el cliente no puede
 *            contrastar contra su factura no se enseña (doctrina del recibo).
 *            Condición de salida para pintarlo: el NETO por modelo medido con
 *            el mecanismo real. `tokens` es el conteo del proveedor del período
 *   `eliminated_input_tokens` NO se expone: es columna COMPARTIDA (libro 2 del SDK + contador
 *   del proveedor en el gateway) y atribuirla al proveedor mentiría con un cliente del SDK.
 */
export type ElisionProveedor =
  | { kind: "none" }
  | { kind: "ok"; requests: number; floorUsd: number };

export function deriveElisionProveedor(usage: FilaUso[]): ElisionProveedor {
  const suma = (f: (r: FilaUso) => number) => usage.reduce((n, r) => n + f(r), 0);
  const requests = suma((r) => r.eliminatedCreditedRequests ?? 0);
  if (requests <= 0) return { kind: "none" };
  return {
    kind: "ok",
    requests,
    floorUsd: suma((r) => r.eliminatedFloorCost ?? 0),
  };
}

export function deriveVerdict(usage: FilaUso[]): Verdict {
  if (usage.length === 0) return { kind: "empty" };
  const suma = (f: (r: FilaUso) => number) => usage.reduce((n, r) => n + f(r), 0);

  const baseline = suma((r) => r.baselineCost);
  const actual = suma((r) => r.actualCost);
  if (!(baseline > 0)) return { kind: "unpriced" };
  const net = 1 - actual / baseline;

  // 0029 · lo MEDIDO POR REFERENCIA suma a lo medido bajo su interruptor: es
  // el contador del proveedor de la petición idéntica que sí corrió, valorado a
  // la baja — la misma regla que el extracto usa para la base.
  const refReq = COMISIONAR_REFERENCIA ? suma((r) => r.referenceRequests ?? 0) : 0;
  const refBase = COMISIONAR_REFERENCIA ? suma((r) => r.referenceBaselineCost ?? 0) : 0;
  const refAct = COMISIONAR_REFERENCIA ? suma((r) => r.referenceActualCost ?? 0) : 0;
  const mBase = suma((r) => r.measuredBaselineCost ?? 0) + refBase;
  const mAct = suma((r) => r.measuredActualCost ?? 0) + refAct;
  const peticiones = suma((r) => r.requests);
  const mReq = suma((r) => r.measuredRequests ?? 0) + refReq;

  // Sin nada medido el titular NO cae al total: eso es justo lo que se arregla.
  if (!(mBase > 0)) return { kind: "sin_medir", requests: peticiones };

  const mNet = 1 - mAct / mBase;
  const share = peticiones > 0 ? mReq / peticiones : 0;
  // El total solo se cuenta si aporta algo. Con todo medido, repetirlo sería
  // ruido; y una diferencia de céntimos por redondeo tampoco es información.
  const difiere = Math.abs(net - mNet) > 1e-9 || share < 1;

  return {
    kind: "measured",
    net: mNet,
    saved: mBase - mAct,
    tone: mNet < 0 ? "neg" : "pos",
    share,
    byReference: refReq > 0 ? { requests: refReq, saved: refBase - refAct } : null,
    total: difiere ? { net, saved: baseline - actual } : null,
  };
}

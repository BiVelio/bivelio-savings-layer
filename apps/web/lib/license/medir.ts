import { randomUUID } from "node:crypto";

import type { AdminClient } from "@/lib/supabase/admin";
import type { UsageRecord } from "@/lib/metering/usage";
import { degradarReferencias } from "@/lib/metering/usage";
import { DOMINIOS_DESECHABLES } from "./dominios-desechables";
import { LIMITES_MEDIR } from "./medir-publico";
import { loadPrivateKey, signCompact } from "./sign";

/**
 * LA LICENCIA «MEDIR» (plan `measure`) — gratuita, permanente, sin tarjeta.
 *
 * Decisión del dueño (docs/COMPETENCIA-2026-09-26.md §8, n.º 2 y 5): el SDK y la
 * pasarela funcionan EN SOMBRA —calculan lo que habrían ahorrado— y SIN
 * palancas: la petición del cliente sale intacta al proveedor y nada se sirve de
 * caché. Para UNA organización, con un tope de asientos y de volumen. Se pasa a
 * pago al activar palancas.
 *
 * Revierte EN PARTE #314 (el free tier cerrado): aquel cierre sigue en pie para
 * quien no tiene NINGUNA licencia (402 `no-license`); lo que se abre es una
 * licencia firmada más, verificada offline como las otras, así que el
 * fail-closed del SDK no cambia. Lo que NO se abre es el dinero: el uso de una
 * org que solo tiene Medir se ingiere para el panel, pero la ingesta lo
 * neutraliza antes de la RPC (`neutralizarParaMedir`) y no puede generar
 * comisión ni una referencia cobrable. Ese candado vive en el servidor, que es
 * lo único que un cliente no puede parchear.
 */

export const PLAN_MEDIR = "measure" as const;

// Los límites y la versión mínima viven en un módulo sin dependencias de
// servidor (medir-publico.ts) para que las páginas públicas los importen sin
// arrastrar la firma, Supabase ni la lista de dominios desechables.
export { LIMITES_MEDIR, VERSION_MINIMA_MEDIR } from "./medir-publico";

/** Dónde se pasa a pago: la cuenta de la organización, con su checkout. */
export const URL_DE_PAGO_MEDIR = "https://savings.bivelio.com/dashboard/account";

const LICENSE_HEADER = { alg: "EdDSA", typ: "BVL", v: 1 } as const;
const DAY_MS = 86_400_000;

// ── ¿Es esta org «solo Medir»? ───────────────────────────────────────────────

export interface FilaDeLicenciaConPlan {
  plan?: string | null;
  revoked: boolean;
  expires_at: string;
  grace_days: number;
}

/** ¿Esta fila está viva (no revocada, dentro de validez + gracia)? El criterio de hasValidLicense. */
export function licenciaViva(l: FilaDeLicenciaConPlan, nowMs: number): boolean {
  if (l.revoked) return false;
  const expira = Date.parse(l.expires_at);
  if (Number.isNaN(expira)) return false;
  return nowMs <= expira + (l.grace_days ?? 0) * DAY_MS;
}

export const esLicenciaMedir = (l: { plan?: string | null }): boolean => l.plan === PLAN_MEDIR;

// ── La ingesta de una org Medir ──────────────────────────────────────────────

/**
 * NUNCA COMISIÓN, NUNCA REFERENCIA COBRABLE. Reescribe EN SITIO los registros de
 * una org que solo tiene Medir, antes de la RPC:
 *
 *  · `reference` → `estimated` (sin sus dos campos): no nace ninguna fila en
 *    `reference_hits` ni un céntimo en `reference_*`;
 *  · todo registro que no sea `shadow` queda con baseline == actual: sin tokens
 *    eliminados ni comprimidos, sin llamada evitada, sin suelo de elisión y con
 *    `netSavings` 0. Lo MEDIDO sigue entrando —el gasto real, que es lo que el
 *    panel necesita— pero su ahorro medido es cero por construcción.
 *  · `shadow` pasa tal cual: es el carril hipotético (0021), que la RPC acumula
 *    solo en shadow_* y que ningún cierre lee.
 *
 * Con el SDK honrado esto no cambia nada (en sombra no hay palanca que ahorre).
 * Existe por el SDK parcheado: quien encienda palancas con una licencia Medir no
 * convierte ese ahorro en una base de comisión ni en un extracto.
 */
export function neutralizarParaMedir(records: UsageRecord[]): { neutralizados: number; referencias: number } {
  const referencias = degradarReferencias(records);
  let neutralizados = 0;
  for (const r of records) {
    const rec = r as Record<string, unknown>;
    if (rec["basis"] === "shadow") continue;
    const antes = JSON.stringify([
      rec["baselineCost"],
      rec["baselineInputTokens"],
      rec["baselineOutputTokens"],
      rec["eliminatedInputTokens"],
      rec["compressedInputTokens"],
      rec["avoidedLlm"],
      rec["netSavings"],
      rec["eliminatedInputFloorCost"],
    ]);
    rec["baselineCost"] = rec["actualCost"];
    rec["baselineInputTokens"] = rec["actualInputTokens"];
    rec["baselineOutputTokens"] = rec["actualOutputTokens"];
    rec["eliminatedInputTokens"] = 0;
    rec["compressedInputTokens"] = 0;
    rec["avoidedLlm"] = 0;
    rec["netSavings"] = 0;
    delete rec["eliminatedInputFloorCost"];
    const despues = JSON.stringify([
      rec["baselineCost"],
      rec["baselineInputTokens"],
      rec["baselineOutputTokens"],
      rec["eliminatedInputTokens"],
      rec["compressedInputTokens"],
      rec["avoidedLlm"],
      rec["netSavings"],
      rec["eliminatedInputFloorCost"],
    ]);
    if (antes !== despues) neutralizados++;
  }
  return { neutralizados, referencias };
}

/** El asiento con el que la RPC apunta un registro (`coalesce(nullif(seatId,''), 'unknown')`). */
export const asientoDe = (r: { seatId?: string }): string => (r.seatId && r.seatId !== "" ? r.seatId : "unknown");

/**
 * EL TOPE DE ASIENTOS. Recibe los asientos que ya constan en `seat_activity`
 * este mes natural y devuelve qué registros del lote entran: los de un asiento
 * ya conocido siempre; los de un asiento NUEVO mientras quede hueco. Cuenta
 * TODOS los asientos, también los de CI y el `unknown` (sin `seatId`): si CI
 * quedara fuera, marcar `ci: true` bastaría para saltarse el tope.
 *
 * Pasado el tope, la capa del cliente sigue funcionando —en sombra no hay nada
 * que quitarle— y lo que no pasa es la MEDICIÓN de ese asiento de más.
 */
export function aplicarTopeDeAsientos<T extends { seatId?: string }>(
  records: T[],
  asientosDelMes: ReadonlySet<string>,
  tope: number = LIMITES_MEDIR.asientos,
): { admitidos: T[]; rechazados: T[]; asientosRechazados: string[] } {
  const conocidos = new Set(asientosDelMes);
  const rechazadosSet = new Set<string>();
  const admitidos: T[] = [];
  const rechazados: T[] = [];
  for (const r of records) {
    const a = asientoDe(r);
    if (!conocidos.has(a)) {
      if (conocidos.size >= tope) {
        rechazados.push(r);
        rechazadosSet.add(a);
        continue;
      }
      conocidos.add(a);
    }
    admitidos.push(r);
  }
  return { admitidos, rechazados, asientosRechazados: [...rechazadosSet] };
}

/**
 * EL TOPE DE VOLUMEN: cuántos registros MEDIDOS (no sombra) caben hoy. Los
 * registros sombra no cuentan: acompañan a una petición ya contada.
 */
export function huecoDeVolumen(peticionesHoy: number, tope: number = LIMITES_MEDIR.peticionesDiarias): number {
  return Math.max(0, tope - Math.max(0, peticionesHoy));
}

/** Primer día (UTC, YYYY-MM-DD) del mes natural de `nowMs`. */
export function inicioDeMes(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

/** El día UTC (YYYY-MM-DD) de `nowMs`. */
export const diaUtc = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/**
 * El dominio del correo, en minúsculas: lo ÚNICO del correo que guarda el alta.
 * Sirve para detectar granjas de cuentas (muchas altas Medir desde un mismo
 * dominio corporativo) sin guardar la dirección.
 */
export function dominioDelCorreo(email: string | null | undefined): string | null {
  const m = /@([^@\s]+)$/.exec((email ?? "").trim().toLowerCase());
  return m ? m[1]! : null;
}

// ── Los correos desechables ──────────────────────────────────────────────────

let desechables: ReadonlySet<string> | null = null;

/**
 * ¿Es un correo DESECHABLE? (decisión del dueño, 2026-09-29: el alta Medir los
 * rechaza con 403 `disposable_email`). Contra la lista pública incrustada en
 * `dominios-desechables.ts` (fuente, commit y fecha en su cabecera; jamás se
 * descarga en runtime). Mira el dominio Y sus padres: `x.mailinator.com` es
 * `mailinator.com` (muchos servicios reparten subdominios), pero nunca baja a
 * un sufijo público de una sola etiqueta.
 *
 * El conjunto se construye en la primera llamada (≈9 000 dominios) y se reutiliza.
 */
export function esCorreoDesechable(email: string | null | undefined): boolean {
  const dominio = dominioDelCorreo(email)?.replace(/\.+$/, "");
  if (!dominio) return false;
  desechables ??= new Set(DOMINIOS_DESECHABLES.split("\n").filter((l) => l.length > 0));
  const etiquetas = dominio.split(".");
  for (let i = 0; i <= etiquetas.length - 2; i++) {
    if (desechables.has(etiquetas.slice(i).join("."))) return true;
  }
  return false;
}

// ── La emisión ───────────────────────────────────────────────────────────────

export interface LicenciaMedirEmitida {
  jti: string;
  token: string;
  expiresAt: number;
}

/**
 * Firma y persiste una licencia Medir. Sin features (no concede ninguna palanca),
 * con el tope de asientos firmado y la vigencia larga. FAIL-CLOSED: si no se
 * puede persistir, lanza y no se devuelve ningún token (un token sin fila no se
 * podría revocar por organización).
 *
 * El candado de unicidad de 0033 (una Medir viva por organización) convierte una
 * doble pulsación en un conflicto 23505: se devuelve la que ganó.
 */
export async function emitirLicenciaMedir(
  admin: AdminClient,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<LicenciaMedirEmitida> {
  const privateKey = loadPrivateKey();
  if (!privateKey) throw new Error("LICENSE_PRIVATE_KEY missing");
  const now = Math.floor(nowMs / 1000);
  const jti = randomUUID();
  const expiresAt = now + LIMITES_MEDIR.diasDeVigencia * 86_400;
  const payload = {
    jti,
    org_id: orgId,
    plan: PLAN_MEDIR,
    seats: LIMITES_MEDIR.asientos,
    features: [] as string[],
    issued_at: now,
    // CADUCADA para cualquier verificador que no conozca el plan: un SDK o una
    // pasarela anteriores al modo sombra encenderían las palancas que no van por
    // feature (caché exacta, resolvers, singleflight…). La vigencia real va en
    // sus campos propios, que solo leen los que saben que `measure` = sombra
    // (src/license/verify.ts#vigenciaEfectiva). La FILA guarda la real.
    expires_at: now,
    grace_days: 0,
    measure_expires_at: expiresAt,
    measure_grace_days: LIMITES_MEDIR.diasDeGracia,
    iss: "bivelio-measure",
  };
  const kid = process.env.LICENSE_KEY_ID;
  const token = signCompact({ ...LICENSE_HEADER, ...(kid ? { kid } : {}) }, payload, privateKey);
  const { error } = await admin.from("licenses").insert({
    id: jti,
    org_id: orgId,
    plan: PLAN_MEDIR,
    seats: LIMITES_MEDIR.asientos,
    features: [],
    issued_at: new Date(now * 1000).toISOString(),
    expires_at: new Date(expiresAt * 1000).toISOString(),
    grace_days: LIMITES_MEDIR.diasDeGracia,
    revoked: false,
    token,
  });
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const viva = await medirViva(admin, orgId);
      if (viva) return viva;
    }
    throw error;
  }
  return { jti, token, expiresAt };
}

/** La licencia Medir viva de una org, si la tiene. */
export async function medirViva(admin: AdminClient, orgId: string): Promise<LicenciaMedirEmitida | null> {
  const { data } = await admin
    .from("licenses")
    .select("id, token, expires_at")
    .eq("org_id", orgId)
    .eq("plan", PLAN_MEDIR)
    .eq("revoked", false)
    .order("issued_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fila = data as { id?: string; token?: string; expires_at?: string } | null;
  if (!fila?.id || !fila.token) return null;
  return { jti: fila.id, token: fila.token, expiresAt: Math.floor(Date.parse(fila.expires_at ?? "") / 1000) };
}

// ── La vuelta a Medir al dejar de pagar ──────────────────────────────────────

export type VueltaAMedir =
  | { resultado: "emitida"; jti: string }
  | { resultado: "ya-viva"; jti: string }
  | { resultado: "bloqueada" };

/**
 * AL CANCELAR O DEJAR DE PAGAR, LA ORGANIZACIÓN VUELVE A MEDIR (decisión del
 * dueño, 2026-09-29): sigue viendo lo que habría ahorrado en vez de quedarse sin
 * capa. Se llama DESPUÉS de cortar lo pagado —la revocación de la cancelación
 * (webhook `customer.subscription.deleted`) o la degradación del barrido de
 * impago (`/api/cron/dunning`)—, nunca antes: una Medir recién emitida es la
 * licencia MÁS NUEVA de la org, y `/api/license/current` entrega la más nueva.
 *
 * Emite una Medir salvo que:
 *  · la org ya tenga una VIVA (la conserva la cancelación: `conservarMedir`);
 *  · el operador la haya BLOQUEADO (`medir_altas.bloqueada`): el corte por abuso
 *    no se deshace porque la org pague y cancele.
 *
 * No escribe `medir_altas`: la vuelta no la reclama ninguna cuenta (la dispara
 * Stripe o el cron), y el candado de una organización por cuenta es del ALTA. Los
 * topes de asientos y de volumen sí le aplican: van por la licencia, en la ingesta.
 *
 * Lanza si no puede leer o emitir. Los llamadores NO dejan que eso deshaga el
 * corte de lo pagado: alertan, y la org siempre puede reclamarla desde el panel.
 */
export async function volverAMedir(
  admin: AdminClient,
  orgId: string,
  nowMs: number = Date.now(),
): Promise<VueltaAMedir> {
  const { data: bloqueo, error } = await admin
    .from("medir_altas")
    .select("org_id, bloqueada")
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) throw error;
  if ((bloqueo as { bloqueada?: boolean | null } | null)?.bloqueada === true) return { resultado: "bloqueada" };

  const viva = await medirViva(admin, orgId);
  if (viva && viva.expiresAt * 1000 > nowMs) return { resultado: "ya-viva", jti: viva.jti };

  const emitida = await emitirLicenciaMedir(admin, orgId, nowMs);
  return { resultado: "emitida", jti: emitida.jti };
}

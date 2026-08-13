import { getTranslations } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { elegirLicencia } from "./derive";

/**
 * Server data layer for the dashboard. Every query is best-effort: the bound
 * Supabase project (the unified BiVelio platform) may not have the savings
 * control-plane tables yet, so a missing table / RLS denial must degrade to an
 * HONEST fallback — never a fabricated or hardcoded value.
 */

// ---- The measured A/B artifact (public/data/ab-live.json) ----
export interface CI {
  point: number;
  lower: number;
  upper: number;
}
export interface AbLedger {
  ledger: string;
  scenarios: string[];
  savings: CI;
  deltaCost: number;
  proven: boolean;
}
export interface AbScenario {
  name: string;
  lever: string;
  ledger: string;
  kind: string;
  reps: number;
  armA: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  armB: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  measured: { savings: CI; wilcoxonP: number; inputTokenDeltaMean: number; outputTokenDeltaMean: number };
  quality: { gate: string; passed: number; total: number };
  amortization?: { coldMissCost: number; hitCost: number; breakEvenK: number | null };
}
export interface AbArtifact {
  mode: "LIVE" | "MOCK";
  generatedNote: string;
  methodology: string;
  config: { reps: number; seed: number };
  pricing: { note: string; table: Record<string, unknown> };
  scenarios: AbScenario[];
  ledgers: AbLedger[];
  reconciliation: { totalDelta: number; ledgerSum: number; residual: number; reconciled: boolean };
  /**
   * Los DOS brazos hablaron con el mismo modelo. Antes se leía
   * `fingerprintStable`, que comprobaba el `system_fingerprint` del brazo naive
   * y nunca los comparaba entre sí — y a través de una pasarela ese valor es un
   * id POR PETICIÓN, así que la señal era ruido.
   */
  modelStable: boolean;
  aggregate: { savings: CI; wilcoxonP: number; qualityPassRate: number; proven: boolean; headline: string };
  honesty: string[];
}

// ---- Account / org context (best-effort) ----
export interface OrgContext {
  /** Resolved organization, or null when the user isn't in one / schema absent. */
  org: { name: string; plan: string } | null;
  role: string | null;
  seats: number | null;
  /**
   * Estado de cobro de la suscripción. Los tres campos SE LEÍAN YA de la base
   * (el SELECT de abajo los pedía) y se tiraban: solo se usaba `seats`. Por eso
   * un impago era invisible — `past_due` mapea a plan "pro", así que el panel
   * pintaba "Pro" con normalidad mientras corría la gracia y el cliente se
   * enteraba cuando el SDK se le paraba, semanas después.
   */
  subscription: { status: string; currentPeriodEnd: string | null; pastDueSince: string | null } | null;
  license: {
    status: "active" | "grace" | "expired" | "revoked";
    expiresAt: string | null;
    /** Los días de gracia FIRMADOS en esa licencia, para contar lo que le queda. */
    graceDays: number;
  } | null;
  serviceAccount: { keyPrefix: string; lastUsedAt: string | null } | null;
}

/** Try the standard membership→organization shape; degrade silently on any error. */
export async function getOrgContext(
  supabase: SupabaseClient,
  orgId: string,
  userId: string,
): Promise<OrgContext> {
  const ctx: OrgContext = {
    org: null,
    role: null,
    seats: null,
    subscription: null,
    license: null,
    serviceAccount: null,
  };

  // organizations via a membership table. Table/column names may differ in the
  // bound project — a PGRST error just means "not resolvable here".
  try {
    const { data } = await supabase
      .schema("bvsala")
      .from("org_members")
      .select("role, organizations(name, plan)")
      // LOS DOS FILTROS, Y EL SEGUNDO FALTABA. `.eq("org_id", …)` a secas devuelve
      // una fila ARBITRARIA de la organización —`limit(1)` sin `order`— así que en
      // cuanto una organización tiene dos miembros, el panel le enseña a cualquiera
      // el rol de OTRO. Le dijo "owner" a un `member` recién invitado.
      //
      // No era escalada de privilegios: el servidor decide con `lib/org/permisos`
      // y la resolución propia, no con esto. Pero era una mentira en pantalla, y se
      // habría convertido en escalada el día que alguien enseñara u ocultara un
      // botón mirando `ctx.role`.
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();
    const row = data as { role?: string; organizations?: { name?: string; plan?: string } | null } | null;
    if (row?.organizations?.name) {
      ctx.org = { name: row.organizations.name, plan: (row.organizations.plan ?? "free").toLowerCase() };
      ctx.role = row.role ?? null;
    }
  } catch {
    /* schema absent — honest fallback */
  }

  // Best-effort seat / license from a subscriptions/licenses table.
  if (ctx.org) {
    try {
      const { data } = await supabase
        .schema("bvsala")
        .from("subscriptions")
        .select("seats, status, current_period_end, past_due_since")
        .eq("org_id", orgId)
        .limit(1)
        .maybeSingle();
      const sub = data as {
        seats?: number;
        status?: string;
        current_period_end?: string | null;
        past_due_since?: string | null;
      } | null;
      if (sub?.seats != null) ctx.seats = sub.seats;
      if (sub?.status) {
        ctx.subscription = {
          status: sub.status,
          currentPeriodEnd: sub.current_period_end ?? null,
          pastDueSince: sub.past_due_since ?? null,
        };
      }
    } catch {
      /* no subscription table */
    }
  }

  // Licencia real. Este bloque NO existía: `ctx.license` se declaraba, se
  // inicializaba a null y no se asignaba nunca, así que la espina daba por
  // buena la licencia con solo existir la organización — y esa fila la crea el
  // endpoint de claves de servicio. Pulsar "crear clave" encendía "License
  // active" sin que hubiera ni una fila en bvsala.licenses.
  //
  // La migración 0007 quitó `token` del alcance de authenticated, así que aquí
  // solo se piden las columnas de estado, que siguen siendo legibles.
  try {
    const { data } = await supabase
      .schema("bvsala")
      .from("licenses")
      .select("expires_at, grace_days, revoked")
      .eq("org_id", orgId)
      // SIN filtrar por `revoked`, a propósito. Filtrarlas antes de mirar hacía
      // que una org con la licencia revocada no devolviera ninguna fila y el
      // panel la tratara como "nunca tuvo licencia": el peor estado posible era
      // el único sin una palabra en pantalla. Quién manda cuando hay varias lo
      // decide `elegirLicencia`, que sí prefiere una viva a una revocada vieja.
      .order("expires_at", { ascending: false })
      .limit(5);
    const filas = (data ?? []) as { expires_at?: string; grace_days?: number; revoked?: boolean }[];
    const elegida = elegirLicencia(filas, Date.now());
    if (elegida?.row.expires_at) {
      ctx.license = {
        status: elegida.status,
        expiresAt: elegida.row.expires_at,
        graceDays: elegida.row.grace_days ?? 0,
      };
    }
  } catch {
    /* sin tabla de licencias: se queda en null, que significa AUSENCIA medida */
  }

  // Service-account key PREFIX only (plaintext key is never stored/reproducible).
  try {
    const { data } = await supabase
      .schema("bvsala")
      .from("service_accounts")
      .select("key_prefix, last_used_at")
      .eq("org_id", orgId)
      .limit(1)
      .maybeSingle();
    const sa = data as { key_prefix?: string; last_used_at?: string | null } | null;
    if (sa?.key_prefix) ctx.serviceAccount = { keyPrefix: sa.key_prefix, lastUsedAt: sa.last_used_at ?? null };
  } catch {
    /* no service_accounts table */
  }

  return ctx;
}

// ---- Live usage rollups (currently 0 rows until the CP-1 metering pipeline) ----
export interface UsageRollup {
  day: string;
  requests: number;
  avoidedLlm: number;
  actualLlm: number;
  eliminatedInputTokens: number;
  compressedInputTokens: number;
  providerCachedInputTokens: number;
  baselineCost: number;
  actualCost: number;
  /** Subconjunto MEDIDO: baseline reconstruido desde el contador del proveedor. */
  measuredRequests: number;
  measuredBaselineCost: number;
  measuredActualCost: number;
}

/** Reads usage_daily. Returns [] today (no metering pipeline). Never invents rows. */
/**
 * Resultado de leer el uso. `failed` distingue "la consulta falló" de "no hay
 * tráfico" — antes las dos colapsaban al array vacío, así que un 503 de
 * PostgREST, una columna que aún no existe (proyecto por detrás de una
 * migración) o un RLS que deniega se le pintaban al cliente como
 * "0 solicitudes vistas. Instala el SDK", con sus datos intactos en la base.
 */
export interface UsageResult {
  rows: UsageRollup[];
  failed: boolean;
}

export async function getUsageRollups(supabase: SupabaseClient, orgId: string): Promise<UsageResult> {
  try {
    // Defense-in-depth: scope to this org explicitly (not just via RLS) and bound the
    // window so a dashboard read can't grow unbounded as usage history accumulates.
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .schema("bvsala")
      .from("usage_daily")
      .select(
        "day, requests, avoided_llm, actual_llm, eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens, baseline_cost, actual_cost, measured_requests, measured_baseline_cost, measured_actual_cost",
      )
      .eq("org_id", orgId)
      .gte("day", since)
      .order("day", { ascending: true });
    // Un error de PostgREST llega como VALOR, no como excepción. Se distingue de
    // "no hay filas" (data === [] sin error), que sí es tráfico cero legítimo.
    if (error) {
      console.error("[dashboard] usage_daily read failed:", error);
      return { rows: [], failed: true };
    }
    if (!data) return { rows: [], failed: false };
    const rows = (data as Record<string, number | string>[]).map((r) => ({
      day: String(r["day"]),
      requests: Number(r["requests"] ?? 0),
      avoidedLlm: Number(r["avoided_llm"] ?? 0),
      actualLlm: Number(r["actual_llm"] ?? 0),
      eliminatedInputTokens: Number(r["eliminated_input_tokens"] ?? 0),
      compressedInputTokens: Number(r["compressed_input_tokens"] ?? 0),
      providerCachedInputTokens: Number(r["provider_cached_input_tokens"] ?? 0),
      baselineCost: Number(r["baseline_cost"] ?? 0),
      actualCost: Number(r["actual_cost"] ?? 0),
      measuredRequests: Number(r["measured_requests"] ?? 0),
      measuredBaselineCost: Number(r["measured_baseline_cost"] ?? 0),
      measuredActualCost: Number(r["measured_actual_cost"] ?? 0),
    }));
    return { rows, failed: false };
  } catch (err) {
    console.error("[dashboard] usage_daily read threw:", err);
    return { rows: [], failed: true };
  }
}

// ---- Derived connection / activation state ----
export type Metering = "awaiting" | "live";
export function meteringState(usage: UsageRollup[]): Metering {
  return usage.length > 0 ? "live" : "awaiting";
}

export interface StepState {
  /** Stable, locale-independent identity (the original English label). Logic keys off this. */
  id: string;
  /** Human-readable, localized display label. */
  label: string;
  status: "done" | "current" | "pending";
}
/** The 5-node activation spine, derived (never stored). */
export async function activationSteps(
  hasUser: boolean,
  ctx: OrgContext,
  usage: UsageRollup[],
): Promise<StepState[]> {
  const t = await getTranslations("dashboard");
  const installed = ctx.serviceAccount != null;
  // Sin `|| ctx.org != null`. Ese fallback era el que encendía el paso: la
  // organización la crea el endpoint de claves, así que no prueba nada sobre la
  // licencia. Una licencia en periodo de gracia SÍ cuenta: sigue vigente.
  const licensed = ctx.license?.status === "active" || ctx.license?.status === "grace";
  const reporting = usage.length > 0;
  const raw: Array<[string, string, boolean]> = [
    ["Account created", t("overview.steps.accountCreated"), hasUser],
    ["SDK installed", t("overview.steps.sdkInstalled"), installed],
    ["License active", t("overview.steps.licenseActive"), licensed],
    ["First report", t("overview.steps.firstReport"), reporting],
    ["Live meter", t("overview.steps.liveMeter"), reporting],
  ];
  // First not-done step is "current"; the rest "pending".
  let currentAssigned = false;
  return raw.map(([id, label, done]) => {
    if (done) return { id, label, status: "done" as const };
    if (!currentAssigned) {
      currentAssigned = true;
      return { id, label, status: "current" as const };
    }
    return { id, label, status: "pending" as const };
  });
}

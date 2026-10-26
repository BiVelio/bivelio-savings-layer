import { getTranslations } from "next-intl/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdminClient } from "@/lib/supabase/admin";
import { elegirLicencia } from "./derive";
import { estadoMedir, type EstadoMedir } from "./medir";
import { agregarAsientos, type FilaAsiento } from "@/lib/version/asientos";
import { DIA_MS, type AsientoVisto } from "@/lib/version/aviso-version";
import { esColumnaInexistente, esTablaInexistente } from "@/lib/supabase/esquema-pendiente";

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
  /** Brazo A1 (B1, integración razonablemente optimizada). Opcional: un artefacto anterior al 12-09 no lo trae. */
  armA1?: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  armB: { meanInputTokens: number; meanOutputTokens: number; meanCost: number };
  measured: { savings: CI; wilcoxonP: number; inputTokenDeltaMean: number; outputTokenDeltaMean: number };
  /** El ahorro de B frente a B1, con su propio intervalo. Opcional, como `armA1`. */
  measuredB1?: { savings: CI; wilcoxonP: number; inputTokenDeltaMean: number; outputTokenDeltaMean: number };
  quality: { gate: string; passed: number; total: number };
  amortization?: { coldMissCost: number; hitCost: number; breakEvenK: number | null };
  /** La palanca que el escenario existe para ejercitar, y si llegó a hacerlo. */
  palanca?: { palanca: string; ejercitada?: boolean; motivo?: string } | null;
}
export interface AbArtifact {
  mode: "LIVE" | "MOCK";
  /**
   * Qué SDK midió la tirada (lo sella `benchmarks/ab-live.ts`). `asShipped:
   * true` = sin piezas que el banco inyecta y el paquete de npm no trae (el
   * compresor). Opcional porque el artefacto del 2026-09-12 es anterior al
   * sello — y se midió CON el compresor. Quien lo lea pasa por
   * `lib/bench/sdk-instalado.ts`.
   */
  sdk?: { version?: string; asShipped?: boolean; compressor?: string; tokenizer?: string };
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
  /**
   * El MISMO titular frente a B1 (la integración razonablemente optimizada):
   * lo que queda después de descontar lo que un cliente razonable ya tendría
   * sin nosotros. Opcional porque los artefactos anteriores al 12-09 no lo
   * traen; la web aún no lo pinta.
   */
  aggregateB1?: { savings: CI; wilcoxonP: number; qualityPassRate: number; proven: boolean; headline: string };
  ledgersB1?: AbLedger[];
  honesty: string[];
  /**
   * La declaración del propio banco sobre qué palancas llegaron a ejecutarse.
   * El artefacto la trae desde siempre y el panel la tiraba: por eso una
   * palanca NO ejercitada (su aviso literal: «produce las mismas cifras que
   * una que no ahorra») se pintaba como un 0% medido. Opcional porque un
   * artefacto viejo puede no traerla — sin ella, las tarjetas caen al
   * comportamiento anterior en vez de romper el panel.
   */
  levers?: {
    exercised?: { palanca: string; escenario?: string | null; motivo?: string }[];
    notExercised?: { palanca: string; escenario?: string | null; motivo?: string }[];
    notMeasurable?: { palanca: string; motivo?: string }[];
    warning?: string;
  };
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
  /**
   * Qué licencia manda, visto por la licencia gratuita Medir (ver `medir.ts`):
   * `solo-medir` enseña «esto habrías ahorrado»; `sin-licencia` ofrece el alta
   * sin tarjeta. Opcional: los contextos construidos a mano (tests) no la llevan.
   */
  medir?: EstadoMedir;
}

/**
 * El contexto de la organización: membresía y organización, suscripción,
 * licencia y clave de servicio. Degrada en silencio ante cualquier error de
 * esquema: una tabla que no existe no es un fallo, es AUSENCIA medida.
 *
 * LAS CUATRO CONSULTAS SALEN A LA VEZ (22-09-2026). Iban una detrás de otra,
 * y la de suscripción además esperaba a saber si había organización. Medido en
 * producción: la función corre en Vercel y la base en Fráncfort, así que cada
 * viaje de ida y vuelta cuesta lo que cueste la distancia entre las dos —
 * ~100 ms cuando la función estaba en Virginia— y cuatro en serie eran cuatro
 * veces eso ANTES de pintar nada. Ninguna consulta depende del resultado de
 * otra: las cuatro filtran por `orgId`, y la RLS ya devuelve vacío a quien no
 * es miembro, con lo que pedir la suscripción sin saber aún si hay
 * organización cuesta una fila vacía y no una fuga. Cada una conserva su
 * propio `catch` para que el esquema de una no tumbe a las demás.
 */
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

  // Cuatro envoltorios `async` con su `try`: los constructores de PostgREST son
  // «thenables» sin `.catch`, y el esquema ausente de una tabla no debe tumbar
  // a las otras tres.
  type Membresia = { role?: string; organizations?: { name?: string; plan?: string } | null } | null;
  type Suscripcion = {
    seats?: number;
    status?: string;
    current_period_end?: string | null;
    past_due_since?: string | null;
  } | null;
  type Licencia = { expires_at?: string; grace_days?: number; revoked?: boolean; plan?: string | null };
  type ClaveDeServicio = { key_prefix?: string; last_used_at?: string | null } | null;

  const [membresia, suscripcion, licencias, claveDeServicio] = await Promise.all([
    // Organización vía tabla de membresía. LOS DOS FILTROS, y el segundo faltaba:
    // `.eq("org_id", …)` a secas devuelve una fila ARBITRARIA de la organización
    // —`limit(1)` sin `order`— así que en cuanto una organización tiene dos
    // miembros el panel le enseña a cualquiera el rol de OTRO. Le dijo "owner" a
    // un `member` recién invitado. No era escalada de privilegios: el servidor
    // decide con `lib/org/permisos` y la resolución propia, no con esto. Pero era
    // una mentira en pantalla.
    (async (): Promise<Membresia> => {
      try {
        const { data } = await supabase
          .schema("bvsala")
          .from("org_members")
          .select("role, organizations(name, plan)")
          .eq("org_id", orgId)
          .eq("user_id", userId)
          .maybeSingle();
        return data as Membresia;
      } catch {
        return null; /* schema absent — honest fallback */
      }
    })(),
    // Asientos y estado de cobro. Los tres campos de estado se LEÍAN y se tiraban:
    // un impago era invisible porque `past_due` mapea a plan "pro".
    (async (): Promise<Suscripcion> => {
      try {
        const { data } = await supabase
          .schema("bvsala")
          .from("subscriptions")
          .select("seats, status, current_period_end, past_due_since")
          .eq("org_id", orgId)
          .limit(1)
          .maybeSingle();
        return data as Suscripcion;
      } catch {
        return null; /* no subscription table */
      }
    })(),
    // Licencia real. Este bloque NO existía: `ctx.license` se declaraba, se
    // inicializaba a null y no se asignaba nunca, así que la espina daba por
    // buena la licencia con solo existir la organización. La migración 0007 quitó
    // `token` del alcance de authenticated; aquí solo se piden columnas de estado.
    // SIN filtrar por `revoked`, a propósito: filtrarlas antes de mirar hacía que
    // una org con la licencia revocada no devolviera ninguna fila y el panel la
    // tratara como "nunca tuvo licencia". Quién manda cuando hay varias lo decide
    // `elegirLicencia`, que prefiere una viva a una revocada vieja.
    (async (): Promise<Licencia[]> => {
      try {
        const { data } = await supabase
          .schema("bvsala")
          .from("licenses")
          .select("expires_at, grace_days, revoked, plan")
          .eq("org_id", orgId)
          .order("expires_at", { ascending: false })
          .limit(5);
        return (data ?? []) as Licencia[];
      } catch {
        return []; /* sin tabla de licencias: null significa AUSENCIA medida */
      }
    })(),
    // Solo el PREFIJO de la clave de servicio: la clave en claro nunca se guarda.
    (async (): Promise<ClaveDeServicio> => {
      try {
        const { data } = await supabase
          .schema("bvsala")
          .from("service_accounts")
          .select("key_prefix, last_used_at")
          .eq("org_id", orgId)
          .limit(1)
          .maybeSingle();
        return data as ClaveDeServicio;
      } catch {
        return null; /* no service_accounts table */
      }
    })(),
  ]);

  if (membresia?.organizations?.name) {
    ctx.org = { name: membresia.organizations.name, plan: (membresia.organizations.plan ?? "free").toLowerCase() };
    ctx.role = membresia.role ?? null;
  }

  // La suscripción solo cuenta si hay organización: misma regla que antes, cuando
  // la consulta ni se hacía sin ella. Ahora se hace en paralelo y se descarta.
  if (ctx.org && suscripcion) {
    if (suscripcion.seats != null) ctx.seats = suscripcion.seats;
    if (suscripcion.status) {
      ctx.subscription = {
        status: suscripcion.status,
        currentPeriodEnd: suscripcion.current_period_end ?? null,
        pastDueSince: suscripcion.past_due_since ?? null,
      };
    }
  }

  const elegida = elegirLicencia(licencias, Date.now());
  ctx.medir = estadoMedir(licencias, ctx.subscription?.status ?? null, Date.now());
  if (elegida?.row.expires_at) {
    ctx.license = {
      status: elegida.status,
      expiresAt: elegida.row.expires_at,
      graceDays: elegida.row.grace_days ?? 0,
    };
  }

  if (claveDeServicio?.key_prefix) {
    ctx.serviceAccount = { keyPrefix: claveDeServicio.key_prefix, lastUsedAt: claveDeServicio.last_used_at ?? null };
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
  /**
   * Totales de tokens (migración 0015). OPCIONALES a propósito: un proyecto que
   * aún no la haya aplicado no tiene estas columnas, y ahí la respuesta honesta
   * es "no disponible", nunca 0 — un cero se lee como "no ahorraste nada".
   */
  baselineInputTokens?: number;
  actualInputTokens?: number;
  baselineOutputTokens?: number;
  actualOutputTokens?: number;
  /**
   * El carril SOMBRA (migración 0021): qué habría pasado con la elisión
   * encendida. HIPOTÉTICO por doctrina — jamás se suma a nada de lo de arriba.
   * Opcionales por la misma razón que los tokens: sin la columna, la respuesta
   * es "no disponible", no 0.
   */
  shadowRequests?: number;
  shadowBaselineCost?: number;
  shadowActualCost?: number;
  /**
   * El carril del BORRADO DEL PROVEEDOR (migración 0025): registros en los que
   * nuestros diales cambiaron la petición y el proveedor borró (acreditadas), y
   * su valor al precio SUELO de lectura de caché. Carril propio, como la
   * sombra: jamás se suma a measured_* ni entra en la comisión
   * (COMISIONAR_ELISION_SUELO). El dólar se GUARDA pero el panel enseña solo el
   * conteo (derive.ts explica por qué). Opcionales: sin la columna, «no
   * disponible», no 0.
   */
  eliminatedFloorCost?: number;
  eliminatedCreditedRequests?: number;
  /**
   * El carril MEDIDO POR REFERENCIA (migración 0029): llamadas evitadas
   * valoradas con el contador del proveedor de la petición idéntica que sí
   * corrió. Entra en el titular y en el extracto bajo COMISIONAR_REFERENCIA
   * (lib/billing/tarifa.ts). Opcionales: sin la columna, «no disponible», no 0.
   */
  referenceRequests?: number;
  referenceBaselineCost?: number;
  referenceActualCost?: number;
  /**
   * El AHORRO NATIVO de la caché de prefijo del proveedor (migración 0032): el
   * descuento de lectura y la prima de escritura (USD, ≥ 0) y las peticiones
   * que los traen. Del proveedor: se enseña APARTE, jamás en el titular ni en
   * la comisión. Opcionales: sin la columna, «no disponible», no 0.
   */
  nativeCacheReadSavings?: number;
  nativeCacheWritePremium?: number;
  nativeRequests?: number;
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

// `esColumnaInexistente` / `esTablaInexistente` (lib/supabase/esquema-pendiente.ts):
// ¿el error de PostgREST es «esa columna / tabla aún no existe»? Confundir ese
// caso con un fallo real de lectura es justo lo que deja el panel en blanco.

/** Columnas que existían antes de la migración 0015. */
const COLUMNAS_BASE =
  "day, requests, avoided_llm, actual_llm, eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens, baseline_cost, actual_cost, measured_requests, measured_baseline_cost, measured_actual_cost";
/** Los cuatro totales de tokens que añade 0015. */
const COLUMNAS_TOKENS =
  "baseline_input_tokens, actual_input_tokens, baseline_output_tokens, actual_output_tokens";
/** El carril sombra que añade 0021. */
const COLUMNAS_SOMBRA = "shadow_requests, shadow_baseline_cost, shadow_actual_cost";
/** El carril del borrado del proveedor que añade 0025. */
const COLUMNAS_ELISION = "eliminated_floor_cost, eliminated_credited_requests";
/** El carril medido por referencia que añade 0029. */
const COLUMNAS_REFERENCIA = "reference_requests, reference_baseline_cost, reference_actual_cost";
/** El carril del ahorro nativo de la caché del proveedor que añade 0032. */
const COLUMNAS_NATIVO = "native_cache_read_savings, native_cache_write_premium, native_requests";

export async function getUsageRollups(supabase: SupabaseClient, orgId: string): Promise<UsageResult> {
  try {
    // Defense-in-depth: scope to this org explicitly (not just via RLS) and bound the
    // window so a dashboard read can't grow unbounded as usage history accumulates.
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const leer = (columnas: string) =>
      supabase
        .schema("bvsala")
        .from("usage_daily")
        .select(columnas)
        .eq("org_id", orgId)
        .gte("day", since)
        .order("day", { ascending: true });

    let { data, error } = await leer(
      `${COLUMNAS_BASE}, ${COLUMNAS_TOKENS}, ${COLUMNAS_SOMBRA}, ${COLUMNAS_ELISION}, ${COLUMNAS_REFERENCIA}, ${COLUMNAS_NATIVO}`,
    );
    // EL DESPLIEGUE PUEDE ADELANTAR A LA MIGRACIÓN, y sin esto eso tumbaba el
    // panel ENTERO. PostgREST responde 42703 cuando una columna no existe; si
    // pedimos las de 0015/0021/0025 contra un proyecto que aún no las tiene, el
    // `failed` de abajo le pinta "la lectura falló" a un cliente cuyos datos
    // están intactos — y no solo en la tarjeta nueva, sino en todo lo demás.
    //
    // Se reintenta en escalera (0032 → 0029 → 0025 → 0021 → 0015 → base). Las filas
    // salen sin las columnas que falten, que es exactamente lo que son: no
    // disponibles todavía. Las tarjetas lo dirán así, y el resto del panel sigue.
    if (error && esColumnaInexistente(error)) {
      console.warn(
        "[dashboard] usage_daily sin las columnas del ahorro nativo (¿falta la migración 0032?); " +
          "se lee sin ellas y la tarjeta del ahorro nativo no saldrá",
      );
      ({ data, error } = await leer(
        `${COLUMNAS_BASE}, ${COLUMNAS_TOKENS}, ${COLUMNAS_SOMBRA}, ${COLUMNAS_ELISION}, ${COLUMNAS_REFERENCIA}`,
      ));
    }
    if (error && esColumnaInexistente(error)) {
      console.warn(
        "[dashboard] usage_daily sin las columnas del carril medido por referencia (¿falta la migración 0029?); " +
          "se lee sin ellas y el titular y el extracto saldrán solo con lo medido por la propia petición",
      );
      ({ data, error } = await leer(`${COLUMNAS_BASE}, ${COLUMNAS_TOKENS}, ${COLUMNAS_SOMBRA}, ${COLUMNAS_ELISION}`));
    }
    if (error && esColumnaInexistente(error)) {
      console.warn(
        "[dashboard] usage_daily sin las columnas del borrado del proveedor (¿falta la migración 0025?); " +
          "se lee sin ellas y la tarjeta de borrado del proveedor no saldrá",
      );
      ({ data, error } = await leer(`${COLUMNAS_BASE}, ${COLUMNAS_TOKENS}, ${COLUMNAS_SOMBRA}`));
    }
    if (error && esColumnaInexistente(error)) {
      console.warn(
        "[dashboard] usage_daily sin las columnas del carril sombra (¿falta la migración 0021?); " +
          "se lee sin ellas y la tarjeta de sombra no saldrá",
      );
      ({ data, error } = await leer(`${COLUMNAS_BASE}, ${COLUMNAS_TOKENS}`));
    }
    if (error && esColumnaInexistente(error)) {
      console.warn(
        "[dashboard] usage_daily sin las columnas de tokens (¿falta la migración 0015?); " +
          "se lee sin ellas y la tarjeta de tokens saldrá como no disponible",
      );
      ({ data, error } = await leer(COLUMNAS_BASE));
    }
    // Un error de PostgREST llega como VALOR, no como excepción. Se distingue de
    // "no hay filas" (data === [] sin error), que sí es tráfico cero legítimo.
    if (error) {
      console.error("[dashboard] usage_daily read failed:", error);
      return { rows: [], failed: true };
    }
    if (!data) return { rows: [], failed: false };
    // Vía `unknown`: al construir el `select` con una lista de columnas variable
    // (para poder reintentar sin las de 0015) supabase-js pierde la inferencia y
    // tipa `data` como su union de error. El acceso de abajo es por índice y ya
    // normaliza cada campo con `Number`/`String`, así que la forma real la fija
    // el mapeo, no el tipo declarado.
    const rows = (data as unknown as Record<string, number | string>[]).map((r) => ({
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
      // `undefined` cuando la columna no vino (proyecto por detrás de 0015), NO
      // 0: el derivador distingue las dos cosas y la tarjeta no publica un cero
      // que se leería como "no ahorraste nada".
      ...(r["baseline_input_tokens"] != null
        ? {
            baselineInputTokens: Number(r["baseline_input_tokens"]),
            actualInputTokens: Number(r["actual_input_tokens"] ?? 0),
            baselineOutputTokens: Number(r["baseline_output_tokens"] ?? 0),
            actualOutputTokens: Number(r["actual_output_tokens"] ?? 0),
          }
        : {}),
      ...(r["shadow_requests"] != null
        ? {
            shadowRequests: Number(r["shadow_requests"]),
            shadowBaselineCost: Number(r["shadow_baseline_cost"] ?? 0),
            shadowActualCost: Number(r["shadow_actual_cost"] ?? 0),
          }
        : {}),
      ...(r["eliminated_credited_requests"] != null
        ? {
            eliminatedCreditedRequests: Number(r["eliminated_credited_requests"]),
            eliminatedFloorCost: Number(r["eliminated_floor_cost"] ?? 0),
          }
        : {}),
      ...(r["reference_requests"] != null
        ? {
            referenceRequests: Number(r["reference_requests"]),
            referenceBaselineCost: Number(r["reference_baseline_cost"] ?? 0),
            referenceActualCost: Number(r["reference_actual_cost"] ?? 0),
          }
        : {}),
      ...(r["native_requests"] != null
        ? {
            nativeRequests: Number(r["native_requests"]),
            nativeCacheReadSavings: Number(r["native_cache_read_savings"] ?? 0),
            nativeCacheWritePremium: Number(r["native_cache_write_premium"] ?? 0),
          }
        : {}),
    }));
    return { rows, failed: false };
  } catch (err) {
    console.error("[dashboard] usage_daily read threw:", err);
    return { rows: [], failed: true };
  }
}

// ---- Sesiones (0019): coste por sesión y subagente, últimos 7 días ----

export interface SesionRollup {
  day: string;
  sessionId: string;
  /** '' = el agente principal; cada subagente trae su propio id. */
  agentId: string;
  requests: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  actualCost: number;
}

// Sin la tabla de 0019 (`esTablaInexistente`), la tarjeta de sesiones se
// esconde y el resto del panel ni se entera: el despliegue puede adelantar a la
// migración, misma lección que las columnas.

export async function getSesiones(supabase: SupabaseClient, orgId: string): Promise<{ rows: SesionRollup[]; failed: boolean }> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .schema("bvsala")
      .from("usage_sessions")
      .select("day, session_id, agent_id, requests, actual_input_tokens, actual_output_tokens, actual_cost")
      .eq("org_id", orgId)
      .gte("day", since)
      .order("actual_cost", { ascending: false })
      .limit(50);
    if (error) {
      if (esTablaInexistente(error)) return { rows: [], failed: false };
      console.error("[dashboard] usage_sessions read failed:", error.code, error.message);
      return { rows: [], failed: true };
    }
    const rows = ((data ?? []) as unknown as Record<string, number | string>[]).map((r) => ({
      day: String(r["day"]),
      sessionId: String(r["session_id"] ?? ""),
      agentId: String(r["agent_id"] ?? ""),
      requests: Number(r["requests"] ?? 0),
      actualInputTokens: Number(r["actual_input_tokens"] ?? 0),
      actualOutputTokens: Number(r["actual_output_tokens"] ?? 0),
      actualCost: Number(r["actual_cost"] ?? 0),
    }));
    return { rows, failed: false };
  } catch (err) {
    console.error("[dashboard] usage_sessions read threw:", err);
    return { rows: [], failed: true };
  }
}

// ---- Uso por modelo (0022): desglose por (día, modelo) ----

export type { AsientoVisto };

/**
 * Máquinas (0024): una fila de seat_activity por asiento-día en 30 días,
 * agregada POR ASIENTO en memoria (`agregarAsientos`, pura y con tests). El
 * panel decide el aviso por el dinero medido de 7 días y explica con la versión.
 *
 * 0031 añade lo medido POR REFERENCIA por asiento (reference_*): con él, un
 * asiento cuyo ahorro de la semana son repeticiones valoradas con el contador
 * de la petición idéntica deja de salir con «0 € medidos». Nada de esto cobra:
 * los asientos se facturan por días activos y la comisión sale de usage_daily.
 *
 * Tolerante en las dos direcciones del despliegue, en ESCALERA como
 * getUsageRollups: sin las columnas de 0031 (42703/PGRST204 →
 * `esColumnaInexistente`) se relee con las de 0024 y la referencia por asiento
 * sale a 0 (no disponible: la tarjeta no pinta su nota); si faltaran también
 * las de 0024, o la tabla entera (`esTablaInexistente`), la tarjeta se esconde
 * y el panel sigue. Cualquier otro error sí es un fallo (failed) con traza.
 *
 * limit 2000 y no 500: cada job de CI es un asiento nuevo (hostnames efímeros),
 * y ordenado por día descendente para que, si se corta, se corte por lo viejo.
 */
const COLUMNAS_ASIENTO_0024 =
  "seat_id, is_ci, day, last_seen_at, client_version_min, client_version_max, requests_sin_version, measured_baseline_cost, measured_actual_cost";
/** Lo medido por referencia por asiento que añade 0031. */
const COLUMNAS_ASIENTO_0031 = "reference_baseline_cost, reference_actual_cost";

export async function getAsientos(supabase: SupabaseClient, orgId: string): Promise<{ rows: AsientoVisto[]; failed: boolean }> {
  try {
    const nowMs = Date.now();
    const since = new Date(nowMs - 30 * DIA_MS).toISOString().slice(0, 10);
    const leer = (columnas: string) =>
      supabase
        .schema("bvsala")
        .from("seat_activity")
        .select(columnas)
        .eq("org_id", orgId)
        .gte("day", since)
        .order("day", { ascending: false })
        .limit(2000);
    let { data, error } = await leer(`${COLUMNAS_ASIENTO_0024}, ${COLUMNAS_ASIENTO_0031}`);
    if (error && esColumnaInexistente(error)) {
      console.warn(
        "[dashboard] seat_activity sin las columnas de referencia por asiento (¿falta la migración 0031?); " +
          "se lee sin ellas y la tarjeta de máquinas sumará solo lo medido por la propia petición",
      );
      ({ data, error } = await leer(COLUMNAS_ASIENTO_0024));
    }
    if (error) {
      if (esColumnaInexistente(error) || esTablaInexistente(error)) return { rows: [], failed: false };
      console.error("[dashboard] seat_activity read failed:", error.code, error.message);
      return { rows: [], failed: true };
    }
    // PostgREST devuelve numeric(20,10) como CADENA («0.0200000000»): Number() la
    // normaliza, igual que el resto de columnas de dinero.
    const filas: FilaAsiento[] = ((data ?? []) as unknown as Record<string, unknown>[]).map((r) => ({
      seatId: String(r["seat_id"] ?? "unknown"),
      isCi: Boolean(r["is_ci"]),
      day: String(r["day"] ?? ""),
      lastSeenAt: String(r["last_seen_at"] ?? ""),
      versionMin: r["client_version_min"] == null ? null : String(r["client_version_min"]),
      versionMax: r["client_version_max"] == null ? null : String(r["client_version_max"]),
      requestsSinVersion: Number(r["requests_sin_version"] ?? 0),
      measuredBaselineCost: Number(r["measured_baseline_cost"] ?? 0),
      measuredActualCost: Number(r["measured_actual_cost"] ?? 0),
      referenceBaselineCost: Number(r["reference_baseline_cost"] ?? 0),
      referenceActualCost: Number(r["reference_actual_cost"] ?? 0),
    }));
    return { rows: agregarAsientos(filas, nowMs), failed: false };
  } catch (err) {
    console.error("[dashboard] seat_activity read threw:", err);
    return { rows: [], failed: true };
  }
}

export interface ModelDia {
  day: string;
  model: string;
  requests: number;
  baselineCost: number;
  actualCost: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  /** El ahorro nativo por modelo (0032), USD. Opcionales: sin la columna, no vienen. */
  nativeCacheReadSavings?: number;
  nativeCacheWritePremium?: number;
}

/**
 * Lee usage_daily_by_model, misma ventana de 120 días que getUsageRollups.
 * TOLERANTE como getSesiones: si la migración 0022 aún no está en prod (el
 * despliegue puede adelantarla), la tabla no existe y se degrada a
 * `{ rows: [], failed: false }` — el explorador muestra "acumulando por modelo",
 * nunca filas inventadas. Sin historial: el modelo nunca se guardó antes de
 * 0022, así que el desglose empieza vacío y crece con el tráfico nuevo.
 */
export async function getUsageByModel(
  supabase: SupabaseClient,
  orgId: string,
): Promise<{ rows: ModelDia[]; failed: boolean }> {
  try {
    const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const leer = (columnas: string) =>
      supabase
        .schema("bvsala")
        .from("usage_daily_by_model")
        .select(columnas)
        .eq("org_id", orgId)
        .gte("day", since)
        .order("day", { ascending: true });
    const COLUMNAS = "day, model, requests, baseline_cost, actual_cost, actual_input_tokens, actual_output_tokens";
    let { data, error } = await leer(`${COLUMNAS}, native_cache_read_savings, native_cache_write_premium`);
    // Sin 0032 las dos columnas nativas no existen: se relee sin ellas y el
    // desglose por proveedor del ahorro nativo no sale; el explorador, igual.
    if (error && esColumnaInexistente(error)) ({ data, error } = await leer(COLUMNAS));
    if (error) {
      if (esTablaInexistente(error)) return { rows: [], failed: false };
      console.error("[dashboard] usage_daily_by_model read failed:", error.code, error.message);
      return { rows: [], failed: true };
    }
    const rows = ((data ?? []) as unknown as Record<string, number | string>[]).map((r) => ({
      day: String(r["day"]),
      model: String(r["model"] ?? "unknown"),
      requests: Number(r["requests"] ?? 0),
      baselineCost: Number(r["baseline_cost"] ?? 0),
      actualCost: Number(r["actual_cost"] ?? 0),
      actualInputTokens: Number(r["actual_input_tokens"] ?? 0),
      actualOutputTokens: Number(r["actual_output_tokens"] ?? 0),
      ...(r["native_cache_read_savings"] != null
        ? {
            nativeCacheReadSavings: Number(r["native_cache_read_savings"]),
            nativeCacheWritePremium: Number(r["native_cache_write_premium"] ?? 0),
          }
        : {}),
    }));
    return { rows, failed: false };
  } catch (err) {
    console.error("[dashboard] usage_daily_by_model read threw:", err);
    return { rows: [], failed: true };
  }
}

// ---- Oportunidades sombra por modelo (0037) ----

export interface ShadowModelDia {
  day: string;
  model: string;
  shadowRequests: number;
  shadowBaselineCost: number;
  shadowActualCost: number;
}

export type ShadowReadStatus = "data" | "empty" | "hidden" | "error" | "unavailable";
export interface ShadowByModelResult {
  rows: ShadowModelDia[];
  status: ShadowReadStatus;
  /** Solo un fallo de lectura. Una migración ausente es `unavailable`, no un fallo. */
  failed: boolean;
}

/**
 * Lee el desglose sombra sin confundir tabla ausente, vacío, RLS y error. La
 * comprobación admin solo se hace cuando el usuario ve cero filas: RLS devuelve
 * ese mismo cero cuando esconde datos. Nunca devuelve contenido de prompts.
 */
export async function getShadowByModel(
  supabase: SupabaseClient,
  orgId: string,
  admin?: AdminClient,
): Promise<ShadowByModelResult> {
  const since = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .schema("bvsala")
      .from("usage_daily_shadow_by_model")
      .select("day, model, shadow_requests, shadow_baseline_cost, shadow_actual_cost")
      .eq("org_id", orgId)
      .gte("day", since)
      .order("day", { ascending: true });
    if (error) {
      if (esTablaInexistente(error)) return { rows: [], status: "unavailable", failed: false };
      console.error("[dashboard] usage_daily_shadow_by_model read failed:", error.code, error.message);
      return { rows: [], status: "error", failed: true };
    }
    const rows = ((data ?? []) as unknown as Record<string, number | string>[]).map((r) => ({
      day: String(r["day"]),
      model: String(r["model"] ?? "unknown"),
      shadowRequests: Number(r["shadow_requests"] ?? 0),
      shadowBaselineCost: Number(r["shadow_baseline_cost"] ?? 0),
      shadowActualCost: Number(r["shadow_actual_cost"] ?? 0),
    }));
    if (rows.length > 0 || !admin) return { rows, status: rows.length > 0 ? "data" : "empty", failed: false };

    const { count, error: errorReal } = await admin
      .schema("bvsala")
      .from("usage_daily_shadow_by_model")
      .select("org_id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .gte("day", since);
    if (errorReal) {
      if (esTablaInexistente(errorReal)) return { rows: [], status: "unavailable", failed: false };
      console.error("[dashboard] no se pudo comprobar la visibilidad sombra:", errorReal.code, errorReal.message);
      return { rows: [], status: "error", failed: true };
    }
    if (typeof count !== "number") return { rows: [], status: "error", failed: true };
    return { rows: [], status: count > 0 ? "hidden" : "empty", failed: false };
  } catch (err) {
    console.error("[dashboard] usage_daily_shadow_by_model read threw:", err);
    return { rows: [], status: "error", failed: true };
  }
}

// ---- Derived connection / activation state ----
export type Metering = "awaiting" | "live";
export function meteringState(usage: UsageRollup[]): Metering {
  return usage.length > 0 ? "live" : "awaiting";
}

export interface StepState {
  /** Stable, locale-independent identity. Logic keys off this, never off the label. */
  id: string;
  label: string;
  status: "done" | "current" | "pending" | "unavailable";
}

export interface ActivationReadState {
  usageFailed: boolean;
  usageHidden: boolean;
}

/** Cuenta → licencia → instalación → petición real → informe. */
export async function activationSteps(
  hasUser: boolean,
  ctx: OrgContext,
  usage: UsageRollup[],
  read: ActivationReadState,
): Promise<StepState[]> {
  const t = await getTranslations("dashboard");
  const firstRequest = usage.some((r) => r.requests > 0);
  // Una service account es una credencial, no una instalación. Con la telemetría
  // actual solo una petición real prueba que SDK o gateway están conectados.
  const installed = firstRequest;
  const licensed = ctx.license?.status === "active" || ctx.license?.status === "grace";
  const credentialsAndLicense = licensed && ctx.serviceAccount != null;
  const reporting = firstRequest && usage.length > 0;
  const usageReadable = !read.usageFailed && !read.usageHidden;
  const raw: Array<[string, string, boolean, boolean]> = [
    ["Account created", t("overview.steps.accountCreated"), hasUser, true],
    ["License active", t("overview.steps.licenseActive"), credentialsAndLicense, true],
    ["SDK or gateway installed", t("overview.steps.sdkInstalled"), installed, usageReadable],
    ["First real request", t("overview.steps.firstRequest"), firstRequest, usageReadable],
    ["Report ready", t("overview.steps.reportReady"), reporting, usageReadable],
  ];
  let currentAssigned = false;
  return raw.map(([id, label, done, available]) => {
    if (done) return { id, label, status: "done" as const };
    if (!available) return { id, label, status: "unavailable" as const };
    if (!currentAssigned) {
      currentAssigned = true;
      return { id, label, status: "current" as const };
    }
    return { id, label, status: "pending" as const };
  });
}

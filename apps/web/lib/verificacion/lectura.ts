import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { esColumnaInexistente, esFuncionInexistente, esTablaInexistente, type ErrorDePostgrest } from "@/lib/supabase/esquema-pendiente";
import { leerTodo } from "@/lib/supabase/leer-todo";

import {
  informeDelBancoPropio,
  MAX_PARES_EN_INFORME,
  type FilaDeResumen,
  type InformeDelBancoPropio,
  type Par,
} from "./banco-propio";

/**
 * LA LECTURA DE «TU PROPIO BANCO» para el panel.
 *
 * Cliente de SOLO LECTURA (se aplica la RLS de miembro) y además el filtro por
 * `org_id` explícito: un usuario en varias organizaciones no puede ver mezcladas
 * las filas de todas.
 *
 * Nunca pinta ceros por un fallo: sin tablas o sin función (0030 sin aplicar)
 * → `no_disponible`; cualquier otro error → `fallo`. «Apagado» (sin datos) es
 * solo lo que de verdad dicen las tablas.
 */

export type LecturaDelBancoPropio =
  | { estado: "no_disponible" }
  | { estado: "fallo" }
  | { estado: "ok"; desde: string; hasta: string; informe: InformeDelBancoPropio };

/** La ventana UTC `[hoy − (rango − 1), hoy]`. */
export function ventanaDelRango(rango: number, hoy: Date = new Date()): { desde: string; hasta: string } {
  const hasta = hoy.toISOString().slice(0, 10);
  const desde = new Date(Date.parse(`${hasta}T00:00:00Z`) - (rango - 1) * 86_400_000).toISOString().slice(0, 10);
  return { desde, hasta };
}

/** Semilla reproducible del informe: la misma org y ventana dan las mismas cifras. */
export function semillaDelInforme(orgId: string, desde: string, hasta: string): number {
  return Number.parseInt(createHash("sha256").update(`${orgId}:${desde}:${hasta}:your-bench`).digest("hex").slice(0, 8), 16);
}

const TAM_PAGINA = 1000;

class LecturaFallida extends Error {
  constructor(readonly error: ErrorDePostgrest) {
    super(error.message ?? "lectura fallida");
  }
}

const pendiente = (e: ErrorDePostgrest) => esTablaInexistente(e) || esFuncionInexistente(e) || esColumnaInexistente(e);

export async function leerBancoPropio(
  supabase: SupabaseClient,
  orgId: string,
  rango: number,
  hoy: Date = new Date(),
): Promise<LecturaDelBancoPropio> {
  const { desde, hasta } = ventanaDelRango(rango, hoy);
  try {
    const bv = supabase.schema("bvsala");
    const [resumen, diarios, cuenta] = await Promise.all([
      bv.rpc("verification_summary", { p_org: orgId, p_from: desde, p_to: hasta }).then(({ data, error }) => {
        if (error) throw new LecturaFallida(error);
        return (data ?? []) as Array<Record<string, unknown>>;
      }),
      leerTodo<Record<string, unknown>>(() =>
        bv.from("verification_daily").select("day, category, requests").eq("org_id", orgId).gte("day", desde).lte("day", hasta),
      ).catch((e: ErrorDePostgrest) => {
        throw new LecturaFallida(e);
      }),
      bv
        .from("verification_samples")
        .select("request_id", { count: "exact", head: true })
        .eq("org_id", orgId)
        .eq("outcome", "paired")
        .gte("day", desde)
        .lte("day", hasta)
        .then(({ count, error }) => {
          if (error) throw new LecturaFallida(error);
          return count ?? 0;
        }),
    ]);

    // Los pares, en orden ALEATORIO estable (sort_key = md5(request_id)) y con
    // paginación por clave hasta el tope: por encima, el informe se calcula sobre
    // un subconjunto aleatorio y lo dice.
    const pares: Par[] = [];
    let despuesDe: string | null = null;
    while (pares.length < MAX_PARES_EN_INFORME) {
      let q = bv
        .from("verification_samples")
        .select("sort_key, stratum, naive_cost::text, optimized_cost::text, naive_input_tokens, naive_output_tokens, cached_input_per_1k::text, output_per_1k::text")
        .eq("org_id", orgId)
        .eq("outcome", "paired")
        .gte("day", desde)
        .lte("day", hasta);
      if (despuesDe !== null) q = q.gt("sort_key", despuesDe);
      const { data, error } = await q.order("sort_key", { ascending: true }).limit(Math.min(TAM_PAGINA, MAX_PARES_EN_INFORME - pares.length));
      if (error) throw new LecturaFallida(error);
      const filas = (data ?? []) as unknown as Array<Record<string, unknown>>;
      for (const f of filas) {
        pares.push({
          stratum: String(f["stratum"]),
          naiveCost: Number(f["naive_cost"] ?? 0),
          optimizedCost: Number(f["optimized_cost"] ?? 0),
          naiveInputTokens: Number(f["naive_input_tokens"] ?? 0),
          naiveOutputTokens: Number(f["naive_output_tokens"] ?? 0),
          cachedInputPer1k: f["cached_input_per_1k"] === null || f["cached_input_per_1k"] === undefined ? null : Number(f["cached_input_per_1k"]),
          outputPer1k: Number(f["output_per_1k"] ?? 0),
        });
      }
      if (filas.length < TAM_PAGINA) break;
      const ultimo = String(filas[filas.length - 1]!["sort_key"]);
      if (ultimo === despuesDe) break;
      despuesDe = ultimo;
    }

    const conteos: Record<string, number> = {};
    for (const d of diarios) {
      const k = String(d["category"]);
      conteos[k] = (conteos[k] ?? 0) + Number(d["requests"] ?? 0);
    }
    const filasDeResumen: FilaDeResumen[] = resumen.map((f) => ({
      outcome: String(f["outcome"]),
      stratum: String(f["stratum"]),
      samples: Number(f["samples"] ?? 0),
      naiveCost: Number(f["naive_cost"] ?? 0),
      naiveTruncated: Number(f["naive_truncated"] ?? 0),
      naiveContractMissed: Number(f["naive_contract_missed"] ?? 0),
    }));

    return {
      estado: "ok",
      desde,
      hasta,
      informe: informeDelBancoPropio({
        conteos,
        resumen: filasDeResumen,
        pares,
        totalPares: cuenta,
        semilla: semillaDelInforme(orgId, desde, hasta),
      }),
    };
  } catch (err) {
    const e = err instanceof LecturaFallida ? err.error : (err as ErrorDePostgrest);
    if (e && pendiente(e)) {
      console.warn("[dashboard/your-bench] sin el esquema de 0030 (¿migración sin aplicar?)", e);
      return { estado: "no_disponible" };
    }
    console.error("[dashboard/your-bench] la lectura falló:", err);
    return { estado: "fallo" };
  }
}

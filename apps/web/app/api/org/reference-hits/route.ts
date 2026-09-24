import { NextResponse } from "next/server";

import { COLUMNAS_REFERENCE_HITS, csvDeReferencias, type FilaDeReferencia } from "@/lib/metering/referencias-csv";
import { contextoDeLaOrg } from "@/lib/org/guardia";
import { createAdminClient } from "@/lib/supabase/admin";
import { esTablaInexistente, type ErrorDePostgrest } from "@/lib/supabase/esquema-pendiente";
import { leerTodo } from "@/lib/supabase/leer-todo";
import { createClient } from "@/lib/supabase/server";

/**
 * LAS REPETICIONES MEDIDAS POR REFERENCIA DE UN PERÍODO, UNA FILA POR PETICIÓN
 * (CSV). Es el enlace del extracto (0029).
 *
 * Por qué existe: una repetición valorada por referencia no tiene contador
 * propio — su baseline es el contador que el proveedor devolvió para la
 * petición idéntica que sí corrió. Lo que la hace defendible es poder
 * contrastarla FILA A FILA: cada línea dice qué petición sirvió de referencia
 * (`reference_request_id`, su report.requestId) y cuándo se leyó su contador
 * (`reference_at`), para cotejarla con el informe de esa petición y con el uso
 * del proveedor de ese día.
 *
 * Mismo contrato que el resto de /api/org: sesión (401 sin ella), organización y
 * permiso `ver_panel` por `contextoDeLaOrg` (su status si no pasa), y el filtro
 * por `org_id` EXPLÍCITO — el cliente de servicio salta la RLS.
 *
 * El despliegue puede adelantar a la migración: sin la tabla de 0029, el CSV
 * sale con la cabecera y ninguna fila, que es la verdad (no hay repeticiones
 * medidas por referencia sin la tabla que las guarda).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "ver_panel");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const periodo = new URL(req.url).searchParams.get("periodo") ?? "";
  if (!PERIODO.test(periodo)) {
    return NextResponse.json({ error: "periodo must be YYYY-MM" }, { status: 400 });
  }
  const desde = `${periodo}-01`;
  // Cota superior sin aritmética de meses: el primer día del período siguiente.
  const [y, m] = periodo.split("-").map(Number);
  const hasta = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);

  let filas: FilaDeReferencia[];
  try {
    // PAGINADO: PostgREST corta a 1000 filas sin error, y un mes de FAQ
    // repetida pasa de mil aciertos en un día. Orden estable (día, petición).
    filas = await leerTodo<FilaDeReferencia>(() =>
      admin
        .from("reference_hits")
        .select(COLUMNAS_REFERENCE_HITS)
        .eq("org_id", g.orgId)
        .gte("day", desde)
        .lt("day", hasta)
        .order("day", { ascending: true })
        .order("request_id", { ascending: true }),
    );
  } catch (error) {
    if (esTablaInexistente(error as ErrorDePostgrest)) {
      console.warn("[org/reference-hits] sin la tabla reference_hits (¿falta la migración 0029?); CSV vacío");
      filas = [];
    } else {
      console.error("[org/reference-hits] lectura falló:", error);
      return NextResponse.json({ error: "Could not read the repeated requests." }, { status: 503 });
    }
  }

  return new Response(csvDeReferencias(filas), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="reference-hits-${periodo}.csv"`,
      // Datos de la organización: ni proxies ni el navegador lo guardan.
      "cache-control": "private, no-store",
    },
  });
}

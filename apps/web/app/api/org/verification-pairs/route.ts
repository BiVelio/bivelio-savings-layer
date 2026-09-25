import { NextResponse } from "next/server";

import {
  diaSiguiente,
  diasEntre,
  esDiaValido,
  MAX_FILAS_POR_DESCARGA,
  PRESUPUESTO_DESCARGA_MS,
} from "@/lib/metering/referencias-csv";
import { contextoDeLaOrg } from "@/lib/org/guardia";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  esColumnaInexistente,
  esFuncionInexistente,
  esTablaInexistente,
  type ErrorDePostgrest,
} from "@/lib/supabase/esquema-pendiente";
import { createClient } from "@/lib/supabase/server";
import {
  bloqueCsvVerificacion,
  CABECERA_CSV_VERIFICACION,
  COLUMNAS_VERIFICATION_SAMPLES,
  type FilaDeVerificacion,
  type LectorDePaginaDeVerificacion,
} from "@/lib/verificacion/csv";
import { paginasPorClave } from "@/lib/verificacion/csv-bloque";

/**
 * LOS PARES DE «TU PROPIO BANCO», UNA FILA POR PETICIÓN COMPROBADA (CSV).
 *
 * Con esto y los recuentos del panel el cliente puede rehacer cada cifra: los
 * dos lados del par con sus tokens, su coste y las tarifas con que se valoró.
 * Informativo: nada de esto se factura.
 *
 * Mismo contrato que `reference-hits`: sesión (401), `contextoDeLaOrg(…,
 * "ver_panel")` y filtro por `org_id` EXPLÍCITO (el cliente de servicio salta la
 * RLS). `?range=30|90|120` (la ventana UTC del panel) o `?dia=YYYY-MM-DD`.
 * A escala: recuento previo (413 por encima de un millón), lectura por día con
 * paginación por clave y streaming. Sin tabla o sin función → 503, jamás un CSV
 * vacío.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Literal: Next exige la configuración de segmento estática (= DURACION_MAXIMA_DESCARGA_S).
export const maxDuration = 300;

const RANGOS = new Set(["30", "90", "120"]);

export async function GET(req: Request): Promise<Response> {
  const inicio = Date.now();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const admin = createAdminClient();
  const g = await contextoDeLaOrg(admin, user.id, "ver_panel");
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const params = new URL(req.url).searchParams;
  const rango = params.get("range");
  const dia = params.get("dia");
  let desde: string;
  let hasta: string; // exclusivo
  let nombre: string;
  if (dia !== null && rango === null && esDiaValido(dia)) {
    desde = dia;
    hasta = diaSiguiente(dia);
    nombre = dia;
  } else if (rango !== null && dia === null && RANGOS.has(rango)) {
    const hoy = new Date(inicio).toISOString().slice(0, 10);
    desde = new Date(Date.parse(`${hoy}T00:00:00Z`) - (Number(rango) - 1) * 86_400_000).toISOString().slice(0, 10);
    hasta = diaSiguiente(hoy);
    nombre = `${rango}d-${hoy}`;
  } else {
    return NextResponse.json({ error: "range must be 30, 90 or 120, or dia must be YYYY-MM-DD" }, { status: 400 });
  }

  // 1 · CUÁNTAS FILAS, ANTES DE LEER NINGUNA: el resumen exacto de 0030 con la org resuelta.
  const { data: resumen, error: errResumen } = await admin.rpc("verification_summary", {
    p_org: g.orgId,
    p_from: desde,
    p_to: new Date(Date.parse(`${hasta}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10),
  });
  if (errResumen) return noDisponible("verification_summary", errResumen);
  const filasEsperadas = ((resumen ?? []) as Array<{ samples: number | string | null }>).reduce(
    (n, f) => n + Number(f.samples ?? 0),
    0,
  );
  if (filasEsperadas > MAX_FILAS_POR_DESCARGA) {
    return NextResponse.json(
      {
        error:
          `This range has ${filasEsperadas} checked requests, more than one download can carry ` +
          `(${MAX_FILAS_POR_DESCARGA}). Download it one day at a time with ?dia=YYYY-MM-DD.`,
        rows: filasEsperadas,
        limit: MAX_FILAS_POR_DESCARGA,
        firstDay: `/api/org/verification-pairs?dia=${desde}`,
      },
      { status: 413 },
    );
  }

  // 2 · PÁGINAS POR CLAVE, día a día (índice (org_id, day, request_id) de 0030).
  const leer: LectorDePaginaDeVerificacion = async (d, despuesDe, tam) => {
    let q = admin.from("verification_samples").select(COLUMNAS_VERIFICATION_SAMPLES).eq("org_id", g.orgId).eq("day", d);
    if (despuesDe !== null) q = q.gt("request_id", despuesDe);
    const { data, error } = await q.order("request_id", { ascending: true }).limit(tam);
    if (error) throw error;
    return (data ?? []) as unknown as FilaDeVerificacion[];
  };
  const paginas = paginasPorClave(diasEntre(desde, hasta), leer, bloqueCsvVerificacion, {
    fin: inicio + PRESUPUESTO_DESCARGA_MS,
  });

  let primera: IteratorResult<string, void>;
  try {
    primera = await paginas.next();
  } catch (error) {
    return noDisponible("verification_samples", error as ErrorDePostgrest);
  }

  const texto = new TextEncoder();
  const cuerpo = new ReadableStream<Uint8Array>({
    start(controlador) {
      controlador.enqueue(texto.encode(`${CABECERA_CSV_VERIFICACION}\r\n`));
      if (primera.done) controlador.close();
      else controlador.enqueue(texto.encode(primera.value));
    },
    async pull(controlador) {
      try {
        const r = await paginas.next();
        if (r.done) controlador.close();
        else controlador.enqueue(texto.encode(r.value));
      } catch (error) {
        console.error("[org/verification-pairs] la descarga se cortó a mitad:", error);
        controlador.error(error);
      }
    },
    async cancel() {
      await paginas.return(undefined);
    },
  });

  return new Response(cuerpo, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="verification-pairs-${nombre}.csv"`,
      "cache-control": "private, no-store",
    },
  });
}

/** 503: los pares no se pueden servir enteros ahora mismo. Nunca un CSV vacío en su lugar. */
function noDisponible(fuente: string, error: ErrorDePostgrest): Response {
  if (esTablaInexistente(error) || esFuncionInexistente(error) || esColumnaInexistente(error)) {
    console.warn(`[org/verification-pairs] ${fuente} sin el esquema de 0030 (¿migración sin aplicar?)`, error);
  } else {
    console.error(`[org/verification-pairs] lectura de ${fuente} falló:`, error);
  }
  return NextResponse.json({ error: "Could not read the verification pairs." }, { status: 503 });
}

import { NextResponse } from "next/server";

import {
  CABECERA_CSV_REFERENCIAS,
  COLUMNAS_REFERENCE_HITS,
  diaSiguiente,
  diasEntre,
  esDiaValido,
  MAX_FILAS_POR_DESCARGA,
  paginasDeReferencias,
  PRESUPUESTO_DESCARGA_MS,
  type FilaDeReferencia,
  type LectorDePaginaDeReferencias,
} from "@/lib/metering/referencias-csv";
import { contextoDeLaOrg } from "@/lib/org/guardia";
import { createAdminClient } from "@/lib/supabase/admin";
import { esColumnaInexistente, type ErrorDePostgrest } from "@/lib/supabase/esquema-pendiente";
import { createClient } from "@/lib/supabase/server";

/**
 * LAS REPETICIONES MEDIDAS POR REFERENCIA DE UN PERÍODO (O DE UN DÍA), UNA FILA
 * POR PETICIÓN (CSV). Es el enlace del extracto (0029).
 *
 * Por qué existe: una repetición valorada por referencia no tiene contador
 * propio — su baseline es el contador que el proveedor devolvió para la
 * petición idéntica que sí corrió. Lo que la hace defendible es poder
 * contrastarla FILA A FILA: cada línea dice qué petición sirvió de referencia
 * (`reference_request_id`, su report.requestId) y cuándo se leyó su contador
 * (`reference_at`), para cotejarla con el informe de esa petición y con el uso
 * del proveedor de ese día. La verja del ingest garantiza que toda fila lleva
 * los dos (sin puntero, el registro baja a estimated y no llega aquí).
 *
 * Mismo contrato que el resto de /api/org: sesión (401 sin ella), organización y
 * permiso `ver_panel` por `contextoDeLaOrg` (su status si no pasa), y el filtro
 * por `org_id` EXPLÍCITO — el cliente de servicio salta la RLS.
 *
 * `?periodo=YYYY-MM` (el mes) o `?dia=YYYY-MM-DD` (un día; con `periodo`, tiene
 * que caer dentro). A ESCALA (ver lib/metering/referencias-csv.ts): lectura por
 * día con paginación por clave y respuesta en streaming; un rango con más de
 * MAX_FILAS_POR_DESCARGA filas responde 413 y se baja por días.
 *
 * Es una PRUEBA, así que nunca miente por omisión: si la lectura falla —también
 * si la tabla o las columnas de 0029 aún no existen, o la caché de esquema de
 * PostgREST no las ve— responde 503, jamás un CSV vacío que diría «no hubo
 * repeticiones» mientras el extracto pinta un importe. Un fallo a mitad del
 * flujo corta la descarga con error, jamás la da por terminada.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Literal: Next exige la configuración de segmento estática. Igual a
// DURACION_MAXIMA_DESCARGA_S (route.test.ts lo fija).
export const maxDuration = 300;

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

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
  const periodo = params.get("periodo");
  const dia = params.get("dia");
  let desde: string;
  let hasta: string;
  let nombre: string;
  if (dia !== null) {
    if (!esDiaValido(dia) || (periodo !== null && !dia.startsWith(`${periodo}-`))) {
      return NextResponse.json({ error: "dia must be YYYY-MM-DD (inside periodo, if given)" }, { status: 400 });
    }
    desde = dia;
    hasta = diaSiguiente(dia);
    nombre = dia;
  } else {
    if (periodo === null || !PERIODO.test(periodo)) {
      return NextResponse.json({ error: "periodo must be YYYY-MM" }, { status: 400 });
    }
    desde = `${periodo}-01`;
    // Cota superior sin aritmética de meses: el primer día del período siguiente.
    const [y, m] = periodo.split("-").map(Number);
    hasta = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
    nombre = periodo;
  }

  // 1 · CUÁNTAS FILAS, ANTES DE LEER NINGUNA. usage_daily.reference_requests
  // cuenta exactamente las filas de reference_hits (la RPC escribe las dos en
  // la misma vuelta, bajo la misma condición) y son ≤ 31 filas por org: cuesta
  // una ida y vuelta, frente a un count(*) sobre millones.
  const { data: dias, error: errCuenta } = await admin
    .from("usage_daily")
    .select("reference_requests")
    .eq("org_id", g.orgId)
    .gte("day", desde)
    .lt("day", hasta);
  if (errCuenta) return noDisponible("usage_daily", errCuenta);
  const filasEsperadas = ((dias ?? []) as Array<{ reference_requests: number | string | null }>).reduce(
    (n, d) => n + Number(d.reference_requests ?? 0),
    0,
  );
  if (filasEsperadas > MAX_FILAS_POR_DESCARGA) {
    return NextResponse.json(
      {
        error:
          `This range has ${filasEsperadas} repeated requests, more than one download can carry ` +
          `(${MAX_FILAS_POR_DESCARGA}). Download it one day at a time with ?dia=YYYY-MM-DD.`,
        rows: filasEsperadas,
        limit: MAX_FILAS_POR_DESCARGA,
        firstDay: `/api/org/reference-hits?dia=${desde}`,
      },
      { status: 413 },
    );
  }

  // 2 · PÁGINAS POR CLAVE, día a día (índice (org_id, day, request_id) de 0029).
  const leer: LectorDePaginaDeReferencias = async (d, despuesDe, tam) => {
    let q = admin.from("reference_hits").select(COLUMNAS_REFERENCE_HITS).eq("org_id", g.orgId).eq("day", d);
    if (despuesDe !== null) q = q.gt("request_id", despuesDe);
    const { data, error } = await q.order("request_id", { ascending: true }).limit(tam);
    if (error) throw error;
    return (data ?? []) as unknown as FilaDeReferencia[];
  };
  const paginas = paginasDeReferencias(diasEntre(desde, hasta), leer, { fin: inicio + PRESUPUESTO_DESCARGA_MS });

  // La PRIMERA lectura va antes del 200: si la tabla no está (0029 sin aplicar)
  // o la caché de esquema no la ve, el cliente recibe un 503 y no un fichero.
  let primera: IteratorResult<string, void>;
  try {
    primera = await paginas.next();
  } catch (error) {
    return noDisponible("reference_hits", error as ErrorDePostgrest);
  }

  // 3 · STREAMING con contrapresión: cada `pull` lee una página cuando el
  // cliente ha consumido la anterior. Un error a mitad corta el flujo CON ERROR
  // (la descarga falla a la vista) en vez de cerrarlo como si hubiera acabado.
  const texto = new TextEncoder();
  const cuerpo = new ReadableStream<Uint8Array>({
    start(controlador) {
      controlador.enqueue(texto.encode(`${CABECERA_CSV_REFERENCIAS}\r\n`));
      if (primera.done) controlador.close();
      else controlador.enqueue(texto.encode(primera.value));
    },
    async pull(controlador) {
      try {
        const r = await paginas.next();
        if (r.done) controlador.close();
        else controlador.enqueue(texto.encode(r.value));
      } catch (error) {
        console.error("[org/reference-hits] la descarga se cortó a mitad:", error);
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
      "content-disposition": `attachment; filename="reference-hits-${nombre}.csv"`,
      // Datos de la organización: ni proxies ni el navegador lo guardan.
      "cache-control": "private, no-store",
    },
  });
}

/** 503: la prueba no se puede servir entera ahora mismo. Nunca un CSV vacío en su lugar. */
function noDisponible(tabla: string, error: ErrorDePostgrest): Response {
  if (esColumnaInexistente(error)) {
    console.warn(`[org/reference-hits] ${tabla} sin el esquema de 0029 (¿migración sin aplicar o caché de esquema desfasada?)`, error);
  } else {
    console.error(`[org/reference-hits] lectura de ${tabla} falló:`, error);
  }
  return NextResponse.json({ error: "Could not read the repeated requests." }, { status: 503 });
}

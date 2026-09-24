import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/org/reference-hits?periodo=YYYY-MM — el CSV de las repeticiones
 * medidas por referencia (0029), el enlace del extracto. Lo que se protege:
 *   · sin sesión, 401; sin permiso, el status del guardia; período raro, 400;
 *   · el filtro por org_id EXPLÍCITO (el cliente de servicio salta la RLS);
 *   · la cabecera exacta y la defensa contra la inyección de fórmulas;
 *   · sin la tabla (0029 sin aplicar), un CSV con cabecera y sin filas.
 */

const ORG = "22222222-2222-4222-8222-222222222222";

let usuario: { id: string } | null = { id: "user-1" };
let guardia: { ok: true; orgId: string; role: string } | { ok: false; status: number; error: string } = {
  ok: true,
  orgId: ORG,
  role: "member",
};
let filas: Array<Record<string, unknown>> = [];
let errorDeLectura: { code?: string; message?: string } | null = null;
/** Lo que la ruta pidió a PostgREST. */
const consulta: { tabla?: string; eq: Array<[string, unknown]>; gte: Array<[string, unknown]>; lt: Array<[string, unknown]>; order: string[] } = {
  eq: [],
  gte: [],
  lt: [],
  order: [],
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: usuario } }) } }),
}));
vi.mock("@/lib/org/guardia", () => ({
  contextoDeLaOrg: async (_admin: unknown, _uid: string, accion: string) => {
    expect(accion).toBe("ver_panel");
    return guardia;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabla: string) => {
      consulta.tabla = tabla;
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (c: string, v: unknown) => (consulta.eq.push([c, v]), b),
        gte: (c: string, v: unknown) => (consulta.gte.push([c, v]), b),
        lt: (c: string, v: unknown) => (consulta.lt.push([c, v]), b),
        order: (c: string) => (consulta.order.push(c), b),
        range: async (desde: number) => (errorDeLectura ? { data: null, error: errorDeLectura } : { data: desde === 0 ? filas : [], error: null }),
      });
      return b;
    },
  }),
}));

import { CABECERA_CSV_REFERENCIAS, celdaCsv } from "@/lib/metering/referencias-csv";

import { GET } from "./route";

const pedir = (periodo = "2026-09") =>
  GET(new Request(`https://savings.bivelio.com/api/org/reference-hits?periodo=${encodeURIComponent(periodo)}`));

beforeEach(() => {
  usuario = { id: "user-1" };
  guardia = { ok: true, orgId: ORG, role: "member" };
  filas = [];
  errorDeLectura = null;
  consulta.tabla = undefined;
  consulta.eq = [];
  consulta.gte = [];
  consulta.lt = [];
  consulta.order = [];
});

describe("GET /api/org/reference-hits", () => {
  it("sin sesión → 401, sin tocar la base", async () => {
    usuario = null;
    const res = await pedir();
    expect(res.status).toBe(401);
    expect(consulta.tabla).toBeUndefined();
  });

  it("sin permiso → el status del guardia", async () => {
    guardia = { ok: false, status: 404, error: "No organization." };
    expect((await pedir()).status).toBe(404);
  });

  it("período inválido → 400", async () => {
    for (const malo of ["2026-9", "2026-13", "septiembre", "2026-09-01", ""]) {
      expect((await pedir(malo)).status, malo).toBe(400);
    }
    expect(consulta.tabla).toBeUndefined();
  });

  it("CSV con la cabecera exacta, filtrado por la org del guardia y por el rango del período", async () => {
    filas = [
      {
        request_id: "req-2",
        day: "2026-09-03",
        model: "openai/gpt-4o-mini",
        cache_result: "exact",
        reference_request_id: "req-1",
        reference_at: "2026-09-03T10:00:00+00:00",
        baseline_input_tokens: 1736,
        baseline_output_tokens: 267,
        baseline_cost: "0.0002904000",
      },
    ];
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="reference-hits-2026-09.csv"');
    const texto = await res.text();
    const [cabecera, primera] = texto.split("\r\n");
    expect(cabecera).toBe(
      "request_id,day,model,cache_result,reference_request_id,reference_at,credited_input_tokens,credited_output_tokens,baseline_cost_usd",
    );
    expect(cabecera).toBe(CABECERA_CSV_REFERENCIAS);
    expect(primera).toBe("req-2,2026-09-03,openai/gpt-4o-mini,exact,req-1,2026-09-03T10:00:00+00:00,1736,267,0.0002904000");
    expect(consulta.tabla).toBe("reference_hits");
    expect(consulta.eq).toEqual([["org_id", ORG]]);
    expect(consulta.gte).toEqual([["day", "2026-09-01"]]);
    expect(consulta.lt).toEqual([["day", "2026-10-01"]]);
    expect(consulta.order).toEqual(["day", "request_id"]);
  });

  it("diciembre cierra en el 1 de enero del año siguiente", async () => {
    await pedir("2026-12");
    expect(consulta.lt).toEqual([["day", "2027-01-01"]]);
  });

  it("⛔ inyección de fórmulas: todo valor que empiece por = + - @ se prefija con '", async () => {
    filas = [
      {
        request_id: "=HYPERLINK(\"http://x\")",
        day: "2026-09-03",
        model: "+cmd",
        cache_result: "@SUM(A1)",
        reference_request_id: "-1",
        reference_at: null,
        baseline_input_tokens: 1,
        baseline_output_tokens: 0,
        baseline_cost: 0,
      },
    ];
    const texto = await (await pedir()).text();
    const linea = texto.split("\r\n")[1]!;
    expect(linea).toBe(`"'=HYPERLINK(""http://x"")",2026-09-03,'+cmd,'@SUM(A1),'-1,,1,0,0`);
    expect(celdaCsv("=1+1")).toBe("'=1+1");
    expect(celdaCsv("a,b")).toBe('"a,b"');
    expect(celdaCsv(null)).toBe("");
  });

  it("sin la tabla (0029 sin aplicar) → CSV con la cabecera y ninguna fila, no un 503", async () => {
    errorDeLectura = { code: "PGRST205", message: "Could not find the table 'bvsala.reference_hits' in the schema cache" };
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${CABECERA_CSV_REFERENCIAS}\r\n`);
  });

  it("un fallo real de lectura → 503, nunca un CSV vacío que se leería como «no hubo repeticiones»", async () => {
    errorDeLectura = { code: "57014", message: "canceling statement due to statement timeout" };
    expect((await pedir()).status).toBe(503);
  });
});

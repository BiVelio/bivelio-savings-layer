import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/org/reference-hits?periodo=YYYY-MM | ?dia=YYYY-MM-DD — el CSV de las
 * repeticiones medidas por referencia (0029), el enlace del extracto. Lo que se
 * protege:
 *   · sin sesión, 401; sin permiso, el status del guardia; período o día raros, 400;
 *   · el filtro por org_id EXPLÍCITO (el cliente de servicio salta la RLS);
 *   · la cabecera exacta y la defensa contra la inyección de fórmulas;
 *   · A ESCALA: paginación POR CLAVE día a día (jamás `.range()`/OFFSET), en
 *     streaming, y 413 por encima del tope de una descarga;
 *   · es una PRUEBA: sin la tabla o con un fallo, 503 — jamás un CSV vacío.
 */

const ORG = "22222222-2222-4222-8222-222222222222";

let usuario: { id: string } | null = { id: "user-1" };
let guardia: { ok: true; orgId: string; role: string } | { ok: false; status: number; error: string } = {
  ok: true,
  orgId: ORG,
  role: "member",
};
/** La tabla reference_hits del doble (todas las orgs). */
let hits: Array<Record<string, unknown>> = [];
/** Las filas de usage_daily del doble: el recuento previo. */
let usoDiario: Array<{ org_id: string; day: string; reference_requests: number }> = [];
let errorDeHits: { code?: string; message?: string } | null = null;
/** A partir de qué lectura de reference_hits (0 = la primera) falla. */
let fallaHitsDesdeLectura = 0;
let errorDeUso: { code?: string; message?: string } | null = null;

interface Llamada {
  tabla: string;
  select?: string;
  eq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  lt: Array<[string, unknown]>;
  gt: Array<[string, unknown]>;
  order: string[];
  limit?: number;
}
let llamadas: Llamada[] = [];
let lecturasDeHits = 0;

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
      const ll: Llamada = { tabla, eq: [], gte: [], lt: [], gt: [], order: [] };
      llamadas.push(ll);
      /** Ejecuta la consulta sobre el doble, con la semántica de PostgREST. */
      const resolver = () => {
        if (tabla === "usage_daily") {
          if (errorDeUso) return { data: null, error: errorDeUso };
          const filas = usoDiario.filter(
            (f) =>
              ll.eq.every(([c, v]) => (f as Record<string, unknown>)[c] === v) &&
              ll.gte.every(([c, v]) => String((f as Record<string, unknown>)[c]) >= String(v)) &&
              ll.lt.every(([c, v]) => String((f as Record<string, unknown>)[c]) < String(v)),
          );
          return { data: filas.map((f) => ({ reference_requests: f.reference_requests })), error: null };
        }
        const n = lecturasDeHits++;
        if (errorDeHits && n >= fallaHitsDesdeLectura) return { data: null, error: errorDeHits };
        let filas = hits.filter(
          (f) =>
            ll.eq.every(([c, v]) => f[c] === v) &&
            ll.gt.every(([c, v]) => String(f[c]) > String(v)) &&
            ll.gte.every(([c, v]) => String(f[c]) >= String(v)) &&
            ll.lt.every(([c, v]) => String(f[c]) < String(v)),
        );
        for (const c of [...ll.order].reverse()) {
          filas = [...filas].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0));
        }
        if (ll.limit !== undefined) filas = filas.slice(0, ll.limit);
        return { data: filas, error: null };
      };
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (s: string) => ((ll.select = s), b),
        eq: (c: string, v: unknown) => (ll.eq.push([c, v]), b),
        gte: (c: string, v: unknown) => (ll.gte.push([c, v]), b),
        lt: (c: string, v: unknown) => (ll.lt.push([c, v]), b),
        gt: (c: string, v: unknown) => (ll.gt.push([c, v]), b),
        order: (c: string) => (ll.order.push(c), b),
        limit: (n: number) => ((ll.limit = n), b),
        // OFFSET prohibido: si alguien vuelve a `.range()`, el test lo caza.
        range: () => {
          throw new Error("range() = OFFSET: prohibido en la descarga de referencias");
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, ko),
      });
      return b;
    },
  }),
}));

import { CABECERA_CSV_REFERENCIAS, celdaCsv, DURACION_MAXIMA_DESCARGA_S, MAX_FILAS_POR_DESCARGA } from "@/lib/metering/referencias-csv";

import { GET, maxDuration } from "./route";

const pedir = (query = "periodo=2026-09") => GET(new Request(`https://savings.bivelio.com/api/org/reference-hits?${query}`));

/** Un acierto de la org ORG (o de otra) en un día. */
function hit(day: string, requestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG,
    request_id: requestId,
    day,
    model: "openai/gpt-4o-mini",
    cache_result: "exact",
    reference_request_id: "req-poblada",
    reference_at: `${day}T08:00:00+00:00`,
    baseline_input_tokens: 1736,
    baseline_output_tokens: 267,
    baseline_cost: "0.0002904000",
    ...extra,
  };
}

/** Pone los aciertos y su recuento en usage_daily (lo que la RPC escribe en la misma vuelta). */
function sembrar(filas: Array<Record<string, unknown>>): void {
  hits = filas;
  const porDia = new Map<string, number>();
  for (const f of filas) {
    if (f["org_id"] !== ORG) continue;
    porDia.set(String(f["day"]), (porDia.get(String(f["day"])) ?? 0) + 1);
  }
  usoDiario = [...porDia].map(([day, n]) => ({ org_id: ORG, day, reference_requests: n }));
}

const lineas = (texto: string) => texto.split("\r\n").filter((l) => l !== "");

beforeEach(() => {
  usuario = { id: "user-1" };
  guardia = { ok: true, orgId: ORG, role: "member" };
  hits = [];
  usoDiario = [];
  errorDeHits = null;
  fallaHitsDesdeLectura = 0;
  errorDeUso = null;
  llamadas = [];
  lecturasDeHits = 0;
});

describe("GET /api/org/reference-hits — contrato", () => {
  it("sin sesión → 401, sin tocar la base", async () => {
    usuario = null;
    const res = await pedir();
    expect(res.status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it("sin permiso → el status del guardia", async () => {
    guardia = { ok: false, status: 404, error: "No organization." };
    expect((await pedir()).status).toBe(404);
  });

  it("período o día inválidos → 400, sin tocar la base", async () => {
    for (const malo of ["periodo=2026-9", "periodo=2026-13", "periodo=septiembre", "periodo=2026-09-01", "periodo=", ""]) {
      expect((await pedir(malo)).status, malo).toBe(400);
    }
    for (const malo of ["dia=2026-02-30", "dia=2026-9-01", "dia=2026-09", "periodo=2026-09&dia=2026-10-01"]) {
      expect((await pedir(malo)).status, malo).toBe(400);
    }
    expect(llamadas).toHaveLength(0);
  });

  it("CSV con la cabecera exacta, filtrado por la org del guardia y leído día a día del período", async () => {
    sembrar([hit("2026-09-03", "req-2"), hit("2026-09-03", "req-9", { org_id: "otra-org" })]);
    const res = await pedir();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="reference-hits-2026-09.csv"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [cabecera, primera, ...resto] = lineas(await res.text());
    expect(cabecera).toBe(
      "request_id,day,model,cache_result,reference_request_id,reference_at,credited_input_tokens,credited_output_tokens,baseline_cost_usd",
    );
    expect(cabecera).toBe(CABECERA_CSV_REFERENCIAS);
    expect(primera).toBe("req-2,2026-09-03,openai/gpt-4o-mini,exact,req-poblada,2026-09-03T08:00:00+00:00,1736,267,0.0002904000");
    expect(resto).toEqual([]); // la fila de la otra org no sale
    const deHits = llamadas.filter((l) => l.tabla === "reference_hits");
    // Un día por consulta, los 30 de septiembre, y siempre con la org del guardia.
    expect(deHits.map((l) => l.eq.find(([c]) => c === "day")![1])).toEqual(
      Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    for (const l of deHits) {
      expect(l.eq[0]).toEqual(["org_id", ORG]);
      expect(l.order).toEqual(["request_id"]);
      expect(l.limit).toBe(1000);
    }
    // El dinero se pide como texto (exacto, sin notación exponencial).
    expect(deHits[0]!.select).toContain("baseline_cost::text");
    // El recuento previo, también de la org y del rango.
    const cuenta = llamadas.find((l) => l.tabla === "usage_daily")!;
    expect(cuenta.eq).toEqual([["org_id", ORG]]);
    expect(cuenta.gte).toEqual([["day", "2026-09-01"]]);
    expect(cuenta.lt).toEqual([["day", "2026-10-01"]]);
  });

  it("diciembre cierra en el 1 de enero del año siguiente", async () => {
    await (await pedir("periodo=2026-12")).text();
    expect(llamadas.find((l) => l.tabla === "usage_daily")!.lt).toEqual([["day", "2027-01-01"]]);
    const dias = llamadas.filter((l) => l.tabla === "reference_hits").map((l) => l.eq.find(([c]) => c === "day")![1]);
    expect(dias.at(-1)).toBe("2026-12-31");
  });

  it("?dia= baja un solo día (con o sin periodo) y se nombra por el día", async () => {
    sembrar([hit("2026-09-03", "req-a"), hit("2026-09-04", "req-b")]);
    for (const q of ["dia=2026-09-04", "periodo=2026-09&dia=2026-09-04"]) {
      llamadas = [];
      const res = await pedir(q);
      expect(res.status, q).toBe(200);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="reference-hits-2026-09-04.csv"');
      const [, ...filas] = lineas(await res.text());
      expect(filas.map((l) => l.split(",")[0])).toEqual(["req-b"]);
      const deHits = llamadas.filter((l) => l.tabla === "reference_hits");
      expect(deHits.map((l) => l.eq.find(([c]) => c === "day")![1])).toEqual(["2026-09-04"]);
    }
  });

  it("⛔ inyección de fórmulas: todo valor que empiece por = + - @ se prefija con '", async () => {
    sembrar([
      hit("2026-09-03", "=HYPERLINK(\"http://x\")", {
        model: "+cmd",
        cache_result: "@SUM(A1)",
        reference_request_id: "-1",
        reference_at: null,
        baseline_input_tokens: 1,
        baseline_output_tokens: 0,
        baseline_cost: "0.0000000000",
      }),
    ]);
    const linea = lineas(await (await pedir()).text())[1]!;
    expect(linea).toBe(`"'=HYPERLINK(""http://x"")",2026-09-03,'+cmd,'@SUM(A1),'-1,,1,0,0.0000000000`);
    expect(celdaCsv("=1+1")).toBe("'=1+1");
    expect(celdaCsv("a,b")).toBe('"a,b"');
    expect(celdaCsv(null)).toBe("");
  });

  it("maxDuration es un literal igual a DURACION_MAXIMA_DESCARGA_S (Next exige configuración estática)", () => {
    expect(maxDuration).toBe(DURACION_MAXIMA_DESCARGA_S);
    const fuente = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(fuente).toMatch(new RegExp(`export const maxDuration = ${DURACION_MAXIMA_DESCARGA_S};`));
  });
});

describe("GET /api/org/reference-hits — a escala (revisión adversaria de PR-A)", () => {
  it("más de 1.000 filas: paginación POR CLAVE, continua, sin huecos ni duplicados y sin OFFSET", async () => {
    // 1.200 aciertos el día 2, ninguno el 3, 1.300 el día 4 (2.500 filas).
    const id = (n: number) => `req-${String(n).padStart(5, "0")}`;
    const filas = [
      ...Array.from({ length: 1200 }, (_, i) => hit("2026-09-02", id(i))),
      ...Array.from({ length: 1300 }, (_, i) => hit("2026-09-04", id(10_000 + i))),
    ];
    // Desordenadas a propósito: el orden lo pone la consulta, no la tabla.
    sembrar([...filas].reverse());
    const res = await pedir();
    expect(res.status).toBe(200);
    const [cabecera, ...cuerpo] = lineas(await res.text());
    expect(cabecera).toBe(CABECERA_CSV_REFERENCIAS);
    expect(cuerpo).toHaveLength(2500);
    const claves = cuerpo.map((l) => `${l.split(",")[1]}|${l.split(",")[0]}`);
    expect(new Set(claves).size).toBe(2500);
    expect(claves).toEqual([...claves].sort());
    // Las páginas del día 2: desde el principio, luego tras la última clave vista.
    const dia2 = llamadas.filter((l) => l.tabla === "reference_hits" && l.eq.some(([c, v]) => c === "day" && v === "2026-09-02"));
    expect(dia2.map((l) => l.gt)).toEqual([[], [["request_id", id(999)]]]);
    const dia4 = llamadas.filter((l) => l.tabla === "reference_hits" && l.eq.some(([c, v]) => c === "day" && v === "2026-09-04"));
    expect(dia4.map((l) => l.gt)).toEqual([[], [["request_id", id(10_999)]]]);
  });

  it("se sirve en STREAMING: la respuesta sale antes de haber leído todas las páginas", async () => {
    sembrar(Array.from({ length: 3500 }, (_, i) => hit("2026-09-05", `req-${String(i).padStart(5, "0")}`)));
    const res = await pedir("dia=2026-09-05");
    expect(res.status).toBe(200);
    // Al volver GET solo se ha leído la primera página (antes del 200).
    expect(lecturasDeHits).toBe(1);
    const [, ...cuerpo] = lineas(await res.text());
    expect(cuerpo).toHaveLength(3500);
    expect(lecturasDeHits).toBe(4);
  });

  it(`por encima de ${MAX_FILAS_POR_DESCARGA} filas → 413 con el camino por días, sin leer reference_hits`, async () => {
    usoDiario = [
      { org_id: ORG, day: "2026-09-01", reference_requests: MAX_FILAS_POR_DESCARGA },
      { org_id: ORG, day: "2026-09-02", reference_requests: 1 },
    ];
    const res = await pedir();
    expect(res.status).toBe(413);
    const cuerpo = (await res.json()) as { error: string; rows: number; limit: number; firstDay: string };
    expect(cuerpo.rows).toBe(MAX_FILAS_POR_DESCARGA + 1);
    expect(cuerpo.limit).toBe(MAX_FILAS_POR_DESCARGA);
    expect(cuerpo.firstDay).toBe("/api/org/reference-hits?dia=2026-09-01");
    expect(cuerpo.error).toContain("?dia=");
    expect(llamadas.some((l) => l.tabla === "reference_hits")).toBe(false);
  });

  it("justo en el tope se sirve", async () => {
    usoDiario = [{ org_id: ORG, day: "2026-09-01", reference_requests: MAX_FILAS_POR_DESCARGA }];
    expect((await pedir()).status).toBe(200);
  });
});

describe("GET /api/org/reference-hits — es una prueba: nunca un CSV vacío en lugar de un error", () => {
  it("sin la tabla (0029 sin aplicar, o caché de esquema desfasada) → 503, no un CSV con solo la cabecera", async () => {
    usoDiario = [{ org_id: ORG, day: "2026-09-03", reference_requests: 2 }];
    errorDeHits = { code: "PGRST205", message: "Could not find the table 'bvsala.reference_hits' in the schema cache" };
    const res = await pedir();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).not.toContain("text/csv");
  });

  it("sin las columnas de 0029 en usage_daily → 503", async () => {
    errorDeUso = { code: "42703", message: 'column usage_daily.reference_requests does not exist' };
    expect((await pedir()).status).toBe(503);
    expect(llamadas.some((l) => l.tabla === "reference_hits")).toBe(false);
  });

  it("un fallo real de lectura → 503", async () => {
    errorDeHits = { code: "57014", message: "canceling statement due to statement timeout" };
    expect((await pedir()).status).toBe(503);
  });

  it("un fallo A MITAD del flujo corta la descarga con error — jamás un CSV truncado que pasa por completo", async () => {
    sembrar(Array.from({ length: 2500 }, (_, i) => hit("2026-09-05", `req-${String(i).padStart(5, "0")}`)));
    errorDeHits = { code: "57014", message: "canceling statement due to statement timeout" };
    fallaHitsDesdeLectura = 1; // la primera página sale; la segunda falla
    const errores = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await pedir("dia=2026-09-05");
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toBeDefined();
    } finally {
      errores.mockRestore();
    }
  });
});

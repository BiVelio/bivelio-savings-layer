import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/org/verification-pairs?range=30|90|120 | ?dia=YYYY-MM-DD — los pares
 * de «tu propio banco» en CSV. El mismo juego que reference-hits: sesión,
 * guardia, filtro por org explícito, cabecera exacta, paginación por clave, 413
 * y 503 (nunca un CSV vacío). Y aquí, además: ni una columna con signo.
 */

const ORG = "33333333-3333-4333-8333-333333333333";

let usuario: { id: string } | null = { id: "user-1" };
let guardia: { ok: true; orgId: string; role: string } | { ok: false; status: number; error: string } = { ok: true, orgId: ORG, role: "member" };
let muestras: Array<Record<string, unknown>> = [];
let errorDeMuestras: { code?: string; message?: string } | null = null;
let errorDeResumen: { code?: string; message?: string } | null = null;
let resumenForzado: Array<{ samples: number }> | null = null;
let rpcs: Array<{ nombre: string; args: Record<string, unknown> }> = [];

interface Llamada {
  tabla: string;
  select?: string;
  eq: Array<[string, unknown]>;
  gt: Array<[string, unknown]>;
  order: string[];
  limit?: number;
}
let llamadas: Llamada[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: usuario } }) } }),
}));
vi.mock("@/lib/org/guardia", () => ({
  contextoDeLaOrg: async (_a: unknown, _u: string, accion: string) => {
    expect(accion).toBe("ver_panel");
    return guardia;
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (nombre: string, args: Record<string, unknown>) => {
      rpcs.push({ nombre, args });
      if (errorDeResumen) return { data: null, error: errorDeResumen };
      if (resumenForzado) return { data: resumenForzado, error: null };
      const deLaOrg = muestras.filter((m) => m["org_id"] === args["p_org"] && String(m["day"]) >= String(args["p_from"]) && String(m["day"]) <= String(args["p_to"]));
      return { data: [{ outcome: "paired", stratum: "unchanged", samples: deLaOrg.length }], error: null };
    },
    from: (tabla: string) => {
      const ll: Llamada = { tabla, eq: [], gt: [], order: [] };
      llamadas.push(ll);
      const resolver = () => {
        if (errorDeMuestras) return { data: null, error: errorDeMuestras };
        let filas = muestras.filter((f) => ll.eq.every(([c, v]) => f[c] === v) && ll.gt.every(([c, v]) => String(f[c]) > String(v)));
        filas = [...filas].sort((a, b) => (String(a["request_id"]) < String(b["request_id"]) ? -1 : 1));
        if (ll.limit !== undefined) filas = filas.slice(0, ll.limit);
        return { data: filas, error: null };
      };
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: (s: string) => ((ll.select = s), b),
        eq: (c: string, v: unknown) => (ll.eq.push([c, v]), b),
        gt: (c: string, v: unknown) => (ll.gt.push([c, v]), b),
        order: (c: string) => (ll.order.push(c), b),
        limit: (n: number) => ((ll.limit = n), b),
        range: () => {
          throw new Error("range() = OFFSET: prohibido");
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, ko),
      });
      return b;
    },
  }),
}));

import { CABECERA_CSV_VERIFICACION } from "@/lib/verificacion/csv";
import { MAX_FILAS_POR_DESCARGA } from "@/lib/metering/referencias-csv";

import { GET, maxDuration } from "./route";

const pedir = (query: string) => GET(new Request(`https://savings.bivelio.com/api/org/verification-pairs?${query}`));
const lineas = (t: string) => t.split("\r\n").filter((l) => l !== "");
const HOY = "2026-09-25";

function par(day: string, requestId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG,
    request_id: requestId,
    day,
    at: `${day}T10:00:00+00:00`,
    stratum: "tokens_removed",
    outcome: "paired",
    requested_model: "openai/gpt-4o-mini",
    served_model: "openai/gpt-4o-mini",
    cache_result: "miss",
    naive_input_tokens: 1300,
    naive_cached_input_tokens: 0,
    naive_output_tokens: 125,
    naive_cost: "0.0002700000",
    naive_finish_reason: "stop",
    naive_contract: "none",
    optimized_input_tokens: 900,
    optimized_cached_input_tokens: 0,
    optimized_output_tokens: 120,
    optimized_cost: "0.0002070000",
    input_per_1k: "0.0001500000",
    cached_input_per_1k: "0.0000750000",
    output_per_1k: "0.0006000000",
    ...extra,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${HOY}T12:00:00Z`));
  usuario = { id: "user-1" };
  guardia = { ok: true, orgId: ORG, role: "member" };
  muestras = [];
  errorDeMuestras = null;
  errorDeResumen = null;
  resumenForzado = null;
  rpcs = [];
  llamadas = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/org/verification-pairs — contrato", () => {
  it("sin sesión → 401; sin permiso → el status del guardia", async () => {
    usuario = null;
    expect((await pedir("range=30")).status).toBe(401);
    usuario = { id: "u" };
    guardia = { ok: false, status: 404, error: "No organization." };
    expect((await pedir("range=30")).status).toBe(404);
    expect(llamadas).toHaveLength(0);
  });

  it("rango o día inválidos → 400 con el mensaje exacto, sin tocar la base", async () => {
    for (const malo of ["", "range=7", "range=all", "range=030", "dia=2026-02-30", "dia=2026-9-01", "range=30&dia=2026-09-01"]) {
      const res = await pedir(malo);
      expect(res.status, malo).toBe(400);
      expect(await res.json()).toEqual({ error: "range must be 30, 90 or 120, or dia must be YYYY-MM-DD" });
    }
    expect(rpcs).toHaveLength(0);
    expect(llamadas).toHaveLength(0);
  });

  it("CSV con la cabecera EXACTA, de la org del guardia, día a día de la ventana", async () => {
    muestras = [par("2026-09-20", "req-2"), par("2026-09-20", "req-9", { org_id: "otra-org" })];
    const res = await pedir("range=30");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="verification-pairs-30d-${HOY}.csv"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [cabecera, primera, ...resto] = lineas(await res.text());
    expect(cabecera).toBe(
      "request_id,day,at,stratum,outcome,requested_model,served_model,cache_result,naive_input_tokens,naive_cached_input_tokens,naive_output_tokens,naive_cost_usd,naive_finish_reason,naive_contract,optimized_input_tokens,optimized_cached_input_tokens,optimized_output_tokens,optimized_cost_usd,input_per_1k,cached_input_per_1k,output_per_1k",
    );
    expect(cabecera).toBe(CABECERA_CSV_VERIFICACION);
    expect(primera).toBe(
      "req-2,2026-09-20,2026-09-20T10:00:00+00:00,tokens_removed,paired,openai/gpt-4o-mini,openai/gpt-4o-mini,miss,1300,0,125,0.0002700000,stop,none,900,0,120,0.0002070000,0.0001500000,0.0000750000,0.0006000000",
    );
    expect(resto).toEqual([]);
    const dias = llamadas.map((l) => l.eq.find(([c]) => c === "day")![1]);
    expect(dias).toHaveLength(30);
    expect(dias[0]).toBe("2026-08-27");
    expect(dias.at(-1)).toBe(HOY);
    for (const l of llamadas) {
      expect(l.tabla).toBe("verification_samples");
      expect(l.eq[0]).toEqual(["org_id", ORG]);
      expect(l.order).toEqual(["request_id"]);
      expect(l.limit).toBe(1000);
      expect(l.select).toContain("naive_cost::text");
      expect(l.select).toContain("optimized_cost::text");
    }
    expect(rpcs).toEqual([{ nombre: "verification_summary", args: { p_org: ORG, p_from: "2026-08-27", p_to: HOY } }]);
  });

  it("?dia= baja un solo día", async () => {
    muestras = [par("2026-09-20", "a"), par("2026-09-21", "b")];
    const res = await pedir("dia=2026-09-21");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="verification-pairs-2026-09-21.csv"');
    expect(lineas(await res.text()).slice(1).map((l) => l.split(",")[0])).toEqual(["b"]);
  });

  it("⛔ ninguna columna con signo; un valor que empiece por «-» sale con '", async () => {
    expect(CABECERA_CSV_VERIFICACION).not.toMatch(/diff|delta|saving|signed/i);
    muestras = [par(HOY, "-1", { served_model: "=cmd" })];
    const linea = lineas(await (await pedir("range=30")).text())[1]!;
    expect(linea.startsWith("'-1,")).toBe(true);
    expect(linea).toContain(",'=cmd,");
  });

  it("maxDuration es un literal (300)", () => {
    expect(maxDuration).toBe(300);
    expect(readFileSync(new URL("./route.ts", import.meta.url), "utf8")).toMatch(/export const maxDuration = 300;/);
  });
});

describe("GET /api/org/verification-pairs — a escala", () => {
  it("más de 1.000 filas en un día: paginación por clave, sin huecos ni OFFSET", async () => {
    const id = (n: number) => `req-${String(n).padStart(5, "0")}`;
    muestras = Array.from({ length: 2300 }, (_, i) => par(HOY, id(i))).reverse();
    const res = await pedir(`dia=${HOY}`);
    const cuerpo = lineas(await res.text()).slice(1);
    expect(cuerpo).toHaveLength(2300);
    expect(new Set(cuerpo.map((l) => l.split(",")[0])).size).toBe(2300);
    expect(llamadas.map((l) => l.gt)).toEqual([[], [["request_id", id(999)]], [["request_id", id(1999)]]]);
  });

  it(`por encima de ${MAX_FILAS_POR_DESCARGA} filas → 413 con el camino por días`, async () => {
    resumenForzado = [{ samples: MAX_FILAS_POR_DESCARGA }, { samples: 1 }];
    const res = await pedir("range=90");
    expect(res.status).toBe(413);
    const cuerpo = (await res.json()) as { error: string; firstDay: string };
    expect(cuerpo.error).toBe(
      `This range has ${MAX_FILAS_POR_DESCARGA + 1} checked requests, more than one download can carry (${MAX_FILAS_POR_DESCARGA}). Download it one day at a time with ?dia=YYYY-MM-DD.`,
    );
    expect(cuerpo.firstDay).toBe("/api/org/verification-pairs?dia=2026-06-28");
    expect(llamadas).toHaveLength(0);
  });
});

describe("GET /api/org/verification-pairs — nunca un CSV vacío en lugar de un error", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sin la función de 0030 → 503", async () => {
    errorDeResumen = { code: "PGRST202", message: "Could not find the function bvsala.verification_summary" };
    const res = await pedir("range=30");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Could not read the verification pairs." });
  });

  it("sin la tabla → 503", async () => {
    errorDeMuestras = { code: "PGRST205", message: "Could not find the table 'bvsala.verification_samples'" };
    expect((await pedir("range=30")).status).toBe(503);
  });

  it("un fallo real de lectura → 503", async () => {
    errorDeMuestras = { code: "57014", message: "statement timeout" };
    expect((await pedir("range=30")).status).toBe(503);
  });
});

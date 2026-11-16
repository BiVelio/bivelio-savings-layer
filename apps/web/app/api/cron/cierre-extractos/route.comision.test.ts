import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/cron/cierre-extractos — ⛔ QUIÉN CIERRA CON COMISIÓN (2026-11-16).
 *
 * LICENSE-CLOUD §6(b): hay comisión «only if your subscription is on a plan
 * that the Published Pricing lists as carrying a commission». El cierre cobraba
 * a toda organización que no tuviera, el día 1, una suscripción VIVA en Pro o
 * Equipo: quien cancelaba Pro el día 20 recibía una factura de comisión por
 * los días en que estuvo en un plan de cuota fija. Estos casos pasan por la
 * ruta entera (lecturas, decisión, fila sellada) para que la regla no se
 * pueda quedar solo en la función pura.
 *
 * Y LO QUE NO SE PUEDE DECIDIR NO SE SELLA (revisión del 2026-11-16): un Price
 * sin declarar o un mes con comisión y cuota fija saltan a esa organización con
 * alerta CRÍTICA; sin ningún Price de comisión configurado se aplaza el cierre
 * entero. Los ensayos en seco no mandan alertas.
 */

const CATALOGO = { comision: ["price_legacy_m", "price_legacy_y"], pro: ["price_pro_m"], equipo: ["price_team_m"] };

interface Sub {
  org_id: string;
  price_id: string | null;
  status: string;
  created_at?: string | null;
  canceled_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  last_event_at?: string | null;
}

interface Estado {
  /** org → [base medida, coste real medido] del único día con uso del período. */
  uso: Record<string, [number, number]>;
  exentas: string[];
  subs: Sub[];
  catalogo: typeof CATALOGO;
  falloSubs: boolean;
  /** Lo que el cron pidió a `subscriptions`. */
  consulta: { columnas: string; orgs: string[]; filtros: string[] } | null;
  upsert: Array<Record<string, unknown>> | null;
  alertas: Array<{ nivel: string; asunto: string; detalle?: Record<string, unknown> }>;
}
const estado: Estado = { uso: {}, exentas: [], subs: [], catalogo: CATALOGO, falloSubs: false, consulta: null, upsert: null, alertas: [] };

function builder(tabla: string) {
  let columnas = "";
  let ids: string[] | null = null;
  const filtros: string[] = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: (c: string) => {
      columnas = c;
      return b;
    },
    eq: (col: string) => {
      filtros.push(`eq:${col}`);
      return b;
    },
    in: (col: string, valores: string[]) => {
      filtros.push(`in:${col}`);
      if (col === "org_id") ids = valores;
      return b;
    },
    gte: () => b,
    lt: () => b,
    order: () => b,
    limit: () => b,
    range: async () => {
      if (tabla === "organizations") return { data: estado.exentas.map((id) => ({ id })), error: null };
      if (tabla === "usage_daily") {
        const filas = Object.entries(estado.uso).map(([org_id, [base, actual]]) => ({
          org_id,
          day: "2026-10-10",
          requests: 10,
          baseline_cost: base,
          actual_cost: actual,
          measured_requests: 10,
          measured_baseline_cost: base,
          measured_actual_cost: actual,
          reference_requests: 0,
          reference_baseline_cost: 0,
          reference_actual_cost: 0,
        }));
        return { data: filas, error: null };
      }
      if (tabla === "subscriptions") {
        estado.consulta = { columnas, orgs: ids ?? [], filtros: [...filtros] };
        if (estado.falloSubs) return { data: null, error: { message: "timeout" } };
        // Como PostgREST: solo las filas de las organizaciones pedidas, lleven el Price que lleven.
        return { data: estado.subs.filter((s) => (ids ?? []).includes(s.org_id)), error: null };
      }
      return { data: [], error: null };
    },
    // Primer uso en agosto: octubre NO es calibración para nadie.
    maybeSingle: async () => ({ data: { day: "2026-08-01" }, error: null }),
    upsert: async (filas: Array<Record<string, unknown>>) => {
      estado.upsert = filas;
      return { error: null, count: filas.length };
    },
  });
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
}));
vi.mock("@/lib/stripe/env", () => ({ catalogoDeComision: () => estado.catalogo }));
vi.mock("@/lib/billing/fx", () => ({ obtenerFxCierre: async () => ({ eurPorUsd: 0.9, fuente: "BCE (test)" }) }));
vi.mock("@/lib/observabilidad/alerta", () => ({
  alertar: async (a: Estado["alertas"][number]) => {
    estado.alertas.push(a);
  },
}));

import { GET } from "./route";

const cerrar = (extra = "") =>
  GET(
    new Request(`https://savings.bivelio.com/api/cron/cierre-extractos?periodo=2026-10${extra}`, {
      headers: { authorization: "Bearer secreto-de-prueba" },
    }),
  );

const sub = (org_id: string, price_id: string | null, status: string, mas: Partial<Sub> = {}): Sub => ({
  org_id,
  price_id,
  status,
  created_at: "2026-06-03T09:00:00Z",
  canceled_at: null,
  current_period_end: "2026-11-03T09:00:00Z",
  cancel_at_period_end: false,
  // Cancelación inmediata salvo que el caso diga otra cosa: el `deleted` es del mismo instante.
  last_event_at: status === "canceled" ? (mas.canceled_at ?? null) : "2026-10-03T09:00:05Z",
  ...mas,
});

/** La fila sellada de una org. */
const fila = (org: string) => estado.upsert!.find((f) => f.org_id === org)!;

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
  Object.assign(estado, { uso: {}, exentas: [], subs: [], catalogo: CATALOGO, falloSubs: false, consulta: null, upsert: null, alertas: [] });
});
afterEach(() => vi.unstubAllEnvs());

interface Cuerpo {
  error?: string;
  cerrados?: number;
  extractos?: Array<{ org_id: string; cargo_eur: number; es_exento: boolean }>;
  comision: Array<{ org_id: string; cobra: boolean; motivo: string; precios: string[] }>;
  sin_sellar: Array<{ org_id: string; motivo: string; precios?: string[] }>;
}

describe("⛔ el cierre cobra comisión SOLO a quien llevó un plan con comisión en el período", () => {
  it("un mes con todos los casos: solo los dos de la modalidad con comisión cierran con cargo, y la respuesta dice por qué", async () => {
    estado.uso = {
      "pro-cancelado": [2000, 1100],
      "equipo-impagado": [2000, 1100],
      "legado-vivo": [2000, 1100],
      "legado-cancelado": [2000, 1100],
      "solo-medir": [2000, 2000], // el ingest de «Medir» deja base = real
      "enterprise-sin-sub": [2000, 1100],
      "exenta-con-legado": [2000, 1100],
      "socio-declarado": [2000, 1100],
    };
    estado.catalogo = { ...CATALOGO, sinComision: ["price_socio"] } as typeof CATALOGO;
    estado.exentas = ["exenta-con-legado"];
    estado.subs = [
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
      sub("equipo-impagado", "price_team_m", "unpaid"),
      sub("legado-vivo", "price_legacy_m", "active"),
      sub("legado-cancelado", "price_legacy_y", "canceled", { canceled_at: "2026-10-15T10:00:00Z" }),
      sub("exenta-con-legado", "price_legacy_m", "active"),
      sub("socio-declarado", "price_socio", "active"),
    ];
    const res = await cerrar();
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as Cuerpo;

    // El extracto de TODAS se conserva: una fila por organización con uso.
    expect(estado.upsert!.map((f) => f.org_id).sort()).toEqual(Object.keys(estado.uso).sort());
    expect(cuerpo.sin_sellar).toEqual([]);

    for (const org of ["pro-cancelado", "equipo-impagado", "enterprise-sin-sub", "exenta-con-legado", "socio-declarado"]) {
      expect(fila(org), org).toMatchObject({ cargo_eur: 0, es_exento: true, ahorro_medido_usd: 900 });
      // «Lo que habría sido» sigue en el documento, para auditoría.
      expect(Number(fila(org).comision_eur), org).toBeGreaterThan(0);
    }
    expect(fila("solo-medir")).toMatchObject({ cargo_eur: 0, comision_eur: 0, ahorro_medido_usd: 0 });

    for (const org of ["legado-vivo", "legado-cancelado"]) {
      expect(fila(org), org).toMatchObject({ es_exento: false, es_calibracion: false });
      expect(Number(fila(org).cargo_eur), org).toBeGreaterThan(0);
      expect(fila(org).cargo_eur, org).toBe(fila(org).comision_eur);
    }
    expect(estado.alertas).toEqual([]);

    // EL PORQUÉ de cada cierre a 0 (`es_exento` ya significa cuatro cosas): va en la respuesta.
    const motivo = Object.fromEntries(cuerpo.comision.map((d) => [d.org_id, `${d.cobra}:${d.motivo}`]));
    expect(motivo).toEqual({
      "pro-cancelado": "false:plan_de_cuota_fija",
      "equipo-impagado": "false:plan_de_cuota_fija",
      "socio-declarado": "false:plan_de_cuota_fija",
      "legado-vivo": "true:plan_con_comision",
      "legado-cancelado": "true:plan_con_comision",
      "solo-medir": "false:sin_suscripcion_con_comision",
      "enterprise-sin-sub": "false:sin_suscripcion_con_comision",
      "exenta-con-legado": "false:exenta",
    });
  });

  it("lee TODAS las filas de las orgs con uso — sin filtrar por estado NI POR PRICE — y pide last_event_at", async () => {
    // ANTES se exigía `in:price_id` con los ids del catálogo. Ese filtro era el
    // fallo: la fila de un cliente cuyo Price no está en el catálogo no se leía
    // nunca, y su extracto cerraba a 0 sin que nada lo viera.
    estado.uso = { a: [2000, 1100], b: [2000, 1100] };
    await cerrar();
    expect(estado.consulta!.columnas).toBe(
      "org_id, price_id, status, created_at, canceled_at, current_period_end, cancel_at_period_end, last_event_at",
    );
    expect(estado.consulta!.orgs.sort()).toEqual(["a", "b"]);
    expect(estado.consulta!.filtros).toEqual(["in:org_id"]);
  });

  it("el mes siguiente a la cancelación de la comisión ya no se cobra", async () => {
    estado.uso = { ex: [2000, 1100] };
    estado.subs = [sub("ex", "price_legacy_m", "canceled", { canceled_at: "2026-09-15T10:00:00Z" })];
    await cerrar();
    expect(fila("ex")).toMatchObject({ cargo_eur: 0, es_exento: true });
  });

  it("⛔ cancelación a fin de ciclo con la marca de Stripe a false: el último mes parcial SE COBRA", async () => {
    estado.uso = { sale: [2000, 1100] };
    estado.subs = [
      sub("sale", "price_legacy_m", "canceled", {
        canceled_at: "2026-09-25T08:00:00Z", // el día en que lo pidió, el mes anterior
        current_period_end: "2026-10-10T09:00:00Z",
        last_event_at: "2026-10-10T09:00:02Z",
        cancel_at_period_end: false,
      }),
    ];
    await cerrar();
    expect(fila("sale")).toMatchObject({ es_exento: false });
    expect(Number(fila("sale").cargo_eur)).toBeGreaterThan(0);
  });

  it("falla CERRADO: si las suscripciones no se pueden leer, no se sella nada y se alerta", async () => {
    estado.uso = { a: [2000, 1100] };
    estado.falloSubs = true;
    const res = await cerrar();
    expect(res.status).toBe(500);
    expect(estado.upsert).toBeNull();
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico" });
  });

  it("?seco=1 enseña el mismo veredicto sin sellar", async () => {
    estado.uso = { "pro-cancelado": [2000, 1100], "legado-vivo": [2000, 1100] };
    estado.subs = [
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
      sub("legado-vivo", "price_legacy_m", "active"),
    ];
    const res = await cerrar("&seco=1");
    const cuerpo = (await res.json()) as Cuerpo;
    expect(estado.upsert).toBeNull();
    const de = (org: string) => cuerpo.extractos!.find((e) => e.org_id === org)!;
    expect(de("pro-cancelado")).toMatchObject({ cargo_eur: 0, es_exento: true });
    expect(de("legado-vivo").es_exento).toBe(false);
    expect(de("legado-vivo").cargo_eur).toBeGreaterThan(0);
    expect(cuerpo.comision.find((d) => d.org_id === "pro-cancelado")).toMatchObject({ cobra: false, motivo: "plan_de_cuota_fija" });
  });

  it("?seco=1 enseña los price ids detrás de cada decisión: un 0 por un Price de la lista sin comisión se VE", async () => {
    // Un Price de comisión archivado por error en STRIPE_PRICE_IDS_SIN_COMISION
    // cierra a 0 sin alerta (es lo declarado). El único sitio donde el dueño lo
    // puede ver antes de sellar es el ensayo: motivo Y Price, uno al lado del otro.
    estado.catalogo = { ...CATALOGO, sinComision: ["price_socio"] } as typeof CATALOGO;
    estado.uso = { socio: [2000, 1100], "legado-vivo": [2000, 1100], "pro-cancelado": [2000, 1100], "sin-sub": [2000, 1100] };
    estado.subs = [
      sub("socio", "price_socio", "active"),
      sub("legado-vivo", "price_legacy_m", "active"),
      sub("pro-cancelado", "price_pro_m", "canceled", { canceled_at: "2026-10-20T10:00:00Z" }),
    ];
    const cuerpo = (await (await cerrar("&seco=1")).json()) as Cuerpo;
    expect(estado.upsert).toBeNull();
    expect([...cuerpo.comision].sort((a, b) => a.org_id.localeCompare(b.org_id))).toEqual([
      { org_id: "legado-vivo", cobra: true, motivo: "plan_con_comision", precios: ["price_legacy_m"] },
      { org_id: "pro-cancelado", cobra: false, motivo: "plan_de_cuota_fija", precios: ["price_pro_m"] },
      { org_id: "sin-sub", cobra: false, motivo: "sin_suscripcion_con_comision", precios: [] },
      { org_id: "socio", cobra: false, motivo: "plan_de_cuota_fija", precios: ["price_socio"] },
    ]);
  });
});

describe("⛔ lo que no se puede decidir NO SE SELLA: se salta la organización y se alerta en crítico", () => {
  it("un Price sin declarar (el de comisión rotado a STRIPE_PRICE_IDS_EXTRA): ni cargo ni 0, y la alerta trae los price ids", async () => {
    // ANTES este caso (`precio-de-cortesia`) exigía fila sellada a 0 y
    // `alertas: []`. Eso era sellar a 0, para siempre y en silencio, al cliente
    // de comisión anterior a la rotación de agosto (#53): su Price solo está en
    // STRIPE_PRICE_IDS_EXTRA, que no dice si lleva comisión.
    estado.uso = { "legado-rotado": [2000, 1100], "otro-rotado": [2000, 1100], "legado-vivo": [2000, 1100], "pro-vivo": [2000, 1100] };
    estado.subs = [
      sub("legado-rotado", "price_legacy_inclusive_m", "active"),
      sub("otro-rotado", "price_legacy_inclusive_y", "past_due"),
      sub("legado-vivo", "price_legacy_m", "active"),
      sub("pro-vivo", "price_pro_m", "active"),
    ];
    const res = await cerrar();
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as Cuerpo;

    // Las demás se sellan con normalidad; las dos dudosas NO aparecen.
    expect(estado.upsert!.map((f) => f.org_id).sort()).toEqual(["legado-vivo", "pro-vivo"]);
    expect(cuerpo.cerrados).toBe(2);
    expect(cuerpo.sin_sellar).toEqual([
      { org_id: "legado-rotado", motivo: "precio_desconocido", precios: ["price_legacy_inclusive_m"] },
      { org_id: "otro-rotado", motivo: "precio_desconocido", precios: ["price_legacy_inclusive_y"] },
    ]);

    expect(estado.alertas).toHaveLength(1);
    expect(estado.alertas[0]).toMatchObject({
      nivel: "critico", // solo lo crítico llega por correo
      detalle: { periodo: "2026-10", precios_sin_declarar: ["price_legacy_inclusive_m", "price_legacy_inclusive_y"] },
    });
    expect(estado.alertas[0]!.asunto).toMatch(/SIN SELLAR/);
  });

  it("declarado el Price en STRIPE_PRICE_IDS_COMISION y relanzado, esa organización cierra CON cargo", async () => {
    estado.catalogo = { ...CATALOGO, comision: [...CATALOGO.comision, "price_legacy_inclusive_m"] };
    estado.uso = { "legado-rotado": [2000, 1100] };
    estado.subs = [sub("legado-rotado", "price_legacy_inclusive_m", "active")];
    await cerrar();
    expect(fila("legado-rotado")).toMatchObject({ es_exento: false });
    expect(Number(fila("legado-rotado").cargo_eur)).toBeGreaterThan(0);
    expect(estado.alertas).toEqual([]);
  });

  it("la marca de exención gana: una exenta con un Price sin declarar se sella a 0 sin alerta", async () => {
    estado.uso = { cortesia: [2000, 1100] };
    estado.exentas = ["cortesia"];
    estado.subs = [sub("cortesia", "price_cortesia", "active")];
    const cuerpo = (await (await cerrar()).json()) as Cuerpo;
    expect(fila("cortesia")).toMatchObject({ cargo_eur: 0, es_exento: true });
    // Con los price ids detrás de la decisión (no son secretos): es donde se ve un Price mal archivado.
    expect(cuerpo.comision).toEqual([{ org_id: "cortesia", cobra: false, motivo: "exenta", precios: ["price_cortesia"] }]);
    expect(estado.alertas).toEqual([]);
  });

  it("comisión y Pro en el mismo mes → NO se sella y alerta crítica (antes: cargo 0 con un aviso que no llega por correo)", async () => {
    estado.uso = { mixta: [2000, 1100], "legado-con-pro-antiguo": [2000, 1100] };
    estado.subs = [
      sub("mixta", "price_legacy_m", "canceled", { canceled_at: "2026-10-05T10:00:00Z" }),
      sub("mixta", "price_pro_m", "active", { created_at: "2026-10-05T10:05:00Z" }),
      sub("legado-con-pro-antiguo", "price_legacy_m", "active"),
      sub("legado-con-pro-antiguo", "price_pro_m", "canceled", {
        created_at: "2026-01-01T00:00:00Z",
        canceled_at: "2026-03-01T00:00:00Z",
        current_period_end: "2026-03-01T00:00:00Z",
      }),
    ];
    const cuerpo = (await (await cerrar()).json()) as Cuerpo;
    expect(estado.upsert!.map((f) => f.org_id)).toEqual(["legado-con-pro-antiguo"]);
    expect(Number(fila("legado-con-pro-antiguo").cargo_eur)).toBeGreaterThan(0);
    expect(cuerpo.sin_sellar).toEqual([
      { org_id: "mixta", motivo: "plan_sin_comision_en_el_periodo", precios: ["price_legacy_m", "price_pro_m"] },
    ]);
    expect(estado.alertas).toHaveLength(1);
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico", detalle: { periodo: "2026-10", precios_sin_declarar: [] } });
  });

  it("si TODAS las organizaciones quedan sin sellar no se escribe nada (y no revienta)", async () => {
    estado.uso = { rara: [2000, 1100] };
    estado.subs = [sub("rara", "price_x", "active")];
    const res = await cerrar();
    expect(res.status).toBe(200);
    expect(estado.upsert).toBeNull();
    expect(((await res.json()) as Cuerpo).cerrados).toBe(0);
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico" });
  });

  it("?seco=1 lo enseña en la respuesta y NO manda la alerta", async () => {
    estado.uso = { "legado-rotado": [2000, 1100], mixta: [2000, 1100] };
    estado.subs = [
      sub("legado-rotado", "price_legacy_inclusive_m", "active"),
      sub("mixta", "price_legacy_m", "canceled", { canceled_at: "2026-10-05T10:00:00Z" }),
      sub("mixta", "price_pro_m", "active", { created_at: "2026-10-05T10:05:00Z" }),
    ];
    const cuerpo = (await (await cerrar("&seco=1")).json()) as Cuerpo;
    expect(cuerpo.sin_sellar.map((x) => `${x.org_id}:${x.motivo}`).sort()).toEqual([
      "legado-rotado:precio_desconocido",
      "mixta:plan_sin_comision_en_el_periodo",
    ]);
    expect(cuerpo.extractos).toEqual([]);
    expect(estado.upsert).toBeNull();
    expect(estado.alertas).toEqual([]);
  });
});

describe("⛔ sin ningún Price de comisión configurado y con suscripciones: el cierre se APLAZA entero", () => {
  const sinCatalogo = { comision: [], pro: ["price_pro_m"], equipo: ["price_team_m"] };

  it("500 + alerta crítica, nada sellado (antes: todos a 0 con un aviso que no llega por correo)", async () => {
    // ANTES este caso exigía fila a 0, `consulta` nula y nivel `aviso`: con
    // STRIPE_PRICE_ID_MONTHLY/YEARLY ausentes en Production, TODOS los clientes
    // con comisión se sellaban a 0 de forma inmutable.
    estado.catalogo = sinCatalogo;
    estado.uso = { a: [2000, 1100], "pro-vivo": [2000, 1100] };
    estado.subs = [sub("a", "price_legacy_m", "active"), sub("pro-vivo", "price_pro_m", "active")];
    const res = await cerrar();
    expect(res.status).toBe(500);
    expect(estado.upsert).toBeNull();
    expect(estado.alertas).toHaveLength(1);
    expect(estado.alertas[0]).toMatchObject({ nivel: "critico" });
    expect(estado.alertas[0]!.asunto).toMatch(/Price de comisión/);
    expect(JSON.stringify(estado.alertas[0]!.detalle)).toMatch(/STRIPE_PRICE_ID_MONTHLY/);
  });

  it("en seco: mismo 500 que explica el aplazamiento, sin alerta", async () => {
    estado.catalogo = sinCatalogo;
    estado.uso = { a: [2000, 1100] };
    estado.subs = [sub("a", "price_legacy_m", "active")];
    const res = await cerrar("&seco=1");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "commission catalogue empty", seco: true });
    expect(estado.alertas).toEqual([]);
  });

  it("sin ninguna suscripción a la vista no hay nada que aplazar: todo cierra a 0", async () => {
    estado.catalogo = sinCatalogo;
    estado.uso = { "solo-medir": [2000, 2000], "sin-sub": [2000, 1100] };
    const res = await cerrar();
    expect(res.status).toBe(200);
    expect(fila("sin-sub")).toMatchObject({ cargo_eur: 0, es_exento: true });
    expect(estado.alertas).toEqual([]);
  });
});

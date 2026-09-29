import { describe, expect, it } from "vitest";

import type { Medicion } from "../benchmarks/banco-semanal/extraer.js";
import {
  cuadrarLaFactura,
  cuadresPendientesDe,
  decidir,
  diasDeLaVentana,
  facturaCerrada,
  gastoEsperado,
  leerFacturaAnthropic,
  leerFacturaOpenAI,
  type Cuadre,
  type Ventana,
} from "../benchmarks/banco-semanal/factura.js";
import { resumenMarkdown } from "../benchmarks/banco-semanal/resumen.js";
import { evaluar, evaluarFactura, type ResultadoDeCelda } from "../benchmarks/banco-semanal/umbrales.js";

/**
 * EL CUADRE CONTRA LA FACTURA REAL (criterio 4 de CAMINO-A-0.5), sin red y sin
 * claves: las respuestas están grabadas con la forma de la documentación
 * oficial (consultada el 2026-09-29) de la Usage & Cost Admin API de Anthropic
 * y de la Costs/Usage API de OpenAI. Las claves de administrador de aquí son
 * de mentira; lo que se comprueba es que NUNCA salen en lo que se escribe.
 */

const CLAVE_ANT = "sk-ant-admin01-FALSAfalsaFALSAfalsaFALSAfalsa";
const CLAVE_OAI = "sk-admin-FALSAfalsaFALSAfalsaFALSAfalsa";
const WS = "wrkspc_01BancoSemanal";
const PROY = "proj_banco_semanal";
const KEY_ANT = "apikey_01BancoSemanal";
const KEY_OAI = "key_banco_semanal";

const VENTANA: Ventana = { inicio: "2026-09-28T04:17:12.000Z", fin: "2026-09-28T09:40:03.000Z" };
const DIA = Date.parse("2026-09-28T00:00:00Z");
const MIN = 60_000;
// Durante la tirada (antes de cerrar el día) y una semana después (día cerrado).
const HOY = Date.parse("2026-09-28T09:41:00Z");
const SEMANA_DESPUES = Date.parse("2026-10-05T04:30:00Z");

const ENV_BASE: NodeJS.ProcessEnv = {
  BVSALA_DEMO_ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
  BVSALA_DEMO_OPENAI_BASE_URL: "https://api.openai.com/v1",
  BVSALA_DEMO_BASE_URL: "https://api.openai.com/v1",
  BVSALA_DEMO_GOOGLE_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai",
};
const ENV: NodeJS.ProcessEnv = {
  ...ENV_BASE,
  ANTHROPIC_ADMIN_API_KEY: CLAVE_ANT,
  BANCO_ANTHROPIC_WORKSPACE_ID: WS,
  BANCO_ANTHROPIC_API_KEY_ID: KEY_ANT,
  OPENAI_ADMIN_API_KEY: CLAVE_OAI,
  BANCO_OPENAI_PROJECT_ID: PROY,
  BANCO_OPENAI_API_KEY_ID: KEY_OAI,
};

function medida(bateria: ResultadoDeCelda["bateria"], modelo: string, gastoUsd: number, gastoJuezUsd?: number): ResultadoDeCelda {
  const medicion: Medicion = {
    bateria,
    modelo,
    estado: "medido",
    gastoUsd,
    ...(gastoJuezUsd !== undefined ? { gastoJuezUsd } : {}),
    n: 10,
    cortadaPorTope: false,
    fallosDeLaCapa: 0,
    ejemplosDeFallos: [],
    exactitud: [],
    informeVsFactura: [],
  };
  return { bateria, modelo, estado: "medida", topeUsd: 1.25, medicion };
}

// Anthropic: 0,50 + 0,30 = 0,80 $. OpenAI: (0,20 − 0,05 del juez) + 0,40 = 0,55 $. Google no entra.
const RESULTADOS: ResultadoDeCelda[] = [
  medida("gsm8k", "anthropic/claude-haiku-4-5", 0.5),
  medida("bfcl", "anthropic/claude-sonnet-5", 0.3),
  medida("mt-bench", "openai/gpt-4o-mini", 0.2, 0.05),
  medida("xstest", "openai/gpt-4o-mini", 0.4),
  medida("gsm8k", "google/gemini-3.8-flash", 0.33),
  { bateria: "bfcl", modelo: "openai/gpt-5.5", estado: "sin-clave", motivo: "sin clave" },
];

// ── Respuestas grabadas ─────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** cost_report de Anthropic: céntimos en cadena decimal, agrupado por workspace y descripción. */
function costeAnthropic(centimosDelBanco: [string, string][], otroWorkspace = "5000"): unknown {
  return {
    data: [
      {
        starting_at: iso(DIA),
        ending_at: iso(DIA + 24 * 3600_000),
        results: [
          ...centimosDelBanco.map(([amount, token_type]) => ({
            amount,
            context_window: "0-200k",
            cost_type: "tokens",
            currency: "USD",
            description: `Claude Haiku 4.5 Usage - ${token_type}`,
            inference_geo: "not_available",
            model: "claude-haiku-4-5",
            service_tier: "standard",
            token_type,
            workspace_id: WS,
          })),
          // Otro workspace de la organización: NO es del banco y no puede entrar.
          { amount: otroWorkspace, context_window: "0-200k", cost_type: "tokens", currency: "USD", description: "Claude Opus 5.5 Usage - Output Tokens", inference_geo: "global", model: "claude-opus-5-5", service_tier: "standard", token_type: "output_tokens", workspace_id: "wrkspc_01Produccion" },
        ],
      },
    ],
    has_more: false,
    next_page: null,
  };
}

/** usage_report/messages por minuto: uso en los minutos dados, con su clave. */
function usoAnthropic(minutos: { ms: number; clave: string }[]): unknown {
  return {
    data: minutos.map(({ ms, clave }) => ({
      starting_at: iso(ms),
      ending_at: iso(ms + MIN),
      results: [
        {
          account_id: null,
          api_key_id: clave,
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          cache_read_input_tokens: 200,
          context_window: null,
          inference_geo: null,
          model: null,
          output_tokens: 500,
          server_tool_use: { web_search_requests: 0 },
          service_account_id: null,
          service_tier: null,
          uncached_input_tokens: 1500,
          workspace_id: null,
        },
      ],
    })),
    has_more: false,
    next_page: null,
  };
}

/** /v1/organization/costs de OpenAI: dólares, agrupado por line_item. */
function costeOpenAI(lineas: [number, string][]): unknown {
  return {
    object: "page",
    data: [
      {
        object: "bucket",
        start_time: DIA / 1000,
        end_time: DIA / 1000 + 86400,
        results: lineas.map(([value, line_item]) => ({
          object: "organization.costs.result",
          amount: { value, currency: "usd" },
          line_item,
          project_id: null,
          api_key_id: null,
          quantity: null,
          quantity_unit: null,
        })),
      },
    ],
    has_more: false,
    next_page: null,
  };
}

function usoOpenAI(minutos: { ms: number; clave: string }[]): unknown {
  return {
    object: "page",
    data: minutos.map(({ ms, clave }) => ({
      object: "bucket",
      start_time: ms / 1000,
      end_time: ms / 1000 + 60,
      results: [
        { object: "organization.usage.completions.result", input_tokens: 1200, output_tokens: 300, input_cached_tokens: 0, num_model_requests: 3, project_id: null, api_key_id: clave, model: null, batch: null },
      ],
    })),
    has_more: false,
    next_page: null,
  };
}

const EN_LA_TIRADA = Date.parse("2026-09-28T05:03:00Z");

interface Grabado {
  anthCoste?: unknown[];
  anthUso?: unknown;
  oaiCoste?: unknown[];
  oaiUso?: unknown;
  estado?: number;
}

/** Un `fetch` que responde lo grabado; cada lectura de coste sucesiva devuelve la siguiente (retraso). */
function fetchGrabado(g: Grabado) {
  const pedidas: { url: URL; headers: Record<string, string> }[] = [];
  let nAnt = 0;
  let nOai = 0;
  const f = (async (entrada: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(entrada));
    pedidas.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (g.estado) return new Response(JSON.stringify({ type: "error", error: { type: "permission_error", message: `clave ${CLAVE_ANT} sin permiso` } }), { status: g.estado });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "content-type": "application/json" } });
    switch (url.pathname) {
      case "/v1/organizations/cost_report":
        return json(g.anthCoste![Math.min(nAnt++, g.anthCoste!.length - 1)]);
      case "/v1/organizations/usage_report/messages":
        return json(g.anthUso ?? usoAnthropic([{ ms: EN_LA_TIRADA, clave: KEY_ANT }]));
      case "/v1/organization/costs":
        return json(g.oaiCoste![Math.min(nOai++, g.oaiCoste!.length - 1)]);
      case "/v1/organization/usage/completions":
        return json(g.oaiUso ?? usoOpenAI([{ ms: EN_LA_TIRADA, clave: KEY_OAI }]));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, pedidas };
}

/** Reloj de mentira: `dormir` avanza el tiempo en vez de esperar. */
function reloj(inicio: number) {
  let t = inicio;
  return { ahora: () => t, dormir: async (ms: number) => void (t += ms) };
}

const CUADRA_ANT = costeAnthropic([
  ["70.5", "uncached_input_tokens"],
  ["8.1", "cache_read_input_tokens"],
  ["1.4", "output_tokens"],
]); // 80,00 céntimos = 0,80 $
const CUADRA_OAI = costeOpenAI([
  [0.3, "gpt-4o-mini-2024-07-18, input"],
  [0.05, "gpt-4o-mini-2024-07-18, cached input"],
  [0.2, "gpt-4o-mini-2024-07-18, output"],
]); // 0,55 $

const sinSecretos = (x: unknown) => {
  const t = JSON.stringify(x);
  expect(t).not.toContain(CLAVE_ANT);
  expect(t).not.toContain(CLAVE_OAI);
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe("factura real · lo que el banco midió, por proveedor", () => {
  it("suma A + B (+ juez si va directo) por el proveedor que factura cada celda; Google y la pasarela no entran", () => {
    const e = gastoEsperado(RESULTADOS, ENV);
    expect(e.anthropic.esperadoUsd).toBeCloseTo(0.8, 10);
    expect(e.anthropic.celdas).toBe(2);
    // El juez va por ai-gateway.vercel.sh (lo factura Vercel): se quita de la celda de MT-Bench.
    expect(e.openai.esperadoUsd).toBeCloseTo(0.55, 10);
    expect(e.openai.juezUsd).toBe(0);
  });

  it("el juez entra en la factura de OpenAI solo si va directo a api.openai.com", () => {
    const e = gastoEsperado(RESULTADOS, { ...ENV, BVSALA_JUDGE_BASE_URL: "https://api.openai.com/v1" });
    expect(e.openai.esperadoUsd).toBeCloseTo(0.6, 10);
    expect(e.openai.juezUsd).toBeCloseTo(0.05, 10);
  });

  it("una celda que murió sin artefacto deja el gasto de su proveedor sin conocer", () => {
    const e = gastoEsperado([...RESULTADOS, { bateria: "gsm8k", modelo: "anthropic/claude-opus-5-5", estado: "arnes-falla", motivo: "exit 1", topeUsd: 1.25 }], ENV);
    expect(e.anthropic.desconocidas).toEqual(["gsm8k/anthropic/claude-opus-5-5"]);
    expect(e.openai.desconocidas).toEqual([]);
  });

  it("los días UTC que cubre la tirada, y cuándo se da la factura por cerrada", () => {
    expect(diasDeLaVentana(VENTANA)).toEqual({ desde: DIA, hasta: DIA + 86400_000 });
    expect(diasDeLaVentana({ inicio: "2026-09-28T22:00:00Z", fin: "2026-09-29T01:00:00Z" }).hasta).toBe(DIA + 2 * 86400_000);
    expect(facturaCerrada(VENTANA, HOY)).toBe(false);
    expect(facturaCerrada(VENTANA, SEMANA_DESPUES)).toBe(true);
  });

  it("la decisión: dentro de ±2 % cuadra; por encima no cuadra nunca; por debajo espera hasta que el día cierre", () => {
    expect(decidir(1, 1.019, false)).toBe("cuadra");
    expect(decidir(1, 0.981, false)).toBe("cuadra");
    expect(decidir(1, 1.05, false)).toBe("no-cuadra");
    expect(decidir(1, 0.9, false)).toBe("pendiente");
    expect(decidir(1, 0.9, true)).toBe("no-cuadra");
  });
});

describe("factura real · lectura de las APIs (respuestas grabadas)", () => {
  it("Anthropic: céntimos → dólares, solo el workspace del banco, caché del proveedor aparte, y la clave solo en la cabecera", async () => {
    const { f, pedidas } = fetchGrabado({ anthCoste: [CUADRA_ANT] });
    const l = await leerFacturaAnthropic({ claveAdmin: CLAVE_ANT, workspaceId: WS, apiKeyId: KEY_ANT }, VENTANA, f);
    expect(l.facturadoUsd).toBeCloseTo(0.8, 10);
    expect(l.cacheDelProveedorUsd).toBeCloseTo(0.081, 10);
    expect(l.ajeno).toBeNull();
    const coste = pedidas.find((p) => p.url.pathname.endsWith("/cost_report"))!;
    expect(coste.url.searchParams.get("starting_at")).toBe("2026-09-28T00:00:00Z");
    expect(coste.url.searchParams.get("ending_at")).toBe("2026-09-29T00:00:00Z");
    expect(coste.url.searchParams.get("bucket_width")).toBe("1d");
    expect(coste.url.searchParams.getAll("group_by[]")).toEqual(["workspace_id", "description"]);
    expect(coste.headers["x-api-key"]).toBe(CLAVE_ANT);
    expect(coste.headers["anthropic-version"]).toBe("2023-06-01");
    const uso = pedidas.find((p) => p.url.pathname.endsWith("/usage_report/messages"))!;
    expect(uso.url.searchParams.get("bucket_width")).toBe("1m");
    expect(uso.url.searchParams.getAll("workspace_ids[]")).toEqual([WS]);
    expect(uso.url.searchParams.getAll("group_by[]")).toEqual(["api_key_id"]);
    for (const p of pedidas) expect(p.url.toString()).not.toContain(CLAVE_ANT);
  });

  it("OpenAI: dólares, filtrado por proyecto y clave, en segundos Unix, la línea «cached input» aparte", async () => {
    const { f, pedidas } = fetchGrabado({ oaiCoste: [CUADRA_OAI] });
    const l = await leerFacturaOpenAI({ claveAdmin: CLAVE_OAI, projectId: PROY, apiKeyId: KEY_OAI }, VENTANA, f);
    expect(l.facturadoUsd).toBeCloseTo(0.55, 10);
    expect(l.cacheDelProveedorUsd).toBeCloseTo(0.05, 10);
    expect(l.ajeno).toBeNull();
    const coste = pedidas.find((p) => p.url.pathname === "/v1/organization/costs")!;
    expect(coste.url.searchParams.get("start_time")).toBe(String(DIA / 1000));
    expect(coste.url.searchParams.get("end_time")).toBe(String(DIA / 1000 + 86400));
    expect(coste.url.searchParams.getAll("project_ids[]")).toEqual([PROY]);
    expect(coste.url.searchParams.getAll("api_key_ids[]")).toEqual([KEY_OAI]);
    expect(coste.url.searchParams.getAll("group_by[]")).toEqual(["line_item"]);
    expect(coste.headers["authorization"]).toBe(`Bearer ${CLAVE_OAI}`);
    for (const p of pedidas) expect(p.url.toString()).not.toContain(CLAVE_OAI);
  });

  it("recorre todas las páginas (has_more + next_page)", async () => {
    let n = 0;
    const f = (async (entrada: string | URL | Request) => {
      const url = new URL(String(entrada));
      if (url.pathname.endsWith("/costs")) {
        n++;
        const pag = url.searchParams.get("page");
        const cuerpo = pag === "page_2" ? { ...(CUADRA_OAI as object), has_more: false, next_page: null } : { ...(costeOpenAI([[0.1, "x, output"]]) as object), has_more: true, next_page: "page_2" };
        return new Response(JSON.stringify(cuerpo), { status: 200 });
      }
      return new Response(JSON.stringify(usoOpenAI([])), { status: 200 });
    }) as typeof fetch;
    const l = await leerFacturaOpenAI({ claveAdmin: CLAVE_OAI, projectId: PROY }, VENTANA, f);
    expect(n).toBe(2);
    expect(l.facturadoUsd).toBeCloseTo(0.65, 10);
  });

  it("tráfico ajeno: uso fuera de la ventana de la tirada, o de otra clave, en los mismos días", async () => {
    const fuera = fetchGrabado({ anthCoste: [CUADRA_ANT], anthUso: usoAnthropic([{ ms: EN_LA_TIRADA, clave: KEY_ANT }, { ms: Date.parse("2026-09-28T15:00:00Z"), clave: KEY_ANT }]) });
    expect((await leerFacturaAnthropic({ claveAdmin: CLAVE_ANT, workspaceId: WS, apiKeyId: KEY_ANT }, VENTANA, fuera.f)).ajeno).toMatch(/1 minutos con uso fuera/);
    const otra = fetchGrabado({ oaiCoste: [CUADRA_OAI], oaiUso: usoOpenAI([{ ms: EN_LA_TIRADA, clave: "key_de_produccion" }]) });
    expect((await leerFacturaOpenAI({ claveAdmin: CLAVE_OAI, projectId: PROY, apiKeyId: KEY_OAI }, VENTANA, otra.f)).ajeno).toMatch(/otras claves \(key_de_produccion\)/);
  });
});

describe("factura real · el cuadre, con su espera", () => {
  it("cuadra a la primera en los dos proveedores: sin infracciones ni avisos", async () => {
    const { f } = fetchGrabado({ anthCoste: [CUADRA_ANT], oaiCoste: [CUADRA_OAI] });
    const r = reloj(HOY);
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV, f, ...r });
    expect(c.map((x) => [x.proveedor, x.estado, x.intentos])).toEqual([
      ["anthropic", "cuadra", 1],
      ["openai", "cuadra", 1],
    ]);
    expect(evaluarFactura(c)).toEqual({ infracciones: [], avisos: [] });
    sinSecretos(c);
  });

  it("RETRASO: la factura llega a medias, se reintenta y cuadra cuando llegan los datos", async () => {
    const aMedias = costeAnthropic([["40", "uncached_input_tokens"]]);
    const { f } = fetchGrabado({ anthCoste: [aMedias, aMedias, CUADRA_ANT], oaiCoste: [CUADRA_OAI] });
    const r = reloj(HOY);
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV, f, ...r });
    const ant = c.find((x) => x.proveedor === "anthropic")!;
    expect(ant.estado).toBe("cuadra");
    expect(ant.intentos).toBe(3);
    expect(r.ahora() - HOY).toBe(2 * 300_000);
  });

  it("RETRASO que agota la espera: `pendiente`, un aviso, el banco NO falla; y la tirada siguiente lo decide", async () => {
    const aMedias = costeOpenAI([[0.3, "gpt-4o-mini-2024-07-18, input"]]);
    const { f } = fetchGrabado({ anthCoste: [CUADRA_ANT], oaiCoste: [aMedias] });
    const r = reloj(HOY);
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: { ...ENV, BANCO_FACTURA_ESPERA_MIN: "10" }, f, ...r });
    const oai = c.find((x) => x.proveedor === "openai")!;
    expect(oai.estado).toBe("pendiente");
    expect(oai.intentos).toBe(3); // t=0, 5 y 10 min
    const v = evaluar(RESULTADOS, null, c);
    expect(v.ok).toBe(true);
    expect(v.avisos.join("\n")).toMatch(/openai · tirada abc123 .*pendiente/);

    // La tirada N+1 lee el resultados.json de la N (tal cual se escribe) y vuelve a leer la factura, ya cerrada.
    const previos = cuadresPendientesDe(JSON.parse(JSON.stringify({ runId: "abc123", factura: c })));
    expect(previos.map((x) => x.proveedor)).toEqual(["openai"]);

    const siguen = fetchGrabado({ anthCoste: [CUADRA_ANT], oaiCoste: [aMedias] });
    const n1 = await cuadrarLaFactura({ runId: "def456", ventana: VENTANA, resultados: [], env: ENV, previos, f: siguen.f, ...reloj(SEMANA_DESPUES) });
    expect(n1).toHaveLength(3);
    expect(n1[0]).toMatchObject({ proveedor: "openai", runId: "abc123", estado: "no-cuadra", intentos: 1 });
    const vn1 = evaluar([], null, n1);
    expect(vn1.ok).toBe(false);
    expect(vn1.infracciones.map((i) => [i.regla, i.modelo])).toEqual([["factura-no-cuadra", "openai"]]);
    expect(vn1.infracciones[0]!.detalle).toMatch(/tirada abc123: .*día cerrado/);

    const llegaron = fetchGrabado({ anthCoste: [CUADRA_ANT], oaiCoste: [CUADRA_OAI] });
    const ok = await cuadrarLaFactura({ runId: "def456", ventana: VENTANA, resultados: [], env: ENV, previos, f: llegaron.f, ...reloj(SEMANA_DESPUES) });
    expect(ok[0]).toMatchObject({ runId: "abc123", estado: "cuadra" });
    expect(evaluar([], null, ok).ok).toBe(true);
  });

  it("una factura POR ENCIMA del 2 % no cuadra ya, sin esperar (el retraso no infla una factura)", async () => {
    const { f } = fetchGrabado({ anthCoste: [costeAnthropic([["95", "output_tokens"]])], oaiCoste: [CUADRA_OAI] });
    const r = reloj(HOY);
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV, f, ...r });
    const ant = c.find((x) => x.proveedor === "anthropic")!;
    expect(ant).toMatchObject({ estado: "no-cuadra", intentos: 1, facturadoUsd: 0.95 });
    expect(r.ahora()).toBe(HOY);
    const v = evaluar(RESULTADOS, null, c);
    expect(v.ok).toBe(false);
    expect(v.infracciones[0]).toMatchObject({ regla: "factura-no-cuadra", bateria: "banco", modelo: "anthropic" });
    expect(v.infracciones[0]!.detalle).toMatch(/0\.8000 \$ .* 0\.9500 \$ \(-15\.79 %\)/);
  });

  it("TRÁFICO AJENO: no se afirma nada (aviso, no falla) aunque las cifras no cuadren", async () => {
    const { f } = fetchGrabado({
      anthCoste: [costeAnthropic([["300", "output_tokens"]])],
      anthUso: usoAnthropic([{ ms: EN_LA_TIRADA, clave: KEY_ANT }, { ms: EN_LA_TIRADA, clave: "apikey_01OtraApp" }]),
      oaiCoste: [CUADRA_OAI],
    });
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV, f, ...reloj(HOY) });
    const ant = c.find((x) => x.proveedor === "anthropic")!;
    expect(ant.estado).toBe("no-comprobable");
    expect(ant.detalle).toMatch(/tráfico ajeno .*apikey_01OtraApp.*aísla el gasto del banco/);
    const v = evaluar(RESULTADOS, null, c);
    expect(v.ok).toBe(true);
    expect(v.avisos.some((a) => /tráfico ajeno/.test(a))).toBe(true);
  });

  it("SIN CLAVE DE ADMINISTRADOR: «factura real no comprobada (sin clave de administrador)», y el banco no falla ni llama a nadie", async () => {
    const { f, pedidas } = fetchGrabado({});
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV_BASE, f, ...reloj(HOY) });
    expect(pedidas).toHaveLength(0);
    expect(c.map((x) => x.estado)).toEqual(["sin-clave", "sin-clave"]);
    const v = evaluar(RESULTADOS, null, c);
    expect(v.ok).toBe(true);
    expect(v.avisos.filter((a) => a.includes("factura real no comprobada (sin clave de administrador"))).toHaveLength(2);
  });

  it("con clave pero sin workspace/proyecto dedicado: no comprobable, sin llamar", async () => {
    const { f, pedidas } = fetchGrabado({});
    const env = { ...ENV_BASE, ANTHROPIC_ADMIN_API_KEY: CLAVE_ANT, OPENAI_ADMIN_API_KEY: CLAVE_OAI };
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env, f, ...reloj(HOY) });
    expect(pedidas).toHaveLength(0);
    expect(c.map((x) => x.estado)).toEqual(["no-comprobable", "no-comprobable"]);
    expect(c[0]!.detalle).toContain("BANCO_ANTHROPIC_WORKSPACE_ID");
    expect(evaluar(RESULTADOS, null, c).ok).toBe(true);
  });

  it("clave rechazada (403): no comprobable, y ni la clave ni el cuerpo del error salen en el detalle", async () => {
    const { f } = fetchGrabado({ estado: 403 });
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV, f, ...reloj(HOY) });
    expect(c.map((x) => x.estado)).toEqual(["no-comprobable", "no-comprobable"]);
    expect(c[0]!.detalle).toMatch(/HTTP 403 permission_error/);
    sinSecretos(c);
    sinSecretos(resumenMarkdown(datosDelResumen(c)));
  });

  it("una celda muerta sin artefacto deja el cuadre de su proveedor en no comprobable", async () => {
    const { f } = fetchGrabado({ anthCoste: [CUADRA_ANT], oaiCoste: [CUADRA_OAI] });
    const res = [...RESULTADOS, { bateria: "gsm8k", modelo: "anthropic/claude-opus-5-5", estado: "arnes-falla", motivo: "exit 1", topeUsd: 1.25 } as ResultadoDeCelda];
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: res, env: ENV, f, ...reloj(HOY) });
    expect(c.find((x) => x.proveedor === "anthropic")!.estado).toBe("no-comprobable");
    expect(c.find((x) => x.proveedor === "openai")!.estado).toBe("cuadra");
  });

  it("sin gasto de un proveedor no hay nada que cuadrar (ni aviso)", async () => {
    const { f, pedidas } = fetchGrabado({ oaiCoste: [CUADRA_OAI] });
    const soloOpenAI = RESULTADOS.filter((r) => r.modelo.startsWith("openai/"));
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: soloOpenAI, env: ENV, f, ...reloj(HOY) });
    expect(c.map((x) => x.estado)).toEqual(["sin-gasto", "cuadra"]);
    expect(pedidas.every((p) => p.url.host === "api.openai.com")).toBe(true);
    expect(evaluarFactura(c).avisos).toEqual([]);
  });

  it("cuadresPendientesDe ignora lo que no reconoce", () => {
    expect(cuadresPendientesDe(null)).toEqual([]);
    expect(cuadresPendientesDe({ factura: "x" })).toEqual([]);
    expect(cuadresPendientesDe({ factura: [{ estado: "pendiente", proveedor: "google", runId: "a", esperadoUsd: 1, ventana: VENTANA }] })).toEqual([]);
    expect(cuadresPendientesDe({ factura: [{ estado: "cuadra", proveedor: "openai", runId: "a", esperadoUsd: 1, ventana: VENTANA }] })).toEqual([]);
  });
});

function datosDelResumen(factura: Cuadre[]): Parameters<typeof resumenMarkdown>[0] {
  return {
    modo: "vivo",
    commit: "abc1234",
    version: "0.4.33",
    inicio: VENTANA.inicio,
    fin: VENTANA.fin,
    gastoUsd: 1.83,
    reparto: { porModelo: {}, porBateria: {}, juezUsd: 0, asignadoUsd: 41.7, margenUsd: 8.3 } as unknown as Parameters<typeof resumenMarkdown>[0]["reparto"],
    resultados: RESULTADOS,
    veredicto: evaluar(RESULTADOS, null, factura),
    factura,
  };
}

describe("factura real · el resumen", () => {
  it("una sección propia con cada cuadre, la caché del proveedor aparte y Google declarado sin comprobar", async () => {
    const { f } = fetchGrabado({ anthCoste: [CUADRA_ANT], oaiCoste: [CUADRA_OAI] });
    const c = await cuadrarLaFactura({ runId: "abc123", ventana: VENTANA, resultados: RESULTADOS, env: ENV, f, ...reloj(HOY) });
    const md = resumenMarkdown(datosDelResumen(c));
    expect(md).toMatch(/## Factura real \(criterio 4: ±2 %, ahorro nativo aparte\)/);
    expect(md).toMatch(/anthropic · tirada abc123 .*\*\*cuadra\*\*.*0\.0810 \$ son caché de prefijo del proveedor \(ahorro nativo: aparte, no es de la capa\)/);
    expect(md).toMatch(/Google \(Gemini\): sin API de costes integrada/);
    expect(resumenMarkdown({ ...datosDelResumen([]), modo: "seco" })).toMatch(/En SECO no hay gasto/);
  });
});

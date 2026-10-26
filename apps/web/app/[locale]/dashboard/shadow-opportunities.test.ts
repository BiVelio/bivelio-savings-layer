import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { createTranslator, type AbstractIntlMessages } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { getShadowByModel, type ShadowModelDia, type UsageRollup } from "./data";
import { deriveOpportunities, opportunityExportCsv, opportunityExportJson } from "./opportunities";
import { ShadowOpportunitiesCard } from "./components/ShadowOpportunitiesCard";

const ORG = "33333333-3333-4333-8333-333333333333";
const estado = vi.hoisted(() => ({ locale: "en", messages: {} as Record<string, unknown> }));
const lanzar = (error: Error) => { throw error; };
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => createTranslator({
    locale: estado.locale,
    messages: estado.messages as AbstractIntlMessages,
    namespace: namespace as never,
    onError: lanzar,
  }),
}));

const mensajes = (locale: string) =>
  JSON.parse(readFileSync(new URL(`../../../messages/${locale}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

function cliente({
  rows = [],
  error = null,
  count = null,
  realError = null,
}: {
  rows?: Array<Record<string, unknown>>;
  error?: { code: string; message: string } | null;
  count?: number | null;
  realError?: { code: string; message: string } | null;
} = {}) {
  const real = count !== null || realError !== null;
  const hacer = () => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      order: () => q,
      then: (ok: (value: unknown) => unknown, ko?: (error: unknown) => unknown) => Promise.resolve(
        real ? { count, error: realError } : { data: rows, error },
      ).then(ok, ko),
    };
    return q;
  };
  return { schema: () => ({ from: hacer }) } as never;
}

describe("getShadowByModel — datos, vacío, oculto, error y no disponible", () => {
  it("normaliza numeric y distingue datos de una tabla vacía", async () => {
    const conDatos = await getShadowByModel(cliente({ rows: [{
      day: "2026-10-25", model: "gpt-5", shadow_requests: 2,
      shadow_baseline_cost: "1.2500000000", shadow_actual_cost: "0.7500000000",
    }] }), ORG);
    expect(conDatos).toMatchObject({ status: "data", failed: false });
    expect(conDatos.rows[0]).toEqual({
      day: "2026-10-25", model: "gpt-5", shadowRequests: 2,
      shadowBaselineCost: 1.25, shadowActualCost: 0.75,
    });
    expect((await getShadowByModel(cliente(), ORG)).status).toBe("empty");
  });

  it("migración ausente = unavailable, failed=false", async () => {
    const result = await getShadowByModel(cliente({
      error: { code: "PGRST205", message: "Could not find the table" },
    }), ORG);
    expect(result).toEqual({ rows: [], status: "unavailable", failed: false });
  });

  it("un error real = error y failed=true", async () => {
    const errores = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await getShadowByModel(cliente({ error: { code: "57014", message: "timeout" } }), ORG);
      expect(result).toEqual({ rows: [], status: "error", failed: true });
    } finally {
      errores.mockRestore();
    }
  });

  it("RLS que devuelve [] se distingue de vacío con la comprobación admin", async () => {
    const usuario = cliente();
    expect((await getShadowByModel(usuario, ORG, cliente({ count: 3 }))).status).toBe("hidden");
    expect((await getShadowByModel(usuario, ORG, cliente({ count: 0 }))).status).toBe("empty");
  });
});

const dias: ShadowModelDia[] = [
  { day: "2026-10-24", model: "gpt-5", shadowRequests: 2, shadowBaselineCost: 2, shadowActualCost: 1.25 },
  { day: "2026-10-25", model: "gpt-5", shadowRequests: 1, shadowBaselineCost: 1, shadowActualCost: 0.5 },
  { day: "2026-10-25", model: "claude-sonnet-5", shadowRequests: 1, shadowBaselineCost: 3, shadowActualCost: 3.25 },
];
const uso = [{ shadowRequests: 8 }] as UsageRollup[];

describe("deriveOpportunities y exportaciones", () => {
  it("agrega por modelo, conserva pérdidas y expone cobertura parcial", () => {
    const summary = deriveOpportunities(dias, uso);
    expect(summary.rows.map((r) => r.model)).toEqual(["gpt-5", "claude-sonnet-5"]);
    expect(summary.rows[0]).toMatchObject({ shadowRequests: 3, baselineCost: 3, actualCost: 1.75, hypotheticalSavings: 1.25, coverageRatio: 3 / 8 });
    expect(summary.rows[1]!.hypotheticalSavings).toBe(-0.25);
    expect(summary).toMatchObject({ totalShadowRequests: 8, attributedShadowRequests: 4, coverageRatio: 0.5, partialCoverage: true });
  });

  it("sin total diario la cobertura es desconocida, no 100 %", () => {
    const summary = deriveOpportunities(dias, [{}] as UsageRollup[]);
    expect(summary.coverageRatio).toBeNull();
    expect(summary.partialCoverage).toBeNull();
    expect(summary.rows.every((r) => r.coverageRatio === null)).toBe(true);
  });

  it("JSON y CSV llevan SHADOW/estimado y la cobertura parcial explícita", () => {
    const summary = deriveOpportunities(dias, uso);
    const json = opportunityExportJson(summary, 30, "2026-10-25T00:00:00.000Z");
    expect(json).toMatchObject({ basis: "shadow", estimated: true, partialCoverage: true, coverageRatio: 0.5, rangeDays: 30 });
    expect(json.rows).toHaveLength(2);
    expect(JSON.stringify(json)).not.toMatch(/prompt|completion/i);
    const csv = opportunityExportCsv(summary, 30, "2026-10-25T00:00:00.000Z");
    expect(csv).toContain("# basis=SHADOW\r\n# estimated=true");
    expect(csv).toContain("# partial_coverage=true");
    expect(csv).toContain("# coverage_ratio=0.5");
    expect(csv).toContain("# lever=unavailable_not_preserved_by_current_wire");
    expect(csv).toContain("# surface=unavailable_not_preserved_by_current_wire");
    expect(json.unavailableDimensions).toEqual({
      lever: "not_preserved_by_current_wire",
      surface: "not_preserved_by_current_wire",
    });
    expect(csv).toContain("gpt-5,3,3,1.75,1.25,0.375");
  });

  it("el modelo queda protegido contra fórmulas de hoja de cálculo", () => {
    const summary = deriveOpportunities([{ ...dias[0]!, model: "=HYPERLINK(\"x\")" }], uso);
    expect(opportunityExportCsv(summary, 30, "2026-10-25T00:00:00.000Z")).toContain("'=HYPERLINK");
  });
});

describe("ShadowOpportunitiesCard", () => {
  async function render(locale = "en", status: "data" | "empty" | "hidden" | "error" | "unavailable" = "data", rows = dias) {
    estado.locale = locale;
    estado.messages = mensajes(locale);
    return renderToString(await ShadowOpportunitiesCard({ rows, usage: uso, status, rango: 30 }));
  }

  it("etiqueta SHADOW, enseña cobertura parcial y enlaza exports/CTA sin atribuir palancas", async () => {
    const html = await render();
    expect(html).toContain("SHADOW · ESTIMATED");
    expect(html).toContain("Partial coverage");
    expect(html).toContain("gpt-5");
    expect(html).toContain("/api/org/shadow-opportunities?format=csv&amp;range=30");
    expect(html).toContain("/api/org/shadow-opportunities?format=json&amp;range=30");
    expect(html).toContain('href="/dashboard/account"');
    expect(html).toContain('href="/dashboard/install"');
    expect(html).toContain("Lever and surface are unavailable");
    expect(html).toContain("server-first change");
  });

  it("histórico, migración ausente, oculto y error no se disfrazan de vacío", async () => {
    expect(await render("en", "data", [])).toContain("history predating this migration");
    expect(await render("en", "unavailable", [])).toContain("not available on this server yet");
    expect(await render("en", "hidden", [])).toContain("visibility fault");
    expect(await render("en", "error", [])).toContain("role=\"alert\"");
  });

  for (const locale of ["ca", "de", "en", "es", "fr", "id", "it", "nl", "pl", "pt", "tr", "vi"]) {
    it(`renderiza con los mensajes reales: ${locale}`, async () => {
      const html = await render(locale);
      expect(html).toContain("SHADOW");
      expect(html).not.toContain("shadowOpportunities.");
    });
  }
});

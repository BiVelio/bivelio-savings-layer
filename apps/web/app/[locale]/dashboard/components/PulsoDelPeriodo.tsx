import { getLocale, getTranslations } from "next-intl/server";

import { LogoProveedor } from "@/app/components/LogoProveedor";
import { EvidenceBadge } from "@/app/components/ui";
import { ModelUsage, type ModelUsageCompany } from "@/vendor/affectui/model-usage";

import type { ModelDia, UsageRollup } from "../data";
import { deriveVerdict, proveedorDeModelo, type ProveedorDeCache } from "../derive";
import { compact, intfmt, money, pct0Floor } from "../format";
import type { Rango } from "../rango";
import { CosteDiarioChart } from "./CosteDiarioChart";

/**
 * EL PULSO DEL PERIODO — dos piezas de affectUI bajo las cifras, con los
 * mismos datos y el mismo rango que el titular:
 *
 *  · KPI Chart: línea base MEDIDA y coste real MEDIDO, día a día. La banda
 *    entre las dos es el ahorro acreditado de cada día y el tooltip lo dice
 *    con su cifra. Un día sin fila, o con tráfico pero sin nada medido, es un
 *    HUECO en la línea — nunca un cero (regla del panel).
 *  · Model Usage: el coste observado por EMPRESA proveedora, apilado por
 *    modelo, con el mismo `proveedorDeModelo` que ya usa el ahorro nativo. El
 *    selector cambia de medida entre las tres que la base guarda por modelo:
 *    coste real, peticiones y tokens facturados.
 *
 * Lo que NO hay: comparación con el periodo anterior (no existe una serie
 * comparable), ni ahorro por proveedor (el desglose por modelo no separa lo
 * medido de lo no medido, así que acreditarlo por empresa sería inventarlo).
 * El gráfico solo se pinta cuando el veredicto es «medido»; el desglose, solo
 * cuando hay filas por modelo. Sin eso, el titular ya explica qué falta.
 */

const DIA_MS = 86_400_000;
/** Colores estables por empresa: no dependen del orden ni del rango. */
const COLOR: Record<ProveedorDeCache, string> = {
  anthropic: "var(--brand)",
  openai: "var(--deep)",
  google: "var(--mint)",
  other: "var(--ink-soft)",
};
const ORDEN: ProveedorDeCache[] = ["anthropic", "openai", "google", "other"];
const MAX_MODELOS = 4;

export async function PulsoDelPeriodo({
  usage,
  porModelo,
  rango,
}: {
  /** Uso diario YA cortado al rango (el del titular). */
  usage: UsageRollup[];
  /** Filas por modelo YA cortadas al rango. */
  porModelo: ModelDia[];
  rango: Rango;
}) {
  const t = await getTranslations("dashboard");
  const u = await getTranslations("ui");
  const locale = await getLocale();
  const v = deriveVerdict(usage);
  const periodo = t("verdictHero.rangeDays", { n: rango });

  // ── Serie diaria medida: un punto por día natural entre el primero y el
  //    último con fila; `null` donde no hubo fila o no hubo nada medido.
  let grafico: React.ReactNode = null;
  if (v.kind === "measured" && usage.length > 1) {
    const porDia = new Map<string, { base: number; real: number; medidas: number }>();
    for (const r of usage) {
      const g = porDia.get(r.day) ?? { base: 0, real: 0, medidas: 0 };
      g.base += r.measuredBaselineCost;
      g.real += r.measuredActualCost;
      g.medidas += r.measuredRequests;
      porDia.set(r.day, g);
    }
    const dias = [...porDia.keys()].sort();
    const desde = Date.parse(`${dias[0]}T00:00:00Z`);
    const hasta = Date.parse(`${dias[dias.length - 1]}T00:00:00Z`);
    if (!Number.isNaN(desde) && !Number.isNaN(hasta) && hasta - desde <= 400 * DIA_MS) {
      // Fechas formateadas en SERVIDOR y bajadas como cadena (regla #418).
      const largo = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      const corto = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
      const labels: string[] = [];
      const tooltipLabels: string[] = [];
      const base: (number | null)[] = [];
      const real: (number | null)[] = [];
      const ahorro: (number | null)[] = [];
      for (let d = desde; d <= hasta; d += DIA_MS) {
        const fecha = new Date(d);
        const g = porDia.get(fecha.toISOString().slice(0, 10));
        const medido = g !== undefined && g.medidas > 0;
        labels.push(corto.format(fecha));
        tooltipLabels.push(largo.format(fecha));
        base.push(medido ? g.base : null);
        real.push(medido ? g.real : null);
        ahorro.push(medido ? g.base - g.real : null);
      }
      grafico = (
        <CosteDiarioChart
          title={t("overview.pulse.chartTitle")}
          aside={<EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno />}
          labels={labels}
          tooltipLabels={tooltipLabels}
          base={base}
          real={real}
          ahorro={ahorro}
          textos={{
            base: t("overview.pulse.seriesBaseline"),
            real: t("overview.pulse.seriesActual"),
            ahorro: t("overview.pulse.seriesSaved"),
            banda: t("overview.pulse.band"),
            plot: t("overview.pulse.chartAria"),
            vacio: t("overview.kpi.notMeasured"),
            hueco: t("overview.pulse.gap"),
          }}
          footer={t("overview.pulse.chartFoot", { period: periodo, share: pct0Floor(v.share) })}
        />
      );
    }
  }

  // ── Coste observado por empresa proveedora → modelos.
  let empresas: React.ReactNode = null;
  if (porModelo.length > 0) {
    type Fila = { coste: number; peticiones: number; tokens: number };
    const porEmpresa = new Map<ProveedorDeCache, Map<string, Fila>>();
    for (const r of porModelo) {
      const p = proveedorDeModelo(r.model);
      const modelos = porEmpresa.get(p) ?? new Map<string, Fila>();
      const f = modelos.get(r.model) ?? { coste: 0, peticiones: 0, tokens: 0 };
      f.coste += r.actualCost;
      f.peticiones += r.requests;
      f.tokens += r.actualInputTokens + r.actualOutputTokens;
      modelos.set(r.model, f);
      porEmpresa.set(p, modelos);
    }
    const vista = (f: Fila) => ({
      values: { coste: f.coste, peticiones: f.peticiones, tokens: f.tokens },
      display: { coste: money(f.coste), peticiones: intfmt(f.peticiones), tokens: compact(f.tokens) },
    });
    const suma = (fs: Fila[]): Fila => fs.reduce((a, f) => ({ coste: a.coste + f.coste, peticiones: a.peticiones + f.peticiones, tokens: a.tokens + f.tokens }), { coste: 0, peticiones: 0, tokens: 0 });
    const resto = t("usageExplorer.modelOther");
    const companies: ModelUsageCompany[] = ORDEN.filter((p) => porEmpresa.has(p)).map((p) => {
      const filas = [...(porEmpresa.get(p) ?? new Map<string, Fila>()).entries()].sort((a, b) => b[1].coste - a[1].coste || a[0].localeCompare(b[0]));
      const cabeza = filas.slice(0, MAX_MODELOS);
      const cola = filas.slice(MAX_MODELOS);
      const logo = p === "other" ? null : <LogoProveedor marca={p} size={13} />;
      return {
        id: p,
        name: t(`ahorroNativo.proveedor.${p}`),
        color: COLOR[p],
        logo: logo ?? undefined,
        display: vista(suma(filas.map(([, f]) => f))).display,
        models: [
          ...cabeza.map(([name, f]) => ({ name, ...vista(f) })),
          ...(cola.length > 0 ? [{ name: resto, ...vista(suma(cola.map(([, f]) => f))) }] : []),
        ],
      };
    });
    const total = suma([...porEmpresa.values()].flatMap((m) => [...m.values()]));
    const observado = usage.reduce((n, r) => n + r.actualCost, 0);
    const cobertura = observado > 0 ? Math.min(1, total.coste / observado) : null;
    empresas = (
      <ModelUsage
        className="ov-providers"
        title={t("overview.pulse.providersTitle")}
        totals={vista(total).display}
        totalLabel={periodo}
        measures={[
          { id: "coste", label: t("overview.pulse.measureCost") },
          { id: "peticiones", label: t("overview.kpi.requests") },
          { id: "tokens", label: t("overview.pulse.measureTokens") },
        ]}
        measuresLabel={t("overview.pulse.measuresAria")}
        companies={companies}
        barLabel={t("overview.pulse.barAria", { company: "{company}", value: "{value}" })}
        detailTotalLabel={t("usageExplorer.rowTotal")}
        aside={<EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno />}
        emptyText={t("overview.breakdown.empty")}
        footer={
          cobertura === null
            ? t("overview.breakdown.coverageUnknown")
            : cobertura >= 0.995
              ? t("overview.breakdown.coverageFull")
              : t("overview.breakdown.coveragePartial", { coverage: pct0Floor(cobertura) })
        }
      />
    );
  }

  if (!grafico && !empresas) return null;
  return (
    <div className={grafico && empresas ? "ov-pulse" : "ov-pulse solo"} data-tour="pulse">
      {grafico}
      {empresas}
    </div>
  );
}

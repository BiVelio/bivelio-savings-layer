import { getTranslations } from "next-intl/server";

import { EmptyState, EvidenceBadge } from "@/app/components/ui";
import { CompactBreakdown } from "@/vendor/affectui/compact-breakdown";

import type { ModelDia, UsageRollup } from "../data";
import { agregarPorModelo, topConResto } from "../explorer-datos";
import { money, pct0Floor } from "../format";
import type { Rango } from "../rango";

/**
 * COSTE OBSERVADO POR MODELO — el Compact Breakdown de affectUI, para la única
 * magnitud del panel que SÍ es aditiva por modelo: el coste real del periodo,
 * misma moneda y mismo rango que el titular.
 *
 * Lo que NO entra aquí, a propósito: los cuatro libros del SavingsReport (no
 * son partes de un mismo total) y cualquier mezcla de ahorro medido, estimado
 * y potencial. Tampoco el `delta` del bloque original: era una variación
 * frente al periodo anterior y aquí no hay serie comparable.
 *
 * COLOR ESTABLE POR MODELO: el color se reparte por el orden del modelo en la
 * ventana COMPLETA (`porModeloCompleto`), no en el rango elegido, así que un
 * modelo conserva su color al pasar de 30 a 120 días. «Otros» siempre es gris.
 *
 * COBERTURA: el desglose por modelo se acumula con el tráfico nuevo y puede
 * sumar menos que el coste observado del periodo. La nota del pie lo dice
 * junto al total, en vez de dejar que el total parezca el de la cuenta.
 */
const MAX_FILAS = 5;
const PALETA = ["var(--brand)", "var(--deep)", "var(--mint)", "var(--amber)", "var(--ui)", "#8E6BD9", "#3B8EA5", "#B5651D"];
const COLOR_RESTO = "var(--line-strong)";

export async function DesgloseModelos({
  porModelo,
  porModeloCompleto,
  usage,
  rango,
  fallo = false,
}: {
  /** Filas por modelo YA cortadas al rango. */
  porModelo: ModelDia[];
  /** La ventana completa: solo decide el color de cada modelo. */
  porModeloCompleto: ModelDia[];
  /** El uso diario del mismo rango: da el total contra el que se mide la cobertura. */
  usage: UsageRollup[];
  rango: Rango;
  /** La lectura por modelo falló: se dice, no se pinta vacío. */
  fallo?: boolean;
}) {
  const t = await getTranslations("dashboard");
  const u = await getTranslations("ui");
  const titulo = t("overview.breakdown.title");

  if (fallo) {
    return (
      <div className="card card-pad ov-breakdown-empty">
        <div className="n card-title">{titulo}</div>
        <EmptyState compacto sinCaja alInicio como="p" titulo={t("overview.readErrors.models")} />
      </div>
    );
  }

  const barras = agregarPorModelo(porModelo, "costeReal").filter((b) => b.valor > 0);
  if (barras.length === 0) {
    return (
      <div className="card card-pad ov-breakdown-empty">
        <div className="n card-title">{titulo}</div>
        <EmptyState compacto sinCaja alInicio como="p" titulo={t("overview.breakdown.empty")} texto={t("usageExplorer.modelEmpty")} />
      </div>
    );
  }

  const orden = agregarPorModelo(porModeloCompleto, "costeReal").map((b) => b.model);
  const colorDe = (modelo: string): string => {
    const i = orden.indexOf(modelo);
    return i < 0 ? COLOR_RESTO : (PALETA[i % PALETA.length] ?? COLOR_RESTO);
  };
  const resto = t("usageExplorer.modelOther");
  const filas = topConResto(barras, MAX_FILAS, resto);
  const total = barras.reduce((n, b) => n + b.valor, 0);
  const observado = usage.reduce((n, r) => n + r.actualCost, 0);
  const cobertura = observado > 0 ? Math.min(1, total / observado) : null;

  return (
    <CompactBreakdown
      className="ov-breakdown"
      title={titulo}
      total={money(total)}
      totalLabel={t("overview.breakdown.totalLabel", { period: t("verdictHero.rangeDays", { n: rango }) })}
      aside={<EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno />}
      items={filas.map((b, i) => {
        const esResto = barras.length > MAX_FILAS && i === filas.length - 1;
        return {
          id: esResto ? "__resto" : b.model,
          label: b.model,
          value: b.valor,
          display: money(b.valor),
          color: esResto ? COLOR_RESTO : colorDe(b.model),
        };
      })}
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

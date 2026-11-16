import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";

import { ArrowRightIcon, CheckIcon, InstallIcon } from "@/app/components/icons";
import { EvidenceBadge } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import { KpiBoard, KpiFocus, KpiStat } from "@/vendor/affectui/kpi-board";

import type { StepState, UsageRollup } from "../data";
import { deriveVerdict } from "../derive";
import { intfmt, money, moneySigned, pct0Floor } from "../format";
import type { Rango } from "../rango";

/**
 * LAS TRES CIFRAS DEL PERIODO Y EL SIGUIENTE PASO — la composición del KPI
 * Board de affectUI debajo del titular, que sigue siendo el protagonista.
 *
 *   · Coste observado: lo que costó el tráfico con precio, a tus precios.
 *   · Ahorro acreditado: lo MEDIDO (`deriveVerdict.saved`), con su insignia.
 *   · Peticiones: el recuento del periodo y cuántas tienen contador.
 *
 * Cada una con su unidad, su periodo y su base escritos. NINGUNA SE RELLENA:
 * sin precio no hay coste; sin nada medido no hay ahorro, y se dice por qué
 * en vez de pintar un cero. No hay «vs. periodo anterior»: no existe una serie
 * comparable completa que respaldarlo (el panel guarda una sola ventana), así
 * que ese elemento del bloque original se omite. Tampoco se suman porcentajes.
 *
 * La línea fina bajo coste y peticiones son los valores diarios REALES del
 * periodo; un día sin fila corta la línea, no la baja a cero.
 *
 * La tarjeta de foco es el SIGUIENTE PASO REAL, sacado de los mismos hitos que
 * la espina: enlaza a su instrucción y, con los cinco hechos, a la evidencia.
 */

const DIA_MS = 86_400_000;

/** Una serie por día natural entre el primero y el último con fila; los huecos son `null`. */
function serieDiaria(usage: readonly UsageRollup[], valor: (r: UsageRollup) => number): (number | null)[] {
  if (usage.length < 2) return [];
  const porDia = new Map<string, number>();
  for (const r of usage) porDia.set(r.day, (porDia.get(r.day) ?? 0) + valor(r));
  const dias = [...porDia.keys()].sort();
  const desde = Date.parse(`${dias[0]}T00:00:00Z`);
  const hasta = Date.parse(`${dias[dias.length - 1]}T00:00:00Z`);
  if (Number.isNaN(desde) || Number.isNaN(hasta) || hasta - desde > 400 * DIA_MS) return [];
  const serie: (number | null)[] = [];
  for (let d = desde; d <= hasta; d += DIA_MS) {
    serie.push(porDia.get(new Date(d).toISOString().slice(0, 10)) ?? null);
  }
  return serie;
}

export async function ResumenKpis({
  usage,
  rango,
  steps,
}: {
  /** Ya cortado al rango, el mismo que recibe el titular. */
  usage: UsageRollup[];
  rango: Rango;
  steps: StepState[];
}) {
  const t = await getTranslations("dashboard");
  const u = await getTranslations("ui");
  const v = deriveVerdict(usage);
  const periodo = t("verdictHero.rangeDays", { n: rango });

  const peticiones = usage.reduce((n, r) => n + r.requests, 0);
  const conPrecio = v.kind === "measured" || v.kind === "sin_medir";
  const coste = usage.reduce((n, r) => n + r.actualCost, 0);
  const sinPrecio = t("overview.kpi.noPrice");
  const sinMedir = t("overview.kpi.notMeasured");

  const actual = steps.find((s) => s.status === "current");
  const noDisponible = steps.some((s) => s.status === "unavailable");
  const completo = steps.length > 0 && steps.every((s) => s.status === "done");

  let foco: { titulo: string; nota: ReactNode; accion: ReactNode; icono: ReactNode };
  if (completo) {
    foco = {
      titulo: t("overview.next.doneTitle"),
      nota: t("overview.next.doneBody"),
      icono: <CheckIcon />,
      accion: (
        <Link className="btn btn-ghost btn-sm" href="/dashboard/proof">
          {t("overview.next.proofCta")}
          <ArrowRightIcon />
        </Link>
      ),
    };
  } else if (actual) {
    foco = {
      titulo: actual.label,
      nota:
        actual.id === "License active"
          ? t("instrumentationSpine.hintLicense")
          : actual.id === "SDK or gateway installed"
            ? t("instrumentationSpine.hintInstall")
            : actual.id === "First real request"
              ? t("instrumentationSpine.hintFirstRequest")
              : actual.id === "Report ready"
                ? t("instrumentationSpine.hintReport")
                : t("instrumentationSpine.hintDefault"),
      icono: <InstallIcon />,
      accion: (
        <a className="btn btn-primary btn-sm" href="#puesta-en-marcha">
          {t("overview.next.openCta")}
        </a>
      ),
    };
  } else {
    foco = {
      titulo: t("overview.next.unavailableTitle"),
      nota: noDisponible ? t("instrumentationSpine.unavailableHint") : t("instrumentationSpine.hintDefault"),
      icono: <InstallIcon />,
      accion: (
        <Link className="btn btn-ghost btn-sm" href="/dashboard/install">
          {t("instrumentationSpine.linkInstall")}
        </Link>
      ),
    };
  }

  return (
    <KpiBoard label={t("overview.kpi.label")} className="ov-kpis">
      <KpiStat
        label={t("overview.kpi.cost")}
        value={conPrecio ? money(coste) : undefined}
        empty={sinPrecio}
        base={conPrecio ? t("overview.kpi.costBase", { period: periodo }) : undefined}
        series={conPrecio ? serieDiaria(usage, (r) => r.actualCost) : undefined}
      />
      <KpiStat
        label={t("overview.kpi.saved")}
        value={v.kind === "measured" ? moneySigned(v.saved) : undefined}
        tone={v.kind === "measured" ? (v.tone === "neg" ? "bad" : "good") : "neutral"}
        empty={v.kind === "unpriced" ? sinPrecio : sinMedir}
        base={v.kind === "measured" ? t("overview.kpi.savedBase", { period: periodo }) : undefined}
        badge={v.kind === "measured" ? <EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno /> : undefined}
      />
      <KpiStat
        label={t("overview.kpi.requests")}
        value={intfmt(peticiones)}
        base={
          v.kind === "measured"
            ? t("overview.kpi.requestsBase", { period: periodo, share: pct0Floor(v.share) })
            : t("overview.kpi.requestsBaseNone", { period: periodo })
        }
        series={serieDiaria(usage, (r) => r.requests)}
      />
      <KpiFocus eyebrow={t("overview.next.eyebrow")} title={foco.titulo} note={foco.nota} icon={foco.icono} action={foco.accion} />
    </KpiBoard>
  );
}

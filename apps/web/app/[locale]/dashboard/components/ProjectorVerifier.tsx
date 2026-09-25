"use client";

import { useMemo, useState } from "react";

import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";

/* Perfiles de uso: rellenan volumen y tamaños sin pedir que nadie sepa sus
 * "tokens de entrada promedio" de memoria. Ajustables en Ajustes avanzados. */
const PROFILES = {
  chat: { reqs: 300_000, inTok: 900, outTok: 350 },
  extract: { reqs: 1_000_000, inTok: 1800, outTok: 150 },
  agent: { reqs: 150_000, inTok: 2500, outTok: 600 },
} as const;

/* Escenarios: las tres palancas (% llamadas evitadas, % recorte de entrada,
 * % recorte de salida) resumidas en una sola elección. */
const SCENARIOS = {
  cautious: { avoid: 0.12, elim: 0.25, outRed: 0.18 },
  typical: { avoid: 0.25, elim: 0.4, outRed: 0.3 },
  bold: { avoid: 0.4, elim: 0.55, outRed: 0.45 },
} as const;

/**
 * El PROYECTOR de factura del panel: una ESTIMACIÓN con deslizadores, y lo dice
 * su etiqueta. Es la mitad que 9feb377 (#85) sacó de la portada porque el
 * visitante inventaba sus propios porcentajes, y por eso se queda aquí, tras el
 * login, y no vuelve a la portada.
 *
 * La otra mitad —el verificador de formato— se fue a `FormatVerifier`
 * (app/components), que cuenta con el tokenizador EXACTO y es el mismo en la
 * portada y en el panel. Aquí contaba con el heurístico y enseñaba a clientes
 * que pagan un 45–51 % donde lo real es 17–27 %.
 */
export function ProjectorVerifier({ prices }: { prices: { inPer1k: number; outPer1k: number } }) {
  const t = useTranslations("dashboard");

  // Projector inputs
  const [reqs, setReqs] = useState<number>(PROFILES.chat.reqs);
  const [inTok, setInTok] = useState<number>(PROFILES.chat.inTok);
  const [outTok, setOutTok] = useState<number>(PROFILES.chat.outTok);
  const [avoid, setAvoid] = useState<number>(SCENARIOS.typical.avoid);
  const [elim, setElim] = useState<number>(SCENARIOS.typical.elim);
  const [outRed, setOutRed] = useState<number>(SCENARIOS.typical.outRed);

  const projected = useMemo(() => {
    const baseline = (reqs * inTok) / 1e6 * prices.inPer1k * 1000 + (reqs * outTok) / 1e6 * prices.outPer1k * 1000;
    const served = reqs * (1 - avoid);
    const optIn = served * inTok * (1 - elim);
    const optOut = served * outTok * (1 - outRed);
    const opt = optIn / 1e6 * prices.inPer1k * 1000 + optOut / 1e6 * prices.outPer1k * 1000;
    const saved = baseline - opt;
    return { baseline, opt, saved, pct: baseline ? (saved / baseline) * 100 : 0 };
  }, [reqs, inTok, outTok, avoid, elim, outRed, prices]);

  const money = (n: number) => (n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "k" : "$" + n.toFixed(0));

  const profileKey = (Object.keys(PROFILES) as (keyof typeof PROFILES)[])
    .find((k) => PROFILES[k].reqs === reqs && PROFILES[k].inTok === inTok && PROFILES[k].outTok === outTok);
  const scenarioKey = (Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[])
    .find((k) => Math.abs(SCENARIOS[k].avoid - avoid) < 0.005 && Math.abs(SCENARIOS[k].elim - elim) < 0.005 && Math.abs(SCENARIOS[k].outRed - outRed) < 0.005);

  const pickProfile = (k: keyof typeof PROFILES) => { setReqs(PROFILES[k].reqs); setInTok(PROFILES[k].inTok); setOutTok(PROFILES[k].outTok); };
  const pickScenario = (k: keyof typeof SCENARIOS) => { setAvoid(SCENARIOS[k].avoid); setElim(SCENARIOS[k].elim); setOutRed(SCENARIOS[k].outRed); };

  return (
    <div className="proj proj-solo">
      <div>
        <div className="ck-head" style={{ marginBottom: "8px" }}>
          <b style={{ fontSize: ".9rem" }}>{t("projectorVerifier.projectorTitle")}</b>
          <span className="est-tag">{t("projectorVerifier.estimate")}</span>
        </div>
        <p className="pv-label">{t("projectorVerifier.profileLabel")}</p>
        <div className="pv-chips">
          {(["chat", "extract", "agent"] as const).map((k) => (
            <button key={k} type="button" className={`pv-chip ${profileKey === k ? "on" : ""}`} onClick={() => pickProfile(k)}>
              {t(`projectorVerifier.profile_${k}`)}
            </button>
          ))}
        </div>
        <p className="pv-label">{t("projectorVerifier.scenarioLabel")}</p>
        <div className="pv-chips">
          {(["cautious", "typical", "bold"] as const).map((k) => (
            <button key={k} type="button" className={`pv-chip ${scenarioKey === k ? "on" : ""}`} onClick={() => pickScenario(k)}>
              {t(`projectorVerifier.scenario_${k}`)}
            </button>
          ))}
        </div>
        <details className="pv-adv">
          <summary>{t("projectorVerifier.advanced")}</summary>
          <div className="pv-adv-body">
            {([
              ["reqsPerMonth", reqs, setReqs, 10000],
              ["avgInputTokens", inTok, setInTok, 50],
              ["avgOutputTokens", outTok, setOutTok, 10],
            ] as const).map(([labelKey, val, set, step]) => (
              <div key={labelKey} className="field2">
                <label>{t(`projectorVerifier.${labelKey}`)}</label>
                <input type="number" value={val} step={step} onChange={(e) => set(Number(e.target.value) || 0)} />
              </div>
            ))}
            {([
              ["callsAvoided", avoid, setAvoid],
              ["inputCut", elim, setElim],
              ["outputCut", outRed, setOutRed],
            ] as const).map(([labelKey, val, set]) => (
              <div key={labelKey} className="field2">
                <label>{t(`projectorVerifier.${labelKey}`)}: {(val * 100).toFixed(0)}%</label>
                <input type="range" min={0} max={0.8} step={0.01} value={val} style={{ width: "110px" }} onChange={(e) => set(Number(e.target.value))} />
              </div>
            ))}
          </div>
        </details>
        <div className="kpi pv-kpi" style={{ marginTop: "10px", minHeight: "auto" }}>
          <div className="n">{t("projectorVerifier.projectedSaving", { model: "gpt-4o-mini" })}</div>
          <div className="v pos ck-num">{money(projected.saved)}</div>
          <div className="sub">{t("projectorVerifier.projFriendly", { baseline: money(projected.baseline), opt: money(projected.opt), pct: projected.pct.toFixed(0) })}</div>
        </div>
      </div>

      <div className="pv-note">
        <b>{t("projectorVerifier.onlyChatTitle")}</b>
        <p>{t("projectorVerifier.onlyChatBody")}</p>
        <Link href="/dashboard/install">{t("projectorVerifier.onlyChatCta")}</Link>
      </div>
    </div>
  );
}

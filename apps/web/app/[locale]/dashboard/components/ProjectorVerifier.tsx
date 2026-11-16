"use client";

import { useMemo, useState } from "react";

import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import { NumberTicker } from "@/vendor/affectui/number-ticker";
import { ToggleGroup } from "@/vendor/affectui/toggle-group";

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
 *
 * Los dos selectores son el Toggle Group de affectUI (uno solo encendido; si
 * los ajustes avanzados ya no cuadran con ningún perfil, ninguno). La cifra
 * rueda (Number Ticker) porque quien mira acaba de mover un supuesto, y las dos
 * barras comparan la factura sin optimizar con la estimada: misma escala, y la
 * etiqueta «estimación» sigue pegada a la cifra.
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

  // Un solo formato para la cifra que rueda, la frase y las barras: dólares sin
  // céntimos, y en miles a partir de mil. "en-US" fijo: mismo texto en servidor
  // y en navegador.
  const formato = (n: number): Intl.NumberFormatOptions =>
    Math.abs(n) >= 1e3
      ? { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }
      : { style: "currency", currency: "USD", maximumFractionDigits: 0 };
  const money = (n: number) => new Intl.NumberFormat("en-US", formato(n)).format(n);

  const profileKey = (Object.keys(PROFILES) as (keyof typeof PROFILES)[])
    .find((k) => PROFILES[k].reqs === reqs && PROFILES[k].inTok === inTok && PROFILES[k].outTok === outTok);
  const scenarioKey = (Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[])
    .find((k) => Math.abs(SCENARIOS[k].avoid - avoid) < 0.005 && Math.abs(SCENARIOS[k].elim - elim) < 0.005 && Math.abs(SCENARIOS[k].outRed - outRed) < 0.005);

  const pickProfile = (k: keyof typeof PROFILES) => { setReqs(PROFILES[k].reqs); setInTok(PROFILES[k].inTok); setOutTok(PROFILES[k].outTok); };
  const pickScenario = (k: keyof typeof SCENARIOS) => { setAvoid(SCENARIOS[k].avoid); setElim(SCENARIOS[k].elim); setOutRed(SCENARIOS[k].outRed); };

  return (
    <div className="proj proj-solo">
      <div className="card pv-card">
        <div className="pv-cols">
          <div className="pv-in">
            <p className="pv-label" id="pv-perfil">{t("projectorVerifier.profileLabel")}</p>
            <ToggleGroup
              type="single"
              required
              size="lg"
              className="pv-chips"
              aria-labelledby="pv-perfil"
              items={(["chat", "extract", "agent"] as const).map((k) => ({ value: k, label: t(`projectorVerifier.profile_${k}`) }))}
              value={profileKey ?? null}
              onChange={(k) => k && pickProfile(k)}
            />
            <p className="pv-label" id="pv-escenario">{t("projectorVerifier.scenarioLabel")}</p>
            <ToggleGroup
              type="single"
              required
              size="lg"
              className="pv-chips"
              aria-labelledby="pv-escenario"
              items={(["cautious", "typical", "bold"] as const).map((k) => ({ value: k, label: t(`projectorVerifier.scenario_${k}`) }))}
              value={scenarioKey ?? null}
              onChange={(k) => k && pickScenario(k)}
            />
            <details className="pv-adv">
              <summary>{t("projectorVerifier.advanced")}</summary>
              <div className="pv-adv-body">
                {([
                  ["reqsPerMonth", reqs, setReqs, 10000],
                  ["avgInputTokens", inTok, setInTok, 50],
                  ["avgOutputTokens", outTok, setOutTok, 10],
                ] as const).map(([labelKey, val, set, step]) => (
                  <div key={labelKey} className="field2">
                    <label htmlFor={`pv-${labelKey}`}>{t(`projectorVerifier.${labelKey}`)}</label>
                    <input id={`pv-${labelKey}`} type="number" value={val} step={step} onChange={(e) => set(Number(e.target.value) || 0)} />
                  </div>
                ))}
                {([
                  ["callsAvoided", avoid, setAvoid],
                  ["inputCut", elim, setElim],
                  ["outputCut", outRed, setOutRed],
                ] as const).map(([labelKey, val, set]) => (
                  <div key={labelKey} className="field2">
                    <label htmlFor={`pv-${labelKey}`}>{t(`projectorVerifier.${labelKey}`)}: {(val * 100).toFixed(0)}%</label>
                    <input id={`pv-${labelKey}`} className="pv-range" type="range" min={0} max={0.8} step={0.01} value={val} onChange={(e) => set(Number(e.target.value))} />
                  </div>
                ))}
              </div>
            </details>
          </div>
          {/* EL RESULTADO ES UNA ESTIMACIÓN, y lo dice junto a la cifra: sale de
              los supuestos de la izquierda, no de una factura ni de una medida. */}
          <div className="pv-out" role="status">
            <span className="est-tag">{t("projectorVerifier.estimate")}</span>
            <p className="pv-out-k">{t("projectorVerifier.projectedSaving", { model: "gpt-4o-mini" })}</p>
            <p className="pv-out-v ck-num">
              <NumberTicker value={projected.saved} format={formato(projected.saved)} locale="en-US" />
            </p>
            <p className="pv-out-s">{t("projectorVerifier.projFriendly", { baseline: money(projected.baseline), opt: money(projected.opt), pct: projected.pct.toFixed(0) })}</p>
            {/* Las dos facturas a la misma escala. Decorativas: las cifras ya están en la frase. */}
            <dl className="pv-bars">
              <div>
                <dt>{t("projectorVerifier.barBaseline")}</dt>
                <dd>
                  <span className="pv-bar" aria-hidden>
                    <i className="pv-bar-a" style={{ width: projected.baseline > 0 ? "100%" : "0%" }} />
                  </span>
                  <span className="mono">{money(projected.baseline)}</span>
                </dd>
              </div>
              <div>
                <dt>{t("projectorVerifier.barOptimized")}</dt>
                <dd>
                  <span className="pv-bar" aria-hidden>
                    <i className="pv-bar-b" style={{ width: projected.baseline > 0 ? `${Math.max(0, Math.min(100, (projected.opt / projected.baseline) * 100))}%` : "0%" }} />
                  </span>
                  <span className="mono">{money(projected.opt)}</span>
                </dd>
              </div>
            </dl>
            <p className="pv-out-n">{t("projectorVerifier.notInvoiceBody")}</p>
          </div>
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

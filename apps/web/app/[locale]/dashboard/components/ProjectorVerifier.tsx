"use client";

import { useEffect, useMemo, useState } from "react";

import { useTranslations, useLocale } from "next-intl";

import { Link } from "@/i18n/navigation";

/* Muestras con forma tabular real: en las tres el optimizador encuentra un
 * formato más barato que el JSON compacto, así que la primera impresión
 * enseña un ahorro de verdad (−44% a −51% con el bundle 0.5.0). */
const SAMPLES: Record<string, string> = {
  users: JSON.stringify(
    { users: Array.from({ length: 24 }, (_, i) => ({ id: 1000 + i, name: `user_${i}`, role: i % 3 ? "member" : "admin", active: i % 4 !== 0 })) },
    null,
    2,
  ),
  orders: JSON.stringify(
    { orders: Array.from({ length: 18 }, (_, i) => ({ order: `PED-2026-0${140 + i}`, customer: `cliente_${i + 1}`, items: (i % 4) + 1, total: Number((19.9 + i * 7.35).toFixed(2)), status: ["pagado", "enviado", "entregado"][i % 3] })) },
    null,
    2,
  ),
  tickets: JSON.stringify(
    { tickets: Array.from({ length: 16 }, (_, i) => ({ id: `TCK-${3300 + i}`, subject: `No puedo acceder a mi cuenta (${i + 1})`, priority: ["baja", "media", "alta"][i % 3], status: i % 2 ? "abierto" : "resuelto", agent: `agente_${(i % 5) + 1}` })) },
    null,
    2,
  ),
};

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

/** Verify-locally island: the REAL BV-SALA optimizer + a bill projector. Every
 *  output is a heuristic ESTIMATE, never a provider-metered measurement. */
export function ProjectorVerifier({ prices }: { prices: { inPer1k: number; outPer1k: number } }) {
  type Selector = { choose: (p: unknown, o: { model: string }) => { chosen: string; candidateTokens: Record<string, number> } };
  type SdkModule = { FormatSelector: new (o: { tokenizer: unknown }) => Selector; defaultTokenizerRegistry: unknown };
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const [selector, setSelector] = useState<Selector | null>(null);
  const [payload, setPayload] = useState(SAMPLES.users);
  const [sample, setSample] = useState<string | null>("users");
  const [err, setErr] = useState("");
  const [baseTok, setBaseTok] = useState(0);
  const [chosenTok, setChosenTok] = useState(0);

  // Projector inputs
  const [reqs, setReqs] = useState<number>(PROFILES.chat.reqs);
  const [inTok, setInTok] = useState<number>(PROFILES.chat.inTok);
  const [outTok, setOutTok] = useState<number>(PROFILES.chat.outTok);
  const [avoid, setAvoid] = useState<number>(SCENARIOS.typical.avoid);
  const [elim, setElim] = useState<number>(SCENARIOS.typical.elim);
  const [outRed, setOutRed] = useState<number>(SCENARIOS.typical.outRed);

  useEffect(() => {
    let alive = true;
    // Runtime dynamic import of the vendored SDK bundle (public/vendor/bv-sala.js).
    // webpackIgnore leaves it a native browser URL import (allowed by CSP
    // 'self'); the browser resolves the same bundle the landing uses.
    // @ts-expect-error — non-module URL specifier, resolved at runtime not build.
    const p: Promise<SdkModule> = import(/* webpackIgnore: true */ "/vendor/bv-sala.js");
    p.then((m) => {
      if (!alive) return;
      setSelector(new m.FormatSelector({ tokenizer: m.defaultTokenizerRegistry }));
    }).catch(() => setErr(t("projectorVerifier.errBundle")));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selector) return;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); setErr(""); } catch (e) { setErr(t("projectorVerifier.errInvalidData", { message: (e as Error).message })); return; }
    const choice = selector.choose(parsed, { model: "openai/gpt-4o-mini" });
    // Sin lista fija de formatos: la línea base es el JSON compacto y el ganador
    // es lo que diga el selector, se llame como se llame en esta versión del
    // SDK ("toon" ayer, "compact-rows" hoy). Una lista fija aquí es lo que
    // dejaba el medidor clavado en "recorta 0 tokens".
    const base = choice.candidateTokens["json-compact"] ?? Math.max(...Object.values(choice.candidateTokens), 0);
    setBaseTok(base);
    setChosenTok(choice.candidateTokens[choice.chosen] ?? base);
  }, [selector, payload]);

  const maxTok = Math.max(baseTok, chosenTok, 1);
  const savedTokPct = baseTok > 0 ? Math.round((100 * (baseTok - chosenTok)) / baseTok) : 0;
  const win = chosenTok < baseTok;

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

  const pickSample = (k: string) => { setSample(k); setPayload(SAMPLES[k]); };
  const pickProfile = (k: keyof typeof PROFILES) => { setReqs(PROFILES[k].reqs); setInTok(PROFILES[k].inTok); setOutTok(PROFILES[k].outTok); };
  const pickScenario = (k: keyof typeof SCENARIOS) => { setAvoid(SCENARIOS[k].avoid); setElim(SCENARIOS[k].elim); setOutRed(SCENARIOS[k].outRed); };

  return (
    <div className="proj">
      <div>
        <div className="ck-head" style={{ marginBottom: "8px" }}>
          <b style={{ fontSize: ".9rem" }}>{t("projectorVerifier.verifierTitle")}</b>
          <span className="est-tag">{t("projectorVerifier.estimateFull")}</span>
        </div>
        <p className="pv-label">{t("projectorVerifier.tryExample")}</p>
        <div className="pv-chips">
          {(["users", "orders", "tickets"] as const).map((k) => (
            <button key={k} type="button" className={`pv-chip ${sample === k ? "on" : ""}`} onClick={() => pickSample(k)}>
              {t(`projectorVerifier.sample_${k}`)}
            </button>
          ))}
        </div>
        <textarea
          className="proj-ta"
          value={payload}
          spellCheck={false}
          onChange={(e) => { setPayload(e.target.value); setSample(null); }}
        />
        <p className="ck-note">{t("projectorVerifier.pasteHint")}</p>
        {err ? <p className="ck-note" style={{ color: "var(--danger)" }}>{err}</p> : null}
        <div className="pv-verdict">
          <span className={`pv-pct ${win ? "" : "zero"}`}>{win ? t("projectorVerifier.savedPct", { pct: savedTokPct.toLocaleString(locale) }) : "0%"}</span>
        </div>
        <div>
          {[
            { name: t("projectorVerifier.yourData"), tokens: baseTok, win: false },
            { name: "BV-SALA", tokens: chosenTok, win },
          ].map((c) => (
            <div key={c.name} className="fmt-row2">
              <span className={`fmt-name2 ${c.win ? "win" : ""}`}>{c.name}{c.win ? " ●" : ""}</span>
              <span className="track2"><span className={`fill2 ${c.win ? "win" : ""}`} style={{ width: `${(100 * c.tokens) / maxTok}%` }} /></span>
              <span className="fmt-tok2">{c.tokens.toLocaleString(locale)}</span>
            </div>
          ))}
        </div>
        <p className="ck-note">
          {win
            ? t("projectorVerifier.trimsFriendly", { before: baseTok.toLocaleString(locale), after: chosenTok.toLocaleString(locale) })
            : t("projectorVerifier.alreadyOptimal")}
        </p>
      </div>

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

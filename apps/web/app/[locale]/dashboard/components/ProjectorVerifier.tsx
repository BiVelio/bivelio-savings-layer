"use client";

import { useEffect, useMemo, useState } from "react";

import { useTranslations } from "next-intl";

type Cand = { fmt: string; tokens: number };
const SAMPLE = JSON.stringify(
  { users: Array.from({ length: 24 }, (_, i) => ({ id: 1000 + i, name: `user_${i}`, role: i % 3 ? "member" : "admin", active: i % 4 !== 0 })) },
  null,
  2,
);

/** Verify-locally island: the REAL BV-SALA optimizer + a bill projector. Every
 *  output is a heuristic ESTIMATE, never a provider-metered measurement. */
export function ProjectorVerifier({ prices }: { prices: { inPer1k: number; outPer1k: number } }) {
  type Selector = { choose: (p: unknown, o: { model: string }) => { chosen: string; candidateTokens: Record<string, number> } };
  type SdkModule = { FormatSelector: new (o: { tokenizer: unknown }) => Selector; defaultTokenizerRegistry: unknown };
  const t = useTranslations("dashboard");
  const [selector, setSelector] = useState<Selector | null>(null);
  const [payload, setPayload] = useState(SAMPLE);
  const [err, setErr] = useState("");
  const [cands, setCands] = useState<Cand[]>([]);
  const [chosen, setChosen] = useState("json-compact");

  // Projector inputs
  const [reqs, setReqs] = useState(1_000_000);
  const [inTok, setInTok] = useState(1200);
  const [outTok, setOutTok] = useState(250);
  const [avoid, setAvoid] = useState(0.25);
  const [elim, setElim] = useState(0.4);
  const [outRed, setOutRed] = useState(0.3);

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
    const order = ["json-compact", "toon", "csv"];
    setCands(order.filter((f) => choice.candidateTokens[f] != null).map((f) => ({ fmt: f, tokens: choice.candidateTokens[f]! })));
    setChosen(choice.chosen);
  }, [selector, payload]);

  const baseTok = cands.find((c) => c.fmt === "json-compact")?.tokens ?? 0;
  const chosenTok = cands.find((c) => c.fmt === chosen)?.tokens ?? baseTok;
  const maxTok = Math.max(baseTok, chosenTok, 1);

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

  return (
    <div className="proj">
      <div>
        <div className="ck-head" style={{ marginBottom: "8px" }}>
          <b style={{ fontSize: ".9rem" }}>{t("projectorVerifier.verifierTitle")}</b>
          <span className="est-tag">{t("projectorVerifier.estimateFull")}</span>
        </div>
        <textarea className="proj-ta" value={payload} spellCheck={false} onChange={(e) => setPayload(e.target.value)} />
        {err ? <p className="ck-note" style={{ color: "var(--danger)" }}>{err}</p> : null}
        <div style={{ marginTop: "10px" }}>
          {[
            { name: t("projectorVerifier.yourData"), tokens: baseTok, win: false },
            { name: "BV-SALA", tokens: chosenTok, win: chosen !== "json-compact" },
          ].map((c) => (
            <div key={c.name} className="fmt-row2">
              <span className={`fmt-name2 ${c.win ? "win" : ""}`}>{c.name}{c.win ? " ●" : ""}</span>
              <span className="track2"><span className={`fill2 ${c.win ? "win" : ""}`} style={{ width: `${(100 * c.tokens) / maxTok}%` }} /></span>
              <span className="fmt-tok2">{c.tokens.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <p className="ck-note">
          {chosen !== "json-compact"
            ? t("projectorVerifier.trims", { tokens: (baseTok - chosenTok).toLocaleString() })
            : t("projectorVerifier.alreadyOptimal")}
        </p>
      </div>

      <div>
        <div className="ck-head" style={{ marginBottom: "8px" }}>
          <b style={{ fontSize: ".9rem" }}>{t("projectorVerifier.projectorTitle")}</b>
          <span className="est-tag">{t("projectorVerifier.estimate")}</span>
        </div>
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
        <div className="kpi" style={{ marginTop: "10px", minHeight: "auto" }}>
          <div className="n">{t("projectorVerifier.projectedSaving", { model: "gpt-4o-mini" })}</div>
          <div className="v pos ck-num">{money(projected.saved)}</div>
          <div className="lo">{t("projectorVerifier.projLower", { baseline: money(projected.baseline), opt: money(projected.opt), pct: projected.pct.toFixed(0) })}</div>
        </div>
      </div>
    </div>
  );
}

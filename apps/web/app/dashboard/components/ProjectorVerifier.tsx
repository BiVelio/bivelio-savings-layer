"use client";

import { useEffect, useMemo, useState } from "react";

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
    }).catch(() => setErr("Could not load the optimizer bundle."));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!selector) return;
    let parsed: unknown;
    try { parsed = JSON.parse(payload); setErr(""); } catch (e) { setErr("Waiting for valid data… " + (e as Error).message); return; }
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
          <b style={{ fontSize: ".9rem" }}>Savings verifier</b>
          <span className="est-tag">ESTIMATE — heuristic, not provider-metered</span>
        </div>
        <textarea className="proj-ta" value={payload} spellCheck={false} onChange={(e) => setPayload(e.target.value)} />
        {err ? <p className="ck-note" style={{ color: "var(--warn)" }}>{err}</p> : null}
        <div style={{ marginTop: "10px" }}>
          {[
            { name: "Your data", tokens: baseTok, win: false },
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
            ? `BV‑SALA trims ${(baseTok - chosenTok).toLocaleString()} tokens per send.`
            : "Already optimal here — BV‑SALA never makes it worse."}
        </p>
      </div>

      <div>
        <div className="ck-head" style={{ marginBottom: "8px" }}>
          <b style={{ fontSize: ".9rem" }}>Bill projector</b>
          <span className="est-tag">ESTIMATE</span>
        </div>
        {([
          ["Requests / month", reqs, setReqs, 10000],
          ["Avg input tokens", inTok, setInTok, 50],
          ["Avg output tokens", outTok, setOutTok, 10],
        ] as const).map(([label, val, set, step]) => (
          <div key={label} className="field2">
            <label>{label}</label>
            <input type="number" value={val} step={step} onChange={(e) => set(Number(e.target.value) || 0)} />
          </div>
        ))}
        {([
          ["Calls avoided", avoid, setAvoid],
          ["Input cut", elim, setElim],
          ["Output cut", outRed, setOutRed],
        ] as const).map(([label, val, set]) => (
          <div key={label} className="field2">
            <label>{label}: {(val * 100).toFixed(0)}%</label>
            <input type="range" min={0} max={0.8} step={0.01} value={val} style={{ width: "110px" }} onChange={(e) => set(Number(e.target.value))} />
          </div>
        ))}
        <div className="kpi" style={{ marginTop: "10px", minHeight: "auto" }}>
          <div className="n">projected saving / month · at gpt-4o-mini prices</div>
          <div className="v pos ck-num">{money(projected.saved)}</div>
          <div className="lo">{money(projected.baseline)} → {money(projected.opt)} · {projected.pct.toFixed(0)}% lower</div>
        </div>
      </div>
    </div>
  );
}

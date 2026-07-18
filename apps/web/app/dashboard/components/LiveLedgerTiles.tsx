import type { AbArtifact, UsageRollup } from "../data";
import { intfmt, LEDGER_COLOR } from "../format";

// The LIVE ledger names (NOT the reference's output_restriction). Each maps to a
// real usage_daily column; a faint reference "ghost" keeps the never-summed model
// legible before any customer data exists.
const LIVE = [
  { key: "avoided_calls", col: "avoided_llm", what: "LLM/retrieval/tool calls that never ran", ghost: "ref 35%" },
  { key: "eliminated_tokens", col: "eliminated_input_tokens", what: "input tokens dropped as unnecessary", ghost: "ref 61%" },
  { key: "compressed_tokens", col: "compressed_input_tokens", what: "input tokens re-encoded smaller", ghost: "ref 57%" },
  { key: "provider_cached_tokens", col: "provider_cached_input_tokens", what: "input tokens billed cheaper (prefix cache)", ghost: "—" },
] as const;

function liveValue(usage: UsageRollup[], key: string): number | null {
  if (usage.length === 0) return null;
  const sum = (f: (r: UsageRollup) => number) => usage.reduce((n, r) => n + f(r), 0);
  switch (key) {
    case "avoided_calls": return sum((r) => r.avoidedLlm);
    case "eliminated_tokens": return sum((r) => r.eliminatedInputTokens);
    case "compressed_tokens": return sum((r) => r.compressedInputTokens);
    case "provider_cached_tokens": return sum((r) => r.providerCachedInputTokens);
    default: return null;
  }
}

export function LiveLedgerTiles({ usage }: { usage: UsageRollup[]; ab: AbArtifact }) {
  return (
    <>
      <div className="kpis">
        {LIVE.map((l) => {
          const v = liveValue(usage, l.key);
          return (
            <div key={l.key} className="kpi">
              <div className="n">
                <span className="ltag" style={{ background: LEDGER_COLOR[l.key] ?? "var(--muted)" }} />
                {l.key}
              </div>
              {v == null ? (
                <>
                  <div className="v empty ck-num">—</div>
                  <div className="sub">{l.what}</div>
                  <div className="ghost">{l.ghost} · awaiting first report</div>
                </>
              ) : (
                <>
                  <div className="v pos ck-num">{intfmt(v)}</div>
                  <div className="sub">{l.what}</div>
                </>
              )}
              <div className="src">usage_daily.{l.col}</div>
            </div>
          );
        })}
      </div>
      <p className="footnote">
        Four ledgers, <b>never summed</b> — we can&apos;t double-count a dollar. Counts and cost only, never your
        prompts. The report is the meter.
      </p>
    </>
  );
}

import { getTranslations } from "next-intl/server";

import type { AbArtifact, UsageRollup } from "../data";
import { intfmt, LEDGER_COLOR } from "../format";

// The LIVE ledger names (NOT the reference's output_restriction). Each maps to a
// real usage_daily column; a faint reference "ghost" keeps the never-summed model
// legible before any customer data exists.
const LIVE = [
  { key: "avoided_calls", col: "avoided_llm", whatKey: "whatAvoidedCalls", ghost: "ref 35%" },
  { key: "eliminated_tokens", col: "eliminated_input_tokens", whatKey: "whatEliminatedTokens", ghost: "ref 61%" },
  { key: "compressed_tokens", col: "compressed_input_tokens", whatKey: "whatCompressedTokens", ghost: "ref 57%" },
  { key: "provider_cached_tokens", col: "provider_cached_input_tokens", whatKey: "whatProviderCachedTokens", ghost: "—" },
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

export async function LiveLedgerTiles({ usage }: { usage: UsageRollup[]; ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
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
                  <div className="sub">{t(`liveLedgerTiles.${l.whatKey}`)}</div>
                  <div className="ghost">{t("liveLedgerTiles.ghostAwaiting", { ref: l.ghost })}</div>
                </>
              ) : (
                <>
                  <div className="v pos ck-num">{intfmt(v)}</div>
                  <div className="sub">{t(`liveLedgerTiles.${l.whatKey}`)}</div>
                </>
              )}
              <div className="src">usage_daily.{l.col}</div>
            </div>
          );
        })}
      </div>
      <p className="footnote">
        {t.rich("liveLedgerTiles.footnote", { b: (chunks) => <b>{chunks}</b> })}
      </p>
    </>
  );
}

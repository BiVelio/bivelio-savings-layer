import { getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { intfmt, LEDGER_COLOR } from "../format";

// The LIVE ledger names (NOT the reference's output_restriction). Before any
// customer data exists each tile says it is awaiting its first report — no
// reference figure from another run.
const LIVE = [
  { key: "avoided_calls", whatKey: "whatAvoidedCalls" },
  { key: "eliminated_tokens", whatKey: "whatEliminatedTokens" },
  { key: "compressed_tokens", whatKey: "whatCompressedTokens" },
  { key: "provider_cached_tokens", whatKey: "whatProviderCachedTokens" },
] as const;

/*
 * Hasta el 2026-09-29 la baldosa vacía enseñaba un «fantasma» de referencia
 * («ref 47 %») sacado de la tirada sintética del 12-09, durante toda la ventana
 * de onboarding: justo cuando el cliente decide si paga. Era la cifra de otra
 * tirada (con un compresor que npm no trae), no la suya. Ahora la baldosa vacía
 * dice solo que espera su primer informe: en su panel, su dinero.
 */

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

export async function LiveLedgerTiles({ usage }: { usage: UsageRollup[] }) {
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
                  <div className="ghost">
                    {t("liveLedgerTiles.ghostAwaiting")}
                  </div>
                </>
              ) : (
                <>
                  <div className="v pos ck-num">{intfmt(v)}</div>
                  <div className="sub">{t(`liveLedgerTiles.${l.whatKey}`)}</div>
                </>
              )}
              {l.key === "eliminated_tokens" ? (
                <div className="sub">{t("liveLedgerTiles.elisionNota")}</div>
              ) : null}
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

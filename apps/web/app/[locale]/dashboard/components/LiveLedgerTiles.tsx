import { getTranslations } from "next-intl/server";

import type { AbArtifact, UsageRollup } from "../data";
import { intfmt, LEDGER_COLOR } from "../format";

// The LIVE ledger names (NOT the reference's output_restriction). A faint
// reference "ghost" keeps the never-summed model legible before any customer
// data exists.
const LIVE = [
  { key: "avoided_calls", whatKey: "whatAvoidedCalls" },
  { key: "eliminated_tokens", whatKey: "whatEliminatedTokens" },
  { key: "compressed_tokens", whatKey: "whatCompressedTokens" },
  { key: "provider_cached_tokens", whatKey: "whatProviderCachedTokens" },
] as const;

/**
 * El "fantasma" de referencia sale del artefacto A/B que la propia app publica,
 * NO de constantes a mano.
 *
 * Estaban escritas a pelo: «ref 35% / ref 61% / ref 57%» cuando el artefacto que
 * este mismo componente RECIBE por props —y no usaba— mide 47,0% / 8,9% / 34,3%.
 * El de eliminated_tokens sobreestimaba x6,8, y se enseña durante toda la ventana
 * de onboarding, que es justo cuando el cliente decide si paga. Eso no es un fallo
 * de render: es material de venta falso.
 *
 * `provider_cached_tokens` no tiene contrapartida en la referencia (allí el cuarto
 * libro es `output_restriction`), así que se queda sin fantasma en vez de
 * inventarle uno.
 */
function fantasmaDeReferencia(ab: AbArtifact, key: string): string {
  if (key === "provider_cached_tokens") return "—";
  const l = (ab?.ledgers ?? []).find((x) => x.ledger === key);
  const punto = l?.savings?.point;
  if (typeof punto !== "number" || !Number.isFinite(punto)) return "—";
  return `ref ${Math.round(punto * 100)}%`;
}

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

export async function LiveLedgerTiles({ usage, ab }: { usage: UsageRollup[]; ab: AbArtifact }) {
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
                    {t("liveLedgerTiles.ghostAwaiting", { ref: fantasmaDeReferencia(ab, l.key) })}
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

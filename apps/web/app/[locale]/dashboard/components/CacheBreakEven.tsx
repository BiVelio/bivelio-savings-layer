import { getTranslations } from "next-intl/server";

import type { AbArtifact } from "../data";
import { money } from "../format";

/** Cache savings are amortized over repeats, not per single call. */
export async function CacheBreakEven({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  const cache = ab.scenarios.find((s) => s.amortization);
  if (!cache?.amortization) return null;
  const { coldMissCost, hitCost, breakEvenK } = cache.amortization;
  return (
    <div className="bench-badge" style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}>
      <span className="est-tag">{t("cacheBreakEven.tag")}</span>
      <span>
        {t.rich("cacheBreakEven.body", {
          b: (chunks) => <b>{chunks}</b>,
          name: cache.name,
          coldMiss: money(coldMissCost),
          hit: money(hitCost),
          breakEvenK: breakEvenK ?? "∞",
        })}
      </span>
    </div>
  );
}

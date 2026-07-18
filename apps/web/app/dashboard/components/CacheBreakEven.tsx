import type { AbArtifact } from "../data";
import { money } from "../format";

/** Cache savings are amortized over repeats, not per single call. */
export function CacheBreakEven({ ab }: { ab: AbArtifact }) {
  const cache = ab.scenarios.find((s) => s.amortization);
  if (!cache?.amortization) return null;
  const { coldMissCost, hitCost, breakEvenK } = cache.amortization;
  return (
    <div className="bench-badge" style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}>
      <span className="est-tag">cache · amortized</span>
      <span>
        <b>{cache.name}</b>: cold miss {money(coldMissCost)} → hit {money(hitCost)}. Breaks even at{" "}
        <b>K={breakEvenK ?? "∞"}</b> repeats — cache savings are repeat-traffic, not a single-call number, so a
        cold call honestly reads ≈0%.
      </span>
    </div>
  );
}

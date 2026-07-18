import type { AbArtifact } from "../data";
import { pct0, money } from "../format";

/** Trust signals from the A/B run — surfaced, including proven:false. */
export function IntegrityQualityChips({ ab }: { ab: AbArtifact }) {
  const cache = ab.scenarios.find((s) => s.amortization);
  return (
    <div className="chips">
      <span className="chip2 good">
        Quality gate <b>{pct0(ab.aggregate.qualityPassRate)}</b> passed
      </span>
      <span className={`chip2 ${ab.reconciliation.reconciled ? "good" : "warn"}`}>
        Ledgers {ab.reconciliation.reconciled ? "reconcile" : "MISMATCH"}
        {!ab.reconciliation.reconciled ? <> · {money(ab.reconciliation.residual)}</> : null}
      </span>
      <span className={`chip2 ${ab.fingerprintStable ? "good" : "warn"}`}>
        Model fingerprint {ab.fingerprintStable ? "stable" : "changed"}
      </span>
      {cache?.amortization?.breakEvenK != null ? (
        <span className="chip2">
          Cache break-even <b>K={cache.amortization.breakEvenK}</b>
        </span>
      ) : null}
      <span className={`chip2 ${ab.aggregate.proven ? "good" : "warn"}`}>
        {ab.aggregate.proven ? "proven at 95%" : "unproven (mock)"}
      </span>
      <span className="chip2">A regressed answer voids its saving</span>
    </div>
  );
}

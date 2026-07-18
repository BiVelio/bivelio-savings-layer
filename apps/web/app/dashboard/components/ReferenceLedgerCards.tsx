import type { AbArtifact } from "../data";
import { pct, money, LEDGER_COLOR } from "../format";

/** The four REFERENCE ledgers (never summed). Note: these are the reference
 *  levers — the live rail measures a different four (provider_cached replaces
 *  output_restriction), so we never map one onto the other. */
export function ReferenceLedgerCards({ ab }: { ab: AbArtifact }) {
  return (
    <>
      <div className="kpis">
        {ab.ledgers.map((l) => {
          const pos = l.savings.point >= 0;
          return (
            <div key={l.ledger} className="kpi">
              <div className="n">
                <span className="ltag" style={{ background: LEDGER_COLOR[l.ledger] ?? "var(--muted)" }} />
                {l.ledger}
              </div>
              <div className={`v ${pos ? "pos" : "neg"}`}>{pct(l.savings.point)}</div>
              <div className="lo">95% ≥ {pct(l.savings.lower)} · Δ {money(l.deltaCost)}</div>
              <div className="sub">{ab.mode === "LIVE" ? (l.proven ? "proven" : "not proven") : "estimated (mock)"}</div>
            </div>
          );
        })}
      </div>
      <p className="footnote">
        Four ledgers, <b>never summed</b> — each is a separately measured lever, so a dollar can&apos;t be
        double-counted.{" "}
        {ab.reconciliation.reconciled
          ? "Reconciliation residual ≈ 0 proves it."
          : `residual ${money(ab.reconciliation.residual)} — check the accounting.`}{" "}
        These are <b>reference levers</b>: your live rail measures a different four — provider-cached replaces
        output-restriction — so we never map one onto the other.
      </p>
    </>
  );
}

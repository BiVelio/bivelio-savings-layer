import type { AbArtifact } from "../data";
import { ProvenancePill } from "./ProvenancePill";

/** Persistent provenance banner over the whole reference bench. */
export function ReferenceModeBadge({ ab }: { ab: AbArtifact }) {
  const live = ab.mode === "LIVE";
  return (
    <div className="bench-badge">
      <ProvenancePill kind={live ? "live" : "mock"} />
      <span>
        {live ? (
          <>
            <b>LIVE</b> — measured against a real provider, quality-gated.
          </>
        ) : (
          <>
            <b>ESTIMATED · mock provider</b> — this proves the mechanism works, not your bill. A committed LIVE
            run replaces every number here.
          </>
        )}
      </span>
    </div>
  );
}

import { getTranslations } from "next-intl/server";

import type { AbArtifact } from "../data";
import { ProvenancePill } from "./ProvenancePill";

/** Persistent provenance banner over the whole reference bench. */
export async function ReferenceModeBadge({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  const live = ab.mode === "LIVE";
  return (
    <div className="bench-badge">
      <ProvenancePill kind={live ? "live" : "mock"} />
      <span>
        {live ? (
          <>
            <b>LIVE</b> {t("referenceModeBadge.liveDesc")}
          </>
        ) : (
          <>
            {t.rich("referenceModeBadge.mock", { b: (chunks) => <b>{chunks}</b> })}
          </>
        )}
      </span>
    </div>
  );
}

import { getTranslations } from "next-intl/server";

import { midioElSdkInstalado } from "@/lib/bench/sdk-instalado";

import type { AbArtifact } from "../data";
import { ProvenancePill } from "./ProvenancePill";

/**
 * Persistent provenance banner over the whole reference bench.
 *
 * Una tirada LIVE que no midió el SDK tal como se instala (sin
 * `sdk.asShipped: true`: la del 2026-09-12 llevaba el compresor del banco) lo
 * dice aquí, encima de todo el banco, y no en una nota que hay que ir a buscar.
 */
export async function ReferenceModeBadge({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  const live = ab.mode === "LIVE";
  const pendiente = live && !midioElSdkInstalado(ab);
  return (
    <div className="bench-badge">
      <ProvenancePill kind={live ? "live" : "mock"} />
      <span>
        {live ? (
          <>
            <b>LIVE</b> {t("referenceModeBadge.liveDesc")}
            {pendiente ? <> {t("referenceModeBadge.sdkPendiente")}</> : null}
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

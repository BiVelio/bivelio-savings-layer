import { getTranslations } from "next-intl/server";

import { midioElSdkInstalado } from "@/lib/bench/sdk-instalado";

import type { AbArtifact } from "../data";
import { EvidenceBadge } from "@/app/components/ui";

/**
 * Persistent provenance banner over the whole reference bench.
 *
 * Una tirada LIVE que no midió el SDK tal como se instala (sin
 * `sdk.asShipped: true`: la del 2026-09-12 llevaba el compresor del banco) lo
 * dice aquí, encima de todo el banco, y no en una nota que hay que ir a buscar.
 */
export async function ReferenceModeBadge({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  const tu = await getTranslations("ui");
  const live = ab.mode === "LIVE";
  const pendiente = live && !midioElSdkInstalado(ab);
  return (
    <div className="bench-badge">
      {/* La insignia dice de QUÉ CLASE es la evidencia. Antes iba aquí la pastilla
          «LIVE · tu organización», que sobre un banco de referencia afirmaba
          justo lo que no es: estos escenarios no son tráfico del cliente. */}
      {live && !pendiente ? (
        <EvidenceBadge tipo="benchmark" label={tu("evidence.benchmark")} />
      ) : live ? (
        <EvidenceBadge tipo="sintetico" label={tu("evidence.sintetico")} />
      ) : (
        <EvidenceBadge tipo="estimacion" label={tu("evidence.estimacion")} />
      )}
      <span>
        {live ? (
          <>
            <b>LIVE</b> {t("referenceModeBadge.liveDesc")}
            {/* Sintética y sin promesa: lo dice encima de todo el banco. */}
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

import { getTranslations } from "next-intl/server";

import { midioElSdkInstalado } from "@/lib/bench/sdk-instalado";

import type { AbArtifact } from "../data";
import { pct } from "../format";

/**
 * The headline is the 95% CI LOWER bound (never the point estimate).
 *
 * Recibe el ARTEFACTO, no un intervalo suelto: así nadie puede pasarle el suelo
 * de una tirada que no midió el SDK tal como se instala. Sin
 * `sdk.asShipped: true` NO PINTA NADA (2026-09-29): hasta hoy enseñaba ahí un
 * «≥ 10 %» (el titular que la portada ya no publica). Una tirada sintética, con
 * un compresor que npm no trae, explica el mecanismo; no promete una cifra. La
 * cifra que el panel enseña como medida es la del banco en vivo
 * (MedidoEnVivo) y, sobre todo, la del propio cliente.
 */
export async function NetSavingsCIBand({ ab }: { ab: AbArtifact }) {
  if (!midioElSdkInstalado(ab)) return null;
  const t = await getTranslations("dashboard");
  const savings = ab.aggregate.savings;
  const dmin = Math.min(-0.05, savings.lower - 0.05);
  const dmax = Math.max(0.6, savings.upper + 0.05);
  const xp = (v: number) => Math.max(0, Math.min(100, ((v - dmin) / (dmax - dmin)) * 100));
  return (
    <div className="verdict band">
      <div>
        <div className="big pos ck-num">≥ {pct(savings.lower)}</div>
        <div className="cap">
          {t.rich("netSavingsCIBand.caption", {
            b: (chunks) => <b>{chunks}</b>,
            point: pct(savings.point),
            upper: pct(savings.upper),
            mockNote: ab.mode === "MOCK" ? t("netSavingsCIBand.mockNote") : "",
          })}
        </div>
      </div>
      <div>
        <div className="ci-track2">
          <div className="ci-fill2" style={{ left: `${xp(savings.lower)}%`, width: `${xp(savings.upper) - xp(savings.lower)}%` }} />
          <div className="ci-zero2" style={{ left: `${xp(0)}%` }} />
          <div className="ci-lo" style={{ left: `${xp(savings.lower)}%` }} />
          <div className="ci-pt" style={{ left: `${xp(savings.point)}%` }} />
        </div>
        <div className="ci-legend2">
          <span>{pct(dmin)}</span>
          <span>0%</span>
          <span>{pct(dmax)}</span>
        </div>
      </div>
    </div>
  );
}

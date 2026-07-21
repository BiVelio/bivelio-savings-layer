import { getTranslations } from "next-intl/server";

import type { AbArtifact, OrgContext } from "../data";
import { CopyButton } from "./CopyButton";
import { ServiceAccountKeySection } from "./ServiceAccountKeySection";
import { TrialKeyButton } from "./TrialKeyButton";

const WRAP = `import { createSavingsLayer } from "@bivelio/savings-layer";

// your app — the data plane. LLM traffic goes straight to your provider.
const layer = createSavingsLayer({
  provider: yourProvider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,          // step 1 — unlocks the SDK
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,   // step 2 — counts-only usage metering
  licenseServerUrl: "https://savings.bivelio.com",      // license check, kill-switch + metering
});

const { data, report } = await layer.generate({ model, messages, response });
report.cost.netSavings; // → verified savings, per request`;

export async function InstallLicensePanel({ ab, ctx }: { ab: AbArtifact; ctx: OrgContext }) {
  const t = await getTranslations("dashboard");
  return (
    <section className="ck-sec">
      <div className="ck-head">
        <div>
          <p className="ck-eyebrow">{t("installLicensePanel.eyebrow")}</p>
          <h2>{t("installLicensePanel.heading")}</h2>
        </div>
      </div>

      {/* 1 · license key (unlocks the fail-closed SDK) */}
      <p className="ck-note" style={{ marginTop: 0 }}>
        {t.rich("installLicensePanel.step1", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <TrialKeyButton />

      {/* 2 · service-account key (the machine credential for metering) */}
      <p className="ck-note">
        {t.rich("installLicensePanel.step2", {
          b: (chunks) => <b>{chunks}</b>,
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>
      <ServiceAccountKeySection />
      <div className="keycard" style={{ marginTop: 10 }}>
        <div>
          <div className="ck-note" style={{ margin: 0 }}>{t("installLicensePanel.currentKey")}</div>
          <div className="k">{ctx.serviceAccount ? `${ctx.serviceAccount.keyPrefix}…` : t("installLicensePanel.noneYet")}</div>
        </div>
        <div className="ck-note" style={{ margin: 0 }}>{t("installLicensePanel.shownOnce")}</div>
      </div>

      {/* 3 · install (public npm, zero auth) */}
      <p className="ck-note">
        {t.rich("installLicensePanel.step3", { b: (chunks) => <b>{chunks}</b> })}
      </p>
      <div className="code2">
        <span>pnpm add @bivelio/savings-layer</span>
        <CopyButton text="pnpm add @bivelio/savings-layer" />
      </div>

      {/* 4 · wire + run */}
      <p className="ck-note">{t.rich("installLicensePanel.step4", { b: (chunks) => <b>{chunks}</b> })}</p>
      <div className="code2">
        <span>{WRAP}</span>
        <CopyButton text={WRAP} />
      </div>

      <p className="ck-note" style={{ marginTop: 12 }}>
        {t.rich("installLicensePanel.finalNote", {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>

      <div className="legend">
        {ab.honesty.slice(0, 4).map((h, i) => (
          <span key={i} className="lg">{h.length > 64 ? h.slice(0, 62) + "…" : h}</span>
        ))}
      </div>
    </section>
  );
}

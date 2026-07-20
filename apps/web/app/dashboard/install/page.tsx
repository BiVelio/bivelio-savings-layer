import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "../data";
import { loadDashboard } from "../load";
import { InstallLicensePanel } from "../components/InstallLicensePanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Install · BiVelio Savings Layer" };

const ab = abData as unknown as AbArtifact;

export default async function InstallPage() {
  const { ctx } = await loadDashboard();
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">Integrate</p>
        <h1>Install &amp; wire the SDK</h1>
        <p>Drop BV-SALA in front of your provider — your prompts never leave your infra.</p>
      </div>
      <InstallLicensePanel ab={ab} ctx={ctx} />
    </>
  );
}

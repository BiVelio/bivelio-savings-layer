import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "../data";
import { CacheBreakEven } from "../components/CacheBreakEven";
import { IntegrityQualityChips } from "../components/IntegrityQualityChips";
import { NetSavingsCIBand } from "../components/NetSavingsCIBand";
import { ReferenceLedgerCards } from "../components/ReferenceLedgerCards";
import { ReferenceModeBadge } from "../components/ReferenceModeBadge";
import { ScenarioTable } from "../components/ScenarioTable";

export const metadata = { title: "Proof · BiVelio Savings Layer" };

const ab = abData as unknown as AbArtifact;

export default function ProofPage() {
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">Verify, don&apos;t trust · reference bench</p>
        <h1>Proof the optimizer works</h1>
        <p>Measured on both arms — the credibility engine behind your own numbers.</p>
      </div>
      <div className="bench">
        <ReferenceModeBadge ab={ab} />
        <NetSavingsCIBand savings={ab.aggregate.savings} mode={ab.mode} />
        <div style={{ marginTop: "16px" }}>
          <ReferenceLedgerCards ab={ab} />
        </div>
        <div style={{ marginTop: "16px" }}>
          <IntegrityQualityChips ab={ab} />
        </div>
        <div style={{ marginTop: "16px" }}>
          <ScenarioTable scenarios={ab.scenarios} />
        </div>
        <div style={{ marginTop: "16px" }}>
          <CacheBreakEven ab={ab} />
        </div>
      </div>
    </>
  );
}

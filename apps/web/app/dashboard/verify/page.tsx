import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "../data";
import { ProjectorVerifier } from "../components/ProjectorVerifier";

export const metadata = { title: "Verify · BiVelio Savings Layer" };

const ab = abData as unknown as AbArtifact;
const mini = (ab.pricing.table["gpt-4o-mini"] ?? {}) as { inputPer1k?: number; outputPer1k?: number };
const prices = { inPer1k: mini.inputPer1k ?? 0.00015, outPer1k: mini.outputPer1k ?? 0.0006 };

export default function VerifyPage() {
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">Verify locally · nothing leaves this page</p>
        <h1>Model your own payloads</h1>
        <p>Runs the real tokenizer in your browser — paste a payload and watch the accounting.</p>
      </div>
      <ProjectorVerifier prices={prices} />
    </>
  );
}

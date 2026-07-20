import { authConfigured } from "@/lib/supabase/env";
import abData from "@/public/data/ab-live.json";
import { activationSteps, type AbArtifact } from "./data";
import { loadDashboard } from "./load";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { SavingsTrendChart } from "./components/SavingsTrendChart";
import { TrafficModelMix } from "./components/TrafficModelMix";
import { VerdictHero } from "./components/VerdictHero";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · BiVelio Savings Layer" };

const ab = abData as unknown as AbArtifact;

export default async function OverviewPage() {
  if (!authConfigured) {
    return (
      <p className="ck-note">Sign-in isn&apos;t wired up yet. Set the Supabase env vars to enable it.</p>
    );
  }
  const { ctx, usage } = await loadDashboard();
  const steps = activationSteps(true, ctx, usage);

  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">Get to live savings</p>
        <h1>Your meter</h1>
        <p>
          Install the SDK and your net savings appear here — measured on your own traffic, never a
          borrowed number.
        </p>
      </div>

      <InstrumentationSpine steps={steps} />

      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <p className="ck-eyebrow">Your savings</p>
            <h2>What you&apos;re keeping — measured on your own traffic</h2>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <VerdictHero usage={usage} />
          <LiveLedgerTiles usage={usage} ab={ab} />
          <div className="cards" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
            <div className="card" style={{ padding: "16px" }}>
              <div className="n" style={{ marginBottom: "10px" }}>savings trend</div>
              <SavingsTrendChart usage={usage} />
            </div>
            <div className="card" style={{ padding: "16px" }}>
              <div className="n" style={{ marginBottom: "10px" }}>traffic</div>
              <TrafficModelMix usage={usage} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

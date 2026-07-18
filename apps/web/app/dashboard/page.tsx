import { redirect } from "next/navigation";

import { BrandMark } from "@/app/components/BrandMark";
import { authConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

import abData from "@/public/data/ab-live.json";
import {
  activationSteps,
  getOrgContext,
  getUsageRollups,
  meteringState,
  type AbArtifact,
} from "./data";
import { AccountPlanStrip } from "./components/AccountPlanStrip";
import { CacheBreakEven } from "./components/CacheBreakEven";
import { ConnectionStatePill } from "./components/ConnectionStatePill";
import { InstallLicensePanel } from "./components/InstallLicensePanel";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { IntegrityQualityChips } from "./components/IntegrityQualityChips";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { NetSavingsCIBand } from "./components/NetSavingsCIBand";
import { ProjectorVerifier } from "./components/ProjectorVerifier";
import { ReferenceLedgerCards } from "./components/ReferenceLedgerCards";
import { ReferenceModeBadge } from "./components/ReferenceModeBadge";
import { ScenarioTable } from "./components/ScenarioTable";
import { SavingsTrendChart } from "./components/SavingsTrendChart";
import { TrafficModelMix } from "./components/TrafficModelMix";
import { VerdictHero } from "./components/VerdictHero";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · BiVelio Savings Layer" };

const ab = abData as unknown as AbArtifact;
const mini = (ab.pricing.table["gpt-4o-mini"] ?? {}) as { inputPer1k?: number; outputPer1k?: number };
const prices = { inPer1k: mini.inputPer1k ?? 0.00015, outPer1k: mini.outputPer1k ?? 0.0006 };

function Header({ metering }: { metering: "awaiting" | "live" }) {
  return (
    <div className="ck-header">
      <div className="brand" style={{ gap: "10px" }}>
        <BrandMark size={26} /> <span className="tag">Savings Layer</span>
      </div>
      <div className="rt">
        <ConnectionStatePill state={metering} />
        <form action="/auth/signout" method="post">
          <button className="btn btn-ghost" type="submit" style={{ padding: "8px 14px" }}>
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  if (!authConfigured) {
    return (
      <main className="dash-shell">
        <div className="wrap cockpit">
          <Header metering="awaiting" />
          <p className="ck-note" style={{ marginTop: "24px" }}>
            Sign-in isn&apos;t wired up yet. Set the Supabase env vars to enable it.
          </p>
        </div>
      </main>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [ctx, usage] = await Promise.all([
    getOrgContext(supabase, user.id),
    getUsageRollups(supabase),
  ]);
  const metering = meteringState(usage);
  const steps = activationSteps(true, ctx, usage);

  return (
    <main className="dash-shell">
      <div className="wrap cockpit">
        <Header metering={metering} />

        {/* 1 · Activation spine */}
        <InstrumentationSpine steps={steps} />

        {/* 2 · YOUR SAVINGS — the customer's own instrument (honest empty today) */}
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

        {/* 3 · Reference bench — the credibility engine (from ab-live.json) */}
        <section className="ck-sec">
          <div className="ck-head">
            <div>
              <p className="ck-eyebrow">Verify, don&apos;t trust · reference bench</p>
              <h2>Proof the optimizer works — measured, both arms</h2>
            </div>
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
        </section>

        {/* 4 · Verify locally */}
        <section className="ck-sec">
          <div className="ck-head">
            <div>
              <p className="ck-eyebrow">Verify locally · nothing leaves this page</p>
              <h2>Model your own payloads with the real tokenizer</h2>
            </div>
          </div>
          <ProjectorVerifier prices={prices} />
        </section>

        {/* 5 · Install & wire */}
        <InstallLicensePanel ab={ab} ctx={ctx} />

        {/* 6 · Account & plan */}
        <section className="ck-sec">
          <div className="ck-head">
            <div>
              <p className="ck-eyebrow">Account</p>
              <h2>Your BiVelio account</h2>
            </div>
          </div>
          <AccountPlanStrip email={user.email ?? "you@bivelio.com"} ctx={ctx} />
        </section>
      </div>
    </main>
  );
}

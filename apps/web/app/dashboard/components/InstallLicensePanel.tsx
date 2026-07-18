import type { AbArtifact, OrgContext } from "../data";
import { CopyButton } from "./CopyButton";
import { TrialKeyButton } from "./TrialKeyButton";

const WRAP = `import { createSavingsLayer } from "@bivelio/savings-layer";

// your app — the data plane. LLM traffic goes straight to your provider.
const layer = createSavingsLayer({ provider: yourProvider });

const { data, report } = await layer.generate({ model, messages, response });
report.cost.netSavings; // → verified savings, per request`;

export function InstallLicensePanel({ ab, ctx }: { ab: AbArtifact; ctx: OrgContext }) {
  return (
    <section className="ck-sec">
      <div className="ck-head">
        <div>
          <p className="ck-eyebrow">Install &amp; wire the SDK</p>
          <h2>Five lines. Your prompts never touch our servers.</h2>
        </div>
      </div>

      <div className="code2" style={{ marginBottom: "12px" }}>
        <span>
          <span className="c"># 1 · install</span>
          {"\n"}pnpm add @bivelio/savings-layer
        </span>
        <CopyButton text="pnpm add @bivelio/savings-layer" />
      </div>
      <div className="code2">
        <span>
          <span className="c"># 2 · wrap your provider · 3 · read the SavingsReport</span>
          {"\n"}{WRAP}
        </span>
        <CopyButton text={WRAP} />
      </div>

      <div className="keycard">
        <div>
          <div className="ck-note" style={{ margin: 0 }}>your license key (SDK auth)</div>
          <div className="k">
            {ctx.serviceAccount ? `${ctx.serviceAccount.keyPrefix}…` : "no SDK key issued yet"}
          </div>
        </div>
        <div className="ck-note" style={{ margin: 0 }}>
          {ctx.serviceAccount
            ? `last seen ${ctx.serviceAccount.lastUsedAt ?? "never"}`
            : "create a key to start reporting"}
          <br />
          <span style={{ opacity: 0.7 }}>only the prefix is stored — the full key is shown once, at creation.</span>
        </div>
      </div>

      <div style={{ marginTop: "12px" }}>
        <TrialKeyButton />
      </div>

      <div className="legend">
        {ab.honesty.slice(0, 5).map((h, i) => (
          <span key={i} className="lg">{h.length > 64 ? h.slice(0, 62) + "…" : h}</span>
        ))}
      </div>
    </section>
  );
}

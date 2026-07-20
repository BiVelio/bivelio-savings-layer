import type { AbArtifact, OrgContext } from "../data";
import { CopyButton } from "./CopyButton";
import { TrialKeyButton } from "./TrialKeyButton";

const WRAP = `import { createSavingsLayer } from "@bivelio/savings-layer";

// your app — the data plane. LLM traffic goes straight to your provider.
const layer = createSavingsLayer({
  provider: yourProvider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,      // the key from step 1
  licenseServerUrl: "https://savings.bivelio.com",  // license check + kill-switch
});

const { data, report } = await layer.generate({ model, messages, response });
report.cost.netSavings; // → verified savings, per request`;

export function InstallLicensePanel({ ab, ctx }: { ab: AbArtifact; ctx: OrgContext }) {
  return (
    <section className="ck-sec">
      <div className="ck-head">
        <div>
          <p className="ck-eyebrow">Get started</p>
          <h2>Three steps. Your prompts never touch our servers.</h2>
        </div>
      </div>

      {/* 1 · license key (the only credential — install is public, gated at runtime) */}
      <p className="ck-note" style={{ marginTop: 0 }}>
        <b>1 · Get your license key</b> — the SDK is public but fail-closed; it only runs with a
        valid key. This key is your one credential (no registry token needed).
      </p>
      <TrialKeyButton />
      <div className="keycard" style={{ marginTop: 10 }}>
        <div>
          <div className="ck-note" style={{ margin: 0 }}>current license key</div>
          <div className="k">{ctx.serviceAccount ? `${ctx.serviceAccount.keyPrefix}…` : "none yet — click above"}</div>
        </div>
        <div className="ck-note" style={{ margin: 0 }}>shown once at creation — only the prefix is stored.</div>
      </div>

      {/* 2 · install (public npm, zero auth) */}
      <p className="ck-note"><b>2 · Install</b> — public on npm, no token, no config.</p>
      <div className="code2">
        <span>pnpm add @bivelio/savings-layer</span>
        <CopyButton text="pnpm add @bivelio/savings-layer" />
      </div>

      {/* 3 · wire + run */}
      <p className="ck-note"><b>3 · Wire your provider &amp; read the SavingsReport</b></p>
      <div className="code2">
        <span>{WRAP}</span>
        <CopyButton text={WRAP} />
      </div>

      <p className="ck-note" style={{ marginTop: 12 }}>
        That&apos;s it. No valid license → <code>generate()</code> refuses. If your plan is cancelled the
        SDK stops within ~15&nbsp;min via <code>licenseServerUrl</code> — no restart, and it never bricks
        your production if we&apos;re unreachable.
      </p>

      <div className="legend">
        {ab.honesty.slice(0, 4).map((h, i) => (
          <span key={i} className="lg">{h.length > 64 ? h.slice(0, 62) + "…" : h}</span>
        ))}
      </div>
    </section>
  );
}

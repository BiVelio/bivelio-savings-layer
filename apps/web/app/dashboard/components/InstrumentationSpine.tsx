import type { StepState } from "../data";
import { CopyButton } from "./CopyButton";

const INSTALL_CMD = "pnpm add @bivelio/savings-layer";

/** The 5-node activation spine — derived, never faked. The current step expands
 *  into a task card; steps beyond it read grey "pending". */
export function InstrumentationSpine({ steps }: { steps: StepState[] }) {
  const current = steps.find((s) => s.status === "current");
  return (
    <section className="ck-sec">
      <div className="ck-head">
        <div>
          <p className="ck-eyebrow">Get to live savings</p>
          <h2>You&apos;re a few steps from your own meter</h2>
        </div>
      </div>
      <div className="spine">
        {steps.map((s, i) => (
          <div key={s.label} className={`spine-node ${s.status}`}>
            <span className="idx">{s.status === "done" ? "✓" : i + 1}</span>
            <div className="lbl">{s.label}</div>
            <div className="st">
              {s.status === "done" ? "done" : s.status === "current" ? "next" : "pending"}
            </div>
          </div>
        ))}
      </div>
      {current ? (
        <div className="spine-task">
          <p className="t">Next: {current.label}</p>
          {current.label === "SDK installed" ? (
            <div className="code2">
              <span>
                <span className="c"># drop it in front of your provider — your prompts never leave your infra</span>
                {"\n"}
                {INSTALL_CMD}
              </span>
              <CopyButton text={INSTALL_CMD} />
            </div>
          ) : (
            <p className="ck-note" style={{ margin: 0 }}>
              {current.label === "License active"
                ? "Paste your BiVelio license key so the SDK unlocks the managed features and reports usage."
                : current.label === "First report"
                  ? "Wrap a real provider call — the first SavingsReport lands here and your meter goes live."
                  : "This unlocks the moment your first usage_daily row lands."}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

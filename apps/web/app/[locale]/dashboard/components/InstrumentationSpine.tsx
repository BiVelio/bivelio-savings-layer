import { getTranslations } from "next-intl/server";

import type { StepState } from "../data";
import { CopyButton } from "./CopyButton";

const INSTALL_CMD = "pnpm add @bivelio/savings-layer";

/** The 5-node activation spine — derived, never faked. The current step expands
 *  into a task card; steps beyond it read grey "pending". */
export async function InstrumentationSpine({ steps }: { steps: StepState[] }) {
  const t = await getTranslations("dashboard");
  const current = steps.find((s) => s.status === "current");
  return (
    <section className="ck-sec">
      <div className="ck-head">
        <div>
          <p className="ck-eyebrow">{t("instrumentationSpine.eyebrow")}</p>
          <h2>{t("instrumentationSpine.title")}</h2>
        </div>
      </div>
      <div className="spine">
        {steps.map((s, i) => (
          <div key={s.label} className={`spine-node ${s.status}`}>
            <span className="idx">{s.status === "done" ? "✓" : i + 1}</span>
            <div className="lbl">{s.label}</div>
            <div className="st">
              {s.status === "done"
                ? t("instrumentationSpine.statusDone")
                : s.status === "current"
                  ? t("instrumentationSpine.statusNext")
                  : t("instrumentationSpine.statusPending")}
            </div>
          </div>
        ))}
      </div>
      {current ? (
        <div className="spine-task">
          <p className="t">{t("instrumentationSpine.nextLabel", { label: current.label })}</p>
          {current.label === "SDK installed" ? (
            <div className="code2">
              <span>
                <span className="c">{t("instrumentationSpine.installComment")}</span>
                {"\n"}
                {INSTALL_CMD}
              </span>
              <CopyButton text={INSTALL_CMD} />
            </div>
          ) : (
            <p className="ck-note" style={{ margin: 0 }}>
              {current.label === "License active"
                ? t("instrumentationSpine.hintLicense")
                : current.label === "First report"
                  ? t("instrumentationSpine.hintFirstReport")
                  : t("instrumentationSpine.hintDefault")}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

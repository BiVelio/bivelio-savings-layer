import { getTranslations } from "next-intl/server";

import type { OrgContext } from "../data";

/** Real account/plan — reads organizations.plan (best-effort), never hardcoded.
 *  Degrades honestly when the schema can't resolve org/seats. */
export async function AccountPlanStrip({ email, ctx }: { email: string; ctx: OrgContext }) {
  const t = await getTranslations("dashboard");
  const plan = ctx.org?.plan;
  const isActive = plan === "pro" || plan === "enterprise";
  const planLabel = isActive ? plan.charAt(0).toUpperCase() + plan.slice(1) : t("accountPlanStrip.noActivePlan");
  return (
    <div className="cards" style={{ gridTemplateColumns: "1.4fr 1fr", marginTop: "6px" }}>
      <div className="card">
        <div className="n">{t("accountPlanStrip.signedInAs")}</div>
        <h3 style={{ wordBreak: "break-all" }}>{email}</h3>
        <p>
          {ctx.org ? (
            <>
              {t.rich("accountPlanStrip.organization", {
                b: (chunks) => <b style={{ color: "var(--ink)" }}>{chunks}</b>,
                name: ctx.org.name,
              })}
              {ctx.role ? ` · ${ctx.role}` : ""}
            </>
          ) : (
            <>{t("accountPlanStrip.personalNote")}</>
          )}
        </p>
      </div>
      <div className="card">
        <div className="n">{t("accountPlanStrip.plan")}</div>
        <h3>{planLabel}</h3>
        <p>
          {isActive && ctx.seats != null ? <>{t("accountPlanStrip.seatsCount", { count: ctx.seats })} </> : null}
          {t("accountPlanStrip.planBody", { monthly: "$4", yearly: "$39" })}{" "}
          <a href="/#pricing">{isActive ? t("accountPlanStrip.managePlan") : t("accountPlanStrip.subscribe")}</a>
        </p>
      </div>
    </div>
  );
}

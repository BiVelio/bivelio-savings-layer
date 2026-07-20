import type { OrgContext } from "../data";

/** Real account/plan — reads organizations.plan (best-effort), never hardcoded.
 *  Degrades honestly when the schema can't resolve org/seats. */
export function AccountPlanStrip({ email, ctx }: { email: string; ctx: OrgContext }) {
  const plan = ctx.org?.plan;
  const isActive = plan === "pro" || plan === "enterprise";
  const planLabel = isActive ? plan.charAt(0).toUpperCase() + plan.slice(1) : "No active plan";
  return (
    <div className="cards" style={{ gridTemplateColumns: "1.4fr 1fr", marginTop: "6px" }}>
      <div className="card">
        <div className="n">signed in as</div>
        <h3 style={{ wordBreak: "break-all" }}>{email}</h3>
        <p>
          {ctx.org ? (
            <>Organization: <b style={{ color: "var(--ink)" }}>{ctx.org.name}</b>{ctx.role ? ` · ${ctx.role}` : ""}</>
          ) : (
            <>Personal — no organization linked yet. One BiVelio account, shared across the suite.</>
          )}
        </p>
      </div>
      <div className="card">
        <div className="n">plan</div>
        <h3>{planLabel}</h3>
        <p>
          {isActive && ctx.seats != null ? <>{ctx.seats} seat(s). </> : null}
          BV-SALA is fail-closed — it only runs with an active PRO license.
          {" "}$4 / seat / month or $39 / seat / year. A seat is one active machine or service
          identity, not a person.{" "}
          <a href="/#pricing">{isActive ? "Manage plan →" : "Subscribe →"}</a>
        </p>
      </div>
    </div>
  );
}

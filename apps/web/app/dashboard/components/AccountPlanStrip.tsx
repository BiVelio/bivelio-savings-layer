import type { OrgContext } from "../data";

/** Real account/plan — reads organizations.plan (best-effort), never hardcoded.
 *  Degrades honestly when the schema can't resolve org/seats. */
export function AccountPlanStrip({ email, ctx }: { email: string; ctx: OrgContext }) {
  const plan = ctx.org?.plan ?? "free";
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
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
        <h3>
          {planLabel}
          {!ctx.org ? <span className="est-tag" style={{ marginLeft: "8px" }}>best-effort</span> : null}
        </h3>
        <p>
          {ctx.seats != null ? <>{ctx.seats} seat(s). </> : null}
          Local optimizations are free forever. Upgrade to Pro for the managed brain &amp; savings dashboards.{" "}
          <a href="#">Manage / Upgrade →</a>
        </p>
      </div>
    </div>
  );
}

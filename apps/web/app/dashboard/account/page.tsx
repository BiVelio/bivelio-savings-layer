import { loadDashboard } from "../load";
import { AccountPlanStrip } from "../components/AccountPlanStrip";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account · BiVelio Savings Layer" };

export default async function AccountPage() {
  const { user, ctx } = await loadDashboard();
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">Account</p>
        <h1>Your BiVelio account</h1>
        <p>One account across the BiVelio suite.</p>
      </div>
      <AccountPlanStrip email={user?.email ?? "you@bivelio.com"} ctx={ctx} />
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";

import { BrandMark } from "@/app/components/BrandMark";
import { authConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard · BiVelio Savings Layer" };

export default async function DashboardPage() {
  if (!authConfigured) {
    return (
      <main className="dash-shell">
        <div className="wrap">
          <div className="brand" style={{ marginBottom: "26px", gap: "10px" }}>
            <BrandMark size={26} /> <span className="tag">Savings Layer</span>
          </div>
          <h1>Dashboard</h1>
          <p style={{ color: "var(--muted)" }}>
            Sign-in isn&apos;t wired up yet. Set the Supabase env vars (see{" "}
            <code>apps/web/.env.local.example</code>) to enable it — savings binds to the shared
            BiVelio identity at <code>auth.bivelio.com</code>.
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

  return (
    <main className="dash-shell">
      <div className="wrap">
        <div className="brand" style={{ marginBottom: "28px", gap: "10px" }}>
          <BrandMark size={26} /> <span className="tag">Savings Layer</span>
        </div>
        <p className="eyebrow">Your account</p>
        <h1 style={{ fontSize: "clamp(24px,4vw,34px)", margin: "0 0 24px" }}>Welcome</h1>

        <div className="cards">
          <div className="card">
            <div className="n">signed in as</div>
            <h3 style={{ wordBreak: "break-all" }}>{user.email}</h3>
            <p>One BiVelio account, shared across the suite.</p>
          </div>
          <div className="card">
            <div className="n">plan</div>
            <h3>Free</h3>
            <p>Local optimizations are free forever. Upgrade to Pro for the managed brain &amp; savings dashboards.</p>
          </div>
        </div>

        <p style={{ color: "var(--muted)", fontSize: ".88rem", marginTop: "24px" }}>
          Your measured savings appear here once you install the SDK and it reports usage.{" "}
          <Link href="/#measured">See the measured A/B results →</Link>
        </p>

        <form action="/auth/signout" method="post" style={{ marginTop: "24px" }}>
          <button className="btn btn-ghost" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}

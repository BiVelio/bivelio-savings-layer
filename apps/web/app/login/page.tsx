import Link from "next/link";

import AuthForm from "@/app/components/AuthForm";
import { BrandMark } from "@/app/components/BrandMark";

export const metadata = { title: "Sign in · BiVelio Savings Layer" };

export default function LoginPage() {
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: "22px", gap: "10px" }}>
          <BrandMark size={24} /> <span className="tag">Savings Layer</span>
        </div>
        <h1>Welcome back</h1>
        <p className="sub">Sign in with your BiVelio account — the same one you use across the suite.</p>
        <AuthForm mode="login" />
        <p className="auth-alt">
          New to BiVelio? <Link href="/signup">Create an account</Link>
        </p>
        <p className="auth-alt" style={{ marginTop: "10px" }}>
          <Link href="/">← Back to the verifier</Link>
        </p>
      </div>
    </main>
  );
}

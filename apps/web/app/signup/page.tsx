import Link from "next/link";

import AuthForm from "@/app/components/AuthForm";
import { BrandMark } from "@/app/components/BrandMark";

export const metadata = { title: "Create your account · BiVelio Savings Layer" };

export default function SignupPage() {
  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ marginBottom: "22px", gap: "10px" }}>
          <BrandMark size={24} /> <span className="tag">Savings Layer</span>
        </div>
        <h1>Create your account</h1>
        <p className="sub">One BiVelio account across the suite. Verify your savings free in the browser — create an account to subscribe and get your license key.</p>
        <AuthForm mode="signup" />
        <p className="auth-alt">
          Already have a BiVelio account? <Link href="/login">Sign in</Link>
        </p>
        <p className="auth-alt" style={{ marginTop: "10px" }}>
          <Link href="/">← Back to the verifier</Link>
        </p>
      </div>
    </main>
  );
}

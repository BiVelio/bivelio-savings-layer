"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";

type Msg = { type: "error" | "info" | "idle"; text: string };

export default function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<Msg>({ type: "idle", text: "" });
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!authConfigured) {
      setMsg({ type: "error", text: "Sign-in isn't wired up yet — set NEXT_PUBLIC_SUPABASE_ANON_KEY in the deploy." });
      return;
    }
    setLoading(true);
    setMsg({ type: "idle", text: "" });
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
        });
        if (error) throw error;
        setMsg({ type: "info", text: "Check your email to confirm your account, then sign in." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : "Something went wrong." });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {msg.type !== "idle" ? <div className={`auth-msg ${msg.type}`}>{msg.text}</div> : null}
      <div className="field">
        <label htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
        />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
      </div>
      <button className="btn btn-primary auth-submit" type="submit" disabled={loading}>
        {loading ? "…" : mode === "signup" ? "Create account →" : "Sign in →"}
      </button>
    </form>
  );
}

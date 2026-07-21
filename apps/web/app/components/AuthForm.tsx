"use client";

import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";

type Msg = { type: "error" | "info" | "idle"; text: string };

export default function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<Msg>({ type: "idle", text: "" });
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!authConfigured) {
      setMsg({ type: "error", text: t("notWired") });
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
        setMsg({ type: "info", text: t("checkEmail") });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setMsg({ type: "error", text: err instanceof Error ? err.message : t("somethingWrong") });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {msg.type !== "idle" ? <div className={`auth-msg ${msg.type}`}>{msg.text}</div> : null}
      <div className="field">
        <label htmlFor="email">{t("workEmail")}</label>
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
        <label htmlFor="password">{t("password")}</label>
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
        {loading ? t("loadingEllipsis") : mode === "signup" ? t("createAccountCta") : t("signInCta")}
      </button>
    </form>
  );
}

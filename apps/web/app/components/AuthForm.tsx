"use client";

import { useTranslations, useLocale } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";

type Msg = { type: "error" | "info" | "idle"; text: string };

export default function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const t = useTranslations("auth");
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<Msg>({ type: "idle", text: "" });
  const [loading, setLoading] = useState(false);
  // Sub-vista de recuperación: solo aparece en login. Pide el email y manda el
  // enlace de reset. El cambio de contraseña se hace en /reset-password, adonde
  // lleva ese enlace tras pasar por /auth/callback.
  const [view, setView] = useState<"form" | "reset">("form");

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
      if (view === "reset") {
        // El enlace del email vuelve a /auth/callback, que crea la sesión de
        // recuperación y redirige a la página de nueva contraseña (con locale).
        const next = encodeURIComponent(`/${locale}/reset-password`);
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=${next}`,
        });
        if (error) throw error;
        setMsg({ type: "info", text: t("resetEmailSent") });
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          // `?next=` con el `?` inicial: cuando `confirm-signup.html` migre a
          // `{{ .RedirectTo }}&token_hash=...` (Parte B, paso 3), este `redirectTo` es el
          // que usará el enlace del correo; sin el `?` saldría malformado. INERTE hasta ese
          // flip (hoy la plantilla usa `{{ .SiteURL }}` e ignora este valor).
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(
              `/${locale}/dashboard`,
            )}`,
          },
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

  const enReset = view === "reset";

  return (
    <form onSubmit={onSubmit} noValidate>
      {msg.type !== "idle" ? <div className={`auth-msg ${msg.type}`}>{msg.text}</div> : null}
      {enReset ? <p className="sub" style={{ marginTop: 0 }}>{t("resetSubtitle")}</p> : null}
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
      {!enReset ? (
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
      ) : null}
      <button className="btn btn-primary auth-submit" type="submit" disabled={loading}>
        {loading
          ? t("loadingEllipsis")
          : enReset
            ? t("sendResetLink")
            : mode === "signup"
              ? t("createAccountCta")
              : t("signInCta")}
      </button>
      {mode === "login" ? (
        <p className="auth-alt" style={{ marginTop: "12px", textAlign: "center" }}>
          <button
            type="button"
            className="auth-link"
            onClick={() => {
              setMsg({ type: "idle", text: "" });
              setView(enReset ? "form" : "reset");
            }}
          >
            {enReset ? t("backToLogin") : t("forgotPassword")}
          </button>
        </p>
      ) : null}
    </form>
  );
}

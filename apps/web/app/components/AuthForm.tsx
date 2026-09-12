"use client";

import { useTranslations, useLocale } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";
import { safeNextPath } from "@/app/auth/safe-next";
import { textoDeErrorDeAuth } from "@/lib/auth/error-de-auth";

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

  /**
   * ADÓNDE VOLVER DESPUÉS DE ENTRAR. Lo trae `?next=` y lo pone, por ahora, el
   * enlace de una invitación: quien la recibe sin sesión iniciada tenía que
   * firmar y luego VOLVER AL CORREO a buscar el enlace otra vez, que es el tipo
   * de paso manual que sobra en un producto que se vende solo.
   *
   * SE LEE AL ENVIAR, no con `useSearchParams()`. Ese hook obliga a envolver el
   * formulario en un `<Suspense>` y saca de la generación estática a `/login` y
   * `/signup` — el build lo rechaza de plano. Aquí el dato solo hace falta cuando
   * alguien pulsa el botón, y en ese momento el cliente ya existe.
   *
   * Pasa por `safeNextPath`, el mismo guardián que ya usan /auth/callback y
   * /auth/refresh: un `next` sin validar es una redirección abierta (CWE-601), y
   * llega directamente de una URL que fabrica cualquiera.
   */
  function destinoPedido(): string | null {
    if (typeof window === "undefined") return null;
    const pedido = new URLSearchParams(window.location.search).get("next");
    return pedido ? safeNextPath(pedido) : null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const destino = destinoPedido();
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
        // El `?next=` NO es cosmético: la plantilla de correo compartida de la
        // suite construye el enlace desde `{{ .RedirectTo }}` + `&token_hash=…`,
        // así que un redirectTo SIN query string produce una URL malformada. Y
        // además conserva el idioma, igual que ya hace la rama de recuperación.
        const nextSignup = encodeURIComponent(destino ?? `/${locale}/dashboard`);
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${nextSignup}`,
          },
        });
        if (error) throw error;
        setMsg({ type: "info", text: t("checkEmail") });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (destino) {
          // Navegación DURA a propósito. El `destino` ya viene con su prefijo de
          // idioma (`/es/invitacion/…`), y el router de next-intl le añadiría
          // otro: `/es/es/invitacion/…`. Una recarga completa tras iniciar sesión
          // no cuesta nada y no tiene ese modo de fallo.
          window.location.assign(destino);
          return;
        }
        router.push("/dashboard");
        router.refresh();
      }
    } catch (err) {
      setMsg({ type: "error", text: textoDeErrorDeAuth(err, t) });
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

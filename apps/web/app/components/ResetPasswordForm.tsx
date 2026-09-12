"use client";

import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";
import { textoDeErrorDeAuth } from "@/lib/auth/error-de-auth";

type Msg = { type: "error" | "info" | "idle"; text: string };

/**
 * Fija una nueva contraseña. Se llega aquí desde el enlace del email de
 * recuperación, que ya ha creado una sesión de recuperación en /auth/callback,
 * así que `updateUser` actúa sobre el usuario correcto sin pedir la anterior.
 */
export default function ResetPasswordForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<Msg>({ type: "idle", text: "" });
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!authConfigured) {
      setMsg({ type: "error", text: t("notWired") });
      return;
    }
    if (password !== confirm) {
      setMsg({ type: "error", text: t("passwordsDontMatch") });
      return;
    }
    setLoading(true);
    setMsg({ type: "idle", text: "" });
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    try {
      // Sin sesión de recuperación (enlace caducado o abierto directo), esto falla
      // con un mensaje claro en vez de cambiar la contraseña de nadie.
      const { data: sesion } = await supabase.auth.getSession();
      if (!sesion.session) {
        setMsg({ type: "error", text: t("resetLinkExpired") });
        setLoading(false);
        return;
      }
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      setMsg({ type: "info", text: t("passwordUpdated") });
      setTimeout(() => {
        router.push("/dashboard");
        router.refresh();
      }, 1200);
    } catch (err) {
      setMsg({ type: "error", text: textoDeErrorDeAuth(err, t) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {msg.type !== "idle" ? <div className={`auth-msg ${msg.type}`}>{msg.text}</div> : null}
      <div className="field">
        <label htmlFor="password">{t("newPassword")}</label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          disabled={done}
        />
      </div>
      <div className="field">
        <label htmlFor="confirm">{t("confirmPassword")}</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          disabled={done}
        />
      </div>
      <button className="btn btn-primary auth-submit" type="submit" disabled={loading || done}>
        {loading ? t("loadingEllipsis") : t("updatePassword")}
      </button>
    </form>
  );
}

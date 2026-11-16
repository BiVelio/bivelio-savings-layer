"use client";

import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";
import { textoDeErrorDeAuth } from "@/lib/auth/error-de-auth";

import { Button } from "@/vendor/affectui/button-clean";

import { AccesoEnviado, MensajeDeAcceso } from "./acceso/AccesoEstado";
import { CampoClave } from "./acceso/CampoClave";
import { EnlaceConDestino } from "./acceso/EnlaceConDestino";

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

  // Hecho: el formulario ya no sirve (los campos quedaban desactivados a la
  // vista). Se dice que está cambiada y que se está entrando, y nada más.
  if (done) {
    return <AccesoEnviado icono="hecho" tono="ok" titulo={msg.text} />;
  }

  const conError = msg.type === "error";
  // Los dos errores propios de esta pantalla, deducidos del texto que dejó
  // `onSubmit`: el enlace que ya no vale (se ofrece pedir otro) y las dos
  // contraseñas que no casan (se marca el campo de confirmación).
  const caducado = conError && msg.text === t("resetLinkExpired");
  const distintas = conError && msg.text === t("passwordsDontMatch");

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={loading || undefined}>
      {msg.type !== "idle" ? (
        <MensajeDeAcceso tipo={msg.type} id="reset-aviso">
          {msg.text}
        </MensajeDeAcceso>
      ) : null}
      {caducado ? (
        <EnlaceConDestino a="/login" className="btn btn-ghost btn-block acc-otro-enlace">
          {t("requestNewLink")}
        </EnlaceConDestino>
      ) : null}
      <CampoClave
        id="password"
        etiqueta={t("newPassword")}
        valor={password}
        alCambiar={setPassword}
        autoComplete="new-password"
        placeholder="••••••••"
        desactivado={done}
        invalido={conError && !distintas && !caducado}
        descritoPor={conError ? "reset-aviso" : undefined}
        mostrar={t("showPassword")}
        ocultar={t("hidePassword")}
      />
      <CampoClave
        id="confirm"
        etiqueta={t("confirmPassword")}
        valor={confirm}
        alCambiar={setConfirm}
        autoComplete="new-password"
        placeholder="••••••••"
        desactivado={done}
        invalido={distintas}
        descritoPor={distintas ? "reset-aviso" : undefined}
        mostrar={t("showPassword")}
        ocultar={t("hidePassword")}
      />
      <Button className="acc-enviar" type="submit" variant="primary" size="xl" block loading={loading} disabled={done}>
        {loading ? t("working") : t("updatePassword")}
      </Button>
    </form>
  );
}

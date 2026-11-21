"use client";

import { useTranslations, useLocale } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { useState } from "react";

import { authConfigured } from "@/lib/supabase/env";
import { corporateUrl } from "@/lib/corporate";
import { safeNextPath } from "@/app/auth/safe-next";
import { textoDeErrorDeAuth } from "@/lib/auth/error-de-auth";
import { LICENSE_CLOUD_URL } from "@/app/components/LegalGoverns";

import { Button } from "@/vendor/affectui/button-clean";
import { TextField } from "@/vendor/affectui/text-field-clean";

import { AccesoEnviado, MensajeDeAcceso } from "./acceso/AccesoEstado";
import { CampoClave } from "./acceso/CampoClave";
import { EnlaceConDestino } from "./acceso/EnlaceConDestino";
import { Icono } from "./acceso/iconos";

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
    // El formulario lleva `noValidate`, así que `required` no para nada: sin esto
    // un envío vacío llegaba a Supabase como alta anónima y volvía en inglés.
    if (!email.trim() || (view !== "reset" && !password)) {
      setMsg({ type: "error", text: t(view === "reset" ? "errors.emailInvalid" : "errors.missingFields") });
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
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback?next=${nextSignup}`,
          },
        });
        if (error) throw error;
        // CUENTA EXISTENTE: Supabase no crea nada y NO envía el correo de
        // confirmación — `identities` llega vacío. Decirle «revisa tu correo» a
        // quien olvidó su cuenta es engañoso (dueño, 2026-11-16): se le dice la
        // verdad Y se le manda un enlace de acceso (magic link) para que entre
        // sin recordar la contraseña. Sin creación de cuenta (`shouldCreateUser:
        // false`), así un tercero no fabrica cuentas ajenas ni saca más
        // información de la que ya tenía: solo el dueño real recibe el enlace.
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          const { error: otpError } = await supabase.auth.signInWithOtp({
            email,
            options: {
              shouldCreateUser: false,
              emailRedirectTo: `${window.location.origin}/auth/callback?next=${nextSignup}`,
            },
          });
          if (otpError) throw otpError;
          setMsg({ type: "info", text: t("existingAccountLoginLink") });
        } else {
          setMsg({ type: "info", text: t("checkEmail") });
        }
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

  // QUÉ SE ENVIÓ. Los tres avisos de éxito —alta pendiente de confirmar, cuenta
  // que ya existía (#569) y enlace de recuperación— dejan de ser una franja
  // sobre un formulario que ya no sirve y pasan a ser una subvista propia. Se
  // deduce del texto que `onSubmit` ya dejó en `msg` (los tres salen de `t`),
  // para no tocar ni una línea del envío.
  const enviado =
    msg.type !== "info"
      ? null
      : msg.text === t("existingAccountLoginLink")
        ? "existente"
        : msg.text === t("checkEmail")
          ? "nueva"
          : msg.text === t("resetEmailSent")
            ? "recuperacion"
            : null;

  if (enviado) {
    return (
      <AccesoEnviado
        icono="correo"
        titulo={
          enviado === "existente"
            ? t("sentTitleExisting")
            : enviado === "nueva"
              ? t("sentTitleNew")
              : t("sentTitleReset")
        }
        correo={email}
        etiquetaCorreo={t("sentEmailLabel")}
        acciones={
          <>
            {enviado === "existente" ? (
              <EnlaceConDestino a="/login" className="btn btn-ghost btn-block">
                {t("signIn")}
              </EnlaceConDestino>
            ) : null}
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                setMsg({ type: "idle", text: "" });
                if (enviado === "recuperacion") setView("form");
              }}
            >
              {enviado === "recuperacion" ? t("backToLogin") : t("useAnotherEmail")}
            </button>
          </>
        }
      >
        {msg.text}
      </AccesoEnviado>
    );
  }

  const conError = msg.type === "error";

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={loading || undefined}>
      {msg.type !== "idle" ? (
        <MensajeDeAcceso tipo={msg.type} id="auth-aviso">
          {msg.text}
        </MensajeDeAcceso>
      ) : null}
      {enReset ? <p className="sub acc-reset-sub">{t("resetSubtitle")}</p> : null}
      <TextField
        className="acc-campo"
        id="email"
        label={t("workEmail")}
        type="email"
        icon={<Icono nombre="correo" />}
        autoComplete="email"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("emailPlaceholder")}
        invalid={conError}
        aria-describedby={conError ? "auth-aviso" : undefined}
      />
      {!enReset ? (
        <CampoClave
          id="password"
          etiqueta={t("password")}
          valor={password}
          alCambiar={setPassword}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder="••••••••"
          invalido={conError}
          descritoPor={conError ? "auth-aviso" : undefined}
          mostrar={t("showPassword")}
          ocultar={t("hidePassword")}
        />
      ) : null}
      {/* El Button de affectUI: mientras se espera al servidor no admite otro
          envío (`aria-disabled` + clic anulado) y una banda de luz recorre el
          rótulo. Es el único movimiento de la pantalla, y solo en ese rato. */}
      <Button className="acc-enviar" type="submit" variant="primary" size="xl" block loading={loading}>
        {loading ? t("working") : enReset ? t("sendResetLink") : mode === "signup" ? t("createAccountCta") : t("signInCta")}
      </Button>
      {/* Bajo el botón de alta, qué se acepta al crear la cuenta: las
          condiciones de la nube (LICENSE-CLOUD.md) y la política de privacidad
          de BiVelio, que es la que cubre el correo y la organización
          (`privacyPage.account`). Mismo estilo que «¿Has olvidado la
          contraseña?» en el login: no cambia el diseño de la tarjeta. */}
      {mode === "signup" ? (
        <p className="auth-alt acc-olvido">
          {t.rich("signupLegal", {
            terms: (c) => (
              <a href={LICENSE_CLOUD_URL} target="_blank" rel="noopener noreferrer">
                {c}
              </a>
            ),
            privacy: (c) => (
              <a href={corporateUrl("/privacy", locale)} target="_blank" rel="noopener noreferrer">
                {c}
              </a>
            ),
          })}
        </p>
      ) : null}
      {mode === "login" ? (
        <p className="auth-alt acc-olvido">
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

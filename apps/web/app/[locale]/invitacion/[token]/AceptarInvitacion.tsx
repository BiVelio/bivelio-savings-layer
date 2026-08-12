"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

type Estado = "comprobando" | "sin_sesion" | "listo" | "aceptando" | "exito" | "error";

/**
 * ACEPTAR LA INVITACIÓN.
 *
 * El token llega en la RUTA (no en la query: las query strings acaban en los
 * registros de los proxies y en el `Referer` de la siguiente navegación) y no se
 * pinta nunca en pantalla.
 *
 * Se intenta aceptar SOLO. Si hace falta iniciar sesión, el enlace de login lleva
 * un `?next=` de vuelta a esta misma página, así que al volver se acepta sin que
 * nadie tenga que buscar el correo otra vez.
 */
export function AceptarInvitacion({ token }: { token: string }) {
  const t = useTranslations("invitacion");
  const locale = useLocale();
  const [estado, setEstado] = useState<Estado>("comprobando");
  const [motivo, setMotivo] = useState<string>("");

  const aceptar = useCallback(async () => {
    setEstado("aceptando");
    try {
      const res = await fetch("/api/org/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: string };
      if (res.ok) {
        setEstado("exito");
        return;
      }
      if (res.status === 401) {
        setEstado("sin_sesion");
        return;
      }
      setMotivo(json.code ?? "invalida");
      setEstado("error");
    } catch {
      setMotivo("invalida");
      setEstado("error");
    }
  }, [token]);

  // Se intenta nada más llegar: si ya hay sesión con el correo correcto, aceptar
  // no requiere ni un clic. Es una acción con consentimiento previo — el enlace
  // solo llega por correo y solo funciona para su destinatario.
  useEffect(() => {
    void aceptar();
  }, [aceptar]);

  const textoError =
    motivo === "caducada" ? t("caducada")
    : motivo === "ya_aceptada" ? t("yaAceptada")
    : motivo === "otro_correo" ? t("otroCorreo")
    : motivo === "ya_en_otra" ? t("yaEnOtra")
    : t("invalida");

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>{t("title")}</h1>

        {estado === "comprobando" || estado === "aceptando" ? (
          <p className="sub">{estado === "aceptando" ? t("aceptando") : t("comprobando")}</p>
        ) : null}

        {estado === "sin_sesion" ? (
          <>
            <p className="sub">{t("entrar")}</p>
            {/* La vuelta a ESTA página, con el token. `safeNextPath` la valida al
                otro lado; aquí se construye entera nuestra, sin nada de fuera
                salvo el token, que va escapado. */}
            <a
              className="ck-btn"
              href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/invitacion/${encodeURIComponent(token)}`)}`}
            >
              {t("iniciarSesion")}
            </a>
          </>
        ) : null}

        {estado === "exito" ? (
          <>
            <p className="sub">{t("exito")}</p>
            <a className="ck-btn" href={`/${locale}/dashboard`}>
              {t("irAlPanel")}
            </a>
          </>
        ) : null}

        {estado === "error" ? (
          <>
            <div className="auth-msg error">{textoError}</div>
            {/* Con «esta invitación es de otro correo» la salida real es cambiar
                de cuenta, así que se ofrece ir al login en vez de dejar un
                callejón sin salida. */}
            {motivo === "otro_correo" || motivo === "ya_en_otra" ? (
              <p className="auth-alt" style={{ marginTop: "12px" }}>
                <a href={`/${locale}/login`}>{t("iniciarSesion")}</a>
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </main>
  );
}

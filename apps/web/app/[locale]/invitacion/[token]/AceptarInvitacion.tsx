"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

type Estado =
  | "comprobando"
  /** Sin sesión y sin cuenta conocida: se le ofrece crear la contraseña. */
  | "registrarse"
  | "creando"
  | "aceptando"
  | "exito"
  | "error";

interface Vista {
  email: string;
  org: string;
  role: string;
}

/**
 * ACEPTAR UNA INVITACIÓN — incluido el caso de quien NO tiene cuenta.
 *
 * EL AGUJERO QUE ESTO CIERRA. A quien se invita normalmente no es cliente de
 * BiVelio: es un compañero de la empresa que sí lo es. La primera versión le
 * mandaba a iniciar sesión, y ahí se acababa el camino — no tiene contraseña, y
 * «he olvidado mi contraseña» no le encuentra porque su dirección no está en la
 * base. El correo llegaba, se veía bien, y la invitación no se podía aceptar.
 *
 * Ahora, si no hay sesión, la pantalla le pide crear su contraseña (dos veces) y
 * la cuenta nace ya con el correo verificado: la posesión del enlace, que se le
 * mandó a esa dirección exacta, es la misma prueba que usa cualquier correo de
 * confirmación. Pedirle después que confirme un correo que acaba de demostrar que
 * controla sería un paso de más que solo sirve para perder gente.
 *
 * El token va en la RUTA y no se pinta nunca en pantalla.
 */
export function AceptarInvitacion({ token }: { token: string }) {
  const t = useTranslations("invitacion");
  const locale = useLocale();
  const [estado, setEstado] = useState<Estado>("comprobando");
  const [motivo, setMotivo] = useState<string>("");
  const [vista, setVista] = useState<Vista | null>(null);

  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [errorForm, setErrorForm] = useState("");
  /** Con qué cuenta está mirando quien abre el enlace. Lo devuelve `accept`
   *  cuando el motivo es `otro_correo`, y es SU propio correo. */
  const [sesion, setSesion] = useState<string | null>(null);
  const [cerrando, setCerrando] = useState(false);

  /** Intenta aceptar con la sesión que haya. Si no hay, se ofrece registrarse. */
  const intentarAceptar = useCallback(async () => {
    setEstado("aceptando");
    try {
      const res = await fetch("/api/org/invitations/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const json = (await res.json().catch(() => ({}))) as { code?: string; sesion?: string | null };
      if (res.ok) return setEstado("exito");
      if (res.status === 401) return setEstado("registrarse");
      if (json.sesion) setSesion(json.sesion);
      setMotivo(json.code ?? "invalida");
      setEstado("error");
    } catch {
      setMotivo("invalida");
      setEstado("error");
    }
  }, [token]);

  // Al llegar se pide primero QUÉ dice la invitación, para poder enseñar a qué
  // organización y con qué perfil. Un enlace de un remitente desconocido que pide
  // una contraseña sin contar a qué tiene exactamente la forma de un phishing.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/org/invitations/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const json = (await res.json().catch(() => ({}))) as Vista & { code?: string };
        if (!res.ok) {
          setMotivo(json.code ?? "invalida");
          setEstado("error");
          return;
        }
        setVista({ email: json.email, org: json.org, role: json.role });
        await intentarAceptar();
      } catch {
        setMotivo("invalida");
        setEstado("error");
      }
    })();
  }, [token, intentarAceptar]);

  async function crearCuenta(e: React.FormEvent) {
    e.preventDefault();
    setErrorForm("");
    if (pass1.length < 8) return setErrorForm(t("passCorta"));
    if (pass1 !== pass2) return setErrorForm(t("passDistintas"));

    setEstado("creando");
    try {
      const res = await fetch("/api/org/invitations/registrar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: pass1 }),
      });
      const json = (await res.json().catch(() => ({}))) as { email?: string; code?: string };

      if (!res.ok) {
        setEstado("registrarse");
        // «Ya tienes cuenta» no es un error del que entra: es alguien registrado
        // que tiene que usar su contraseña. Se le manda al login CON la vuelta
        // puesta, para que no tenga que buscar el correo otra vez.
        setErrorForm(json.code === "ya_registrado" ? t("yaRegistrado") : t("errorCrear"));
        return;
      }

      // La sesión se crea AQUÍ, en el cliente: es lo que deja la cookie bien
      // puesta. El servidor solo ha creado la cuenta.
      const { createClient } = await import("@/lib/supabase/client");
      const { error } = await createClient().auth.signInWithPassword({
        email: json.email!,
        password: pass1,
      });
      if (error) {
        // La cuenta existe y está dentro de la organización; solo ha fallado el
        // último paso. Que entre por la puerta normal en vez de dejarle colgado.
        setEstado("registrarse");
        setErrorForm(t("creadaEntraTu"));
        return;
      }
      setEstado("exito");
    } catch {
      setEstado("registrarse");
      setErrorForm(t("errorCrear"));
    }
  }

  const textoError =
    motivo === "caducada" ? t("caducada")
    : motivo === "ya_aceptada" ? t("yaAceptada")
    : motivo === "otro_correo" ? t("otroCorreo")
    : motivo === "ya_en_otra" ? t("yaEnOtra")
    : t("invalida");

  /**
   * CERRAR SESIÓN Y VOLVER AQUÍ.
   *
   * NO se cierra sola. Quien abre el enlace reenviado de un compañero en el
   * navegador donde tiene su propia sesión —el caso normal, no el raro— se
   * encontraría echado de su cuenta sin haberlo pedido. La decisión es suya; lo
   * que faltaba era el botón y saber con qué cuenta estaba.
   */
  async function cerrarSesion() {
    setCerrando(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      await createClient().auth.signOut();
    } catch {
      /* aunque falle, se recarga: la pantalla vuelve a decidir con lo que haya */
    }
    window.location.reload();
  }

  const login = `/${locale}/login?next=${encodeURIComponent(`/${locale}/invitacion/${encodeURIComponent(token)}`)}`;

  return (
    <main className="auth-wrap">
      <div className="auth-card">
        <h1>{t("title")}</h1>

        {/* A QUÉ te invitan, en cuanto se sabe. */}
        {vista ? (
          <p className="sub">
            {t.rich("invitadoA", { org: vista.org, b: (c) => <b>{c}</b> })}{" "}
            {t.rich("invitacionPara", { email: vista.email, b: (c) => <b>{c}</b> })}
          </p>
        ) : null}

        {estado === "comprobando" || estado === "aceptando" ? (
          <p className="sub">{estado === "aceptando" ? t("aceptando") : t("comprobando")}</p>
        ) : null}

        {estado === "registrarse" || estado === "creando" ? (
          <>
            <p className="sub">{t("creaTuClave")}</p>
            <form onSubmit={crearCuenta} noValidate>
              {errorForm ? <div className="auth-msg error">{errorForm}</div> : null}
              {/* El correo se ENSEÑA y no se puede tocar: sale de la invitación, no
                  de lo que escriba quien llega. Va desactivado para que se vea con
                  qué cuenta se está entrando. */}
              <div className="field">
                <label htmlFor="inv-email">{t("tuCorreo")}</label>
                <input id="inv-email" type="email" value={vista?.email ?? ""} disabled readOnly />
              </div>
              <div className="field">
                <label htmlFor="inv-pass1">{t("passNueva")}</label>
                <input
                  id="inv-pass1"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  value={pass1}
                  onChange={(ev) => setPass1(ev.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="inv-pass2">{t("passRepetir")}</label>
                <input
                  id="inv-pass2"
                  type="password"
                  required
                  autoComplete="new-password"
                  minLength={8}
                  value={pass2}
                  onChange={(ev) => setPass2(ev.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-primary auth-submit" disabled={estado === "creando"}>
                {estado === "creando" ? t("creando") : t("crearYEntrar")}
              </button>
            </form>
            <p className="auth-alt" style={{ marginTop: "12px" }}>
              {t("yaTengoCuenta")} <a href={login}>{t("iniciarSesion")}</a>
            </p>
          </>
        ) : null}

        {estado === "exito" ? (
          <>
            <p className="sub">{t("exito")}</p>
            <a className="btn btn-primary" href={`/${locale}/dashboard`}>
              {t("irAlPanel")}
            </a>
          </>
        ) : null}

        {estado === "error" ? (
          <>
            <div className="auth-msg error">{textoError}</div>
            {/* CON QUÉ CUENTA ESTÁ. Sin esto, el mensaje «es para otra dirección»
                parece arbitrario: no hay forma de saber por qué le rechaza. */}
            {sesion ? (
              <>
                <p className="sub" style={{ marginTop: "12px" }}>
                  {t.rich("sesionActual", { email: sesion, b: (c) => <b>{c}</b> })}
                </p>
                <button type="button" className="btn btn-primary" onClick={cerrarSesion} disabled={cerrando}>
                  {cerrando ? t("cerrando") : t("cerrarYContinuar")}
                </button>
              </>
            ) : motivo === "otro_correo" || motivo === "ya_en_otra" ? (
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

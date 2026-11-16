"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { AccesoEnviado, MensajeDeAcceso } from "@/app/components/acceso/AccesoEstado";
import { AccesoShell } from "@/app/components/acceso/AccesoShell";
import { CampoClave } from "@/app/components/acceso/CampoClave";
import { Skeleton, SkeletonGroup } from "@/app/components/ui/Skeleton";

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
  // Textos que YA existen en otros dos sitios y aquí solo se reutilizan: los
  // nombres de perfil del panel de Equipo y el «ver/ocultar» de las contraseñas.
  const tp = useTranslations("dashboard");
  const ta = useTranslations("auth");
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

  // El perfil llega como identificador (`admin`, `member`…): se enseña con el
  // mismo nombre que ve quien invita en el panel de Equipo. Uno que esta
  // pantalla no conozca se pinta tal cual, antes que inventarle un nombre.
  const perfil = !vista
    ? ""
    : vista.role === "owner"
      ? tp("equipo.rolOwner")
      : vista.role === "admin"
        ? tp("equipo.rolAdmin")
        : vista.role === "billing"
          ? tp("equipo.rolBilling")
          : vista.role === "member"
            ? tp("equipo.rolMember")
            : vista.role;

  const esperando = estado === "comprobando" || estado === "aceptando";
  // Solo se marca un campo cuando el fallo ES de ese campo. «Ya existe una
  // cuenta» o «no se pudo crear» no son culpa de la contraseña escrita.
  const claveCorta = errorForm !== "" && errorForm === t("passCorta");
  const clavesDistintas = errorForm !== "" && errorForm === t("passDistintas");

  return (
    <AccesoShell>
      <div className="acc-intro">
        <p className="kicker">{t("kicker")}</p>
        <h1>{t("title")}</h1>
      </div>

      {/* A QUÉ te invitan, en cuanto se sabe: organización, destinatario y
          perfil, antes de pedir nada. Mientras se comprueba, su hueco exacto. */}
      {vista ? (
        <dl className="inv-ficha">
          <div className="inv-fila inv-fila--org">
            <dt>{t("labelOrg")}</dt>
            <dd>{vista.org}</dd>
          </div>
          <div className="inv-fila">
            <dt>{t("labelFor")}</dt>
            <dd className="inv-correo">{vista.email}</dd>
          </div>
          <div className="inv-fila">
            <dt>{tp("equipo.columnaRol")}</dt>
            <dd>
              <span className="tag">{perfil}</span>
            </dd>
          </div>
        </dl>
      ) : estado === "comprobando" ? (
        <SkeletonGroup label={t("comprobando")} className="inv-ficha inv-ficha--hueco">
          <Skeleton ancho="34%" alto={10} />
          <Skeleton ancho="62%" alto={22} />
          <Skeleton ancho="78%" alto={14} />
          <Skeleton ancho="30%" alto={14} />
        </SkeletonGroup>
      ) : null}

      {esperando ? (
        <p className="acc-progreso" role="status">
          <span className="acc-spin" aria-hidden />
          {estado === "aceptando" ? t("aceptando") : t("comprobando")}
        </p>
      ) : null}

      {estado === "registrarse" || estado === "creando" ? (
        <>
          <p className="sub">{t("creaTuClave")}</p>
          <form onSubmit={crearCuenta} noValidate aria-busy={estado === "creando" || undefined}>
            {errorForm ? (
              <MensajeDeAcceso tipo="error" id="inv-aviso">
                {errorForm}
              </MensajeDeAcceso>
            ) : null}
            {/* El correo se ENSEÑA y no se puede tocar: sale de la invitación, no
                de lo que escriba quien llega. Va desactivado para que se vea con
                qué cuenta se está entrando. */}
            <div className="field">
              <label htmlFor="inv-email">{t("tuCorreo")}</label>
              <input id="inv-email" type="email" autoComplete="username" value={vista?.email ?? ""} disabled readOnly />
            </div>
            <CampoClave
              id="inv-pass1"
              etiqueta={t("passNueva")}
              valor={pass1}
              alCambiar={setPass1}
              autoComplete="new-password"
              desactivado={estado === "creando"}
              invalido={claveCorta}
              descritoPor={claveCorta ? "inv-aviso" : undefined}
              mostrar={ta("showPassword")}
              ocultar={ta("hidePassword")}
            />
            <CampoClave
              id="inv-pass2"
              etiqueta={t("passRepetir")}
              valor={pass2}
              alCambiar={setPass2}
              autoComplete="new-password"
              desactivado={estado === "creando"}
              invalido={clavesDistintas}
              descritoPor={clavesDistintas ? "inv-aviso" : undefined}
              mostrar={ta("showPassword")}
              ocultar={ta("hidePassword")}
            />
            <button type="submit" className="btn btn-primary auth-submit" disabled={estado === "creando"}>
              {estado === "creando" ? (
                <>
                  <span className="acc-spin" aria-hidden />
                  {t("creando")}
                </>
              ) : (
                t("crearYEntrar")
              )}
            </button>
          </form>
          <p className="auth-alt acc-cruce">
            {t("yaTengoCuenta")} <a href={login}>{t("iniciarSesion")}</a>
          </p>
        </>
      ) : null}

      {estado === "exito" ? (
        <AccesoEnviado
          icono="hecho"
          tono="ok"
          titulo={t("exito")}
          acciones={
            <a className="btn btn-primary btn-block" href={`/${locale}/dashboard`}>
              {t("irAlPanel")}
            </a>
          }
        />
      ) : null}

      {estado === "error" ? (
        <>
          <MensajeDeAcceso tipo="error">{textoError}</MensajeDeAcceso>
          {/* CON QUÉ CUENTA ESTÁ. Sin esto, el mensaje «es para otra dirección»
              parece arbitrario: no hay forma de saber por qué le rechaza. */}
          {sesion ? (
            <>
              <p className="sub inv-sesion">{t.rich("sesionActual", { email: sesion, b: (c) => <b>{c}</b> })}</p>
              <button type="button" className="btn btn-primary btn-block" onClick={cerrarSesion} disabled={cerrando}>
                {cerrando ? t("cerrando") : t("cerrarYContinuar")}
              </button>
            </>
          ) : motivo === "otro_correo" || motivo === "ya_en_otra" ? (
            // Con la vuelta puesta: tras entrar con la cuenta correcta se
            // regresa a ESTA invitación, sin tener que buscar el correo otra vez.
            <a className="btn btn-ghost btn-block" href={login}>
              {t("iniciarSesion")}
            </a>
          ) : null}
        </>
      ) : null}
    </AccesoShell>
  );
}

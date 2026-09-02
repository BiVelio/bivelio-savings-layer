"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

interface Miembro {
  userId: string;
  email: string | null;
  role: string;
  desde: string;
  soyYo: boolean;
}
interface Invitacion {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  caducada: boolean;
}

const ROLES = ["admin", "member", "billing"] as const;

/**
 * EL EQUIPO. Invitar, cambiar perfiles, sacar a alguien y transferir la
 * propiedad.
 *
 * El panel NO decide nada: cada acción la autoriza el servidor con la tabla de
 * `lib/org/permisos`. Aquí solo se esconde lo que no se puede usar, para no
 * ofrecer botones que devuelven 403 — pero esconder no es proteger, y el orden
 * importa: primero se cerró la puerta (fase 7) y después se quitó el picaporte.
 *
 * Si el listado devuelve 403 el panel se calla entero: un `member` no tiene por
 * qué ver siquiera cuánta gente hay en la organización.
 *
 * SOBRE EL ASPECTO: la primera versión usaba clases inventadas (`ck-card`,
 * `ck-btn`, `ck-table`) que no existen en `globals.css`, así que el navegador
 * aplicaba sus valores por defecto y la sección parecía de otro producto. Ahora
 * usa el vocabulario real —`card`, `btn btn-primary`, `kt-input`— y una LISTA en
 * vez de una tabla: `.tbl` alinea a la derecha y numera en tabular porque está
 * pensada para cifras, no para direcciones de correo.
 */
export function EquipoPanel() {
  const t = useTranslations("dashboard.equipo");
  const locale = useLocale();
  const fecha = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

  const [miembros, setMiembros] = useState<Miembro[] | null>(null);
  const [invitaciones, setInvitaciones] = useState<Invitacion[]>([]);
  const [miRol, setMiRol] = useState<string>("");
  /** El nombre de la organización: es lo que ve quien recibe una invitación. */
  const [nombreOrg, setNombreOrg] = useState("");
  const [nombreGuardado, setNombreGuardado] = useState("");
  const [oculto, setOculto] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const [email, setEmail] = useState("");
  const [rol, setRol] = useState<(typeof ROLES)[number]>("member");
  const [enviando, setEnviando] = useState(false);
  /** Id de la fila para la que se pide confirmación. Quitar a alguien y
   *  transferir la propiedad no pueden ser un solo clic. */
  const [confirmando, setConfirmando] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    try {
      const [mRes, iRes] = await Promise.all([
        fetch("/api/org/members"),
        fetch("/api/org/invitations"),
      ]);
      if (mRes.status === 403 || mRes.status === 404) {
        setOculto(true);
        return;
      }
      if (!mRes.ok) {
        setMsg({ tipo: "error", texto: t("error") });
        return;
      }
      const m = (await mRes.json()) as { miembros: Miembro[]; miRol: string; org?: string };
      setMiembros(m.miembros);
      setMiRol(m.miRol);
      if (typeof m.org === "string") {
        setNombreOrg(m.org);
        setNombreGuardado(m.org);
      }
      if (iRes.ok) setInvitaciones(((await iRes.json()) as { invitaciones: Invitacion[] }).invitaciones);
    } catch {
      setMsg({ tipo: "error", texto: t("error") });
    }
  }, [t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function invitar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setMsg(null);
    try {
      const res = await fetch("/api/org/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, role: rol, locale }),
      });
      const json = (await res.json()) as { enviado?: boolean; error?: string };
      if (!res.ok) {
        setMsg({ tipo: "error", texto: json.error ?? t("error") });
        return;
      }
      // Se distingue «creada y enviada» de «creada pero el correo no salió». La
      // segunda no es un error del que invita, pero tiene que saberlo para poder
      // reenviar en vez de quedarse esperando a alguien que nunca recibió nada.
      setMsg({ tipo: json.enviado ? "ok" : "error", texto: json.enviado ? t("enviadoOk") : t("enviadoFallo") });
      setEmail("");
      await cargar();
    } catch {
      setMsg({ tipo: "error", texto: t("error") });
    } finally {
      setEnviando(false);
    }
  }

  async function accion(url: string, metodo: string, cuerpo: unknown) {
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: metodo,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({ tipo: "error", texto: j.error ?? t("error") });
        return;
      }
      await cargar();
    } catch {
      setMsg({ tipo: "error", texto: t("error") });
    } finally {
      setConfirmando(null);
    }
  }

  if (oculto) return null;

  const puedoTransferir = miRol === "owner";
  const nombreRol = (r: string) =>
    r === "owner" ? t("rolOwner") : r === "admin" ? t("rolAdmin") : r === "billing" ? t("rolBilling") : t("rolMember");
  const inicial = (m: Miembro) => (m.email ?? m.userId).trim().charAt(0) || "?";

  return (
    <section className="card equipo">
      <h2>{t("title")}</h2>
      <p className="sub">{t("intro")}</p>

      {/* ------------------------------------------------ nombre de la org */}
      {/* Nace con el CORREO de quien pagó, y ese nombre acaba dentro del correo
          de invitación: «jmfisagol@gmail.com le ha invitado a unirse a
          jmfisagol@gmail.com» es el primer contacto de un desconocido con el
          producto de un cliente, y parece un correo roto o una suplantación. */}
      <form
        className="equipo-form"
        style={{ marginBottom: "14px" }}
        onSubmit={async (ev) => {
          ev.preventDefault();
          setMsg(null);
          const res = await fetch("/api/org", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: nombreOrg }),
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { error?: string };
            setMsg({ tipo: "error", texto: j.error ?? t("error") });
            return;
          }
          setNombreGuardado(nombreOrg);
          setMsg({ tipo: "ok", texto: t("guardado") });
        }}
      >
        <input
          className="kt-input"
          value={nombreOrg}
          maxLength={80}
          onChange={(ev) => setNombreOrg(ev.target.value)}
          placeholder={t("nombreOrg")}
          aria-label={t("nombreOrg")}
        />
        <button type="submit" className="btn btn-ghost" disabled={!nombreOrg.trim() || nombreOrg === nombreGuardado}>
          {t("guardar")}
        </button>
      </form>
      <p className="ck-note" style={{ marginBottom: "18px" }}>{t("nombreOrgAyuda")}</p>

      {/* ---------------------------------------------------------- invitar */}
      <form onSubmit={invitar} className="equipo-form">
        <input
          type="email"
          required
          className="kt-input"
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          placeholder={t("invitarEmail")}
          aria-label={t("invitarEmail")}
        />
        <select
          className="equipo-select"
          value={rol}
          onChange={(ev) => setRol(ev.target.value as (typeof ROLES)[number])}
          aria-label={t("invitarRol")}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {nombreRol(r)}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary" disabled={enviando}>
          {enviando ? t("invitando") : t("invitarBoton")}
        </button>
      </form>
      {/* Aire entre el formulario y su letra pequeña (matiz del dueño, 02-09:
          el texto nacía pegado a la caja del correo). */}
      <p className="ck-note" style={{ marginTop: 14 }}>{t("ayudaRoles")}</p>
      {/* Se dice explícitamente para que nadie deduzca que invitar cuesta dinero:
          un asiento es una MÁQUINA, no una persona. */}
      <p className="ck-note">{t("asientosNota")}</p>

      {msg ? <div className={`equipo-msg ${msg.tipo}`}>{msg.texto}</div> : null}

      {/* --------------------------------------------------------- miembros */}
      <h3>{t("miembrosTitulo")}</h3>
      {miembros === null ? (
        <p className="ck-note">{t("cargando")}</p>
      ) : (
        <ul className="equipo-lista">
          {miembros.map((m) => (
            <li key={m.userId} className="equipo-fila">
              <span className="ini" aria-hidden>
                {inicial(m)}
              </span>
              <span className="quien">
                <b>
                  {m.email ?? m.userId}
                  {m.soyYo ? ` (${t("tu")})` : ""}
                </b>
                <span>{fecha(m.desde)}</span>
              </span>

              {/* Al dueño no se le cambia el rol desde aquí: se transfiere. Y uno
                  no se degrada a sí mismo por accidente. */}
              {m.role === "owner" || m.soyYo ? (
                <span className={`rol${m.role === "owner" ? " owner" : ""}`}>{nombreRol(m.role)}</span>
              ) : (
                <select
                  className="equipo-select"
                  value={m.role}
                  onChange={(ev) => accion("/api/org/members", "PATCH", { userId: m.userId, role: ev.target.value })}
                  aria-label={t("columnaRol")}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {nombreRol(r)}
                    </option>
                  ))}
                </select>
              )}

              <span className="acciones">
                {m.role === "owner" || m.soyYo ? null : confirmando === `q:${m.userId}` ? (
                  <>
                    <button type="button" className="btn btn-primary" onClick={() => accion("/api/org/members", "DELETE", { userId: m.userId })}>
                      {t("confirmar")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmando(null)}>
                      {t("cancelar")}
                    </button>
                  </>
                ) : confirmando === `t:${m.userId}` ? (
                  <>
                    <button type="button" className="btn btn-primary" onClick={() => accion("/api/org/transfer", "POST", { userId: m.userId })}>
                      {t("transferirConfirmar")}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmando(null)}>
                      {t("cancelar")}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirmando(`q:${m.userId}`)}>
                      {t("quitar")}
                    </button>
                    {puedoTransferir ? (
                      <button type="button" className="btn btn-ghost" onClick={() => setConfirmando(`t:${m.userId}`)}>
                        {t("transferirBoton")}
                      </button>
                    ) : null}
                  </>
                )}
              </span>
            </li>
          ))}
          {miembros.length <= 1 ? <li className="equipo-vacio">{t("vacio")}</li> : null}
        </ul>
      )}
      {puedoTransferir && miembros !== null && miembros.length > 1 ? (
        <p className="ck-note">{t("transferirIntro")}</p>
      ) : null}

      {/* ---------------------------------------------------- invitaciones */}
      {invitaciones.length > 0 ? (
        <>
          <h3>{t("invitacionesTitulo")}</h3>
          <ul className="equipo-lista">
            {invitaciones.map((i) => (
              <li key={i.id} className="equipo-fila">
                <span className="ini" aria-hidden>
                  {i.email.charAt(0)}
                </span>
                <span className="quien">
                  <b>{i.email}</b>
                  <span>{nombreRol(i.role)}</span>
                </span>
                <span className={`rol ${i.caducada ? "caducada" : "pendiente"}`}>
                  {i.caducada ? t("caducada") : t("pendiente")}
                </span>
                <span className="acciones">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setEmail(i.email);
                      setRol(i.role as (typeof ROLES)[number]);
                    }}
                  >
                    {t("reenviar")}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => accion("/api/org/invitations", "DELETE", { id: i.id })}>
                    {t("revocar")}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Notice } from "@/app/components/ui";

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
  const tu = useTranslations("ui");
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
  // La carga falló antes de tener un solo miembro: no se pinta un formulario
  // sobre una lista que no existe, sino el fallo y cómo reintentar.
  const cargaFallida = miembros === null && msg?.tipo === "error";

  if (cargaFallida) {
    return (
      <section className="equipo">
        <Notice
          tono="danger"
          titulo={tu("state.error")}
          acciones={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setMsg(null);
                void cargar();
              }}
            >
              {tu("state.retry")}
            </button>
          }
        >
          {msg.texto}
        </Notice>
      </section>
    );
  }

  return (
    <section className="equipo">
      {/* MIEMBROS ≠ ASIENTOS, arriba del todo: nadie debe deducir que invitar
          a una persona cuesta dinero. Un asiento es una máquina. */}
      <Notice tono="info" role="note">
        {t("asientosNota")}
      </Notice>

      {msg ? (
        <div className={`equipo-msg ${msg.tipo}`} role={msg.tipo === "error" ? "alert" : "status"}>
          <span className="equipo-msg-ic" aria-hidden>
            {msg.tipo === "error" ? "!" : "✓"}
          </span>
          {msg.texto}
        </div>
      ) : null}

      {/* --------------------------------------------------------- miembros */}
      <div className="card equipo-card">
        <div className="equipo-head">
          <h2 className="equipo-h">{t("miembrosTitulo")}</h2>
          {miembros !== null ? <span className="equipo-count">{t("miembrosCuenta", { n: miembros.length })}</span> : null}
        </div>
        {miembros === null ? (
          <div className="equipo-carga" role="status" aria-busy="true">
            <span className="sr-only">{t("cargando")}</span>
            <span className="sk equipo-sk" aria-hidden />
            <span className="sk equipo-sk" aria-hidden />
            <span className="sk equipo-sk" aria-hidden />
          </div>
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
                    {m.soyYo ? <span className="equipo-tu">{t("tu")}</span> : null}
                  </b>
                  <span>{t("miembroDesde", { date: fecha(m.desde) })}</span>
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
                    aria-label={t("rolDe", { email: m.email ?? m.userId })}
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
          <p className="ck-note equipo-pie">
            <b>{t("transferirTitulo")}.</b> {t("transferirIntro")}
          </p>
        ) : null}
      </div>

      {/* ---------------------------------------------------------- invitar */}
      <div className="card equipo-card">
        <div className="equipo-head">
          <h2 className="equipo-h">{t("invitarTitulo")}</h2>
        </div>
        <form onSubmit={invitar} className="equipo-form">
          <label className="equipo-campo equipo-campo--ancho">
            <span className="equipo-label">{t("invitarEmail")}</span>
            <input
              type="email"
              required
              autoComplete="off"
              className="kt-input"
              value={email}
              onChange={(ev) => setEmail(ev.target.value)}
            />
          </label>
          <label className="equipo-campo">
            <span className="equipo-label">{t("invitarRol")}</span>
            <select
              className="equipo-select"
              value={rol}
              onChange={(ev) => setRol(ev.target.value as (typeof ROLES)[number])}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {nombreRol(r)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={enviando}>
            {enviando ? t("invitando") : t("invitarBoton")}
          </button>
        </form>

        {/* QUÉ PUEDE HACER CADA PERFIL, a la vista y sin abrir nada: la misma
            tabla que decide en el servidor (lib/org/permisos). */}
        <h3 className="equipo-sub">{t("permisosTitulo")}</h3>
        <dl className="equipo-roles">
          <div>
            <dt><span className="rol owner">{t("rolOwner")}</span></dt>
            <dd>{t("permisoOwner")}</dd>
          </div>
          <div>
            <dt><span className="rol">{t("rolAdmin")}</span></dt>
            <dd>{t("permisoAdmin")}</dd>
          </div>
          <div>
            <dt><span className="rol">{t("rolBilling")}</span></dt>
            <dd>{t("permisoBilling")}</dd>
          </div>
          <div>
            <dt><span className="rol">{t("rolMember")}</span></dt>
            <dd>{t("permisoMember")}</dd>
          </div>
        </dl>

        {/* ---------------------------------------------------- invitaciones */}
        <h3 className="equipo-sub">{t("invitacionesTitulo")}</h3>
        {invitaciones.length > 0 ? (
          <>
            <ul className="equipo-lista">
              {invitaciones.map((i) => (
                <li key={i.id} className="equipo-fila">
                  <span className="ini" aria-hidden>
                    {i.email.charAt(0)}
                  </span>
                  <span className="quien">
                    <b>{i.email}</b>
                    <span>
                      {nombreRol(i.role)} · {t(i.caducada ? "caduco" : "caduca", { date: fecha(i.expires_at) })}
                    </span>
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
            <p className="ck-note equipo-pie">{t("reenviarAyuda")}</p>
          </>
        ) : (
          <p className="ck-note">{t("invitacionesVacio")}</p>
        )}
      </div>

      {/* ------------------------------------------------ nombre de la org */}
      {/* Nace con el CORREO de quien pagó, y ese nombre acaba dentro del correo
          de invitación: es el primer contacto de un desconocido con el producto
          de un cliente, y con un correo por nombre parece una suplantación. */}
      <div className="card equipo-card">
        <div className="equipo-head">
          <h2 className="equipo-h">{t("orgTitulo")}</h2>
        </div>
        <form
          className="equipo-form"
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
          <label className="equipo-campo equipo-campo--ancho">
            <span className="equipo-label">{t("nombreOrg")}</span>
            <input
              className="kt-input"
              value={nombreOrg}
              maxLength={80}
              onChange={(ev) => setNombreOrg(ev.target.value)}
              aria-describedby="equipo-org-ayuda"
            />
          </label>
          <button type="submit" className="btn btn-ghost" disabled={!nombreOrg.trim() || nombreOrg === nombreGuardado}>
            {t("guardar")}
          </button>
        </form>
        <p id="equipo-org-ayuda" className="ck-note equipo-pie">{t("nombreOrgAyuda")}</p>
      </div>
    </section>
  );
}

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
 */
export function EquipoPanel() {
  const t = useTranslations("dashboard.equipo");
  const locale = useLocale();
  const fecha = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

  const [miembros, setMiembros] = useState<Miembro[] | null>(null);
  const [invitaciones, setInvitaciones] = useState<Invitacion[]>([]);
  const [miRol, setMiRol] = useState<string>("");
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
      const m = (await mRes.json()) as { miembros: Miembro[]; miRol: string };
      setMiembros(m.miembros);
      setMiRol(m.miRol);
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

  return (
    <section className="ck-card" style={{ marginTop: "22px" }}>
      <h2>{t("title")}</h2>
      <p className="ck-sub">{t("intro")}</p>

      {/* ---------------------------------------------------------- invitar */}
      <form onSubmit={invitar} style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "14px" }}>
        <input
          type="email"
          required
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
          placeholder={t("invitarEmail")}
          aria-label={t("invitarEmail")}
          style={{ flex: "1 1 220px", minWidth: 0 }}
        />
        <select value={rol} onChange={(ev) => setRol(ev.target.value as (typeof ROLES)[number])} aria-label={t("invitarRol")}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {nombreRol(r)}
            </option>
          ))}
        </select>
        <button type="submit" className="ck-btn" disabled={enviando}>
          {enviando ? t("invitando") : t("invitarBoton")}
        </button>
      </form>
      <p className="ck-hint" style={{ marginTop: "8px" }}>{t("ayudaRoles")}</p>
      {/* Se dice explícitamente para que nadie deduzca que invitar cuesta dinero:
          un asiento es una MÁQUINA, no una persona. */}
      <p className="ck-hint">{t("asientosNota")}</p>

      {msg ? (
        <div className={msg.tipo === "ok" ? "auth-msg" : "auth-msg error"} style={{ marginTop: "10px" }}>
          {msg.texto}
        </div>
      ) : null}

      {/* --------------------------------------------------------- miembros */}
      <h3 style={{ marginTop: "22px" }}>{t("miembrosTitulo")}</h3>
      {miembros === null ? (
        <p className="ck-hint">{t("cargando")}</p>
      ) : (
        <table className="ck-table">
          <thead>
            <tr>
              <th>{t("columnaPersona")}</th>
              <th>{t("columnaRol")}</th>
              <th>{t("columnaDesde")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {miembros.map((m) => (
              <tr key={m.userId}>
                <td>
                  {m.email ?? m.userId}
                  {m.soyYo ? <span className="ck-hint"> ({t("tu")})</span> : null}
                </td>
                <td>
                  {m.role === "owner" || m.soyYo ? (
                    nombreRol(m.role)
                  ) : (
                    <select
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
                </td>
                <td>{fecha(m.desde)}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {/* Al dueño no se le toca desde aquí: se transfiere primero. Y
                      uno no se echa a sí mismo por accidente. */}
                  {m.role === "owner" || m.soyYo ? null : confirmando === `q:${m.userId}` ? (
                    <>
                      <button type="button" className="ck-btn danger" onClick={() => accion("/api/org/members", "DELETE", { userId: m.userId })}>
                        {t("confirmar")}
                      </button>{" "}
                      <button type="button" className="ck-btn ghost" onClick={() => setConfirmando(null)}>
                        {t("cancelar")}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="ck-btn ghost" onClick={() => setConfirmando(`q:${m.userId}`)}>
                        {t("quitar")}
                      </button>
                      {puedoTransferir ? (
                        confirmando === `t:${m.userId}` ? (
                          <>
                            {" "}
                            <button type="button" className="ck-btn danger" onClick={() => accion("/api/org/transfer", "POST", { userId: m.userId })}>
                              {t("transferirConfirmar")}
                            </button>
                          </>
                        ) : (
                          <>
                            {" "}
                            <button type="button" className="ck-btn ghost" onClick={() => setConfirmando(`t:${m.userId}`)}>
                              {t("transferirBoton")}
                            </button>
                          </>
                        )
                      ) : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {miembros !== null && miembros.length <= 1 ? <p className="ck-hint">{t("vacio")}</p> : null}
      {puedoTransferir ? <p className="ck-hint">{t("transferirIntro")}</p> : null}

      {/* ---------------------------------------------------- invitaciones */}
      {invitaciones.length > 0 ? (
        <>
          <h3 style={{ marginTop: "22px" }}>{t("invitacionesTitulo")}</h3>
          <table className="ck-table">
            <tbody>
              {invitaciones.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{nombreRol(i.role)}</td>
                  <td>{i.caducada ? t("caducada") : t("pendiente")}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      className="ck-btn ghost"
                      onClick={() => {
                        setEmail(i.email);
                        setRol(i.role as (typeof ROLES)[number]);
                      }}
                    >
                      {t("reenviar")}
                    </button>{" "}
                    <button type="button" className="ck-btn ghost" onClick={() => accion("/api/org/invitations", "DELETE", { id: i.id })}>
                      {t("revocar")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

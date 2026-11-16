"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Notice } from "@/app/components/ui";
import { Avatar } from "@/vendor/affectui/avatar";
import { Badge } from "@/vendor/affectui/badge";
import { DataTable, type DataTableColumn } from "@/vendor/affectui/data-table";
import { AlertDialog } from "@/vendor/affectui/dialog";
import { DropdownMenu } from "@/vendor/affectui/dropdown-menu";
import { EmptyState } from "@/vendor/affectui/empty-state";
import { Select } from "@/vendor/affectui/select";
import { Spinner } from "@/vendor/affectui/spinner";
import { TeamInvite } from "@/vendor/affectui/team-invite";
import { TextField } from "@/vendor/affectui/text-field";
import { Toaster, toast } from "@/vendor/affectui/toaster";

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
 * REDISEÑO 2026-11 (affectUI): miembros e invitaciones son tablas de SOLO
 * LECTURA (Data Table) con avatar e insignias; el perfil se cambia con Select;
 * «Quitar» y «Transferir» viven en el menú de la fila (Dropdown Menu) y piden
 * confirmación en un diálogo (AlertDialog) — el mismo `accion(...)` de siempre
 * corre solo desde su botón de confirmar. El resultado se anuncia además con
 * un aviso flotante (Toaster): un correo que no salió va en ROJO y no caduca
 * solo, para que nunca parezca enviado. Los fetch y los handlers no cambian.
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
  const tc = useTranslations("dashboard.accountPlanStrip");
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

  /* EL RESULTADO, TAMBIÉN A LA VISTA DONDE SE ESTÉ. El mensaje de arriba puede
     quedar fuera de pantalla cuando se actúa abajo (el nombre de la
     organización): cada `msg` nuevo sale además como aviso flotante. Un error
     —incluido «invitación creada pero el correo no salió»— no se cierra solo. */
  const avisado = useRef<typeof msg>(null);
  /** El último miembro de cada diálogo: su nombre sigue pintado mientras el diálogo se cierra. */
  const ultimoAQuitar = useRef<Miembro | null>(null);
  const ultimoATransferir = useRef<Miembro | null>(null);
  useEffect(() => {
    if (!msg || avisado.current === msg) return;
    avisado.current = msg;
    if (msg.tipo === "ok") toast.success(msg.texto, { toaster: "equipo" });
    else toast.error(msg.texto, { toaster: "equipo", duration: Infinity });
  }, [msg]);

  if (oculto) return null;

  const puedoTransferir = miRol === "owner";
  const nombreRol = (r: string) =>
    r === "owner" ? t("rolOwner") : r === "admin" ? t("rolAdmin") : r === "billing" ? t("rolBilling") : t("rolMember");
  const permisoDe = (r: string) =>
    r === "owner" ? t("permisoOwner") : r === "admin" ? t("permisoAdmin") : r === "billing" ? t("permisoBilling") : t("permisoMember");
  /** «ana.ruiz@…» → «ana ruiz», para que el avatar saque dos iniciales. */
  const nombreDe = (correo: string) => correo.split("@")[0]?.replace(/[._+-]+/g, " ") ?? correo;
  const opcionesDeRol = ROLES.map((r) => ({ value: r, label: nombreRol(r), description: permisoDe(r) }));
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

  /** A quién se refiere la confirmación abierta: `q:` quitar, `t:` transferir. */
  const aQuitar = (miembros ?? []).find((m) => confirmando === `q:${m.userId}`) ?? null;
  const aTransferir = (miembros ?? []).find((m) => confirmando === `t:${m.userId}`) ?? null;
  if (aQuitar) ultimoAQuitar.current = aQuitar;
  if (aTransferir) ultimoATransferir.current = aTransferir;
  const quitado = aQuitar ?? ultimoAQuitar.current;
  const transferido = aTransferir ?? ultimoATransferir.current;

  const menu = (nombre: string, items: Parameters<typeof DropdownMenu>[0]["items"]) => (
    <DropdownMenu
      align="end"
      aria-label={t("accionesDe", { email: nombre })}
      items={items}
      trigger={({ triggerProps }) => (
        <button type="button" className="equipo-mas" aria-label={t("accionesDe", { email: nombre })} {...triggerProps}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden focusable="false">
            <circle cx="3.25" cy="8" r="1.35" />
            <circle cx="8" cy="8" r="1.35" />
            <circle cx="12.75" cy="8" r="1.35" />
          </svg>
        </button>
      )}
    />
  );

  const columnasMiembros: DataTableColumn[] = [
    { id: "persona", header: t("columnaPersona"), lead: true },
    { id: "desde", header: t("columnaDesde"), width: "22%" },
    { id: "rol", header: t("columnaRol"), width: "26%" },
    { id: "acciones", header: "", align: "end", width: "64px", plain: true },
  ];
  const columnasInvitaciones: DataTableColumn[] = [
    { id: "persona", header: t("invitarEmail"), lead: true },
    { id: "rol", header: t("columnaRol"), width: "20%" },
    { id: "estado", header: tc("statusLabel"), width: "30%" },
    { id: "acciones", header: "", align: "end", width: "64px", plain: true },
  ];

  return (
    <section className="equipo">
      <Toaster id="equipo" position="bottom-right" label={t("avisosLabel")} dismissLabel={t("avisoCerrar")} />

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
          {miembros !== null ? (
            <Badge size="md" className="equipo-count">
              {t("miembrosCuenta", { n: miembros.length })}
            </Badge>
          ) : null}
        </div>
        {miembros === null ? (
          <div className="equipo-carga" role="status" aria-busy="true">
            <span className="sr-only">{t("cargando")}</span>
            <span className="sk equipo-sk" aria-hidden />
            <span className="sk equipo-sk" aria-hidden />
            <span className="sk equipo-sk" aria-hidden />
          </div>
        ) : (
          <>
            <DataTable
              flat
              className="equipo-tabla"
              label={t("miembrosTitulo")}
              columns={columnasMiembros}
              rows={miembros.map((m) => {
                const nombre = m.email ?? m.userId;
                // Al dueño no se le cambia el rol desde aquí: se transfiere. Y uno
                // no se degrada a sí mismo por accidente.
                const fijo = m.role === "owner" || m.soyYo;
                return {
                  id: m.userId,
                  cells: {
                    persona: (
                      <span className="equipo-quien">
                        <Avatar size={32} name={nombreDe(nombre)} seed={m.userId} />
                        <span className="equipo-quien-txt">
                          <b>{nombre}</b>
                          {m.soyYo ? <Badge className="equipo-tu">{t("tu")}</Badge> : null}
                        </span>
                      </span>
                    ),
                    desde: <span className="equipo-desde">{fecha(m.desde)}</span>,
                    rol: fijo ? (
                      <Badge size="md" tone={m.role === "owner" ? "info" : "neutral"} className={`rol${m.role === "owner" ? " owner" : ""}`}>
                        {nombreRol(m.role)}
                      </Badge>
                    ) : (
                      <Select
                        className="equipo-rol"
                        size="lg"
                        menuMinWidth={320}
                        options={opcionesDeRol}
                        value={m.role}
                        onChange={(valor) => accion("/api/org/members", "PATCH", { userId: m.userId, role: valor })}
                        aria-label={t("rolDe", { email: nombre })}
                      />
                    ),
                    acciones: fijo
                      ? null
                      : menu(nombre, [
                          ...(puedoTransferir
                            ? [{ label: t("transferirBoton"), onSelect: () => setConfirmando(`t:${m.userId}`) }]
                            : []),
                          { label: t("quitar"), danger: true, divider: puedoTransferir, onSelect: () => setConfirmando(`q:${m.userId}`) },
                        ]),
                  },
                };
              })}
            />
            {miembros.length <= 1 ? (
              <div className="equipo-vacio">
                <TeamInvite className="equipo-ilustracion" />
                <EmptyState bare icon={null} title={t("vacio")} text={t("vacioAyuda")} />
              </div>
            ) : null}
          </>
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
          <TextField
            className="equipo-campo equipo-campo--ancho"
            size="lg"
            label={t("invitarEmail")}
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
          />
          <Select
            className="equipo-campo"
            size="lg"
            menuMinWidth={320}
            label={t("invitarRol")}
            options={opcionesDeRol}
            value={rol}
            onChange={(valor) => setRol(valor as (typeof ROLES)[number])}
          />
          <button type="submit" className="btn btn-primary equipo-enviar" disabled={enviando}>
            {enviando ? <Spinner size={15} /> : null}
            {enviando ? t("invitando") : t("invitarBoton")}
          </button>
        </form>

        {/* QUÉ PUEDE HACER CADA PERFIL, a la vista y sin abrir nada: la misma
            tabla que decide en el servidor (lib/org/permisos). */}
        <h3 className="equipo-sub">{t("permisosTitulo")}</h3>
        <dl className="equipo-roles">
          <div>
            <dt><Badge size="md" tone="info" className="rol owner">{t("rolOwner")}</Badge></dt>
            <dd>{t("permisoOwner")}</dd>
          </div>
          <div>
            <dt><Badge size="md" className="rol">{t("rolAdmin")}</Badge></dt>
            <dd>{t("permisoAdmin")}</dd>
          </div>
          <div>
            <dt><Badge size="md" className="rol">{t("rolBilling")}</Badge></dt>
            <dd>{t("permisoBilling")}</dd>
          </div>
          <div>
            <dt><Badge size="md" className="rol">{t("rolMember")}</Badge></dt>
            <dd>{t("permisoMember")}</dd>
          </div>
        </dl>

        {/* ---------------------------------------------------- invitaciones */}
        <div className="equipo-subhead">
          <h3 className="equipo-sub">{t("invitacionesTitulo")}</h3>
          {invitaciones.length > 0 ? <Badge count={invitaciones.length} tone="warning" /> : null}
        </div>
        {invitaciones.length > 0 ? (
          <>
            <DataTable
              flat
              className="equipo-tabla"
              label={t("invitacionesTitulo")}
              columns={columnasInvitaciones}
              rows={invitaciones.map((i) => ({
                id: i.id,
                cells: {
                  persona: (
                    <span className="equipo-quien">
                      <Avatar size={32} name={nombreDe(i.email)} seed={i.email} />
                      <span className="equipo-quien-txt">
                        <b>{i.email}</b>
                      </span>
                    </span>
                  ),
                  rol: nombreRol(i.role),
                  estado: (
                    <span className="equipo-estado">
                      <Badge size="md" dot tone={i.caducada ? "danger" : "warning"} className={`rol ${i.caducada ? "caducada" : "pendiente"}`}>
                        {i.caducada ? t("caducada") : t("pendiente")}
                      </Badge>
                      <span className="equipo-caduca">{t(i.caducada ? "caduco" : "caduca", { date: fecha(i.expires_at) })}</span>
                    </span>
                  ),
                  acciones: menu(i.email, [
                    {
                      label: t("reenviar"),
                      onSelect: () => {
                        setEmail(i.email);
                        setRol(i.role as (typeof ROLES)[number]);
                      },
                    },
                    {
                      label: t("revocar"),
                      danger: true,
                      divider: true,
                      onSelect: () => accion("/api/org/invitations", "DELETE", { id: i.id }),
                    },
                  ]),
                },
              }))}
            />
            <p className="ck-note equipo-pie">{t("reenviarAyuda")}</p>
          </>
        ) : (
          <EmptyState
            className="equipo-sin-invitaciones"
            title={t("invitacionesVacio")}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                <rect x="3" y="5" width="18" height="14" rx="3" />
                <path d="m4 7.5 8 5.5 8-5.5" />
              </svg>
            }
          />
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
          <TextField
            className="equipo-campo equipo-campo--ancho"
            size="lg"
            label={t("nombreOrg")}
            hint={t("nombreOrgAyuda")}
            value={nombreOrg}
            maxLength={80}
            onChange={(ev) => setNombreOrg(ev.target.value)}
          />
          <button type="submit" className="btn btn-ghost equipo-enviar" disabled={!nombreOrg.trim() || nombreOrg === nombreGuardado}>
            {t("guardar")}
          </button>
        </form>
      </div>

      {/* LAS DOS CONFIRMACIONES. Quitar a alguien y transferir la propiedad no
          pueden ser un solo clic: el menú solo ABRE el diálogo, y el mismo
          `accion(...)` de siempre corre únicamente desde su botón de confirmar.
          Escape y «Cancelar» cierran sin tocar nada. */}
      <AlertDialog
        danger
        open={aQuitar !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setConfirmando(null);
        }}
        title={quitado ? t("quitarTitulo", { email: quitado.email ?? quitado.userId }) : ""}
        description={t("quitarCuerpo")}
        confirmLabel={t("quitarConfirmar")}
        cancelLabel={t("cancelar")}
        onConfirm={() => (aQuitar ? accion("/api/org/members", "DELETE", { userId: aQuitar.userId }) : undefined)}
      />
      <AlertDialog
        open={aTransferir !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setConfirmando(null);
        }}
        title={t("transferirTitulo")}
        description={t("transferirIntro")}
        confirmLabel={t("transferirConfirmar")}
        cancelLabel={t("cancelar")}
        onConfirm={() => (aTransferir ? accion("/api/org/transfer", "POST", { userId: aTransferir.userId }) : undefined)}
      >
        {transferido ? (
          <p className="equipo-dialogo-quien">
            <Avatar size={32} name={nombreDe(transferido.email ?? transferido.userId)} seed={transferido.userId} />
            <b>{transferido.email ?? transferido.userId}</b>
          </p>
        ) : null}
      </AlertDialog>
    </section>
  );
}

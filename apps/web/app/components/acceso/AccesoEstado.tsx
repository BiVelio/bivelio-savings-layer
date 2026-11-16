"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { Icono, type NombreDeIcono } from "./iconos";

/**
 * EL AVISO DE UN FORMULARIO DE ACCESO. Conserva las clases de siempre
 * (`.auth-msg.error` / `.auth-msg.info`) y añade lo que faltaba: un icono, y el
 * papel ARIA que hace que un lector de pantalla lo lea al aparecer.
 */
export function MensajeDeAcceso({ tipo, id, children }: { tipo: "error" | "info"; id?: string; children: ReactNode }) {
  return (
    <div className={`auth-msg ${tipo}`} id={id} role={tipo === "error" ? "alert" : "status"}>
      <Icono nombre={tipo === "error" ? "error" : "info"} />
      <span>{children}</span>
    </div>
  );
}

/**
 * LA SUBVISTA «YA ESTÁ»: sustituye al formulario cuando la acción terminó y lo
 * que queda es ir al correo (alta pendiente de confirmar, cuenta que ya existía,
 * enlace de recuperación) o esperar la redirección (contraseña cambiada).
 *
 * Al aparecer recibe el foco el título: quien navega con teclado o con lector
 * de pantalla acababa de pulsar un botón que ya no existe, y sin esto el foco
 * se quedaba en el vacío.
 */
export function AccesoEnviado({
  icono,
  tono = "info",
  titulo,
  correo,
  etiquetaCorreo,
  acciones,
  children,
}: {
  icono: NombreDeIcono;
  tono?: "info" | "ok";
  titulo: string;
  /** La dirección que se escribió, para que se vea adónde mirar. */
  correo?: string;
  etiquetaCorreo?: string;
  acciones?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="acc-sent" data-tone={tono} role="status">
      <span className="acc-sent-icon" aria-hidden>
        <Icono nombre={icono} />
      </span>
      <h2 className="acc-sent-title" tabIndex={-1} ref={ref}>
        {titulo}
      </h2>
      {children ? <p className="acc-sent-text">{children}</p> : null}
      {correo ? (
        <p className="acc-sent-mail">
          {etiquetaCorreo ? <span className="sr-only">{etiquetaCorreo}: </span> : null}
          {correo}
        </p>
      ) : null}
      {acciones ? <div className="acc-sent-actions">{acciones}</div> : null}
    </div>
  );
}

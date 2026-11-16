"use client";

import { useState } from "react";

import { Icono } from "./iconos";

/**
 * Un campo de contraseña con su botón de ver/ocultar. El `<input>` conserva el
 * `id`, el `autoComplete` y el `minLength` que ya tenían los formularios; lo
 * único nuevo es el ojo, que es un botón de verdad (con nombre accesible y
 * `aria-pressed`) y no un icono pintado encima.
 */
export function CampoClave({
  id,
  etiqueta,
  valor,
  alCambiar,
  autoComplete,
  placeholder,
  desactivado = false,
  invalido = false,
  descritoPor,
  mostrar,
  ocultar,
}: {
  id: string;
  etiqueta: string;
  valor: string;
  alCambiar: (valor: string) => void;
  autoComplete: "new-password" | "current-password";
  placeholder?: string;
  desactivado?: boolean;
  invalido?: boolean;
  descritoPor?: string;
  /** Nombres accesibles del botón, ya traducidos. */
  mostrar: string;
  ocultar: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{etiqueta}</label>
      <div className="acc-clave">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={8}
          value={valor}
          onChange={(e) => alCambiar(e.target.value)}
          placeholder={placeholder}
          disabled={desactivado}
          aria-invalid={invalido || undefined}
          aria-describedby={descritoPor}
        />
        <button
          type="button"
          className="acc-ojo"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? ocultar : mostrar}
          aria-pressed={visible}
          disabled={desactivado}
        >
          <Icono nombre={visible ? "ojoCerrado" : "ojo"} />
        </button>
      </div>
    </div>
  );
}

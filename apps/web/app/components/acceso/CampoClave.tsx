"use client";

import { TextField } from "@/vendor/affectui/text-field-clean";

import { Icono } from "./iconos";

/**
 * Un campo de contraseña. Es el Text Field de affectUI (caja blanca con filo
 * de sombra, foco de marca, 44px) con su botón de ver/ocultar: un botón de
 * verdad, con nombre accesible, `aria-pressed` y su etiqueta flotante. El
 * `<input>` conserva el `id`, el `autoComplete` y el `minLength` que ya tenían
 * los formularios.
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
  return (
    <TextField
      className="acc-campo"
      id={id}
      label={etiqueta}
      type="password"
      icon={<Icono nombre="candado" />}
      autoComplete={autoComplete}
      required
      minLength={8}
      value={valor}
      onChange={(e) => alCambiar(e.target.value)}
      placeholder={placeholder}
      disabled={desactivado}
      invalid={invalido}
      aria-describedby={descritoPor}
      reveal={{ show: mostrar, hide: ocultar }}
    />
  );
}

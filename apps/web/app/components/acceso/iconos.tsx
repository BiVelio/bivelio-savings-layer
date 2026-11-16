/**
 * Los cinco glifos del acceso. Trazo de 1.6 sobre 20×20, como los del `Notice`
 * de la fundación: decoran, no informan (el estado lo dice el texto), así que
 * van siempre con `aria-hidden`.
 */
const TRAZO = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const DIBUJOS = {
  correo: "M3.2 5.6h13.6v9.2H3.2zM3.6 6l6.4 5 6.4-5",
  hecho: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM6.9 10.2l2.2 2.2 4-4.4",
  error: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM10 6.4v4.4M10 13.5v.01",
  info: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM10 9.2v4.3M10 6.5v.01",
  ojo: "M2.4 10s2.8-5 7.6-5 7.6 5 7.6 5-2.8 5-7.6 5-7.6-5-7.6-5zM10 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z",
  ojoCerrado: "M3.2 3.2l13.6 13.6M8.3 5.3A7.6 7.6 0 0 1 10 5c4.8 0 7.6 5 7.6 5a13 13 0 0 1-2.2 2.8M12.9 14.3A7 7 0 0 1 10 15c-4.8 0-7.6-5-7.6-5a13 13 0 0 1 3.1-3.6M8.4 8.4a2.3 2.3 0 0 0 3.2 3.2",
  flecha: "M4.5 10h11M11.5 6l4 4-4 4",
} as const;

export type NombreDeIcono = keyof typeof DIBUJOS;

export function Icono({ nombre }: { nombre: NombreDeIcono }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden focusable="false">
      <path {...TRAZO} d={DIBUJOS[nombre]} />
    </svg>
  );
}

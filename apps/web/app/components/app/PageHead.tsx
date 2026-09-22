import type { ReactNode } from "react";

/**
 * TODAS LAS PANTALLAS DEL PANEL ABREN IGUAL, Y NO POR ACORDARSE.
 *
 * Mismo componente que el `PageHead` del panel de privacy: antetítulo con su
 * punto menta (`.eyebrow`), `h1.t-page` y subtítulo `.sub-page`. El papel va
 * en la clase y la clase la pone el componente, que es lo que impide que dos
 * títulos del mismo nivel midan distinto según quién escribiera la página.
 */
export function PageHead({
  eyebrow,
  title,
  sub,
  aside,
  children,
  role,
}: {
  /** Antetítulo. Va en TODAS las ramas de una pantalla, no sólo en la feliz. */
  eyebrow?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  /** Lo que se alinea a la derecha del título. Enciende `.app-head-row`. */
  aside?: ReactNode;
  children?: ReactNode;
  role?: "alert";
}) {
  const bloque = (
    <>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1 className="t-page">{title}</h1>
      {sub ? <p className="sub-page">{sub}</p> : null}
      {children}
    </>
  );
  return (
    <div className={aside ? "app-head app-head-row" : "app-head"} role={role}>
      {aside ? <div>{bloque}</div> : bloque}
      {aside}
    </div>
  );
}

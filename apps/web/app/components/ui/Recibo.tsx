import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

import { cx } from "./cx";
import { EvidenceBadge, type TipoDeEvidencia } from "./EvidenceBadge";

/**
 * EL RECIBO VERIFICABLE DE UNA LLAMADA — la pieza propia de BiVelio Savings.
 *
 * Un tique: filas «etiqueta ····· valor» en Geist Mono con cifras tabulares,
 * una fila de total con doble filete y un resguardo con la PROCEDENCIA de la
 * medición (insignia de evidencia + «cómo se midió»). Se repite en el héroe,
 * en evidencia, en instalación y en el panel.
 *
 * REGLAS:
 *  - Las cifras llegan YA FORMATEADAS por quien lo usa (moneda, periodo y base
 *    con el locale explícito). Este componente no calcula ni formatea.
 *  - Si las cifras no son medidas, `ilustrativo` es OBLIGATORIO: pinta una
 *    franja permanente («Ejemplo ilustrativo») que no se puede cerrar.
 *  - Un dato que falta se pasa como «—», nunca como cero.
 *  - `tono` es decoración: el signo y la etiqueta ya dicen qué es cada fila.
 *
 * Accesible sin color: <figure> con su <figcaption> y una lista de definición.
 */
export type TonoDeFila = "neutro" | "ahorro" | "coste" | "atenuado";

export type FilaDeRecibo = {
  etiqueta: string;
  valor: ReactNode;
  tono?: TonoDeFila;
  /** `false` pinta el valor en Geist (texto: un modelo, un periodo). Por defecto, mono. */
  mono?: boolean;
};

export type ReciboProps = {
  titulo: string;
  /** Línea de contexto bajo el título: modelo · periodo · base de medición. */
  meta?: ReactNode;
  filas: FilaDeRecibo[];
  total?: { etiqueta: string; valor: ReactNode; tono?: TonoDeFila };
  evidencia?: { tipo: TipoDeEvidencia; label: string };
  procedencia?: { texto: ReactNode; href?: string; enlace?: string };
  /** El texto de la franja permanente, p. ej. t("recibo.ilustrativo"). */
  ilustrativo?: string;
  compacto?: boolean;
  /** Ocupa todo el ancho de su contenedor (por defecto, máx. 420px). */
  ancho?: boolean;
  className?: string;
};

function Fila({ etiqueta, valor, tono = "neutro", mono = true }: FilaDeRecibo) {
  return (
    <div className="recibo-fila" data-tono={tono}>
      <dt>{etiqueta}</dt>
      <span className="recibo-guia" aria-hidden />
      <dd data-sans={mono ? undefined : ""}>{valor}</dd>
    </div>
  );
}

export function Recibo({ titulo, meta, filas, total, evidencia, procedencia, ilustrativo, compacto = false, ancho = false, className }: ReciboProps) {
  const conResguardo = Boolean(evidencia || procedencia);
  const href = procedencia?.href;

  return (
    <figure className={cx("recibo", compacto && "recibo--compacto", ancho && "recibo--ancho", className)}>
      <div className="recibo-papel" data-cierra={conResguardo ? undefined : ""}>
        {ilustrativo ? <p className="recibo-cinta">{ilustrativo}</p> : null}
        <figcaption className="recibo-cabeza">
          <div>
            <p className="recibo-titulo">{titulo}</p>
            {meta ? <p className="recibo-meta">{meta}</p> : null}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="recibo-sello" src="/brand/savings-mark.png" alt="" width={22} height={22} decoding="async" loading="lazy" />
        </figcaption>
        <dl className="recibo-filas">
          {filas.map((f, i) => (
            <Fila key={`${i}-${f.etiqueta}`} {...f} />
          ))}
          {total ? (
            <div className="recibo-fila recibo-total" data-tono={total.tono ?? "neutro"}>
              <dt>{total.etiqueta}</dt>
              <span className="recibo-guia" aria-hidden />
              <dd>{total.valor}</dd>
            </div>
          ) : null}
        </dl>
      </div>
      {conResguardo ? (
        <div className="recibo-resguardo">
          {evidencia ? <EvidenceBadge tipo={evidencia.tipo} label={evidencia.label} /> : null}
          {procedencia ? (
            <p className="recibo-procedencia">
              {procedencia.texto}
              {href && procedencia.enlace ? (
                <>
                  {" "}
                  {href.startsWith("/") ? (
                    <Link className="recibo-enlace" href={href}>
                      {procedencia.enlace}
                    </Link>
                  ) : (
                    <a className="recibo-enlace" href={href} {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                      {procedencia.enlace}
                    </a>
                  )}
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
    </figure>
  );
}

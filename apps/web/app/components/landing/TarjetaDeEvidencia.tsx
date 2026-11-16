import type { ReactNode } from "react";

import { LogoProveedor } from "@/app/components/LogoProveedor";
import { EvidenceBadge, type TipoDeEvidencia } from "@/app/components/ui";

/**
 * UNA CIFRA MEDIDA, CON SU CLASE DE EVIDENCIA AL LADO (guía §6, bloque 5).
 *
 * Un A/B con el SDK y un replay contrafactual del gateway NO son la misma
 * clase de prueba: cada uno va en su tarjeta, con su insignia, su modelo, su
 * fecha y su muestra. La cifra y la frase llegan ya formateadas desde
 * `filasDelBancoEnVivo` / `filaDeLaPalancaTtl` (app/components/MedidoEnVivo.tsx),
 * que leen las constantes con verja contra los informes: aquí no se calcula ni
 * se anima nada.
 */
export function TarjetaDeEvidencia({
  marca,
  modelo,
  cifra,
  que,
  evidencia,
  fecha,
  pie,
}: {
  marca?: string;
  modelo?: string;
  cifra: string;
  que: string;
  evidencia: { tipo: TipoDeEvidencia; label: string };
  /** «Medido el …», ya con la fecha en el idioma de la página. */
  fecha: string;
  /** El enlace al informe. */
  pie?: ReactNode;
}) {
  return (
    <article className="evi rv">
      <header className="evi-cabeza">
        {marca ? (
          <span className="evi-marca">
            <LogoProveedor marca={marca} size={18} />
            <b>{marca}</b>
          </span>
        ) : null}
        <EvidenceBadge tipo={evidencia.tipo} label={evidencia.label} />
      </header>
      <p className="evi-cifra">{cifra}</p>
      <p className="evi-que">{que}</p>
      <p className="evi-meta">
        {modelo ? <code>{modelo}</code> : null}
        <span>{fecha}</span>
      </p>
      {pie ? <p className="evi-pie">{pie}</p> : null}
    </article>
  );
}

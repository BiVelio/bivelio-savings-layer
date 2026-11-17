import type { ReactNode } from "react";

/**
 * CÓMO VIAJAN LOS DATOS — diagrama estático y compacto (guía §6, bloque 7).
 *
 *   tu app o agente → SDK / gateway local (tu infraestructura) → tu proveedor
 *                                  ⇣ (opcional)
 *                             Savings Cloud
 *
 * Dos caminos, dos trazos: el de los prompts es continuo y azul y NO pasa por
 * BiVelio; el de la telemetría es discontinuo, sale solo si conectas Cloud y
 * lleva su etiqueta. Es HTML con texto real (se lee en orden, con o sin CSS),
 * sin contadores ni pulsos: es una ilustración, y lo dice su pie. El Integration
 * Beam interactivo vive en /how-it-works.
 */
export function ViajeDeLosDatos({
  t,
}: {
  t: {
    app: string;
    local: string;
    localSub: string;
    proveedor: string;
    proveedorSub: string;
    cloud: string;
    cloudSub: string;
    prompts: string;
    telemetria: string;
    pie: string;
  };
}) {
  const Flecha = ({ children, opcional = false }: { children: ReactNode; opcional?: boolean }) => (
    <li className="viaje-tramo" data-opcional={opcional ? "" : undefined}>
      <span className="viaje-tramo-t">{children}</span>
      <span className="viaje-linea" aria-hidden />
    </li>
  );

  return (
    <figure className="viaje rv">
      <div className="viaje-lienzo">
        <ol className="viaje-camino">
          <li className="viaje-nodo">
            <span className="viaje-icono" aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5zM6.5 8.5 8.5 10.5 6.5 12.5M10.5 12.5h3" />
              </svg>
            </span>
            <b>{t.app}</b>
          </li>
          <Flecha>{t.prompts}</Flecha>
          <li className="viaje-nodo viaje-nodo--local">
            <span className="viaje-icono" aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m10 3 6.5 3.5L10 10 3.5 6.5zM3.5 10 10 13.5l6.5-3.5M3.5 13.5 10 17l6.5-3.5" />
              </svg>
            </span>
            <b>{t.local}</b>
            <small>{t.localSub}</small>
          </li>
          <Flecha>{t.prompts}</Flecha>
          <li className="viaje-nodo">
            <span className="viaje-icono" aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 15.5a3.5 3.5 0 0 1-.6-6.95 4.75 4.75 0 0 1 9.2.95A3 3 0 0 1 14 15.5z" />
              </svg>
            </span>
            <b>{t.proveedor}</b>
            <small>{t.proveedorSub}</small>
          </li>
        </ol>
        <ol className="viaje-rama">
          <Flecha opcional>{t.telemetria}</Flecha>
          <li className="viaje-nodo viaje-nodo--cloud">
            <span className="viaje-icono" aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 16V9.5M8 16V4M12 16v-5M16 16V7" />
              </svg>
            </span>
            <b>{t.cloud}</b>
            <small>{t.cloudSub}</small>
          </li>
        </ol>
      </div>
      <figcaption className="viaje-pie">{t.pie}</figcaption>
    </figure>
  );
}

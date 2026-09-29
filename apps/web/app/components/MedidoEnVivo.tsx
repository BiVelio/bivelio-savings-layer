import type { ReactNode } from "react";

import { LogoProveedor } from "@/app/components/LogoProveedor";
import { BANCO_EN_VIVO } from "@/lib/portada/banco-en-vivo";

/**
 * LO MEDIDO EN VIVO, UNA SOLA VEZ PARA TODA LA WEB.
 *
 * La portada (héroe, tarjeta del SDK, #measured) y el panel (/dashboard/proof)
 * enseñan las mismas filas: con repeticiones (OpenAI), sin repeticiones (≈ 0) y
 * el mismo flujo en Claude, con la caché de prefijo del proveedor dicha aparte.
 * Las cifras salen de lib/portada/banco-en-vivo.ts (con verja contra sus
 * informes) y los textos de `landing.enVivo.*`. Ninguna con un «al menos».
 */

/** Una fila: marca y modelo (o nada), cifra y qué significa. */
export type FilaMedida = { marca?: string; modelo?: string; cifra: string; que: string };

/** El traductor del namespace `landing` (el de next-intl, reducido a lo que se usa aquí). */
type TraductorLanding = (clave: string, params?: Record<string, string | number>) => string;

/** Las tres filas en el idioma de la página. */
export function filasDelBancoEnVivo(t: TraductorLanding, locale: string): FilaMedida[] {
  // Porcentajes con el idioma de la página («31,5 %», «%31,5»): una décima para
  // las cifras con intervalo, ninguna para las redondas (30 %, 0 %, 41 %).
  const pct1 = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct0 = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const V = BANCO_EN_VIVO;
  const modeloCorto = (m: string) => m.split("/").pop() ?? m;
  return [
    {
      marca: "OpenAI",
      modelo: modeloCorto(V.openai.modelo),
      cifra: pct1.format(V.openai.ahorro.point),
      que: t("enVivo.conRepeticiones", {
        bajo: pct1.format(V.openai.ahorro.lower),
        alto: pct1.format(V.openai.ahorro.upper),
        rep: pct0.format(V.repeticiones),
        bateria: V.bateria,
        version: V.versionSdk,
      }),
    },
    { cifra: `≈ ${pct0.format(0)}`, que: t("enVivo.sinRepeticiones") },
    {
      marca: "Anthropic",
      modelo: modeloCorto(V.anthropic.modelo),
      cifra: pct1.format(V.anthropic.ahorro.point),
      que: t("enVivo.anthropic", {
        bajo: pct1.format(V.anthropic.ahorro.lower),
        alto: pct1.format(V.anthropic.ahorro.upper),
        prefijo: pct0.format(V.anthropic.prefijoDelProveedor),
      }),
    },
  ];
}

/** Las filas, pintadas con las clases de la tarjeta de lo medido. */
export function FilasMedidas({ filas }: { filas: FilaMedida[] }) {
  return (
    <div className="hero-prueba-filas">
      {filas.map((p) => (
        <div className="hp" key={p.que}>
          {p.marca ? (
            <div className="hp-marca">
              <LogoProveedor marca={p.marca} />
              <b>{p.marca}</b>
              {p.modelo ? <code>{p.modelo}</code> : null}
            </div>
          ) : null}
          <div className="hp-dato">
            <span className="hp-n">{p.cifra}</span>
            <span className="hp-q">{p.que}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** La tarjeta entera: título con la fecha, las tres filas y el pie con el enlace al banco. */
export function TarjetaMedidoEnVivo({
  titulo,
  filas,
  pie,
  className = "hero-prueba",
}: {
  titulo: string;
  filas: FilaMedida[];
  pie: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <span className="hero-prueba-t">{titulo}</span>
      <FilasMedidas filas={filas} />
      <p className="cascade-nota">{pie}</p>
    </div>
  );
}

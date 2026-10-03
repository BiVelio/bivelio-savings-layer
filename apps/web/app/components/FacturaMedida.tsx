import type { CSSProperties } from "react";

import { LogoProveedor } from "@/app/components/LogoProveedor";
import { Link } from "@/i18n/navigation";
import { facturaDelHeroe } from "@/lib/portada/factura-del-heroe";

/** El traductor del namespace `landing` (el de next-intl, reducido a lo que se usa aquí). */
type TraductorLanding = (clave: string, params?: Record<string, string | number>) => string;

/**
 * LA IMAGEN DEL HÉROE: tu factura frente a la misma con Savings, medida.
 *
 * Dos barras en CSS (nada de imagen de stock ni generada): la factura directa
 * al proveedor y la de Savings, más corta en lo que midió el banco público en
 * vivo; el IC 95 % va en texto junto a la cifra (variante B: barras limpias,
 * sin horquilla ni tramo discontinuo). Encima, la cifra;
 * debajo, su condición («con un 30 % de peticiones repetidas»), el modelo y el
 * enlace al informe. Las cifras y los anchos salen de facturaDelHeroe(), que
 * los lee de BANCO_EN_VIVO.
 *
 * Componente de servidor y sin script: la barra de Savings «baja» desde la
 * factura entera con una animación CSS que se apaga con prefers-reduced-motion.
 */
export function FacturaMedida({ t, locale }: { t: TraductorLanding; locale: string }) {
  const f = facturaDelHeroe(locale);
  const anchos = { "--fb-con": f.barra.con } as CSSProperties;
  return (
    <figure className="factura" style={anchos}>
      <span className="factura-t">{t("enVivo.titulo", { fecha: f.fecha })}</span>

      <p className="factura-cifra">
        <span className="factura-n">{f.bajada}</span>
        <span className="factura-q">
          {t("hero.visual.menos")}
          {/* La horquilla «25,7 % – 36,7 %» no se parte en dos líneas: el
              guion largo es un punto de corte y ni el espacio duro lo evita;
              la unión de palabra (U+2060) a los dos lados, sí. */}
          <small>{t("hero.visual.intervalo", { bajo: f.bajo, alto: f.alto }).replace(/\s–\s/g, " ⁠–⁠ ")}</small>
        </span>
      </p>

      <div className="factura-barras">
        <div className="fb">
          <span className="fb-k">{t("hero.visual.sin")}</span>
          <span className="fb-pista" aria-hidden="true">
            <i className="fb-sin" />
          </span>
        </div>
        <div className="fb">
          <span className="fb-k">{t("hero.visual.con")}</span>
          <span className="fb-pista" aria-hidden="true">
            <i className="fb-con" />
          </span>
        </div>
      </div>

      <figcaption className="factura-pie">
        <span className="factura-cond">{t("hero.visual.condicion", { rep: f.rep })}</span>
        <span className="factura-meta">
          <LogoProveedor marca={f.marca} size={14} />
          <span className="sr-only">{f.marca}</span>
          <code>{f.modelo}</code>
          <span>{f.bateria}</span>
          <Link href="/benchmarks">{t("hero.visual.informe")}</Link>
        </span>
      </figcaption>
    </figure>
  );
}

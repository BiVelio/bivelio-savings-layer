import { getTranslations } from "next-intl/server";

import { Recibo } from "@/app/components/ui";

/**
 * EL PANEL DE MARCA DEL ACCESO: qué se va a ver al entrar.
 *
 * La pieza es el recibo de la fundación, y las cifras son INVENTADAS: por eso
 * lleva la cinta permanente «Ejemplo ilustrativo», la insignia «Sintético» y la
 * frase que lo repite con palabras. Son cuentas de tokens —sin moneda ni
 * porcentaje— y cuadran entre sí (lo de menos es la resta de las dos entradas),
 * para que el ejemplo enseñe la forma del dato sin prometer un ahorro.
 */
const EJEMPLO = { entradaSinOptimizar: 12480, entradaOptimizada: 3360, salida: 356 } as const;

export async function PanelDeMarca({ locale }: { locale: string }) {
  const t = await getTranslations("auth");
  const tu = await getTranslations("ui");
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: "always" });

  return (
    <div className="acc-panel">
      <div className="acc-panel-texto">
        <p className="kicker">BiVelio Savings Cloud</p>
        <h2 className="editorial-title acc-panel-titulo">
          {t.rich("panel.title", { em: (c) => <span className="serif-accent serif-accent--brand">{c}</span> })}
        </h2>
        <p className="lede-text acc-panel-lede">{t("panel.body")}</p>
      </div>
      <Recibo
        className="acc-panel-recibo"
        titulo={t("panel.receiptTitle")}
        meta={t("panel.receiptMeta")}
        ilustrativo={tu("recibo.ilustrativo")}
        filas={[
          { etiqueta: t("panel.rowBaseline"), valor: n.format(EJEMPLO.entradaSinOptimizar) },
          { etiqueta: t("panel.rowActual"), valor: n.format(EJEMPLO.entradaOptimizada) },
          { etiqueta: t("panel.rowOutput"), valor: n.format(EJEMPLO.salida), tono: "atenuado" },
        ]}
        total={{
          etiqueta: t("panel.total"),
          valor: n.format(EJEMPLO.entradaSinOptimizar - EJEMPLO.entradaOptimizada),
          tono: "ahorro",
        }}
        evidencia={{ tipo: "sintetico", label: tu("evidence.sintetico") }}
        procedencia={{ texto: t("panel.provenance") }}
      />
    </div>
  );
}

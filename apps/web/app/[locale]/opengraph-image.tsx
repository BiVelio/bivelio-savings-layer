import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";

import { locales } from "@/i18n/config";

/**
 * Tarjeta social de la landing, una por idioma. Antes no existía ninguna: cada
 * vez que alguien compartía el enlace en LinkedIn, X, Slack o WhatsApp salía una
 * URL pelada, sin título ni imagen. Para un producto cuyo gancho es "entra y
 * verifica tu ahorro", esa tarjeta es la primera impresión y no había forma de
 * ganarla dos veces.
 *
 * El texto sale de las mismas traducciones que la página, así que la tarjeta
 * habla el idioma del enlace que se comparte y no se desincroniza del copy.
 *
 * Nota: se usa la tipografía por defecto de `next/og`, no Space Grotesk. Satori
 * no lee woff2 (que es el único formato en `public/fonts/`) y convertirlo aquí
 * requeriría el módulo brotli, que no está. Si algún día se quiere la fuente de
 * marca, basta con dejar un `.ttf` junto a este fichero y pasarlo en `fonts`.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "BiVelio Savings Layer";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

const INK = "#0F1218";
const INK_SOFT = "#5A6070";
const BRAND = "#2F63D8";
const BRAND_SOFT = "#EAF0FF";
const LINE = "#DEE4E7";

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "landing" });

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#FDFDFD",
          padding: "72px 80px",
          borderTop: `10px solid ${BRAND}`,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 52,
              height: 52,
              borderRadius: 12,
              background: INK,
              color: "#FFFFFF",
              fontSize: 30,
              fontWeight: 700,
            }}
          >
            B/
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 27, fontWeight: 700, color: INK, letterSpacing: -0.5 }}>BiVelio</div>
            <div style={{ fontSize: 17, color: INK_SOFT, letterSpacing: 2 }}>BV-SALA · SAVINGS LAYER</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", flexWrap: "wrap", fontSize: 74, fontWeight: 700, letterSpacing: -2.4, lineHeight: 1.08 }}>
            <span style={{ color: INK }}>{t("hero.title")}&nbsp;</span>
            <span style={{ color: BRAND }}>{t("hero.titleAccent")}</span>
          </div>
          <div style={{ fontSize: 27, color: INK_SOFT, lineHeight: 1.4, maxWidth: 920 }}>{t("hero.note")}</div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `2px solid ${LINE}`, paddingTop: 26 }}>
          <div style={{ fontSize: 25, color: INK, fontWeight: 700 }}>savings.bivelio.com</div>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              color: BRAND,
              background: BRAND_SOFT,
              padding: "10px 22px",
              borderRadius: 999,
            }}
          >
            {t("pricing.amount")} {t("pricing.per")}
          </div>
        </div>
      </div>
    ),
    size,
  );
}

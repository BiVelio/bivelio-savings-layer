import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";

import abData from "@/public/data/ab-live.json";

/**
 * La MISMA regla de tres que `HowItWorks.tsx`, y no por casualidad: esta
 * tarjeta la cachean LinkedIn y X durante días, así que una cifra que aquí se
 * quede vieja sigue circulando aunque la página ya diga otra cosa. Antes eran
 * dos números escritos a mano ($330 → $160) sin ningún respaldo, copiados en
 * tres sitios; ahora los tres salen del suelo del artefacto publicado.
 */
const SUELO_MEDIDO = abData.aggregate?.savings?.lower ?? 0;
const FACTURA_EJEMPLO = 100;
const FACTURA_CON_CAPA = Math.round(FACTURA_EJEMPLO * (1 - SUELO_MEDIDO));

import { locales } from "@/i18n/config";

/**
 * Tarjeta social de «¿Dónde se instala el ahorro?», una por idioma — el mismo
 * patrón que la OG de la landing. El gancho aquí es el propio diagrama: la
 * capa en verde entre «tu aplicación» y la API, con la factura antes/después.
 * Texto desde las mismas traducciones que la página, para no desincronizarse.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "BiVelio Savings Layer — how it works";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

const INK = "#0F1218";
const INK_SOFT = "#5A6070";
const LINE = "#DEE4E7";
const MINT = "#14A06F";
const MINT_SOFT = "#E7F6EE";
const PANEL = "#F4F6F9";

function Node({ title, mint }: { title: string; mint?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: mint ? MINT_SOFT : "#FFFFFF",
        border: `2px solid ${mint ? MINT : LINE}`,
        borderRadius: 14,
        padding: "18px 28px",
        fontSize: 26,
        fontWeight: 700,
        color: mint ? MINT : INK,
        letterSpacing: -0.5,
      }}
    >
      {title}
    </div>
  );
}

function Arrow() {
  return <div style={{ display: "flex", fontSize: 30, color: INK_SOFT }}>→</div>;
}

export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "howItWorks" });

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
          padding: "64px 80px",
          borderTop: `10px solid ${MINT}`,
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

        <div style={{ display: "flex", flexDirection: "column", gap: 34 }}>
          <div style={{ display: "flex", fontSize: 66, fontWeight: 700, letterSpacing: -2.2, lineHeight: 1.08, color: INK, maxWidth: 1020 }}>
            {t("title")}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: PANEL,
              border: `2px solid ${LINE}`,
              borderRadius: 18,
              padding: "26px 34px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <Node title={t("nodeApp")} />
              <Arrow />
              <Node title="BV-SALA" mint />
              <Arrow />
              <Node title={t("nodeApi")} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ display: "flex", fontSize: 30, color: INK_SOFT, textDecoration: "line-through" }}>${FACTURA_EJEMPLO}</div>
                <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: MINT }}>${FACTURA_CON_CAPA}</div>
              </div>
              <div style={{ display: "flex", fontSize: 17, color: INK_SOFT, letterSpacing: 1.5, textTransform: "uppercase" }}>
                {t("billMonth")}
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `2px solid ${LINE}`, paddingTop: 24 }}>
          <div style={{ display: "flex", fontSize: 25, color: INK, fontWeight: 700 }}>savings.bivelio.com</div>
          <div style={{ display: "flex", fontSize: 22, color: INK_SOFT }}>{t("mAfterV")}</div>
        </div>
      </div>
    ),
    size,
  );
}

import { getTranslations } from "next-intl/server";

import { decidirAvisoVersion, type AsientoVisto } from "@/lib/version/aviso-version";

import { AvisoMigrar05 } from "./AvisoMigrar05";

/**
 * Máquinas con gateway que llevan 7 días sin producir un euro MEDIDO — hermano
 * de BillingStateBanner, con su misma regla: null cuando no hay nada que decir.
 *
 * La decisión (dinero medido por asiento, 0024) vive en
 * `lib/version/aviso-version.ts`, pura y con tests; aquí solo se pinta. La
 * versión declarada por cada máquina EXPLICA el 0 € en una de tres frases
 * (anterior a la palanca / sin declarar / al día pero sin actuar) y jamás
 * afirma que el ahorro del titular sea 0: un 0.4.16 que mide dinero no entra
 * aquí aunque no declare versión.
 *
 * Ámbar y no rojo: no hay nada roto ni cortado, hay dinero que se está
 * dejando de ahorrar.
 */
export async function GatewayVersionBanner({ asientos }: { asientos: AsientoVisto[] }) {
  const aviso = decidirAvisoVersion(asientos, Date.now());
  if (!aviso) return null;

  const t = await getTranslations("dashboard.gatewayVersion");
  const sinEuro = aviso.desactualizadas + aviso.sinDeclarar + aviso.sinPalanca;

  return (
    <div
      className="card"
      role="status"
      style={{ marginTop: 6, borderLeft: "3px solid var(--amber)", opacity: 0.92 }}
    >
      <div className="n">{t("title")}</div>
      <p style={{ marginTop: 6 }}>{t("summary", { n: sinEuro, total: aviso.activas })}</p>
      {aviso.desactualizadas > 0 ? (
        <p style={{ marginTop: 6 }}>{t("outdated", { n: aviso.desactualizadas, minima: aviso.minima })}</p>
      ) : null}
      {aviso.sinDeclarar > 0 ? (
        <p style={{ marginTop: 6 }}>{t("undeclared", { n: aviso.sinDeclarar, minima: aviso.minima })}</p>
      ) : null}
      {aviso.sinPalanca > 0 ? <p style={{ marginTop: 6 }}>{t("noLever", { n: aviso.sinPalanca })}</p> : null}
      <p className="ck-note" style={{ marginTop: 8, marginBottom: 0 }}>{t("action")}</p>
      <AvisoMigrar05 />
    </div>
  );
}

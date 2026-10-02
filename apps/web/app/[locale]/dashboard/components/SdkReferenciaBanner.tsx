import { getTranslations } from "next-intl/server";

import { decidirAvisoReferencia, type AsientoVisto } from "@/lib/version/aviso-version";

import { AvisoMigrar05 } from "./AvisoMigrar05";

/** El comando de actualización: fuera de las traducciones, igual en los 12 idiomas. */
export const ACTUALIZAR_SDK = "npm install @bivelio/savings-layer@latest";

/**
 * Máquinas con un SDK por debajo de `VERSION_MINIMA_REFERENCIA`: sus
 * repeticiones entran como `estimated` y no como referencia hasta que
 * actualicen. Hermano de GatewayVersionBanner, con su misma regla (null cuando
 * no hay nada que decir) y su decisión aparte (`decidirAvisoReferencia`, pura y
 * con tests): los dos pueden salir a la vez sin pisarse.
 *
 * Ámbar y no rojo: no hay nada roto, hay repeticiones que no entran en la base.
 */
export async function SdkReferenciaBanner({ asientos }: { asientos: AsientoVisto[] }) {
  const aviso = decidirAvisoReferencia(asientos, Date.now());
  if (!aviso) return null;

  const t = await getTranslations("dashboard.sdkReferencia");
  const antigua = aviso.versionMasAntigua.slice(aviso.versionMasAntigua.indexOf("/") + 1);

  return (
    <div
      className="card"
      role="status"
      style={{ marginTop: 6, borderLeft: "3px solid var(--amber)", opacity: 0.92 }}
    >
      <div className="n">{t("title", { minima: aviso.minima })}</div>
      <p style={{ marginTop: 6 }}>
        {t("summary", { n: aviso.desactualizadas, minima: aviso.minima, antigua })}
      </p>
      <p className="ck-note" style={{ marginTop: 8, marginBottom: 0 }}>
        {t("action", { minima: aviso.minima })} <code>{ACTUALIZAR_SDK}</code>
      </p>
      <AvisoMigrar05 />
    </div>
  );
}

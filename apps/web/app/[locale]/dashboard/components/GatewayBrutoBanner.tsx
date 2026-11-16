import { getTranslations } from "next-intl/server";

import { decidirAvisoBruto, type AsientoVisto } from "@/lib/version/aviso-version";

import { AvisoMigrar05 } from "./AvisoMigrar05";
import { Notice } from "@/app/components/ui";

/**
 * Máquinas cuyo ahorro medido llega EN BRUTO: un gateway anterior a
 * `VERSION_MINIMA_AHORRO_NETO` acredita la prima de la rebaja de caché y no
 * resta los fallos de caché que esa rebaja provoca. Hermano de
 * GatewayVersionBanner y SdkReferenciaBanner, con su misma regla: null cuando
 * no hay nada que decir, y la decisión aparte (`decidirAvisoBruto`, pura y con
 * tests).
 *
 * Por qué existe: lo ya registrado no se recalcula. Mientras una máquina siga
 * por debajo, lo que suma al titular es más de lo que de verdad ahorró, y un
 * panel que enseña «medido» tiene que decirlo.
 *
 * Ámbar y no rojo: no hay nada roto; hay una cifra que hay que leer con cuidado.
 */
export async function GatewayBrutoBanner({ asientos }: { asientos: AsientoVisto[] }) {
  const aviso = decidirAvisoBruto(asientos, Date.now());
  if (!aviso) return null;

  const t = await getTranslations("dashboard.gatewayBruto");

  return (
    <Notice tono="warn" role="status" className="ov-banner" titulo={t("title")}>
      <p>{t("summary", { n: aviso.maquinas, minima: aviso.minima })}</p>
      <p className="ck-note">{t("action", { minima: aviso.minima })}</p>
      <AvisoMigrar05 />
    </Notice>
  );
}

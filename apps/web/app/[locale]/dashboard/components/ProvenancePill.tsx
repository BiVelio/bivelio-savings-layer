import { getTranslations } from "next-intl/server";

/** Provenance is stamped on every number: reference-mock vs your-org-live. */
export async function ProvenancePill({ kind }: { kind: "mock" | "live" | "await" }) {
  const t = await getTranslations("dashboard");
  const label = kind === "mock" ? t("provenancePill.mock") : kind === "live" ? t("provenancePill.live") : t("provenancePill.await");
  return (
    <span className={`pill ${kind}`}>
      <span className="dot" />
      {label}
    </span>
  );
}

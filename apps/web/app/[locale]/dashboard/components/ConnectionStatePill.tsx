import { getTranslations } from "next-intl/server";

import type { Metering } from "../data";

/** The app's top-level honest state: is the SDK actually metering yet? */
export async function ConnectionStatePill({ state }: { state: Metering }) {
  const t = await getTranslations("dashboard");
  return state === "live" ? (
    <span className="pill live">
      <span className="dot" /> {t("connectionStatePill.meteringLive")}
    </span>
  ) : (
    <span className="pill await">
      <span className="dot" /> {t("connectionStatePill.awaitingFirstReport")}
    </span>
  );
}

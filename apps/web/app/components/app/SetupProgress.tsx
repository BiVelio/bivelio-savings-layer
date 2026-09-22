import { getTranslations } from "next-intl/server";

import { progressPercent, type Progress } from "@/lib/dashboard/progress";

/**
 * «PUESTA EN MARCHA · N DE 5», arriba del raíl. Nada se decide aquí:
 * `lib/dashboard/progress.ts` ya dijo el estado de cada paso; esto sólo lo
 * dibuja. Y la única regla que sí es de este fichero: si `readable` es falso,
 * NO HAY BLOQUE — ni barra, ni «0 de 5»: una frase en `role="status"`.
 */
export async function SetupProgress({ progress }: { progress: Progress }) {
  const t = await getTranslations("app.setup");

  if (!progress.readable) {
    return (
      <p className="app-setup-unreadable" role="status">
        {t("unreadable")}
      </p>
    );
  }

  const percent = progressPercent(progress);
  return (
    <div className="app-setup">
      <p className="app-setup-k">
        {t("title")} · {t("count", { done: progress.done, total: progress.total })}
      </p>
      {/* La barra es decoración de la cifra que ya está escrita encima, así que
          no repite el valor para un lector de pantalla. */}
      <div className="app-setup-bar" aria-hidden>
        <i style={{ width: `${percent}%` }} />
      </div>
      {progress.firstPending && (
        <p className="app-setup-s">{t("missing", { step: progress.firstPending })}</p>
      )}
    </div>
  );
}

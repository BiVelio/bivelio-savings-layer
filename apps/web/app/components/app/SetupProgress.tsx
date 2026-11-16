import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import type { Progress } from "@/lib/dashboard/progress";
import { ProgressTracker, type ProgressStepStatus } from "@/vendor/affectui/progress-tracker-clean";

import { destinoDelHito } from "./setup-destinos";

/**
 * «PUESTA EN MARCHA · N DE 5», arriba del raíl. Nada se decide aquí:
 * `lib/dashboard/progress.ts` ya dijo el estado de cada paso; esto sólo lo
 * dibuja. Y la única regla que sí es de este fichero: si `readable` es falso,
 * NO HAY BLOQUE — ni barra, ni «0 de 5»: una frase en `role="status"`.
 *
 * REDISEÑO 2026-11: el dibujo es el Progress Tracker de affectUI, BIFURCADO a
 * solo lectura (`vendor/affectui/progress-tracker-clean`). Los cinco hitos son
 * los reales y cada fila es un ENLACE a su instrucción: pulsarla no marca
 * nada. Con los cinco hechos la lista sobra y queda el titular con su barra.
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

  const estado = (status: ProgressStepStatus): string =>
    status === "done"
      ? t("status.done")
      : status === "current"
        ? t("status.next")
        : status === "unavailable"
          ? t("status.unavailable")
          : t("status.pending");
  const completo = progress.total > 0 && progress.done === progress.total;

  return (
    <div className="app-setup" data-tour="setup">
      <ProgressTracker
        title={t("title")}
        countLabel={t("count", { done: progress.done, total: progress.total })}
        done={progress.done}
        total={progress.total}
        steps={
          completo
            ? []
            : progress.steps.map((step) => ({
                id: step.id,
                label: step.label,
                status: step.status,
                statusLabel: estado(step.status),
                href: destinoDelHito(step.id),
              }))
        }
        linkAs={Link}
        headingAs="p"
        dense
        bare
      />
    </div>
  );
}

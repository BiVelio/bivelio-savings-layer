import { getTranslations } from "next-intl/server";

import { CheckIcon } from "@/app/components/icons";
import { Link } from "@/i18n/navigation";
import type { Progress } from "@/lib/dashboard/progress";

import { destinoDelHito } from "./setup-destinos";

/**
 * «PUESTA EN MARCHA · N DE 5», arriba del raíl. Nada se decide aquí:
 * `lib/dashboard/progress.ts` ya dijo el estado de cada paso; esto sólo lo
 * dibuja. Y la única regla que sí es de este fichero: si `readable` es falso,
 * NO HAY BLOQUE — ni teselas, ni «0 de 5»: una frase en `role="status"`.
 *
 * FIRMA DE CAMPAÑA (dirección A, 2026-11-17): una tarjeta blanca con el rótulo
 * espaciado y la cuenta a la derecha, CINCO TESELAS (una por hito, en tinta las
 * hechas) y la lista de hitos con su estado en palabras. Cada fila es un
 * ENLACE a su instrucción: pulsarla no marca nada. Con los cinco hechos solo
 * queda la cabecera con su marca de completado. Las teselas repiten lo que ya
 * dicen la cuenta y la lista, así que no entran en el árbol de accesibilidad.
 *
 * Antes era el Progress Tracker de affectUI; la pieza sigue en el panel (la usa
 * `InstrumentationSpine`), así que el reparto de hojas no cambia.
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

  const estado = (status: Progress["steps"][number]["status"]): string =>
    status === "done"
      ? t("status.done")
      : status === "current"
        ? t("status.next")
        : status === "unavailable"
          ? t("status.unavailable")
          : t("status.pending");
  const completo = progress.total > 0 && progress.done === progress.total;

  return (
    <div className="app-setup" data-tour="setup" data-completo={completo ? "" : undefined}>
      <div className="pfc-setup-cab">
        <p className="app-setup-k">{t("title")}</p>
        <span className="pfc-setup-cuenta">
          {completo ? (
            <span className="pfc-setup-ok" aria-hidden>
              <CheckIcon />
            </span>
          ) : null}
          {t("count", { done: progress.done, total: progress.total })}
        </span>
      </div>
      {completo ? null : (
        <>
          <ol className="pfc-teselas" aria-hidden>
            {progress.steps.map((step) => (
              <li key={step.id} data-estado={step.status} />
            ))}
          </ol>
          <ol className="pfc-hitos">
            {progress.steps.map((step) => {
              const href = destinoDelHito(step.id);
              const fila = (
                <>
                  <span className="pfc-hito-ic" aria-hidden>
                    {step.status === "done" ? <CheckIcon /> : null}
                  </span>
                  <span className="pfc-hito-l" dir="auto">
                    {step.label}
                  </span>
                  <span className="pfc-hito-st">{estado(step.status)}</span>
                </>
              );
              return (
                <li
                  key={step.id}
                  data-estado={step.status}
                  aria-current={step.status === "current" ? "step" : undefined}
                >
                  {href ? (
                    <Link className="pfc-hito" href={href}>
                      {fila}
                    </Link>
                  ) : (
                    <div className="pfc-hito">{fila}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </div>
  );
}

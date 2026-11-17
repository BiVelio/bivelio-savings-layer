import { getTranslations } from "next-intl/server";

import { destinoDelHito } from "@/app/components/app/setup-destinos";
// Por fichero y no desde el índice: el índice arrastra el `Link` de next-intl
// y este componente se renderiza también fuera de Next.
import { CodeFrame } from "@/app/components/ui/CodeFrame";
import { ProgressTracker } from "@/vendor/affectui/progress-tracker-clean";

import type { StepState } from "../data";

/**
 * EL MISMO COMANDO QUE EL PANEL DE INSTALACIÓN (`INIT` en InstallLicensePanel).
 * Este paso seguía mostrando `pnpm add` cuando el panel ya recomendaba `init`
 * (#355): dos puertas de entrada que decían cosas distintas. `init` detecta la
 * pila e imprime la línea de instalación para el gestor de paquetes de cada uno,
 * así que el `pnpm add` sobra aquí; a mano sigue en el panel de instalación. No
 * se importa de allí para no arrastrar Stripe a la portada del panel: lo fija
 * `instalacion-renderiza.test.ts` en los dos componentes.
 */
const INSTALL_CMD = "npx @bivelio/savings-layer@latest init";

/**
 * La espina de activación: los cinco hitos — derivados, nunca fingidos.
 *
 * REDISEÑO 2026-11: los hitos se dibujan con el Progress Tracker de affectUI,
 * bifurcado a SOLO LECTURA (`vendor/affectui/progress-tracker-clean`): cada
 * fila enlaza a su instrucción y pulsarla no acredita nada. Debajo, la tarea
 * del hito que toca, con el comando dentro del marco de código compartido.
 *
 * ESTE COMPONENTE SE RENDERIZA TAMBIÉN FUERA DE NEXT (`renderToString` en
 * `instalacion-renderiza.test.ts`): todo lo que pinta por dentro es síncrono
 * y los enlaces son `<a>` con la ruta sin prefijo de idioma, como siempre.
 */
export async function InstrumentationSpine({ steps }: { steps: StepState[] }) {
  const t = await getTranslations("dashboard");
  const current = steps.find((s) => s.status === "current");
  const hasUnavailable = steps.some((s) => s.status === "unavailable");
  const accountCta = current?.id === "Account created" || current?.id === "License active";
  const installCta = current?.id === "First real request";
  const hechos = steps.filter((s) => s.status === "done").length;
  // Con algún hito «no disponible» la cuenta de hechos no es la verdad entera:
  // no se enseña «N de 5», igual que el bloque del raíl.
  const cuenta = hasUnavailable ? t("instrumentationSpine.statusUnavailable") : t("instrumentationSpine.count", { done: hechos, total: steps.length });
  return (
    <section className="app-section" id="puesta-en-marcha">
      <div className="app-sec-head">
        <div>
          <p className="eyebrow">{t("instrumentationSpine.eyebrow")}</p>
          <h2 className="t-section">{t("instrumentationSpine.title")}</h2>
        </div>
      </div>
      <div className="spine">
        <ProgressTracker
          layout="steps"
          bare
          headingAs="h3"
          title={t("instrumentationSpine.trackerTitle")}
          countLabel={cuenta}
          done={hasUnavailable ? 0 : hechos}
          total={steps.length}
          steps={steps.map((s) => ({
            id: s.id,
            label: s.label,
            status: s.status,
            statusLabel:
              s.status === "done"
                ? t("instrumentationSpine.statusDone")
                : s.status === "current"
                  ? t("instrumentationSpine.statusNext")
                  : s.status === "unavailable"
                    ? t("instrumentationSpine.statusUnavailable")
                    : t("instrumentationSpine.statusPending"),
            href: destinoDelHito(s.id),
          }))}
        />
      </div>
      {current ? (
        <div className="spine-task">
          <p className="t">{t("instrumentationSpine.nextLabel", { label: current.label })}</p>
          {current.id === "SDK or gateway installed" ? (
            <>
              <CodeFrame
                ajustar
                etiqueta={t("installLicensePanel.terminal")}
                copiar={{ texto: INSTALL_CMD, etiqueta: t("copyButton.copy"), etiquetaCopiado: t("copyButton.copied") }}
              >
                <span className="c">{t("instrumentationSpine.installComment")}</span>
                {"\n"}
                <span>{INSTALL_CMD}</span>
              </CodeFrame>
              <p className="note">{t("instrumentationSpine.hintInstall")}</p>
              <div className="spine-actions">
                <a className="btn btn-primary btn-sm" href="/dashboard/install#sdk">{t("instrumentationSpine.linkSdk")}</a>
                <a className="btn btn-ghost btn-sm" href="/dashboard/install#gateway">{t("instrumentationSpine.linkGateway")}</a>
              </div>
            </>
          ) : (
            <>
              <p className="note">
                {current.id === "License active"
                  ? t("instrumentationSpine.hintLicense")
                  : current.id === "First real request"
                    ? t("instrumentationSpine.hintFirstRequest")
                    : current.id === "Report ready"
                      ? t("instrumentationSpine.hintReport")
                      : t("instrumentationSpine.hintDefault")}
              </p>
              {accountCta || installCta ? (
                <div className="spine-actions">
                  {accountCta ? <a className="btn btn-primary btn-sm" href="/dashboard/account">{t("instrumentationSpine.linkAccount")}</a> : null}
                  {installCta ? <a className="btn btn-primary btn-sm" href="/dashboard/install">{t("instrumentationSpine.linkInstall")}</a> : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : hasUnavailable ? (
        <p className="note" role="status">{t("instrumentationSpine.unavailableHint")}</p>
      ) : null}
    </section>
  );
}

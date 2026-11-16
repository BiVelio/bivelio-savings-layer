"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * Tiny client island: copy a snippet to the clipboard with feedback.
 *
 * Es el control de copia de las CREDENCIALES (licencia, clave de servicio):
 * por eso sigue siendo propio y no el del marco de código. El cambio de nombre
 * de un botón no lo lee ningún lector de pantalla, así que la confirmación va
 * además en una región viva.
 */
export function CopyButton({ text }: { text: string }) {
  const t = useTranslations("dashboard");
  const [ok, setOk] = useState(false);
  return (
    <>
      <button
        type="button"
        className="copybtn"
        data-copied={ok ? "" : undefined}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setOk(true);
            setTimeout(() => setOk(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          {ok ? (
            <path d="M3.5 8.4 6.6 11.3 12.5 4.9" />
          ) : (
            <>
              <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="2" />
              <path d="M10.5 3.75v-.25A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.25" />
            </>
          )}
        </svg>
        {ok ? t("copyButton.copied") : t("copyButton.copy")}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {ok ? t("copyButton.copied") : ""}
      </span>
    </>
  );
}

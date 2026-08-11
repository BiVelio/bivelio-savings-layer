"use client";

import { useTranslations, useLocale } from "next-intl";
import { useState } from "react";

import { CopyButton } from "./CopyButton";

type State = "idle" | "loading" | "done" | "error";

/**
 * License-key issuance (owner/pilot only — gated server-side). BV-SALA is paid:
 * self-serve keys arrive with Stripe checkout. For an allow-listed owner this mints
 * a real signed key and reveals it once; everyone else gets the "checkout coming
 * online" message from the API.
 */
export function TrialKeyButton() {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const [state, setState] = useState<State>("idle");
  const [token, setToken] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [msg, setMsg] = useState("");

  async function getKey() {
    setState("loading");
    setMsg("");
    try {
      // 1) La licencia PAGADA, si existe. El webhook de Stripe la emitía y
      // descartaba el token, así que quien pagaba no tenía NINGUNA forma de
      // recogerlo y el SDK, fail-closed, no arrancaba ni una vez. Se pide primero
      // porque es la que corresponde a un cliente de pago; 404 significa
      // simplemente que aún no hay ninguna.
      const actual = await fetch("/api/license/current");
      if (actual.ok) {
        const json = (await actual.json()) as { token?: string; expiresAt?: string };
        if (json.token) {
          setToken(json.token);
          setExpiresAt(json.expiresAt ?? "");
          setState("done");
          return;
        }
      }

      // 2) Sin licencia de pago: la ruta interna (allow-list del dueño, o el 402
      // que explica que se entra por checkout).
      const res = await fetch("/api/license/trial", { method: "POST" });
      const json = (await res.json()) as {
        token?: string;
        expiresAt?: string;
        error?: string;
        code?: string;
      };
      if (!res.ok || !json.token) {
        setState("error");
        // El servidor manda un CÓDIGO y se traduce aquí. Antes se pintaba
        // `json.error` tal cual: una frase en inglés que además decía que el pago
        // de autoservicio «aún no está habilitado» — justo lo que el cliente
        // acababa de usar. Los dos motivos llevan a acciones opuestas, así que
        // cada uno tiene su texto.
        const porCodigo: Record<string, string> = {
          pago_en_curso: t("trialKeyButton.errPaymentPending"),
          sin_suscripcion: t("trialKeyButton.errNoSubscription"),
        };
        setMsg((json.code && porCodigo[json.code]) || t("trialKeyButton.errCreate"));
        return;
      }
      setToken(json.token);
      setExpiresAt(json.expiresAt ?? "");
      setState("done");
    } catch {
      setState("error");
      setMsg(t("trialKeyButton.errNetwork"));
    }
  }

  if (state === "done") {
    return (
      <div className="trialkey">
        <div className="ck-note" style={{ margin: "0 0 6px" }}>
          {t("trialKeyButton.keyLabel", {
            suffix: expiresAt
              ? t("trialKeyButton.validUntil", { date: new Date(expiresAt).toLocaleDateString(locale) })
              : "",
          })}
        </div>
        <div className="code2">
          <span style={{ wordBreak: "break-all" }}>{token}</span>
          <CopyButton text={token} />
        </div>
        <p className="ck-note" style={{ marginTop: "6px" }}>
          {t.rich("trialKeyButton.pasteHint", {
            code: () => <code>createSavingsLayer({"{ licenseKey }"})</code>,
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="trialkey">
      <button
        type="button"
        className="btn btn-primary"
        onClick={getKey}
        disabled={state === "loading"}
        style={{ padding: "10px 16px" }}
      >
        {state === "loading" ? t("trialKeyButton.issuing") : t("trialKeyButton.getKey")}
      </button>
      {state === "error" ? (
        <p className="ck-note" style={{ color: "var(--danger)", marginTop: "6px" }}>{msg}</p>
      ) : (
        <p className="ck-note" style={{ marginTop: "6px" }}>
          {t("trialKeyButton.priceNote", { monthly: "€4", yearly: "€39" })}
        </p>
      )}
    </div>
  );
}

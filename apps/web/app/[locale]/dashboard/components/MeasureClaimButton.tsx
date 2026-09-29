"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { CopyButton } from "./CopyButton";

type State = "idle" | "loading" | "done" | "error";

/**
 * EL ALTA SIN TARJETA de la licencia gratuita Medir: un botón, una llamada a
 * /api/license/measure y la clave a la vista. El servidor decide (cuenta
 * verificada, una organización por cuenta, la que ya paga no la recibe…) y
 * devuelve un CÓDIGO que aquí se traduce: nada de frases en inglés del servidor.
 */
export function MeasureClaimButton({ seats }: { seats: number }) {
  const t = useTranslations("dashboard.measurePlan");
  const [state, setState] = useState<State>("idle");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");

  async function reclamar() {
    setState("loading");
    setMsg("");
    try {
      const res = await fetch("/api/license/measure", { method: "POST" });
      const json = (await res.json()) as { token?: string; code?: string };
      if (!res.ok || !json.token) {
        const porCodigo: Record<string, string> = {
          email_not_verified: t("errEmailNotVerified"),
          disposable_email: t("errDisposableEmail"),
          one_org_per_account: t("errOneOrgPerAccount"),
          already_licensed: t("errAlreadyLicensed"),
          measure_blocked: t("errBlocked"),
          role: t("errRole"),
          sign_in: t("errSignIn"),
        };
        setMsg((json.code && porCodigo[json.code]) || t("errGeneric"));
        setState("error");
        return;
      }
      setToken(json.token);
      setState("done");
    } catch {
      setMsg(t("errGeneric"));
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div className="trialkey">
        <div className="ck-note" style={{ margin: "0 0 6px" }}>{t("keyLabel")}</div>
        <div className="code2">
          <span style={{ wordBreak: "break-all" }}>{token}</span>
          <CopyButton text={token} />
        </div>
        <p className="ck-note" style={{ marginTop: "6px" }}>{t("keyHint")}</p>
      </div>
    );
  }

  return (
    <div className="trialkey">
      <p className="ck-note" style={{ marginTop: 0 }}>{t("body", { seats })}</p>
      <button
        type="button"
        className="btn"
        onClick={reclamar}
        disabled={state === "loading"}
        style={{ padding: "10px 16px" }}
      >
        {state === "loading" ? t("claiming") : t("claim")}
      </button>
      {state === "error" ? (
        <p className="ck-note" style={{ color: "var(--danger)", marginTop: "6px" }}>{msg}</p>
      ) : null}
    </div>
  );
}

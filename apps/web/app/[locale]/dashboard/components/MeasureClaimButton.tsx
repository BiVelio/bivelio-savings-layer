"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { VERSION_MEDIR_AHORRA } from "@/lib/license/medir-publico";
import { Spinner } from "@/vendor/affectui/spinner-clean";

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
      <div className="trialkey keyreveal">
        <div className="ck-note keyreveal-k">{t("keyLabel")}</div>
        <div className="code2 keyreveal-v">
          <span className="keyreveal-token">{token}</span>
          <CopyButton text={token} />
        </div>
        <p className="ck-note keyreveal-n">{t("keyHint")}</p>
      </div>
    );
  }

  return (
    <div className="trialkey">
      {/* Desde qué versión ahorra Measure: la misma constante que la tarjeta de
          /pricing y el alta (lib/license/medir-publico.ts), por parámetro. */}
      <p className="ck-note sak-lede">{t("body", { seats, saves: VERSION_MEDIR_AHORRA })}</p>
      <button type="button" className="btn btn-ghost sak-btn" onClick={reclamar} disabled={state === "loading"}>
        {state === "loading" ? <Spinner size={15} /> : null}
        {state === "loading" ? t("claiming") : t("claim")}
      </button>
      {state === "error" ? (
        <p className="ck-note sak-err" role="alert">{msg}</p>
      ) : null}
    </div>
  );
}

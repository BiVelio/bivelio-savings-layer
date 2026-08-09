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
      const res = await fetch("/api/license/trial", { method: "POST" });
      const json = (await res.json()) as {
        token?: string;
        expiresAt?: string;
        error?: string;
      };
      if (!res.ok || !json.token) {
        setState("error");
        setMsg(json.error ?? t("trialKeyButton.errCreate"));
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

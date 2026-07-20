"use client";

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
        setMsg(json.error ?? "Could not issue a license key.");
        return;
      }
      setToken(json.token);
      setExpiresAt(json.expiresAt ?? "");
      setState("done");
    } catch {
      setState("error");
      setMsg("Network error — please try again.");
    }
  }

  if (state === "done") {
    return (
      <div className="trialkey">
        <div className="ck-note" style={{ margin: "0 0 6px" }}>
          your license key{expiresAt ? ` · valid until ${new Date(expiresAt).toLocaleDateString()}` : ""} — shown once, copy it now
        </div>
        <div className="code2">
          <span style={{ wordBreak: "break-all" }}>{token}</span>
          <CopyButton text={token} />
        </div>
        <p className="ck-note" style={{ marginTop: "6px" }}>
          Paste it into <code>createSavingsLayer({"{ licenseKey }"})</code> to unlock the SDK.
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
        {state === "loading" ? "Issuing…" : "Get your license key →"}
      </button>
      {state === "error" ? (
        <p className="ck-note" style={{ color: "var(--warn)", marginTop: "6px" }}>{msg}</p>
      ) : (
        <p className="ck-note" style={{ marginTop: "6px" }}>
          $4 / seat / month or $39 / seat / year. Self-serve checkout is coming online — the key unlocks the SDK in your own app.
        </p>
      )}
    </div>
  );
}

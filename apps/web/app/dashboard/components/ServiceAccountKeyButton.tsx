"use client";

import { useState } from "react";

import { CopyButton } from "./CopyButton";

type State = "idle" | "loading" | "done" | "error";

/**
 * Mints a real service-account key (bvk_…) via POST /api/service-accounts and
 * reveals it ONCE. This is the machine credential the SDK uses to report
 * counts-only usage (`serviceAccountKey`). Only the sha256 hash is stored server
 * side, so the plaintext is shown a single time here.
 */
export function ServiceAccountKeyButton() {
  const [state, setState] = useState<State>("idle");
  const [token, setToken] = useState("");
  const [prefix, setPrefix] = useState("");
  const [msg, setMsg] = useState("");

  async function mint() {
    setState("loading");
    setMsg("");
    try {
      const res = await fetch("/api/service-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "default" }),
      });
      const json = (await res.json()) as { key?: string; keyPrefix?: string; error?: string };
      if (!res.ok || !json.key) {
        setState("error");
        setMsg(json.error ?? "Could not create a key.");
        return;
      }
      setToken(json.key);
      setPrefix(json.keyPrefix ?? "");
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
          your service-account key{prefix ? ` · ${prefix}…` : ""} — shown once, copy it now
        </div>
        <div className="code2">
          <span style={{ wordBreak: "break-all" }}>{token}</span>
          <CopyButton text={token} />
        </div>
        <p className="ck-note" style={{ marginTop: "6px" }}>
          Pass it as <code>serviceAccountKey</code> so the SDK reports counts-only usage.
        </p>
      </div>
    );
  }

  return (
    <div className="trialkey">
      <button
        type="button"
        className="btn btn-primary"
        onClick={mint}
        disabled={state === "loading"}
        style={{ padding: "10px 16px" }}
      >
        {state === "loading" ? "Creating…" : "Create a service-account key →"}
      </button>
      {state === "error" ? (
        <p className="ck-note" style={{ color: "var(--warn)", marginTop: "6px" }}>{msg}</p>
      ) : (
        <p className="ck-note" style={{ marginTop: "6px" }}>
          Only the hash is stored. It authenticates counts-only usage metering — never your prompts.
        </p>
      )}
    </div>
  );
}

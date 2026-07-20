"use client";

import { useState } from "react";

import { CopyButton } from "./CopyButton";

type CreateState = "idle" | "loading" | "done" | "error";
type TestState = "idle" | "testing" | "valid" | "invalid" | "error";

/**
 * Create + verify a service-account key (bvk_…). "Create" mints a real key via
 * POST /api/service-accounts and reveals it once. "Test my key" proves any key is
 * live by hitting the real metering endpoint with an empty batch — 202 = valid,
 * 401 = not recognized. Creating a key auto-fills the tester so the customer gets
 * instant confirmation.
 */
export function ServiceAccountKeySection() {
  const [cState, setCState] = useState<CreateState>("idle");
  const [token, setToken] = useState("");
  const [prefix, setPrefix] = useState("");
  const [cMsg, setCMsg] = useState("");

  const [testInput, setTestInput] = useState("");
  const [tState, setTState] = useState<TestState>("idle");
  const [tMsg, setTMsg] = useState("");

  async function mint() {
    setCState("loading");
    setCMsg("");
    try {
      const res = await fetch("/api/service-accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "default" }),
      });
      const json = (await res.json()) as { key?: string; keyPrefix?: string; error?: string };
      if (!res.ok || !json.key) {
        setCState("error");
        setCMsg(json.error ?? "Could not create a key.");
        return;
      }
      setToken(json.key);
      setPrefix(json.keyPrefix ?? "");
      setTestInput(json.key); // auto-fill the tester with the fresh key
      setTState("idle");
      setCState("done");
    } catch {
      setCState("error");
      setCMsg("Network error — please try again.");
    }
  }

  async function test() {
    const key = testInput.trim();
    if (!key) return;
    setTState("testing");
    setTMsg("");
    try {
      // An empty batch authenticates the key without writing any usage.
      const res = await fetch("/api/metering/usage", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "[]",
      });
      if (res.status === 202) {
        setTState("valid");
      } else if (res.status === 401) {
        setTState("invalid");
        setTMsg("Not recognized — check for typos, or create a new key above.");
      } else {
        setTState("error");
        setTMsg(`Unexpected response (${res.status}). Try again in a moment.`);
      }
    } catch {
      setTState("error");
      setTMsg("Network error — please try again.");
    }
  }

  return (
    <div>
      {cState === "done" ? (
        <div className="trialkey">
          <div className="ck-note" style={{ margin: "0 0 6px" }}>
            your service-account key{prefix ? ` · ${prefix}…` : ""} — shown once, copy it now
          </div>
          <div className="code2">
            <span style={{ wordBreak: "break-all" }}>{token}</span>
            <CopyButton text={token} />
          </div>
          <p className="ck-note" style={{ marginTop: "6px" }}>
            Pass it as <code>serviceAccountKey</code>. It&apos;s pre-filled below — hit{" "}
            <b>Test my key</b> to confirm it&apos;s live.
          </p>
        </div>
      ) : (
        <div className="trialkey">
          <button
            type="button"
            className="btn btn-primary"
            onClick={mint}
            disabled={cState === "loading"}
            style={{ padding: "10px 16px" }}
          >
            {cState === "loading" ? "Creating…" : "Create a service-account key →"}
          </button>
          {cState === "error" ? (
            <p className="ck-note" style={{ color: "var(--warn)", marginTop: "6px" }}>{cMsg}</p>
          ) : (
            <p className="ck-note" style={{ marginTop: "6px" }}>
              Only the hash is stored. It authenticates counts-only usage metering — never your prompts.
            </p>
          )}
        </div>
      )}

      <div className="keytester">
        <div className="ck-note" style={{ margin: "0 0 6px" }}>Verify a key is live</div>
        <div className="kt-row">
          <input
            className="kt-input"
            type="text"
            inputMode="text"
            placeholder="bvk_…"
            value={testInput}
            onChange={(e) => {
              setTestInput(e.target.value);
              setTState("idle");
              setTMsg("");
            }}
            spellCheck={false}
            autoComplete="off"
            aria-label="Service-account key to test"
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={test}
            disabled={tState === "testing" || testInput.trim().length === 0}
          >
            {tState === "testing" ? "Testing…" : "Test my key"}
          </button>
        </div>
        {tState === "valid" && (
          <p className="kt-result kt-ok">✓ Valid — your SDK can report usage with this key.</p>
        )}
        {(tState === "invalid" || tState === "error") && <p className="kt-result kt-bad">✗ {tMsg}</p>}
      </div>
    </div>
  );
}

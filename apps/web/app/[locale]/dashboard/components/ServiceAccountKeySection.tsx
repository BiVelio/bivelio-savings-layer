"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("dashboard");
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
        setCMsg(json.error ?? t("serviceAccountKeySection.errCreate"));
        return;
      }
      setToken(json.key);
      setPrefix(json.keyPrefix ?? "");
      setTestInput(json.key); // auto-fill the tester with the fresh key
      setTState("idle");
      setCState("done");
    } catch {
      setCState("error");
      setCMsg(t("serviceAccountKeySection.errNetwork"));
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
        setTMsg(t("serviceAccountKeySection.errNotRecognized"));
      } else {
        setTState("error");
        setTMsg(t("serviceAccountKeySection.errUnexpected", { status: res.status }));
      }
    } catch {
      setTState("error");
      setTMsg(t("serviceAccountKeySection.errNetwork"));
    }
  }

  return (
    <div>
      {cState === "done" ? (
        <div className="trialkey">
          <div className="ck-note" style={{ margin: "0 0 6px" }}>
            {t("serviceAccountKeySection.keyLabel", { suffix: prefix ? ` · ${prefix}…` : "" })}
          </div>
          <div className="code2">
            <span style={{ wordBreak: "break-all" }}>{token}</span>
            <CopyButton text={token} />
          </div>
          <p className="ck-note" style={{ marginTop: "6px" }}>
            {t.rich("serviceAccountKeySection.passHint", {
              code: (chunks) => <code>{chunks}</code>,
              b: (chunks) => <b>{chunks}</b>,
            })}
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
            {cState === "loading"
              ? t("serviceAccountKeySection.creating")
              : t("serviceAccountKeySection.createKey")}
          </button>
          {cState === "error" ? (
            <p className="ck-note" style={{ color: "var(--danger)", marginTop: "6px" }}>{cMsg}</p>
          ) : (
            <p className="ck-note" style={{ marginTop: "6px" }}>
              {t("serviceAccountKeySection.hashNote")}
            </p>
          )}
        </div>
      )}

      <div className="keytester">
        <div className="ck-note" style={{ margin: "0 0 6px" }}>{t("serviceAccountKeySection.verifyTitle")}</div>
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
            aria-label={t("serviceAccountKeySection.testInputAria")}
          />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={test}
            disabled={tState === "testing" || testInput.trim().length === 0}
          >
            {tState === "testing" ? t("serviceAccountKeySection.testing") : t("serviceAccountKeySection.testMyKey")}
          </button>
        </div>
        {tState === "valid" && (
          <p className="kt-result kt-ok">{t("serviceAccountKeySection.validResult")}</p>
        )}
        {(tState === "invalid" || tState === "error") && <p className="kt-result kt-bad">✗ {tMsg}</p>}
      </div>
    </div>
  );
}

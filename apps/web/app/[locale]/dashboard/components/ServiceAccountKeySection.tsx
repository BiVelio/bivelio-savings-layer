"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { CopyButton } from "./CopyButton";

type CreateState = "idle" | "loading" | "done" | "error";
type TestState = "idle" | "testing" | "valid" | "invalid" | "error";

interface ClaveViva {
  id: string;
  label: string;
  key_prefix: string;
  last_used_at: string | null;
}

/**
 * Create + verify a service-account key (bvk_…). "Create" mints a real key via
 * POST /api/service-accounts and reveals it once. "Test my key" proves any key is
 * live by hitting the real metering endpoint with an empty batch — 202 = valid,
 * 401 = not recognized. Creating a key auto-fills the tester so the customer gets
 * instant confirmation.
 */
export function ServiceAccountKeySection() {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  /* La fecha se pinta en el idioma del panel. Antes salía el ISO crudo
     («2026-08-12») en los 12 locales, y además desplazado a UTC. Este componente
     solo renderiza en cliente tras un fetch, así que formatear aquí no puede
     provocar el desajuste de hidratación que sí obliga a formatear el precio en
     servidor. */
  const fecha = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  const [cState, setCState] = useState<CreateState>("idle");
  const [token, setToken] = useState("");
  const [prefix, setPrefix] = useState("");
  const [cMsg, setCMsg] = useState("");

  const [testInput, setTestInput] = useState("");
  const [tState, setTState] = useState<TestState>("idle");
  const [tMsg, setTMsg] = useState("");

  // LAS CLAVES VIVAS Y SU REVOCACIÓN. No existía ninguna de las dos cosas: el
  // panel solo sabía acuñar. Como la `bvk_` es la credencial que descarga la
  // licencia COMPLETA de la organización, no poder desactivarla convertía la
  // marcha de un empleado con el portátil en un problema sin solución.
  const [claves, setClaves] = useState<ClaveViva[] | null>(null);
  const [revocando, setRevocando] = useState<string | null>(null);
  const [rMsg, setRMsg] = useState("");
  /** Id de la clave para la que se está pidiendo confirmación. Revocar no tiene
   *  vuelta atrás, así que no puede ser un solo clic. */
  const [confirmando, setConfirmando] = useState<string | null>(null);
  /** El listado falló: sin esto, la revocación desaparecía del panel EN SILENCIO
   *  y el cliente no podía saber que la función existe. */
  const [listaFallo, setListaFallo] = useState(false);

  const cargarClaves = useCallback(async () => {
    try {
      const res = await fetch("/api/service-accounts");
      if (!res.ok) {
        setListaFallo(true);
        return;
      }
      const json = (await res.json()) as { keys?: ClaveViva[] };
      setClaves(json.keys ?? []);
      setListaFallo(false);
    } catch {
      setListaFallo(true);
    }
  }, []);

  useEffect(() => {
    void cargarClaves();
  }, [cargarClaves]);

  async function revocar(clave: ClaveViva) {
    setRevocando(clave.id);
    setRMsg("");
    try {
      const res = await fetch("/api/service-accounts", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: clave.id }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setRMsg(json.error ?? t("serviceAccountKeySection.errRevoke"));
        setRevocando(null);
        return;
      }
      // Se quita de la lista ANTES de recargar: si la recarga fallara, dejar la
      // clave muerta pintada como viva sería peor que cualquier desincronización
      // —el cliente creería que sigue teniendo acceso quien ya no lo tiene—.
      setClaves((prev) => (prev ?? []).filter((k) => k.id !== clave.id));
      setConfirmando(null);
      await cargarClaves();
      setRevocando(null);
    } catch {
      setRMsg(t("serviceAccountKeySection.errNetwork"));
      setRevocando(null);
    }
  }

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
      void cargarClaves(); // que la nueva aparezca en la lista revocable
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

      {/* CLAVES VIVAS + REVOCACIÓN. Solo se pinta si hay alguna: una lista vacía
          en un panel recién estrenado es ruido. */}
      {listaFallo ? (
        <p className="ck-note" style={{ marginTop: 10, color: "var(--danger)" }} role="alert">
          {t("serviceAccountKeySection.errList")}
        </p>
      ) : null}

      {claves && claves.length > 0 ? (
        <div className="keytester" style={{ marginTop: 10 }}>
          <div className="ck-note" style={{ margin: "0 0 6px" }}>
            {t("serviceAccountKeySection.liveKeysTitle")}
          </div>
          {claves.map((c) => (
            <div key={c.id} className="keycard" style={{ marginTop: 6 }}>
              <div>
                <div className="k">{c.key_prefix}… <span style={{ opacity: .7 }}>· {c.label}</span></div>
                <div className="ck-note" style={{ margin: 0 }}>
                  {c.last_used_at
                    ? t("serviceAccountKeySection.lastUsed", { when: fecha(c.last_used_at) })
                    : t("serviceAccountKeySection.neverUsed")}
                </div>
              </div>
              {confirmando === c.id ? (
                /* Dos pasos: revocar no tiene vuelta atrás y era un solo clic. */
                <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <span className="ck-note" style={{ margin: 0 }}>
                    {t("serviceAccountKeySection.revokeConfirm")}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void revocar(c)}
                    disabled={revocando !== null}
                    aria-label={t("serviceAccountKeySection.revokeYesAria", { prefix: c.key_prefix })}
                  >
                    {revocando === c.id
                      ? t("serviceAccountKeySection.revoking")
                      : t("serviceAccountKeySection.revokeYes")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmando(null)}
                    disabled={revocando !== null}
                  >
                    {t("serviceAccountKeySection.revokeNo")}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setConfirmando(c.id)}
                  disabled={revocando !== null}
                  /* Sin esto, tres botones «Revocar» son indistinguibles para un
                     lector de pantalla — y el error se paga borrando la clave que
                     no era. */
                  aria-label={t("serviceAccountKeySection.revokeAria", { prefix: c.key_prefix })}
                >
                  {t("serviceAccountKeySection.revoke")}
                </button>
              )}
            </div>
          ))}
          <p className="ck-note" style={{ marginTop: 6 }}>
            {t("serviceAccountKeySection.revokeNote")}
          </p>
          {rMsg ? (
            <p className="ck-note" style={{ color: "var(--danger)", marginTop: 6 }} role="alert">
              {rMsg}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

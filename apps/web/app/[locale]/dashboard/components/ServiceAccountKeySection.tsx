"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { estadoDeLaPrueba, type EstadoDeLaPrueba } from "../prueba-de-clave";
import { KeyIcon } from "@/app/components/icons";
import { Badge } from "@/vendor/affectui/badge-clean";
import { AlertDialog } from "@/vendor/affectui/dialog";
import { Spinner } from "@/vendor/affectui/spinner-clean";
import { TextField } from "@/vendor/affectui/text-field-clean";

import { CopyButton } from "./CopyButton";

type CreateState = "idle" | "loading" | "done" | "error";
type TestState = "idle" | "testing" | EstadoDeLaPrueba;

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
 * 401 = not recognized, 402 = recognized but the organization has no active
 * license or subscription (see `estadoDeLaPrueba`). Creating a key auto-fills the
 * tester so the customer gets instant confirmation.
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
      // 402 = clave buena en una org sin licencia ni suscripción: tiene su propio
      // mensaje (keyNoPlan). Antes caía en «Unexpected response… Try again», que
      // presentaba una clave válida como un fallo pasajero que no se cura
      // reintentando. Ver `estadoDeLaPrueba`.
      const estado = estadoDeLaPrueba(res.status);
      setTState(estado);
      if (estado === "invalid") {
        setTMsg(t("serviceAccountKeySection.errNotRecognized"));
      } else if (estado === "error") {
        setTMsg(t("serviceAccountKeySection.errUnexpected", { status: res.status }));
      }
    } catch {
      setTState("error");
      setTMsg(t("serviceAccountKeySection.errNetwork"));
    }
  }

  /** La clave para la que se pide confirmación (o ninguna). */
  const claveAConfirmar = (claves ?? []).find((c) => c.id === confirmando) ?? null;

  return (
    <div className="sak">
      {cState === "done" ? (
        <div className="trialkey keyreveal">
          <div className="ck-note keyreveal-k">
            {t("serviceAccountKeySection.keyLabel", { suffix: prefix ? ` · ${prefix}…` : "" })}
          </div>
          <div className="code2 keyreveal-v">
            <span className="keyreveal-token">{token}</span>
            <CopyButton text={token} />
          </div>
          <p className="ck-note keyreveal-n">
            {t.rich("serviceAccountKeySection.passHint", {
              code: (chunks) => <code>{chunks}</code>,
              b: (chunks) => <b>{chunks}</b>,
            })}
          </p>
        </div>
      ) : (
        <div className="trialkey">
          <button type="button" className="btn btn-primary sak-btn" onClick={mint} disabled={cState === "loading"}>
            {cState === "loading" ? <Spinner size={15} /> : null}
            {cState === "loading"
              ? t("serviceAccountKeySection.creating")
              : t("serviceAccountKeySection.createKey")}
          </button>
          {cState === "error" ? (
            <p className="ck-note sak-err" role="alert">{cMsg}</p>
          ) : (
            <p className="ck-note sak-hint">
              {t("serviceAccountKeySection.hashNote")}
            </p>
          )}
        </div>
      )}

      <div className="keytester">
        <div className="kt-row">
          <TextField
            className="kt-field"
            inputClassName="kt-mono"
            label={t("serviceAccountKeySection.verifyTitle")}
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
            icon={<KeyIcon />}
          />
          <button
            type="button"
            className="btn btn-ghost sak-btn"
            onClick={test}
            disabled={tState === "testing" || testInput.trim().length === 0}
          >
            {tState === "testing" ? <Spinner size={15} /> : null}
            {tState === "testing" ? t("serviceAccountKeySection.testing") : t("serviceAccountKeySection.testMyKey")}
          </button>
        </div>
        {tState === "valid" && (
          <p className="kt-result kt-ok" role="status">{t("serviceAccountKeySection.validResult")}</p>
        )}
        {tState === "noPlan" && (
          <p className="kt-result kt-warn" role="status">
            {t("serviceAccountKeySection.keyNoPlan")}
          </p>
        )}
        {(tState === "invalid" || tState === "error") && <p className="kt-result kt-bad" role="alert">✗ {tMsg}</p>}
      </div>

      {/* CLAVES VIVAS + REVOCACIÓN. Solo se pinta si hay alguna: una lista vacía
          en un panel recién estrenado es ruido. */}
      {listaFallo ? (
        <p className="ck-note sak-err" role="alert">
          {t("serviceAccountKeySection.errList")}
        </p>
      ) : null}

      {claves && claves.length > 0 ? (
        <div className="keytester sak-live">
          <div className="sak-live-head">
            <span className="sak-live-t">{t("serviceAccountKeySection.liveKeysTitle")}</span>
            <Badge size="sm" count={claves.length} />
          </div>
          <ul className="sak-list">
            {claves.map((c) => (
              <li key={c.id} className="sak-row">
                <span className="ins-key-ic" aria-hidden>
                  <KeyIcon />
                </span>
                <div className="sak-row-txt">
                  <div className="k">
                    {c.key_prefix}… <span className="sak-row-label">· {c.label}</span>
                  </div>
                  <Badge size="sm" tone={c.last_used_at ? "success" : "neutral"} dot>
                    {c.last_used_at
                      ? t("serviceAccountKeySection.lastUsed", { when: fecha(c.last_used_at) })
                      : t("serviceAccountKeySection.neverUsed")}
                  </Badge>
                </div>
                {/* Dos pasos: revocar no tiene vuelta atrás. El segundo es el
                    diálogo de abajo; `revocar` solo corre desde su «Sí, revocar». */}
                <button
                  type="button"
                  className="btn btn-ghost sak-revoke"
                  onClick={() => setConfirmando(c.id)}
                  disabled={revocando !== null}
                  aria-haspopup="dialog"
                  /* Sin esto, tres botones «Revocar» son indistinguibles para un
                     lector de pantalla — y el error se paga borrando la clave que
                     no era. */
                  aria-label={t("serviceAccountKeySection.revokeAria", { prefix: c.key_prefix })}
                >
                  {revocando === c.id ? t("serviceAccountKeySection.revoking") : t("serviceAccountKeySection.revoke")}
                </button>
              </li>
            ))}
          </ul>
          <p className="ck-note sak-hint">
            {t("serviceAccountKeySection.revokeNote")}
          </p>
          {rMsg ? (
            <p className="ck-note sak-err" role="alert">
              {rMsg}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* LA CONFIRMACIÓN. Mismo `revocar(c)` de siempre, y solo tras el «Sí,
          revocar» explícito; Escape o «Cancelar» no tocan nada. El diálogo queda
          abierto y ocupado mientras la petición está en curso. */}
      <AlertDialog
        danger
        open={claveAConfirmar !== null}
        onOpenChange={(abierto) => {
          if (!abierto) setConfirmando(null);
        }}
        title={t("serviceAccountKeySection.revokeConfirm")}
        description={t("serviceAccountKeySection.revokeNote")}
        confirmLabel={t("serviceAccountKeySection.revokeYes")}
        cancelLabel={t("serviceAccountKeySection.revokeNo")}
        onConfirm={() => (claveAConfirmar ? revocar(claveAConfirmar) : undefined)}
      >
        {claveAConfirmar ? (
          <p className="sak-dialog-key">
            <span className="ins-key-ic" aria-hidden>
              <KeyIcon />
            </span>
            <span className="k">
              {claveAConfirmar.key_prefix}… <span className="sak-row-label">· {claveAConfirmar.label}</span>
            </span>
          </p>
        ) : null}
      </AlertDialog>
    </div>
  );
}

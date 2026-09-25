import { getTranslations } from "next-intl/server";

import { librosConPiezaDelBanco } from "@/lib/bench/sdk-instalado";

import type { AbArtifact } from "../data";
import { pct, money, LEDGER_COLOR } from "../format";

/** The four REFERENCE ledgers (never summed). Note: these are the reference
 *  levers — the live rail measures a different four (provider_cached replaces
 *  output_restriction), so we never map one onto the other. */

/**
 * Qué palanca del banco alimenta cada libro. Solo se declaran los pares
 * inequívocos: un libro «proven» nunca consulta esta tabla, así que
 * `semanticCache` (que desemboca en `avoided_calls`, un libro que otras
 * palancas sí prueban) no puede apagar la tarjeta de un ahorro real.
 */
const PALANCA_DEL_LIBRO: Record<string, string> = {
  provider_cached: "providerPrefixCache",
  output_codebook: "outputCodebook",
};

/**
 * El propio artefacto avisa: «Una palanca NO ejercitada produce las mismas
 * cifras que una que no ahorra. No leas su cero como una medición.» Las
 * tarjetas ignoraban ese aviso y pintaban 0% con la misma cara que un 43%
 * medido. Un libro sin probar cuya palanca está declarada en
 * `levers.notExercised` no es un fracaso medido: es una tirada que no llegó
 * a ejercitarlo, y se pinta como tal.
 */
function sinEjercitar(ab: AbArtifact, ledger: string, proven: boolean): boolean {
  if (proven) return false;
  const palanca = PALANCA_DEL_LIBRO[ledger];
  if (!palanca) return false;
  return (ab.levers?.notExercised ?? []).some((l) => l.palanca === palanca);
}

export async function ReferenceLedgerCards({ ab }: { ab: AbArtifact }) {
  const t = await getTranslations("dashboard");
  // Un libro que agrega un escenario cuyo ahorro salió de una pieza que npm no
  // trae (el compresor del banco) no se anuncia con cifra: mezclaría lo que el
  // paquete entrega con lo que no. Vacío cuando la tirada midió lo instalado.
  const conPiezaDelBanco = librosConPiezaDelBanco(ab);
  return (
    <>
      <div className="kpis">
        {ab.ledgers.map((l) => {
          const pos = l.savings.point >= 0;
          if (conPiezaDelBanco.has(l.ledger)) {
            return (
              <div key={l.ledger} className="kpi">
                <div className="n">
                  <span className="ltag" style={{ background: LEDGER_COLOR[l.ledger] ?? "var(--muted)" }} />
                  {l.ledger}
                </div>
                <div className="v empty ck-num">—</div>
                <div className="sub">{t("referenceLedgerCards.benchOnly")}</div>
              </div>
            );
          }
          if (sinEjercitar(ab, l.ledger, l.proven)) {
            return (
              <div key={l.ledger} className="kpi">
                <div className="n">
                  <span className="ltag" style={{ background: LEDGER_COLOR[l.ledger] ?? "var(--muted)" }} />
                  {l.ledger}
                </div>
                <div className="v empty ck-num">—</div>
                <div className="sub">{t("referenceLedgerCards.notExercised")}</div>
              </div>
            );
          }
          return (
            <div key={l.ledger} className="kpi">
              <div className="n">
                <span className="ltag" style={{ background: LEDGER_COLOR[l.ledger] ?? "var(--muted)" }} />
                {l.ledger}
              </div>
              <div className={`v ${pos ? "pos" : "neg"}`}>{pct(l.savings.point)}</div>
              <div className="lo">95% ≥ {pct(l.savings.lower)} · Δ {money(l.deltaCost)}</div>
              <div className="sub">{ab.mode === "LIVE" ? (l.proven ? t("referenceLedgerCards.proven") : t("referenceLedgerCards.notProven")) : t("referenceLedgerCards.estimatedMock")}</div>
            </div>
          );
        })}
      </div>
      <p className="footnote">
        {t.rich("referenceLedgerCards.footnoteMain", { b: (chunks) => <b>{chunks}</b> })}{" "}
        {ab.reconciliation.reconciled
          ? t("referenceLedgerCards.reconciledNote")
          : t("referenceLedgerCards.residualNote", { residual: money(ab.reconciliation.residual) })}{" "}
        {t.rich("referenceLedgerCards.footnoteReference", { b: (chunks) => <b>{chunks}</b> })}
      </p>
    </>
  );
}

import { getTranslations } from "next-intl/server";

import { librosConPiezaDelBanco } from "@/lib/bench/sdk-instalado";

import { Detalle, Termino } from "@/app/components/evidencia/Termino";
import { EvidenceBadge } from "@/app/components/ui";
import { Badge } from "@/vendor/affectui/badge";

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
  const tu = await getTranslations("ui");
  // Un libro que agrega un escenario cuyo ahorro salió de una pieza que npm no
  // trae (el compresor del banco) no se anuncia con cifra: mezclaría lo que el
  // paquete entrega con lo que no. Vacío cuando la tirada midió lo instalado.
  const conPiezaDelBanco = librosConPiezaDelBanco(ab);
  // La escala de las bandas, común a todas las tarjetas: así un intervalo ancho
  // se VE más ancho que el del libro de al lado.
  const cifrados = ab.ledgers.filter((l) => !conPiezaDelBanco.has(l.ledger) && !sinEjercitar(ab, l.ledger, l.proven));
  const dmin = Math.min(-0.05, ...cifrados.map((l) => l.savings.lower - 0.03));
  const dmax = Math.max(0.6, ...cifrados.map((l) => l.savings.upper + 0.03));
  const xp = (v: number) => Math.max(0, Math.min(100, ((v - dmin) / (dmax - dmin)) * 100));
  // El nombre del libro abre sus escenarios (Hover Card): qué filas de la tabla
  // de abajo lo alimentan. Solo nombres y tipo: las cifras están en la tabla.
  const cabecera = (ledger: string) => {
    const suyos = ab.scenarios.filter((s) => s.ledger === ledger);
    const nombre = (
      <>
        <span className="ltag" style={{ background: LEDGER_COLOR[ledger] ?? "var(--muted)" }} />
        {ledger}
      </>
    );
    if (suyos.length === 0) return <div className="n">{nombre}</div>;
    return (
      <div className="n">
        <Detalle
          className="lg-name"
          nombre={t("referenceLedgerCards.scenarios")}
          contenido={
            <div className="lg-card">
              <p className="lg-card-t">{t("referenceLedgerCards.scenarios")}</p>
              <ul className="lg-card-l">
                {suyos.map((s) => (
                  <li key={s.name}>
                    <span>{s.name}</span>
                    <span className="mono">{s.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          }
        >
          {nombre}
        </Detalle>
      </div>
    );
  };
  return (
    <>
      <div className="kpis prf-kpis">
        {ab.ledgers.map((l) => {
          const pos = l.savings.point >= 0;
          if (conPiezaDelBanco.has(l.ledger)) {
            return (
              <div key={l.ledger} className="kpi lg lg--empty">
                {cabecera(l.ledger)}
                <div className="v empty ck-num">—</div>
                <div className="sub">{t("referenceLedgerCards.benchOnly")}</div>
              </div>
            );
          }
          if (sinEjercitar(ab, l.ledger, l.proven)) {
            return (
              <div key={l.ledger} className="kpi lg lg--empty">
                {cabecera(l.ledger)}
                <div className="v empty ck-num">—</div>
                <div className="sub">{t("referenceLedgerCards.notExercised")}</div>
              </div>
            );
          }
          return (
            <div key={l.ledger} className="kpi lg">
              {cabecera(l.ledger)}
              <div className="lg-fig">
                <div className={`v ${pos ? "pos" : "neg"}`}>{pct(l.savings.point)}</div>
                <EvidenceBadge pequeno tipo={ab.mode === "LIVE" ? "sintetico" : "estimacion"} label={ab.mode === "LIVE" ? tu("evidence.sintetico") : tu("evidence.estimacion")} />
              </div>
              {/* La banda del intervalo: decorativa, las tres cifras van escritas. */}
              <div className="lg-ci" aria-hidden>
                <i className="lg-ci-fill" style={{ left: `${xp(l.savings.lower)}%`, width: `${Math.max(1, xp(l.savings.upper) - xp(l.savings.lower))}%` }} />
                <i className="lg-ci-zero" style={{ left: `${xp(0)}%` }} />
                <i className="lg-ci-pt" style={{ left: `${xp(l.savings.point)}%` }} />
              </div>
              <div className="lo">
                <Termino definicion={t("referenceLedgerCards.termFloor")}>95% ≥ {pct(l.savings.lower)}</Termino>
                {" · "}
                <Termino definicion={t("referenceLedgerCards.termDelta")}>Δ {money(l.deltaCost)}</Termino>
              </div>
              <div className="lg-status">
                {ab.mode === "LIVE" ? (
                  l.proven ? (
                    <Badge tone="success" dot>
                      {t("referenceLedgerCards.proven")}
                    </Badge>
                  ) : (
                    <Badge tone="neutral" dot>
                      {t("referenceLedgerCards.notProven")}
                    </Badge>
                  )
                ) : (
                  <Badge tone="warning" dot>
                    {t("referenceLedgerCards.estimatedMock")}
                  </Badge>
                )}
              </div>
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

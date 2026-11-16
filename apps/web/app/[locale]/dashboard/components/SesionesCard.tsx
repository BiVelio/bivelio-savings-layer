import { getTranslations } from "next-intl/server";

import type { SesionRollup } from "../data";
import { intfmt } from "../format";

/**
 * Coste por sesión y subagente (0019) — la vista de flota: qué sesión de qué
 * terminal costó qué, agregada por día. Solo aparece cuando HAY filas: sin
 * migración aplicada o sin clientes 0.4.7+ emitiendo atribución, la tarjeta no
 * existe y nadie ve un hueco vacío prometiendo algo que aún no llega.
 *
 * Los ids son identidades OPACAS de sesión/agente — jamás una persona.
 */
export async function SesionesCard({ sesiones }: { sesiones: SesionRollup[] }) {
  if (sesiones.length === 0) return null;
  const t = await getTranslations("dashboard");

  // Agrega por sesión (las filas vienen por día×agente): coste total, nº de
  // subagentes distintos (agent_id ≠ ''), peticiones y tokens.
  const porSesion = new Map<string, { requests: number; tokens: number; coste: number; agentes: Set<string> }>();
  for (const s of sesiones) {
    const g = porSesion.get(s.sessionId) ?? { requests: 0, tokens: 0, coste: 0, agentes: new Set<string>() };
    g.requests += s.requests;
    g.tokens += s.actualInputTokens + s.actualOutputTokens;
    g.coste += s.actualCost;
    if (s.agentId !== "") g.agentes.add(s.agentId);
    porSesion.set(s.sessionId, g);
  }
  const filas = [...porSesion.entries()].sort((a, b) => b[1].coste - a[1].coste).slice(0, 8);

  return (
    <div className="card card-pad">
      <div className="n card-title">{t("sesiones.title")}</div>
      <div className="tbl-scroll">
        <table className="dt">
          <thead>
            <tr>
              <th scope="col">{t("sesiones.colSession")}</th>
              <th scope="col" className="dt-num">{t("sesiones.colAgents")}</th>
              <th scope="col" className="dt-num">{t("sesiones.colRequests")}</th>
              <th scope="col" className="dt-num">{t("sesiones.colTokens")}</th>
              <th scope="col" className="dt-num">{t("sesiones.colCost")}</th>
            </tr>
          </thead>
          <tbody>
            {filas.map(([sessionId, g]) => (
              <tr key={sessionId}>
                <td className="dt-mono">
                  {sessionId.length > 18 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId}
                </td>
                <td className="dt-num">{g.agentes.size}</td>
                <td className="dt-num">{intfmt(g.requests)}</td>
                <td className="dt-num">{intfmt(g.tokens)}</td>
                <td className="dt-num dt-mono">${g.coste.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ck-note" style={{ marginTop: 8, marginBottom: 0 }}>{t("sesiones.hint")}</p>
    </div>
  );
}

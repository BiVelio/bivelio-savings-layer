import { getTranslations } from "next-intl/server";

import { EvidenceBadge } from "@/app/components/ui";
import { DataTable } from "@/vendor/affectui/data-table-clean";
import { Tooltip } from "@/vendor/affectui/tooltip-clean";

import type { SesionRollup } from "../data";
import { intfmt } from "../format";

/**
 * Coste por sesión y subagente (0019) — la vista de flota: qué sesión de qué
 * terminal costó qué, agregada por día. Solo aparece cuando HAY filas: sin
 * migración aplicada o sin clientes 0.4.7+ emitiendo atribución, la tarjeta no
 * existe y nadie ve un hueco vacío prometiendo algo que aún no llega.
 *
 * Los ids son identidades OPACAS de sesión/agente — jamás una persona.
 *
 * «ESPECTACULAR» 2026-11: la tabla es el Data Table de affectUI en SOLO
 * LECTURA (se ordena por columna; nada se edita) y el id recortado enseña el
 * entero en un Tooltip.
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

  const u = await getTranslations("ui");
  return (
    <div className="card card-pad ox-card">
      <div className="card-head">
        <div className="n">{t("sesiones.title")}</div>
        <EvidenceBadge tipo="tus-datos" label={u("evidence.tusDatos")} pequeno />
      </div>
      <DataTable
        flat
        pinFirst
        label={t("sesiones.title")}
        sortLabel={t("panel.sortBy", { column: "{column}" })}
        minWidth="520px"
        columns={[
          { key: "session", label: t("sesiones.colSession"), mono: true, nowrap: true, sortable: true },
          { key: "agents", label: t("sesiones.colAgents"), align: "end", mono: true, sortable: true },
          { key: "requests", label: t("sesiones.colRequests"), align: "end", mono: true, sortable: true },
          { key: "tokens", label: t("sesiones.colTokens"), align: "end", mono: true, sortable: true },
          { key: "cost", label: t("sesiones.colCost"), align: "end", mono: true, sortable: true },
        ]}
        rows={filas.map(([sessionId, g]) => ({
          id: sessionId,
          sort: { session: sessionId, agents: g.agentes.size, requests: g.requests, tokens: g.tokens, cost: g.coste },
          quiet: g.agentes.size === 0 ? ["agents"] : undefined,
          cells: {
            session:
              sessionId.length > 18 ? (
                <Tooltip content={sessionId} toggleOnClick delay={200} align="start">
                  <button type="button" className="ox-id">{`${sessionId.slice(0, 8)}…${sessionId.slice(-6)}`}</button>
                </Tooltip>
              ) : (
                sessionId
              ),
            agents: g.agentes.size,
            requests: intfmt(g.requests),
            tokens: intfmt(g.tokens),
            cost: `$${g.coste.toFixed(4)}`,
          },
        }))}
      />
      <p className="ck-note ox-foot">{t("sesiones.hint")}</p>
    </div>
  );
}

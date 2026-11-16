import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { AppSidebar } from "@/app/components/app/AppSidebar";
import { AppTopbar } from "@/app/components/app/AppTopbar";
import { PageHead } from "@/app/components/app/PageHead";
import { SetupProgress } from "@/app/components/app/SetupProgress";
import { BillingStateBanner } from "@/app/[locale]/dashboard/components/BillingStateBanner";
import { AhorroNativoCard } from "@/app/[locale]/dashboard/components/AhorroNativoCard";
import { DesgloseModelos } from "@/app/[locale]/dashboard/components/DesgloseModelos";
import { LiveLedgerTiles } from "@/app/[locale]/dashboard/components/LiveLedgerTiles";
import { RitmoCard } from "@/app/[locale]/dashboard/components/RitmoCard";
import { SesionesCard } from "@/app/[locale]/dashboard/components/SesionesCard";
import { ShadowOpportunitiesCard } from "@/app/[locale]/dashboard/components/ShadowOpportunitiesCard";
import { TokenTotalsTiles } from "@/app/[locale]/dashboard/components/TokenTotalsTiles";
import { TrafficModelMix } from "@/app/[locale]/dashboard/components/TrafficModelMix";
import { InstrumentationSpine } from "@/app/[locale]/dashboard/components/InstrumentationSpine";
import { MaquinasCard } from "@/app/[locale]/dashboard/components/MaquinasCard";
import { PulsoDelPeriodo } from "@/app/[locale]/dashboard/components/PulsoDelPeriodo";
import { PanelEditable } from "@/app/[locale]/dashboard/components/PanelEditable";
import { ResumenKpis } from "@/app/[locale]/dashboard/components/ResumenKpis";
import { UsageExplorer } from "@/app/[locale]/dashboard/components/UsageExplorer";
import { VerdictHero } from "@/app/[locale]/dashboard/components/VerdictHero";
import DashboardLoading from "@/app/[locale]/dashboard/loading";
import type { AsientoVisto, ModelDia, OrgContext, SesionRollup, ShadowModelDia, StepState, UsageRollup } from "@/app/[locale]/dashboard/data";
import { setupProgress } from "@/lib/dashboard/progress";
import { capturaDisponible } from "@/lib/portada/panel-del-banco";

/**
 * GALERÍA DE ESTADOS DEL PANEL — SOLO EN DESARROLLO (`pnpm dev` →
 * /es/captura-estados). Pinta los componentes de verdad del Resumen con
 * FIXTURES, para revisar a ojo cada composición sin sesión ni base: los nueve
 * estados del titular, la puesta en marcha en cada hito, el bloque del raíl
 * leído y sin leer, el aviso de cobro, las cifras, el desglose y las máquinas.
 *
 * TRES VISTAS (`?vista=`): `estados` (por defecto, el muestrario), `resumen`
 * (la cáscara entera con una cuenta con datos) y `vacio` (la cáscara con una
 * cuenta recién creada). Las dos últimas sirven también para probar el tour.
 *
 * LAS CIFRAS SON DE MUESTRA, generadas aquí: no son de ningún cliente ni del
 * banco público, y la página lo dice arriba. En producción no existe:
 * `notFound()` antes de pintar nada, igual que /captura-panel. Nadie la
 * enlaza. Los rótulos del muestrario van en español a propósito: no se
 * publica, así que no se traduce (los componentes sí salen en el idioma de la
 * ruta, que es lo que se revisa).
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const DIA_MS = 86_400_000;
const HOY = Date.UTC(2026, 10, 16);
const dia = (haceDias: number) => new Date(HOY - haceDias * DIA_MS).toISOString().slice(0, 10);

/** Una fila diaria de muestra. `medido` = qué parte tiene contador del proveedor. */
function fila(haceDias: number, peticiones: number, base: number, real: number, medido: number): UsageRollup {
  return {
    day: dia(haceDias),
    requests: peticiones,
    avoidedLlm: Math.round(peticiones * 0.18),
    actualLlm: Math.round(peticiones * 0.82),
    eliminatedInputTokens: peticiones * 310,
    compressedInputTokens: peticiones * 120,
    providerCachedInputTokens: peticiones * 540,
    baselineCost: base,
    actualCost: real,
    measuredRequests: Math.round(peticiones * medido),
    measuredBaselineCost: base * medido,
    measuredActualCost: real * medido,
    baselineInputTokens: peticiones * 4200,
    actualInputTokens: peticiones * 3300,
    baselineOutputTokens: peticiones * 380,
    actualOutputTokens: peticiones * 380,
    shadowRequests: Math.round(peticiones * 0.12),
    shadowBaselineCost: base * 0.12,
    shadowActualCost: base * 0.12 * 0.83,
    nativeRequests: Math.round(peticiones * 0.3),
    nativeCacheReadSavings: base * 0.09,
    nativeCacheWritePremium: base * 0.021,
  };
}

/** 24 días con forma (semana laboral, un hueco de dos días) y un ahorro dado. */
function serie(ahorro: number, medido: number): UsageRollup[] {
  const filas: UsageRollup[] = [];
  for (let d = 27; d >= 0; d--) {
    if (d === 11 || d === 12) continue;
    const onda = 1 + 0.35 * Math.sin(d / 2.1) + (d % 7 === 0 ? -0.4 : 0);
    const peticiones = Math.max(40, Math.round(420 * onda));
    const base = peticiones * 0.0123;
    filas.push(fila(d, peticiones, base, base * (1 - ahorro), medido));
  }
  return filas;
}

const POSITIVO = serie(0.214, 1);
const NEGATIVO = serie(-0.038, 1);
const PARCIAL = serie(0.162, 0.64);
const SIN_MEDIR = serie(0.1, 0);
const SIN_PRECIO = serie(0.2, 0).map((r) => ({ ...r, baselineCost: 0, actualCost: 0, measuredBaselineCost: 0, measuredActualCost: 0 }));

const MODELOS = ["claude-sonnet-5-5", "gpt-5.2-mini", "claude-haiku-5", "gemini-3-flash", "gpt-5.2", "mistral-large-3", "llama-4-70b"];
const REPARTO = [0.41, 0.22, 0.14, 0.09, 0.07, 0.04, 0.03];
const POR_MODELO: ModelDia[] = POSITIVO.flatMap((r) =>
  MODELOS.map((model, i) => ({
    day: r.day,
    model,
    requests: Math.round(r.requests * REPARTO[i]!),
    baselineCost: r.baselineCost * REPARTO[i]!,
    actualCost: r.actualCost * REPARTO[i]! * 0.93,
    actualInputTokens: Math.round((r.actualInputTokens ?? 0) * REPARTO[i]!),
    actualOutputTokens: Math.round((r.actualOutputTokens ?? 0) * REPARTO[i]!),
    nativeCacheReadSavings: i < 4 ? r.baselineCost * 0.09 * (REPARTO[i]! / 0.86) : undefined,
    nativeCacheWritePremium: i < 4 ? r.baselineCost * 0.021 * (REPARTO[i]! / 0.86) : undefined,
  })),
);

/** Sombra por modelo: tres modelos con tráfico espejo, cobertura parcial. */
const SOMBRA: ShadowModelDia[] = POSITIVO.flatMap((r) =>
  MODELOS.slice(0, 3).map((model, i) => ({
    day: r.day,
    model,
    shadowRequests: Math.round((r.shadowRequests ?? 0) * [0.5, 0.25, 0.15][i]!),
    shadowBaselineCost: (r.shadowBaselineCost ?? 0) * [0.5, 0.25, 0.15][i]!,
    shadowActualCost: (r.shadowActualCost ?? 0) * [0.46, 0.27, 0.15][i]!,
  })),
);

/** Sesiones opacas: cinco sesiones, alguna con subagentes. */
const SESIONES: SesionRollup[] = [
  ["ses_7c1e02a94bd3f6610", "", 412, 9.84],
  ["ses_7c1e02a94bd3f6610", "agt_a1", 138, 3.12],
  ["ses_7c1e02a94bd3f6610", "agt_b2", 77, 1.6],
  ["ses_02ffab77190c5e4d2", "", 233, 5.41],
  ["ses_02ffab77190c5e4d2", "agt_c3", 61, 0.92],
  ["ses_91b3", "", 118, 2.27],
  ["ses_e45d9a0c33187f20b", "", 64, 0.7312],
  ["ses_5a0077c2e19d4b8f1", "", 19, 0.1045],
].map(([sessionId, agentId, requests, actualCost], i) => ({
  day: dia(i % 4),
  sessionId: sessionId as string,
  agentId: agentId as string,
  requests: requests as number,
  actualInputTokens: (requests as number) * 3300,
  actualOutputTokens: (requests as number) * 380,
  actualCost: actualCost as number,
}));

const IDS = ["Account created", "License active", "SDK or gateway installed", "First real request", "Report ready"] as const;

const ASIENTOS: AsientoVisto[] = [
  { seatId: "seat_9f2c41ab77", isCi: false, surface: "gateway", versionMin: "gateway/0.5.2", versionMax: "gateway/0.5.2", sinVersion7d: false, lastSeenAt: new Date(HOY - 3_600_000).toISOString(), ahorroMedido7dUsd: 18.42, ahorroReferencia7dUsd: 0, conDatos7d: true },
  { seatId: "seat_51d0e3c8", isCi: false, surface: "sdk", versionMin: "sdk/0.5.1", versionMax: "sdk/0.5.2", sinVersion7d: false, lastSeenAt: new Date(HOY - 9 * 3_600_000).toISOString(), ahorroMedido7dUsd: 7.05, ahorroReferencia7dUsd: 0, conDatos7d: true },
  { seatId: "seat_a07b", isCi: false, surface: "gateway", versionMin: null, versionMax: null, sinVersion7d: true, lastSeenAt: new Date(HOY - 2 * DIA_MS).toISOString(), ahorroMedido7dUsd: 0, ahorroReferencia7dUsd: 0, conDatos7d: false },
  { seatId: "ci_1", isCi: true, surface: "gateway", versionMin: "gateway/0.5.2", versionMax: "gateway/0.5.2", sinVersion7d: false, lastSeenAt: new Date(HOY - DIA_MS).toISOString(), ahorroMedido7dUsd: 1.2, ahorroReferencia7dUsd: 0, conDatos7d: true },
];

const CTX_IMPAGO: OrgContext = {
  org: { name: "Organización de muestra", plan: "pro" },
  role: "owner",
  seats: 5,
  subscription: { status: "past_due", currentPeriodEnd: null, pastDueSince: new Date(Date.now() - 2 * DIA_MS).toISOString() },
  license: { status: "active", expiresAt: new Date(Date.now() + 20 * DIA_MS).toISOString(), graceDays: 7 },
  serviceAccount: { keyPrefix: "bvk_muestra", lastUsedAt: null },
};

const ROTULO: CSSProperties = { margin: "0 0 10px", fontSize: 12, fontWeight: 600, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-soft)" };
const BLOQUE: CSSProperties = { marginTop: 44 };
const PILA: CSSProperties = { display: "grid", gap: 22 };
const AVISO: CSSProperties = { margin: "0 0 28px", padding: "10px 14px", borderRadius: 10, border: "1px dashed var(--line-strong)", fontSize: 13, color: "var(--ink-soft)" };

function Caso({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <div>
      <p style={ROTULO}>{titulo}</p>
      {children}
    </div>
  );
}

export default async function GaleriaDeEstados({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ vista?: string; solo?: string }>;
}) {
  if (!capturaDisponible()) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const { vista = "estados", solo } = await searchParams;
  const t = await getTranslations("dashboard");

  const etiqueta: Record<(typeof IDS)[number], string> = {
    "Account created": t("overview.steps.accountCreated"),
    "License active": t("overview.steps.licenseActive"),
    "SDK or gateway installed": t("overview.steps.sdkInstalled"),
    "First real request": t("overview.steps.firstRequest"),
    "Report ready": t("overview.steps.reportReady"),
  };
  /** Los cinco hitos con `hechos` completados; el siguiente queda como «current». */
  const pasos = (hechos: number, sinLeer = false): StepState[] =>
    IDS.map((id, i) => ({
      id,
      label: etiqueta[id],
      status: i < hechos ? "done" : sinLeer && i >= 2 ? "unavailable" : i === hechos ? "current" : "pending",
    }));
  const COMPLETO = pasos(5);

  if (vista === "resumen" || vista === "vacio") {
    const conDatos = vista === "resumen";
    const usage = conDatos ? POSITIVO : [];
    const steps = conDatos ? COMPLETO : pasos(2);
    return (
      <div className="app">
        <AppTopbar email="muestra@example.com" plan="pro" orgName="Organización de muestra" role="owner" />
        <div className="app-body">
          <AppSidebar role="owner" />
          <main className="app-main">
            <div className="app-inner">
              <div className="ov">
                <PageHead eyebrow={t("overview.eyebrow")} title={t("overview.title")} sub={t("overview.intro")} />
                <p style={AVISO}>Galería de desarrollo · cifras de muestra generadas en esta página · no son de ningún cliente.</p>
                <section className="app-section ov-result">
                  <div className="app-sec-head">
                    <div>
                      <p className="eyebrow">{t("overview.savingsEyebrow")}</p>
                      <h2 className="t-section">{t("overview.savingsTitle")}</h2>
                    </div>
                  </div>
                  <div className="panel-stack">
                    <VerdictHero usage={usage} visibilidad={conDatos ? "con_datos" : "sin_trafico"} rango={30} integrado={conDatos} />
                    {conDatos ? <ResumenKpis usage={usage} rango={30} steps={steps} /> : null}
                    {conDatos ? <PulsoDelPeriodo usage={usage} porModelo={POR_MODELO} rango={30} /> : null}
                  </div>
                </section>
                {conDatos ? null : <InstrumentationSpine steps={steps} />}
                <section className="app-section">
                  <div className="app-sec-head">
                    <div>
                      <p className="eyebrow">{t("overview.panelEyebrow")}</p>
                      <h2 className="t-section">{t("overview.panelTitle")}</h2>
                    </div>
                  </div>
                  <PanelEditable
                    tarjetas={[
                      {
                        id: "explorador",
                        titulo: t("usageExplorer.title"),
                        contenido: (
                          <div className="ov-explore">
                            <div className="card card-pad" data-tour="explorer">
                              <div className="n card-title">{t("usageExplorer.title")}</div>
                              <UsageExplorer usage={usage} porModelo={conDatos ? POR_MODELO : []} periodoInicial={30} />
                            </div>
                            <DesgloseModelos porModelo={conDatos ? POR_MODELO : []} porModeloCompleto={conDatos ? POR_MODELO : []} usage={usage} rango={30} />
                          </div>
                        ),
                      },
                      {
                        id: "oportunidades",
                        titulo: t("shadowOpportunities.title"),
                        contenido: <ShadowOpportunitiesCard rows={conDatos ? SOMBRA : []} usage={usage} status={conDatos ? "data" : "empty"} rango={30} />,
                      },
                      { id: "ritmo", titulo: t("panel.cards.ritmo"), contenido: <RitmoCard usage={usage} /> },
                      { id: "nativo", titulo: t("panel.cards.nativo"), contenido: <AhorroNativoCard usage={usage} porModelo={conDatos ? POR_MODELO : []} /> },
                      { id: "tokens", titulo: t("panel.cards.tokens"), contenido: <TokenTotalsTiles usage={usage} /> },
                      { id: "libros", titulo: t("panel.cards.libros"), contenido: <LiveLedgerTiles usage={usage} /> },
                      {
                        id: "trafico",
                        titulo: t("panel.cards.trafico"),
                        contenido: (
                          <div className="card card-pad">
                            <div className="n card-title">{t("overview.traffic")}</div>
                            <TrafficModelMix usage={usage} />
                          </div>
                        ),
                      },
                      { id: "sesiones", titulo: t("panel.cards.sesiones"), contenido: <SesionesCard sesiones={conDatos ? SESIONES : []} /> },
                      {
                        id: "maquinas",
                        titulo: t("panel.cards.maquinas"),
                        contenido: <MaquinasCard asientos={conDatos ? ASIENTOS : []} seats={conDatos ? { used: 4, seats: 5 } : undefined} />,
                        ancla: { id: "maquinas", titulo: t("maquinas.hiddenTitle"), texto: t("maquinas.hiddenBody"), accion: t("maquinas.show") },
                      },
                    ].filter((c) => !solo || solo.split(",").includes(c.id))}
                  />
                </section>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <main className="app-main">
        <div className="app-inner" style={{ width: "min(1200px, 100%)" }}>
          <PageHead eyebrow="Solo desarrollo" title="Estados del panel" sub="Los componentes reales del Resumen, con fixtures. Las cifras son de muestra." />
          <p style={AVISO}>Cifras de muestra generadas en esta página · no son de ningún cliente ni del banco público · esta ruta no existe en producción.</p>

          <section>
            <h2 className="t-section">Titular · nueve composiciones</h2>
            <div style={PILA}>
              <Caso titulo="Positivo · todo medido">
                <VerdictHero usage={POSITIVO} visibilidad="con_datos" rango={30} integrado />
              </Caso>
              <Caso titulo="Negativo · sobrecoste">
                <VerdictHero usage={NEGATIVO} visibilidad="con_datos" rango={30} integrado />
              </Caso>
              <Caso titulo="Inconcluso · medición parcial">
                <VerdictHero usage={PARCIAL} visibilidad="con_datos" rango={90} integrado />
              </Caso>
              <Caso titulo="Sin integrar">
                <VerdictHero usage={[]} visibilidad="sin_trafico" rango={120} integrado={false} />
              </Caso>
              <Caso titulo="Sin tráfico en el periodo">
                <VerdictHero usage={[]} visibilidad="sin_trafico" rango={30} integrado />
              </Caso>
              <Caso titulo="Sin precio">
                <VerdictHero usage={SIN_PRECIO} visibilidad="con_datos" rango={30} integrado />
              </Caso>
              <Caso titulo="Sin medición">
                <VerdictHero usage={SIN_MEDIR} visibilidad="con_datos" rango={30} integrado />
              </Caso>
              <Caso titulo="Lectura fallida">
                <VerdictHero usage={[]} failed visibilidad="desconocido" rango={30} />
              </Caso>
              <Caso titulo="Acceso limitado">
                <VerdictHero usage={[]} visibilidad="oculto" rango={30} />
              </Caso>
            </div>
          </section>

          <section style={BLOQUE}>
            <h2 className="t-section">Cifras del periodo y desglose</h2>
            <div style={PILA}>
              <Caso titulo="Con datos · puesta en marcha completa">
                <ResumenKpis usage={POSITIVO} rango={30} steps={COMPLETO} />
              </Caso>
              <Caso titulo="Sobrecoste · falta un hito">
                <ResumenKpis usage={NEGATIVO} rango={30} steps={pasos(3)} />
              </Caso>
              <Caso titulo="Tráfico sin precio">
                <ResumenKpis usage={SIN_PRECIO} rango={30} steps={pasos(2, true)} />
              </Caso>
              <Caso titulo="Tráfico sin medir">
                <ResumenKpis usage={SIN_MEDIR} rango={30} steps={COMPLETO} />
              </Caso>
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", alignItems: "start" }}>
                <Caso titulo="Desglose · siete modelos (cinco y «otros»)">
                  <DesgloseModelos porModelo={POR_MODELO} porModeloCompleto={POR_MODELO} usage={POSITIVO} rango={30} />
                </Caso>
                <Caso titulo="Desglose · vacío">
                  <DesgloseModelos porModelo={[]} porModeloCompleto={[]} usage={[]} rango={30} />
                </Caso>
                <Caso titulo="Desglose · lectura fallida">
                  <DesgloseModelos porModelo={[]} porModeloCompleto={[]} usage={[]} rango={30} fallo />
                </Caso>
              </div>
            </div>
          </section>

          <section style={BLOQUE}>
            <h2 className="t-section">Puesta en marcha · cada hito</h2>
            <Caso titulo="Siguiente: credenciales y licencia">
              <InstrumentationSpine steps={pasos(1)} />
            </Caso>
            <Caso titulo="Siguiente: SDK o gateway">
              <InstrumentationSpine steps={pasos(2)} />
            </Caso>
            <Caso titulo="Lectura no disponible">
              <InstrumentationSpine steps={pasos(2, true)} />
            </Caso>
          </section>

          <section style={BLOQUE}>
            <h2 className="t-section">Raíl · bloque de puesta en marcha</h2>
            <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 264px), 288px))", alignItems: "start" }}>
              <Caso titulo="Leído · 2 de 5">
                <aside className="app-sidebar" style={{ border: "1px solid var(--line)", borderRadius: 14 }}>
                  <SetupProgress progress={setupProgress(pasos(2), false)} />
                </aside>
              </Caso>
              <Caso titulo="Leído · completo">
                <aside className="app-sidebar" style={{ border: "1px solid var(--line)", borderRadius: 14 }}>
                  <SetupProgress progress={setupProgress(COMPLETO, false)} />
                </aside>
              </Caso>
              <Caso titulo="Sin leer · sin barra ni «0 de 5»">
                <aside className="app-sidebar" style={{ border: "1px solid var(--line)", borderRadius: 14 }}>
                  <SetupProgress progress={setupProgress(pasos(2), true)} />
                </aside>
              </Caso>
            </div>
          </section>

          <section style={BLOQUE}>
            <h2 className="t-section">Atención · cobro</h2>
            <Caso titulo="Suscripción con el pago vencido (past_due)">
              <div className="ov-attention">
                <BillingStateBanner ctx={CTX_IMPAGO} />
              </div>
            </Caso>
          </section>

          <section style={BLOQUE}>
            <h2 className="t-section">Máquinas</h2>
            <div style={PILA}>
              <Caso titulo="Con máquinas · ahorro de 7 días · 4 de 5 asientos">
                <MaquinasCard asientos={ASIENTOS} seats={{ used: 4, seats: 5 }} />
              </Caso>
              <Caso titulo="Con máquinas · todos los asientos en uso">
                <MaquinasCard asientos={ASIENTOS} seats={{ used: 5, seats: 5 }} />
              </Caso>
              <Caso titulo="Sin máquinas">
                <MaquinasCard asientos={[]} />
              </Caso>
              <Caso titulo="Lectura fallida">
                <MaquinasCard asientos={[]} fallo />
              </Caso>
            </div>
          </section>

          <section style={BLOQUE}>
            <h2 className="t-section">Carga</h2>
            <DashboardLoading />
          </section>
        </div>
      </main>
    </div>
  );
}

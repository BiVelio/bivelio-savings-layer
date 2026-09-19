import { getTranslations } from "next-intl/server";
import { authConfigured } from "@/lib/supabase/env";
import abData from "@/public/data/ab-live.json";
import { activationSteps, getAsientos, getSesiones, type AbArtifact } from "./data";
import { cortarPorPeriodo } from "./explorer-datos";
import { loadDashboard } from "./load";
import { RANGO_POR_DEFECTO, rangoDesdeParametro } from "./rango";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BillingStateBanner } from "./components/BillingStateBanner";
import { GatewayVersionBanner } from "./components/GatewayVersionBanner";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { RitmoCard } from "./components/RitmoCard";
import { TokenTotalsTiles } from "./components/TokenTotalsTiles";
import { UsageExplorer } from "./components/UsageExplorer";
import { TrafficModelMix } from "./components/TrafficModelMix";
import { MaquinasCard } from "./components/MaquinasCard";
import { PanelEditable } from "./components/PanelEditable";
import { SesionesCard } from "./components/SesionesCard";
import { VerdictHero } from "./components/VerdictHero";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("overview.metaTitle") };
}

const ab = abData as unknown as AbArtifact;

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const t = await getTranslations("dashboard");
  if (!authConfigured) {
    return <p className="ck-note">{t("overview.authNotWired")}</p>;
  }
  const { ctx, usage: usageCompleto, usageFailed, porModelo: porModeloCompleto, visibilidad, orgId } = await loadDashboard();
  // EL RANGO SE APLICA AQUÍ, una vez, antes de derivar nada: el titular, los
  // libros y el tráfico suman exactamente los días que el selector dice. La
  // consulta sigue trayendo 120 días (el máximo), así que el corte es local y
  // barato. El ritmo del mes y la espina de activación miran el conjunto
  // completo: uno es un cálculo de calendario y el otro una historia de alta.
  const rango = rangoDesdeParametro((await searchParams).range);
  const usage = rango === RANGO_POR_DEFECTO ? usageCompleto : cortarPorPeriodo(usageCompleto, rango);
  const steps = await activationSteps(true, ctx, usageCompleto);
  // Coste por sesión (0019) y máquinas (0024): lecturas aparte y tolerantes —
  // sin tabla o sin columnas (migración por detrás del deploy) o sin filas, la
  // tarjeta no existe y el panel sigue. Un solo cliente de solo lectura para las dos.
  const lector = orgId ? await createReadOnlyClient() : null;
  const [sesiones, asientos] = lector && orgId
    ? await Promise.all([getSesiones(lector, orgId).then((r) => r.rows), getAsientos(lector, orgId).then((r) => r.rows)])
    : [[], []];

  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("overview.eyebrow")}</p>
        <h1>{t("overview.title")}</h1>
        <p>{t("overview.intro")}</p>
      </div>

      {/* Lo primero de la primera pantalla: si el cobro va mal, se entera aquí
          y no cuando el SDK se le pare. */}
      <BillingStateBanner ctx={ctx} />
      {/* Y justo detrás, si alguna máquina con gateway lleva una semana sin un
          euro MEDIDO: decide el dinero por asiento, la versión solo explica. */}
      <GatewayVersionBanner asientos={asientos} />

      <InstrumentationSpine steps={steps} />

      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <p className="ck-eyebrow">{t("overview.savingsEyebrow")}</p>
            <h2>{t("overview.savingsTitle")}</h2>
          </div>
        </div>
        <div className="panel-stack">
          <VerdictHero usage={usage} failed={usageFailed} visibilidad={visibilidad} rango={rango} />
          {/* Lo que sigue lo ordena y filtra quien mira (PanelEditable): las
              tarjetas llegan ya renderizadas por el servidor con sus datos, y
              el cliente solo decide orden y visibilidad. El titular de arriba
              y los avisos NO entran: no son decoración. */}
          <PanelEditable
            tarjetas={[
              // Justo detrás del titular: a qué velocidad va y dónde acaba el mes.
              // Mira el mes completo, no el rango: es un cálculo de calendario.
              { id: "ritmo", titulo: t("panel.cards.ritmo"), contenido: <RitmoCard usage={usageCompleto} /> },
              // Los TOTALES antes que la atribución por libro: "cuántos tokens he
              // gastado" es la pregunta que se hace primero, y los cuatro libros de
              // abajo la responden por partes que NO se pueden sumar entre sí.
              { id: "tokens", titulo: t("panel.cards.tokens"), contenido: <TokenTotalsTiles usage={usage} /> },
              { id: "libros", titulo: t("panel.cards.libros"), contenido: <LiveLedgerTiles usage={usage} ab={ab} /> },
              // El explorador configurable (por día · periodo · modelo · libro) a
              // lo ancho: necesita sitio para los controles y las barras.
              {
                id: "explorador",
                titulo: t("usageExplorer.title"),
                contenido: (
                  <div className="card card-pad">
                    <div className="n card-title">{t("usageExplorer.title")}</div>
                    <UsageExplorer usage={usageCompleto} porModelo={porModeloCompleto} periodoInicial={rango} />
                  </div>
                ),
              },
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
              { id: "sesiones", titulo: t("panel.cards.sesiones"), contenido: <SesionesCard sesiones={sesiones} /> },
              { id: "maquinas", titulo: t("panel.cards.maquinas"), contenido: <MaquinasCard asientos={asientos} /> },
            ]}
          />
          {/* FUERA LAS DOS TARJETAS DE ELISIÓN (2026-09-10).
              La elisión está muerta para el cliente: sus diales llevan apagados
              desde el 09-09 y hoy se quitó `context_elision` de las tres
              licencias pro vivas. Enseñar un −39,5 % en rojo grande sobre
              $735,43 «simulados» de una palanca que el cliente NO PUEDE
              encender no le informa de nada: le da un susto sobre algo que no
              ha pasado y no va a pasar. Lo mismo la del borrado del proveedor,
              que contaba peticiones acreditadas por unos diales apagados.
              La medición NO se pierde: las columnas `shadow_*` y
              `eliminated_*` se siguen escribiendo y son nuestras para
              consultarlas. Lo que se quita es enseñarle al cliente nuestra
              investigación y perdida como si fuera su cuenta. Si algún día la
              palanca vuelve con neto positivo medido, las tarjetas vuelven —
              los componentes siguen en el repo. */}
        </div>
      </section>
    </>
  );
}

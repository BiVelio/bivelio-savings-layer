import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { AccountPlanStrip } from "@/app/[locale]/dashboard/components/AccountPlanStrip";
import { BillingStateBanner } from "@/app/[locale]/dashboard/components/BillingStateBanner";
import { CheckoutBanner } from "@/app/[locale]/dashboard/components/CheckoutBanner";
import { ExtractoVista, type PeriodoCerradoVisible } from "@/app/[locale]/dashboard/components/ExtractoVista";
import { YourBenchContenido } from "@/app/[locale]/dashboard/components/YourBenchContenido";
import type { OrgContext, UsageRollup } from "@/app/[locale]/dashboard/data";
import { extractoEnSombra } from "@/lib/billing/extracto-sombra";
import { capturaDisponible } from "@/lib/portada/panel-del-banco";
import type { InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";

/**
 * MUESTRARIO DE ESTADOS DE CUENTA, EXTRACTO Y «TU BANCO» — SOLO EN DESARROLLO.
 *
 * El panel sin sesión (`next dev` sin variables) solo enseña un estado de cada
 * pantalla: sin plan, sin extracto, sin banco. Aquí se pintan los demás con los
 * MISMOS componentes que ve el cliente, alimentados con datos de muestra:
 * plan activo, activación pendiente, impago, exceso de asientos, licencia en
 * gracia o caducada, extracto con y sin contrato heredado, y el A/B propio en
 * cada uno de sus estados.
 *
 * `?estado=<id>` deja un solo bloque, para capturarlo. Los rótulos van en
 * español a propósito: no se publica ni se enlaza. En producción no existe:
 * `notFound()` antes de leer nada, igual que /captura-panel.
 *
 * TODAS LAS CIFRAS SON DE MUESTRA. Ningún dato ni clave de un cliente real.
 */
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const DIA = 86_400_000;

function contexto(parcial: Partial<OrgContext>): OrgContext {
  return {
    org: { name: "Organización de muestra", plan: "pro" },
    role: "owner",
    seats: 10,
    subscription: { status: "active", currentPeriodEnd: null, pastDueSince: null },
    license: { status: "active", expiresAt: null, graceDays: 21 },
    serviceAccount: null,
    ...parcial,
  };
}

/** Uso de muestra del mes en curso y del anterior, para que el extracto no salga en calibración. */
function usoDeMuestra(): UsageRollup[] {
  const hoy = new Date();
  const dia = (atras: number) => new Date(hoy.getTime() - atras * DIA).toISOString().slice(0, 10);
  const mesPasado = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
  const fila = (day: string, requests: number, base: number, actual: number): UsageRollup => ({
    day,
    requests,
    avoidedLlm: Math.round(requests * 0.2),
    actualLlm: Math.round(requests * 0.8),
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    providerCachedInputTokens: 0,
    baselineCost: base,
    actualCost: actual,
    measuredRequests: requests,
    measuredBaselineCost: base,
    measuredActualCost: actual,
  });
  return [fila(mesPasado, 1800, 96.4, 71.9), fila(`${dia(0).slice(0, 7)}-01`, 2400, 1284.6, 902.3), fila(dia(0), 2150, 1140.2, 815.4)];
}

function informe(parcial: Partial<InformeDelBancoPropio>): InformeDelBancoPropio {
  return {
    estado: "listo",
    paresTotales: 412,
    paresLeidos: 412,
    paresEnTitular: 398,
    submuestreado: false,
    elegibles: 20640,
    cobertura: 0.97,
    cuotaCorta: 0.03,
    tasaLograda: 0.0199,
    remuestreos: 10000,
    semilla: 48213,
    titular: { fraccion: { lower: 0.118, point: 0.164, upper: 0.209 }, diferencia: { lower: 0.00021, point: 0.00031, upper: 0.00042 } },
    peorCaso: { fraccion: { lower: 0.071, point: 0.112, upper: 0.158 }, sinAcotar: { lower: 0.071, point: 0.112, upper: 0.158 } },
    estratos: [
      { estrato: "avoided_call", elegibles: 4120, pares: 81, mediaSinCapa: 0.0021, mediaConCapa: 0, cubierto: true, enTitular: true, diferencia: { lower: 0.0019, point: 0.0021, upper: 0.0023 } },
      { estrato: "tokens_removed", elegibles: 6890, pares: 139, mediaSinCapa: 0.0034, mediaConCapa: 0.0029, cubierto: true, enTitular: true, diferencia: { lower: 0.0003, point: 0.0005, upper: 0.0007 } },
      { estrato: "unchanged", elegibles: 9010, pares: 178, mediaSinCapa: 0.0012, mediaConCapa: 0.0012, cubierto: true, enTitular: true, diferencia: { lower: -0.0001, point: 0, upper: 0.0001 } },
      { estrato: "cheaper_model", elegibles: 620, pares: 0, mediaSinCapa: null, mediaConCapa: null, cubierto: false, enTitular: false },
    ],
    exclusiones: [
      { motivo: "fail_open", peticiones: 214 },
      { motivo: "truncated", peticiones: 37 },
    ],
    resultados: [{ resultado: "check_failed", muestras: 9 }],
    noComparables: { truncadas: 8, incompletas: 2, incumplidas: 4 },
    coste: { usd: 0.94, copias: 412, sinCoste: 3 },
    ...parcial,
  };
}

const CERRADOS: PeriodoCerradoVisible[] = [
  { periodo: "2026-10", base_medida_eur: 1012.4, ahorro_medido_eur: 301.2, ratio: 0.2975, cargo_eur: 41.3, cobro: { estado: "pagado", url: null, numero: "MUESTRA-0002" }, requests_referencia: 0, claveDeEstado: "estadoPagado" },
  { periodo: "2026-09", base_medida_eur: 86.7, ahorro_medido_eur: 22.1, ratio: 0.2549, cargo_eur: 0, cobro: null, requests_referencia: 0, claveDeEstado: "estadoCalibracion" },
];

function Bloque({ id, titulo, children }: { id: string; titulo: string; children: ReactNode }) {
  return (
    <section id={id} style={{ padding: "8px 0 56px" }}>
      <p className="note" style={{ marginBottom: 12 }}>
        <b>{titulo}</b> · ?estado={id} · cifras de muestra
      </p>
      {children}
    </section>
  );
}

export default async function CapturaDeCuenta({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ estado?: string }>;
}) {
  if (!capturaDisponible()) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const { estado } = await searchParams;
  const uso = usoDeMuestra();
  const periodo = new Date().toISOString().slice(0, 7);
  const ahora = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const hasta = new Date().toISOString().slice(0, 10);
  const desde = new Date(ahora - 29 * DIA).toISOString().slice(0, 10);
  const correo = "persona@ejemplo.test";

  const bloques: Array<{ id: string; titulo: string; nodo: ReactNode }> = [
    {
      id: "activo",
      titulo: "Cuenta · plan activo, asientos en uso por debajo de lo contratado",
      nodo: <AccountPlanStrip email={correo} ctx={contexto({})} asientos={{ usados: 7, rotacionEsteMes: false }} />,
    },
    {
      id: "sin-medida",
      titulo: "Cuenta · plan activo, uso de asientos sin medir (no es un cero)",
      nodo: <AccountPlanStrip email={correo} ctx={contexto({ role: "billing" })} asientos={{ usados: null, rotacionEsteMes: false }} />,
    },
    {
      id: "comprar",
      titulo: "Cuenta · sin plan, con perfil que puede comprar",
      nodo: (
        <AccountPlanStrip
          email={correo}
          ctx={contexto({ org: { name: "Organización de muestra", plan: "free" }, seats: null, subscription: null, license: null })}
        />
      ),
    },
    {
      id: "miembro",
      titulo: "Cuenta · perfil sin permiso de compra ni de facturación: nota en vez de botones",
      nodo: (
        <>
          <BillingStateBanner
            ctx={contexto({
              role: "member",
              subscription: { status: "past_due", currentPeriodEnd: null, pastDueSince: iso(ahora - 5 * DIA) },
              license: { status: "grace", expiresAt: iso(ahora - 5 * DIA), graceDays: 21 },
            })}
          />
          <AccountPlanStrip email={correo} ctx={contexto({ role: "member" })} asientos={{ usados: 7, rotacionEsteMes: false }} />
          <AccountPlanStrip
            email={correo}
            ctx={contexto({ role: "member", org: { name: "Organización de muestra", plan: "free" }, seats: null, subscription: null, license: null })}
          />
        </>
      ),
    },
    {
      id: "pendiente",
      titulo: "Cuenta · vuelta de Stripe con la activación pendiente: sin botones de compra",
      nodo: (
        <>
          <CheckoutBanner resultado="success" activo={false} />
          <AccountPlanStrip
            email={correo}
            ctx={contexto({ org: { name: "Organización de muestra", plan: "free" }, seats: null, subscription: null, license: null })}
            ocultarCompra
          />
        </>
      ),
    },
    {
      id: "exceso",
      titulo: "Cuenta · más asientos en uso que contratados, y el ajuste del mes cerrado",
      nodo: (
        <AccountPlanStrip
          email={correo}
          ctx={contexto({})}
          asientos={{
            usados: 13,
            rotacionEsteMes: false,
            ajusteMesPasado: { periodo: "2026-10", usados: 12, pagados: 10, exceso: 2, importeCentimos: 3000 },
          }}
        />
      ),
    },
    {
      id: "impago",
      titulo: "Cuenta · cobro fallido con la gracia corriendo",
      nodo: (
        <>
          <BillingStateBanner
            ctx={contexto({
              subscription: { status: "past_due", currentPeriodEnd: null, pastDueSince: iso(ahora - 5 * DIA) },
              license: { status: "grace", expiresAt: iso(ahora - 5 * DIA), graceDays: 21 },
            })}
          />
          <AccountPlanStrip
            email={correo}
            ctx={contexto({ subscription: { status: "past_due", currentPeriodEnd: null, pastDueSince: iso(ahora - 5 * DIA) } })}
            asientos={{ usados: 9, rotacionEsteMes: false }}
          />
        </>
      ),
    },
    {
      id: "avisos",
      titulo: "Avisos · cancelado, activo, pago en proceso, gracia, caducada y revocada",
      nodo: (
        <>
          <CheckoutBanner resultado="cancelled" activo={false} />
          <CheckoutBanner resultado="success" activo />
          <BillingStateBanner ctx={contexto({ subscription: { status: "incomplete", currentPeriodEnd: null, pastDueSince: null } })} />
          <BillingStateBanner ctx={contexto({ license: { status: "grace", expiresAt: iso(ahora - 3 * DIA), graceDays: 21 } })} />
          <BillingStateBanner ctx={contexto({ license: { status: "expired", expiresAt: iso(ahora - 40 * DIA), graceDays: 21 } })} />
          <BillingStateBanner ctx={contexto({ license: { status: "revoked", expiresAt: null, graceDays: 21 } })} />
        </>
      ),
    },
    {
      id: "extracto-fija",
      titulo: "Extracto · plan de cuota fija: sin comisión, simulación plegada",
      nodo: (
        <ExtractoVista e={extractoEnSombra("muestra", uso, periodo, true)} periodo={periodo} regimen="fija" usageFailed={false} cerrados={[]} diasDeDescarga={null} />
      ),
    },
    {
      id: "extracto-legado",
      titulo: "Extracto · contrato con la modalidad histórica de comisión",
      nodo: (
        <ExtractoVista e={extractoEnSombra("muestra", uso, periodo, false)} periodo={periodo} regimen="legado" usageFailed={false} cerrados={CERRADOS} diasDeDescarga={null} />
      ),
    },
    {
      id: "extracto-indeterminado",
      titulo: "Extracto · régimen que la página no puede determinar (aviso neutro)",
      nodo: (
        <ExtractoVista e={extractoEnSombra("muestra", uso, periodo, false)} periodo={periodo} regimen="indeterminado" usageFailed={false} cerrados={null} diasDeDescarga={null} />
      ),
    },
    {
      id: "extracto-ninguno",
      titulo: "Extracto · sin plan vivo y sin Measure: aviso neutro, sin enlace a la modalidad anterior",
      nodo: (
        <ExtractoVista e={extractoEnSombra("muestra", uso, periodo, false)} periodo={periodo} regimen="ninguno" usageFailed={false} cerrados={[]} diasDeDescarga={null} />
      ),
    },
    {
      id: "extracto-medir",
      titulo: "Extracto · licencia gratuita Measure: ahorro estimado, nunca facturado",
      nodo: (
        <ExtractoVista e={extractoEnSombra("muestra", uso, periodo, false)} periodo={periodo} regimen="medir" usageFailed={false} cerrados={[]} diasDeDescarga={null} />
      ),
    },
    {
      id: "exceso-miembro",
      titulo: "Cuenta · exceso de asientos visto por un miembro: sin la frase de «Gestionar plan»",
      nodo: (
        <AccountPlanStrip email={correo} ctx={contexto({ role: "member" })} asientos={{ usados: 13, rotacionEsteMes: false }} />
      ),
    },
    {
      id: "banco-resultado",
      titulo: "Tu banco · resultado con suelo positivo",
      nodo: (
        <div className="yb">
          <YourBenchContenido lectura={{ estado: "ok", desde, hasta, informe: informe({}) }} rango={30} />
        </div>
      ),
    },
    {
      id: "banco-inconcluso",
      titulo: "Tu banco · resultado inconcluso (el intervalo incluye el cero)",
      nodo: (
        <div className="yb">
          <YourBenchContenido
            lectura={{
              estado: "ok",
              desde,
              hasta,
              informe: informe({
                paresEnTitular: 64,
                cobertura: 0.82,
                titular: { fraccion: { lower: -0.031, point: 0.042, upper: 0.117 }, diferencia: { lower: -0.00006, point: 0.00008, upper: 0.00022 } },
                peorCaso: { fraccion: { lower: -0.058, point: 0.012, upper: 0.083 }, sinAcotar: { lower: -0.058, point: 0.012, upper: 0.083 } },
              }),
            }}
            rango={30}
          />
        </div>
      ),
    },
    {
      id: "banco-reuniendo",
      titulo: "Tu banco · reuniendo pares",
      nodo: (
        <div className="yb">
          <YourBenchContenido
            lectura={{ estado: "ok", desde, hasta, informe: informe({ estado: "reuniendo", falta: "pares", paresEnTitular: 11, paresTotales: 12, paresLeidos: 12, titular: undefined, peorCaso: undefined, coste: { usd: 0.03, copias: 12, sinCoste: 0 } }) }}
            rango={30}
          />
        </div>
      ),
    },
    {
      id: "banco-grupos",
      titulo: "Tu banco · muestra insuficiente en algunos grupos",
      nodo: (
        <div className="yb">
          <YourBenchContenido
            lectura={{ estado: "ok", desde, hasta, informe: informe({ estado: "reuniendo", falta: "grupos", cuotaCorta: 0.18, titular: undefined, peorCaso: undefined }) }}
            rango={30}
          />
        </div>
      ),
    },
    {
      id: "banco-apagado",
      titulo: "Tu banco · sin datos (muestreo apagado)",
      nodo: (
        <div className="yb">
          <YourBenchContenido lectura={{ estado: "ok", desde: "", hasta: "", informe: informe({ estado: "sin_datos", titular: undefined, peorCaso: undefined }) }} rango={30} />
        </div>
      ),
    },
    {
      id: "banco-fallo",
      titulo: "Tu banco · fallo de lectura",
      nodo: (
        <div className="yb">
          <YourBenchContenido lectura={{ estado: "fallo" }} rango={30} />
        </div>
      ),
    },
  ];
  const visibles = estado ? bloques.filter((b) => b.id === estado) : bloques;

  return (
    <div className="app">
      <main className="app-main">
        <div className="app-inner">
          <PageHead eyebrow="Solo desarrollo" title="Estados de cuenta, extracto y tu banco" sub="Componentes reales con datos de muestra. No se publica ni se enlaza." />
          {visibles.map((b) => (
            <Bloque key={b.id} id={b.id} titulo={b.titulo}>
              {b.nodo}
            </Bloque>
          ))}
        </div>
      </main>
    </div>
  );
}

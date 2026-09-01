"use client";

import { useEffect, useMemo, useState } from "react";

import { useLocale, useTranslations } from "next-intl";

import { calcularComision, GARANTIA_NETA_RATIO, TRAMOS } from "@/lib/billing/tarifa";

/**
 * LA CALCULADORA DE COMISIÓN — sustituye a la tarjeta estática de confianza
 * del pricing (pedido del dueño, 2026-08-23): que el cliente JUEGUE y vea,
 * antes de darnos su email, exactamente cuánto sería nuestro extra y cuánto
 * se queda él — sin perjudicarle, transparentemente.
 *
 * Anti-deriva por construcción: los PRECIOS salen del bundle vendored del SDK
 * (el mismo CATALOGO que factura, con su PRECIOS_AL_DIA) y la TARIFA sale de
 * lib/billing/tarifa (la misma máquina que el extracto). Aquí no vive ni un
 * número propio.
 */

type Precio = { inputPer1k: number; outputPer1k: number };
type SdkModule = { CATALOGO: Record<string, Precio>; PRECIOS_AL_DIA: string };

/** Las horquillas, de modesta a alta. Sin mínimo (2026-09-01) ya no hay umbral
 *  ni rampa que enseñar: la fila baja existe para que se vea que un ahorro
 *  pequeño paga comisión pequeña — y que el cliente se queda casi todo. */
const HORQUILLAS = [0.1, 0.25, 0.45, 0.6] as const;

const PROVEEDORES = [
  {
    id: "anthropic",
    nombre: "Anthropic",
    filtro: (k: string) => k.startsWith("claude"),
    /** La fuente original de los precios: la página pública oficial. */
    urlPrecios: "https://www.anthropic.com/pricing",
  },
  {
    id: "openai",
    nombre: "OpenAI",
    filtro: (k: string) => k.startsWith("gpt"),
    urlPrecios: "https://openai.com/api/pricing/",
  },
] as const;

export function CalculadoraComision({ asiento }: { asiento: { cents: number; currency: string } }) {
  const t = useTranslations("landing.calculadora");
  const locale = useLocale();
  const [asientos, setAsientos] = useState(1);
  const [catalogo, setCatalogo] = useState<SdkModule | null>(null);
  const [proveedor, setProveedor] = useState<(typeof PROVEEDORES)[number]["id"]>("anthropic");
  const [modelo, setModelo] = useState("claude-haiku-4-5");
  const [reqs, setReqs] = useState(1_000_000);
  const [inTok, setInTok] = useState(1_200);
  const [outTok, setOutTok] = useState(250);
  const [fx, setFx] = useState(0.9);

  useEffect(() => {
    let alive = true;
    // El mismo bundle que usa el verificador: precios del SDK, sin copia local.
    // @ts-expect-error — especificador URL nativo, resuelto en el navegador.
    const p: Promise<SdkModule> = import(/* webpackIgnore: true */ "/vendor/bv-sala.js");
    p.then((m) => alive && setCatalogo(m)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const prov = PROVEEDORES.find((p) => p.id === proveedor)!;
  const modelos = useMemo(
    () => (catalogo ? Object.keys(catalogo.CATALOGO).filter(prov.filtro) : []),
    [catalogo, prov],
  );
  const modeloActivo = modelos.includes(modelo) ? modelo : modelos[0] ?? "";
  const precio = catalogo && modeloActivo ? catalogo.CATALOGO[modeloActivo] : undefined;

  const eur = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const usd = (n: number) => n.toLocaleString(locale, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const pct = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";

  const filas = useMemo(() => {
    if (!precio) return [];
    // Coste por petición = (tokens/1000) × precio-por-1k; el mes = × peticiones.
    const baseUsdMes = reqs * ((inTok / 1_000) * precio.inputPer1k + (outTok / 1_000) * precio.outputPer1k);
    return HORQUILLAS.map((r) => {
      const ahorroUsd = baseUsdMes * r;
      const baseEur = baseUsdMes * fx;
      const ahorroEur = ahorroUsd * fx;
      const c = calcularComision(baseEur, ahorroEur);
      return {
        ratio: r,
        baseUsd: baseUsdMes,
        ahorroEur,
        extraEur: c.comisionEur,
        netoEur: c.netoClienteEur,
        netoPct: baseEur > 0 ? c.netoClienteEur / baseEur : 0,
      };
    });
  }, [precio, reqs, inTok, outTok, fx]);

  const eurStripe = (cents: number) =>
    (cents / 100).toLocaleString(locale, { style: "currency", currency: asiento.currency.toUpperCase(), maximumFractionDigits: 0 });

  return (
    <div className="calc">
      <div className="calc-head">
        <h3>{t("title")}</h3>
        <span className="est-tag">{t("badge")}</span>
      </div>
      <p className="calc-sub">{t("sub")}</p>

      <div className="calc-grid">
        <label>
          <span>{t("proveedor")}</span>
          <select value={proveedor} onChange={(e) => setProveedor(e.target.value as typeof proveedor)}>
            {PROVEEDORES.map((p) => (
              <option key={p.id} value={p.id}>{p.nombre}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("modelo")}</span>
          <select value={modeloActivo} onChange={(e) => setModelo(e.target.value)} disabled={!catalogo}>
            {modelos.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("reqs")}</span>
          <input type="number" min={0} step={10_000} value={reqs} onChange={(e) => setReqs(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>
          <span>{t("inTok")}</span>
          <input type="number" min={0} step={50} value={inTok} onChange={(e) => setInTok(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>
          <span>{t("outTok")}</span>
          <input type="number" min={0} step={10} value={outTok} onChange={(e) => setOutTok(Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <label>
          {/* El par de divisas va como parámetro: los mensajes tienen prohibido
              llevar EUR/USD a mano (parity.test.ts). */}
          <span>{t("fx", { par: "EUR/USD" })}</span>
          <input type="number" min={0.01} max={10} step={0.01} value={fx} onChange={(e) => setFx(Math.min(10, Math.max(0.01, Number(e.target.value) || 0.9)))} />
        </label>
        <label>
          <span>{t("asientos", { precio: eurStripe(asiento.cents) })}</span>
          <input type="number" min={1} step={1} value={asientos} onChange={(e) => setAsientos(Math.max(1, Math.round(Number(e.target.value) || 1)))} />
        </label>
      </div>

      {precio ? (
        <p className="calc-precios">
          {t("precios", {
            modelo: modeloActivo,
            // Por millón de tokens, el estándar del sector; sale del mismo
            // catálogo (per 1k × mil) — sin redondeos propios.
            inM: (precio.inputPer1k * 1000).toLocaleString(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }),
            outM: (precio.outputPer1k * 1000).toLocaleString(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }),
            cacheM:
              (precio as { cachedInputPer1k?: number }).cachedInputPer1k != null
                ? ((precio as { cachedInputPer1k?: number }).cachedInputPer1k! * 1000).toLocaleString(locale, { style: "currency", currency: "USD", maximumFractionDigits: 3 })
                : "—",
          })}{" "}
          {t.rich("fuente", {
            a: (chunks) => (
              <a href={prov.urlPrecios} target="_blank" rel="noopener noreferrer">
                {chunks}
              </a>
            ),
            proveedor: prov.nombre,
            fecha: catalogo?.PRECIOS_AL_DIA ?? "",
          })}
        </p>
      ) : null}

      {filas.length > 0 ? (
        <>
          <p className="calc-base">{t("factura", { usd: usd(filas[0]!.baseUsd), eur: eur(filas[0]!.baseUsd * fx) })}</p>
          <div className="calc-tblwrap">
            <table>
              <thead>
                <tr>
                  <th>{t("colAhorro")}</th>
                  <th>{t("colTuAhorro")}</th>
                  <th>{t("colExtra")}</th>
                  <th>{t("colTeQuedas")}</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f) => (
                  <tr key={f.ratio}>
                    <td>{pct(f.ratio)}</td>
                    <td>{eur(f.ahorroEur)}</td>
                    <td className={f.extraEur === 0 ? "cero" : ""}>{f.extraEur === 0 ? t("extraCero") : eur(f.extraEur)}</td>
                    <td className="neto">
                      {eur(f.netoEur)} <small>({pct(f.netoPct)})</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* LA VERDAD COMPLETA: el total nuestro incluye también los asientos.
              Se enseña con el escenario del 45% como referencia. */}
          {(() => {
            const ref = filas.find((f) => f.ratio === 0.45) ?? filas[filas.length - 1]!;
            const costeAsientosEur = (asientos * asiento.cents) / 100;
            const totalNuestro = ref.extraEur + costeAsientosEur;
            const netoTotal = ref.ahorroEur - totalNuestro;
            const baseEur = ref.baseUsd * fx;
            return (
              <p className="calc-total">
                {t("resumenTotal", {
                  pct: pct(ref.ratio),
                  asientosCoste: eur(costeAsientosEur),
                  total: eur(totalNuestro),
                  neto: eur(netoTotal),
                  pctNeto: pct(baseEur > 0 ? netoTotal / baseEur : 0),
                })}
              </p>
            );
          })()}
          <p className="calc-nota">{t("notaGarantia", { garantia: pct(GARANTIA_NETA_RATIO) })}</p>
          <p className="calc-nota">
            {t("notaTramos", {
              tramos: TRAMOS.map((tr) =>
                Number.isFinite(tr.hastaEur) ? `${pct(tr.tipo)} ≤ ${eur(tr.hastaEur)}` : `${pct(tr.tipo)} +`,
              ).join(" · "),
            })}
          </p>
          <p className="calc-nota">
            <b>{t("notaPrimerMesLead")}</b> {t("notaPrimerMes")}
          </p>
          {catalogo ? <p className="calc-nota calc-version">{t("version", { fecha: catalogo.PRECIOS_AL_DIA })}</p> : null}
        </>
      ) : (
        <p className="calc-nota">{t("cargando")}</p>
      )}
    </div>
  );
}

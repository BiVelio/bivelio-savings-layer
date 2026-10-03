"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import type { UsageRollup, ModelDia } from "../data";
import { money, intfmt, compact, pct0, LEDGER_COLOR } from "../format";
import {
  cortarPorPeriodo,
  serieDiaria,
  agregarPorModelo,
  topConResto,
  columnaDeMetrica,
  libroDeMetrica,
  metricaDisponiblePorModelo,
  tipoDeMetrica,
  METRICAS,
  PERIODOS,
  type Metrica,
  type Vista,
  type Periodo,
} from "../explorer-datos";
import { aCsv, nombreDeFichero } from "../explorer-exportar";
import {
  escalaBonita,
  marcasEjeX,
  mediaMovil,
  rellenarCalendario,
  resumirSerie,
  type Ranura,
  type Resumen,
} from "../explorer-estadisticas";

/**
 * EXPLORADOR DE USO — uso por día, periodo elegible y desglose por modelo, todo
 * en el cliente sobre las ≤120 filas que el servidor ya trae.
 *
 * Reescrito el 06-09 a petición del dueño («más cuantitativo, es para empresas
 * profesionales»). Lo que había eran barras sin eje: se veía la forma y no se
 * podía leer una sola magnitud. Lo que cambia:
 *
 * · EJE Y con marcas redondas, rejilla y el cero SIEMPRE dentro. Una escala que
 *   arranca en el mínimo observado exagera cualquier diferencia; es el truco de
 *   gráfico más viejo que hay y en un panel que factura no se usa.
 * · EJE X con fechas repartidas, no solo los dos extremos.
 * · CALENDARIO COMPLETO: los huecos se rellenan con ceros MARCADOS. Antes seis
 *   días sueltos de un mes se repartían a lo ancho y se leían como seis días
 *   seguidos.
 * · ESTADÍSTICOS de la distribución (media, σ, mediana, p95, máximo, mínimo) y
 *   una tendencia con su ventana escrita al lado, para que nadie tenga que
 *   adivinar contra qué se compara.
 * · MEDIA MÓVIL de 7 días y línea de media, que es como se mira una serie
 *   ruidosa sin engañarse con el último pico.
 * · TOOLTIP con el valor exacto, el salto contra el día anterior y la cuota del
 *   periodo; navegable con el teclado.
 *
 * Y un fallo de bulto que se va con esto: el SVG tenía `viewBox="0 0 640 170"`
 * con `width="100%"`, así que el navegador lo encajaba POR ALTURA y lo
 * centraba — el gráfico se dibujaba en una franja estrecha con aire muerto a
 * los lados. Ahora el ancho se mide de verdad (ResizeObserver) y una unidad de
 * usuario es un píxel: sin deformación y sin franjas.
 *
 * Honestidad que se mantiene: el desglose por modelo sale vacío («acumulando»)
 * hasta que entre tráfico con modelo — jamás una fila inventada.
 */

const ALTO = 210;
const MARGEN = { arriba: 14, derecha: 16, abajo: 26, izquierda: 62 };
/** Ancho del primer render. IDÉNTICO en servidor y cliente: si no, hidratación rota. */
const ANCHO_BASE = 760;
const MM_VENTANA = 7;
const TOP_MODELOS = 6;

type T = ReturnType<typeof useTranslations>;
type Fmt = (v: number) => string;

/** Selección de un tramo de días por índice en `ranuras`, ambos inclusive. */
export interface Seleccion {
  a: number;
  b: number;
}

/** Clave de la etiqueta traducida de cada métrica. */
const ETIQUETA: Record<Metrica, string> = {
  neto: "usageExplorer.metricNet",
  costeBase: "usageExplorer.metricBaselineCost",
  costeReal: "usageExplorer.metricActualCost",
  peticiones: "usageExplorer.metricRequests",
  tokensEntrada: "usageExplorer.metricInputTokens",
  llamadasEvitadas: "usageExplorer.metricAvoidedCalls",
  tokensEliminados: "usageExplorer.metricEliminatedTokens",
  tokensComprimidos: "usageExplorer.metricCompressedTokens",
  tokensCacheProveedor: "usageExplorer.metricProviderCachedTokens",
};

/** Lo que el explorador recuerda de quien mira, en SU navegador. El periodo no: ese lo manda el rango de la URL. */
const CLAVE_EXPLORADOR = "bvsala.explorer.v1";
interface EstadoRecordado {
  metrica?: Metrica;
  vista?: Vista;
}
const esMetrica = (x: unknown): x is Metrica => METRICAS.some((m) => m.v === x);
const esVista = (x: unknown): x is Vista => x === "dia" || x === "acumulado" || x === "modelo";

function leerRecordado(): EstadoRecordado {
  try {
    const crudo = window.localStorage.getItem(CLAVE_EXPLORADOR);
    const o = crudo ? (JSON.parse(crudo) as Record<string, unknown>) : {};
    return {
      ...(esMetrica(o["metrica"]) ? { metrica: o["metrica"] } : {}),
      ...(esVista(o["vista"]) ? { vista: o["vista"] } : {}),
    };
  } catch {
    return {};
  }
}

function recordar(e: EstadoRecordado): void {
  try {
    window.localStorage.setItem(CLAVE_EXPLORADOR, JSON.stringify(e));
  } catch {
    /* sin almacén no pasa nada: se vuelve al valor por defecto la próxima vez */
  }
}

/** Baja un fichero de texto desde el navegador, sin dejar el enlace colgando del DOM. */
function descargar(nombre: string, contenido: string): void {
  const blob = new Blob([contenido], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function UsageExplorer({
  usage,
  porModelo,
  periodoInicial = 30,
}: {
  usage: UsageRollup[];
  porModelo: ModelDia[];
  /** El rango del panel (URL). El explorador arranca ahí y luego el usuario puede afinar. */
  periodoInicial?: Periodo;
}) {
  const t = useTranslations("dashboard");
  const [periodo, setPeriodo] = useState<Periodo>(periodoInicial);
  const [metrica, setMetrica] = useState<Metrica>("neto");
  const [vista, setVista] = useState<Vista>("dia");
  const [seleccion, setSeleccion] = useState<Seleccion | null>(null);
  const [montado, setMontado] = useState(false);

  // Si el rango del panel cambia (enlace 30/90/120), el explorador lo sigue.
  useEffect(() => {
    setPeriodo(periodoInicial);
    setSeleccion(null);
  }, [periodoInicial]);

  // Métrica y vista se recuerdan tras montar: el primer render es el mismo en
  // servidor y cliente, y solo después se aplica lo que este navegador guardó.
  useEffect(() => {
    const r = leerRecordado();
    if (r.metrica) setMetrica(r.metrica);
    if (r.vista) setVista(r.vista);
    setMontado(true);
  }, []);
  useEffect(() => {
    if (montado) recordar({ metrica, vista });
  }, [montado, metrica, vista]);

  // Dinero para los costes y el neto, entero para recuentos (un recuento pequeño
  // se quiere exacto), compacto para tokens (millones). El valor EXACTO viaja en
  // el tooltip vía `fmtExact`, así que la abreviatura nunca pierde información.
  const tipo = tipoDeMetrica(metrica);
  const fmt: Fmt = (v) => (tipo === "dinero" ? money(v) : tipo === "entero" ? intfmt(v) : compact(v));
  const fmtExact: Fmt = (v) => (tipo === "dinero" ? money(v) : intfmt(v));

  const usageCortado = useMemo(() => cortarPorPeriodo(usage, periodo), [usage, periodo]);
  const modeloCortado = useMemo(() => cortarPorPeriodo(porModelo, periodo), [porModelo, periodo]);

  const diaria = useMemo(() => serieDiaria(usageCortado, metrica), [usageCortado, metrica]);
  const ranuras = useMemo(() => rellenarCalendario(diaria), [diaria]);

  // La selección vive en índices de `ranuras`; si el periodo o la métrica la
  // dejan fuera de rango, se descarta en vez de señalar días que ya no están.
  const sel = seleccion && seleccion.b < ranuras.length ? seleccion : null;
  const ranurasVisibles = useMemo(() => (sel ? ranuras.slice(sel.a, sel.b + 1) : ranuras), [ranuras, sel]);
  const resumen = useMemo(() => resumirSerie(ranurasVisibles, MM_VENTANA), [ranurasVisibles]);

  const modelosTodos = useMemo(() => agregarPorModelo(modeloCortado, metrica), [modeloCortado, metrica]);
  const barras = useMemo(
    () => topConResto(modelosTodos, TOP_MODELOS, t("usageExplorer.modelOther")),
    [modelosTodos, t],
  );

  const seg = <V extends string | number>(
    grupo: string,
    valor: V,
    set: (v: V) => void,
    opciones: { v: V; label: string }[],
  ) => (
    <div className="ux-seg">
      <span className="ck-eyebrow">{grupo}</span>
      <div className="opts" role="group" aria-label={grupo}>
        {opciones.map((o) => (
          <button key={o.v} type="button" aria-pressed={o.v === valor} onClick={() => set(o.v)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  const esModelo = vista === "modelo";
  const libro = libroDeMetrica(metrica);

  const exportar = () => {
    const modo = vista === "acumulado" ? "acumulado" : "dia";
    let acc = 0;
    const serieCompleta = ranuras.map((r) => (modo === "dia" ? r.valor : (acc += r.valor)));
    const serie = sel ? serieCompleta.slice(sel.a, sel.b + 1) : serieCompleta;
    descargar(
      nombreDeFichero(ranurasVisibles, metrica),
      aCsv(ranurasVisibles, serie, {
        metrica,
        periodoDias: periodo,
        modo,
        origen: `bvsala.usage_daily.${columnaDeMetrica(metrica)}`,
        generadoEn: new Date().toISOString(),
      }),
    );
  };

  return (
    <div>
      <div className="ux-controls">
        {seg<Periodo>(t("usageExplorer.period"), periodo, (p) => { setPeriodo(p); setSeleccion(null); }, PERIODOS.map((p) => ({ v: p, label: String(p) })))}
        {seg<Metrica>(t("usageExplorer.metric"), metrica, (m) => { setMetrica(m); setSeleccion(null); }, METRICAS.map((m) => ({ v: m.v, label: t(ETIQUETA[m.v]) })))}
        {seg<Vista>(t("usageExplorer.view"), vista, setVista, [
          { v: "dia", label: t("usageExplorer.viewDaily") },
          { v: "acumulado", label: t("usageExplorer.viewCumulative") },
          { v: "modelo", label: t("usageExplorer.viewModel") },
        ])}
        {!esModelo && ranuras.length > 0 && (
          <div className="ux-seg ux-actions">
            <span className="ck-eyebrow">{t("usageExplorer.actions")}</span>
            <div className="opts">
              <button type="button" onClick={exportar}>{t("usageExplorer.exportCsv")}</button>
            </div>
          </div>
        )}
      </div>

      {esModelo ? (
        metricaDisponiblePorModelo(metrica) ? (
          <VistaModelo barras={barras} totalModelos={modelosTodos.length} metrica={metrica} fmt={fmt} fmtExact={fmtExact} t={t} />
        ) : (
          <p className="ck-note">{t("usageExplorer.modelMetricUnavailable", { metric: t(ETIQUETA[metrica]) })}</p>
        )
      ) : ranuras.length === 0 ? (
        <p className="ck-note">{t("usageExplorer.emptyPeriod")}</p>
      ) : (
        <>
          <TiraEstadisticas resumen={resumen} metrica={metrica} fmt={fmt} t={t} />
          <Grafico
            ranuras={ranuras}
            modo={vista === "acumulado" ? "acumulado" : "dia"}
            metrica={metrica}
            color={libro ? LEDGER_COLOR[libro] ?? "var(--ink)" : undefined}
            seleccion={sel}
            onSeleccion={setSeleccion}
            fmt={fmt}
            fmtExact={fmtExact}
            t={t}
            aria={vista === "acumulado" ? t("savingsTrendChart.chartAria") : t("usageExplorer.dailyAria")}
          />
          <div className="ux-sel">
            {sel ? (
              <>
                <span className="ux-foot">
                  {t("usageExplorer.selection", { from: ranurasVisibles[0]!.day, to: ranurasVisibles[ranurasVisibles.length - 1]!.day, n: ranurasVisibles.length })}
                </span>
                <button type="button" className="pe-btn" onClick={() => setSeleccion(null)}>
                  {t("usageExplorer.clearSelection")}
                </button>
              </>
            ) : (
              <span className="ux-foot">
                {ranuras[0]!.day} → {ranuras[ranuras.length - 1]!.day} ·{" "}
                {t("usageExplorer.coverage", { conUso: resumen.diasConUso, total: resumen.diasTotales })} · {t("usageExplorer.selectHint")}
              </span>
            )}
          </div>
          <p className="ux-foot src">
            {t("usageExplorer.source", { column: `bvsala.usage_daily.${columnaDeMetrica(metrica)}` })}
            {libro && ` · ${t("usageExplorer.ledgerNote", { ledger: libro })}`}
          </p>
        </>
      )}
    </div>
  );
}

/* ── Estadísticos ───────────────────────────────────────────────────────── */

function Casilla({ k, v, s, cls }: { k: string; v: string; s: string; cls?: string }) {
  return (
    <div className="ux-stat">
      <span className="k">{k}</span>
      <div className={`v ${cls ?? ""}`.trim()}>{v}</div>
      <span className="s">{s}</span>
    </div>
  );
}

/** «+38 %» / «−12 %». Con el signo menos de verdad, que es un número, no un guion. */
const pctFirmado = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${pct0(Math.abs(x))}`;

function TiraEstadisticas({ resumen, metrica, fmt, t }: { resumen: Resumen; metrica: Metrica; fmt: Fmt; t: T }) {
  // El color solo significa algo cuando la métrica ES dinero ahorrado. Teñir de
  // rojo «más peticiones» diría que consumir es malo, y este producto no vende
  // eso: vende que lo que consumes cueste menos.
  const tono = (v: number) => (metrica !== "neto" ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
  const tend = resumen.tendencia;
  const etiquetaVentana = tend
    ? tend.modo === "ventana"
      ? t("usageExplorer.trendWindow", { n: tend.ventana })
      : t("usageExplorer.trendHalves")
    : "—";

  return (
    <div className="ux-stats">
      <Casilla
        k={t("usageExplorer.statTotal")}
        v={fmt(resumen.total)}
        cls={tono(resumen.total)}
        s={t("usageExplorer.coverage", { conUso: resumen.diasConUso, total: resumen.diasTotales })}
      />
      <Casilla k={t("usageExplorer.statMean")} v={fmt(resumen.media)} s={`σ ${fmt(resumen.desviacion)}`} />
      <Casilla k={t("usageExplorer.statMedian")} v={fmt(resumen.mediana)} s={`p95 ${fmt(resumen.p95)}`} />
      <Casilla k={t("usageExplorer.statMax")} v={fmt(resumen.max?.valor ?? 0)} s={resumen.max?.day ?? "—"} />
      <Casilla k={t("usageExplorer.statMin")} v={fmt(resumen.min?.valor ?? 0)} s={resumen.min?.day ?? "—"} />
      <Casilla
        k={t("usageExplorer.statTrend")}
        v={tend?.delta != null ? pctFirmado(tend.delta) : "—"}
        cls={tend?.delta != null ? tono(tend.delta) : ""}
        s={tend ? (tend.delta == null ? t("usageExplorer.trendNoBase") : etiquetaVentana) : "—"}
      />
    </div>
  );
}

/* ── El gráfico ─────────────────────────────────────────────────────────── */

/** Etiqueta compacta de fecha para el eje: MM-DD, que ordena y no depende del idioma. */
const etiquetaDia = (iso: string) => iso.slice(5);

function Grafico({
  ranuras,
  modo,
  metrica,
  color,
  seleccion,
  onSeleccion,
  fmt,
  fmtExact,
  t,
  aria,
}: {
  ranuras: Ranura[];
  modo: "dia" | "acumulado";
  metrica: Metrica;
  /** Color de la serie cuando la métrica es un libro (la rampa de LEDGER_COLOR). */
  color?: string;
  seleccion: Seleccion | null;
  onSeleccion: (s: Seleccion | null) => void;
  fmt: Fmt;
  fmtExact: Fmt;
  t: T;
  aria: string;
}) {
  const cajaRef = useRef<HTMLDivElement | null>(null);
  const [ancho, setAncho] = useState(ANCHO_BASE);
  const [foco, setFoco] = useState<number | null>(null);
  /** Índice donde empezó el arrastre; null cuando no se está arrastrando. */
  const [arrastre, setArrastre] = useState<number | null>(null);

  // El ancho se MIDE. Con `viewBox` fijo y `width="100%"` el navegador encajaba
  // el dibujo por altura y lo centraba, dejando franjas muertas a los lados.
  useEffect(() => {
    const el = cajaRef.current;
    if (!el) return;
    const medir = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setAncho(w);
    };
    medir();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", medir);
      return () => window.removeEventListener("resize", medir);
    }
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = ranuras.length;

  const serie = useMemo(() => {
    if (modo === "dia") return ranuras.map((r) => r.valor);
    let acc = 0;
    return ranuras.map((r) => (acc += r.valor));
  }, [ranuras, modo]);

  const mm = useMemo(() => (modo === "dia" ? mediaMovil(ranuras, MM_VENTANA) : []), [ranuras, modo]);
  const esc = useMemo(
    () => escalaBonita(Math.min(0, ...serie), Math.max(0, ...serie), 4),
    [serie],
  );

  const anchoInterior = Math.max(60, ancho - MARGEN.izquierda - MARGEN.derecha);
  const altoInterior = ALTO - MARGEN.arriba - MARGEN.abajo;
  const slot = anchoInterior / Math.max(1, n);
  const xc = (i: number) => MARGEN.izquierda + i * slot + slot / 2;
  const rango = esc.max - esc.min || 1;
  const y = (v: number) => MARGEN.arriba + altoInterior * (1 - (v - esc.min) / rango);
  /** Media línea de desfase: sin esto un hairline de 1px sale gris y borroso. */
  const yNitido = (v: number) => Math.round(y(v)) + 0.5;
  const yCero = y(0);
  const anchoBarra = Math.max(1, Math.min(30, slot * 0.66));

  const media = n > 0 ? serie.reduce((s, v) => s + v, 0) / n : 0;
  const totalSerie = modo === "dia" ? serie.reduce((s, v) => s + v, 0) : (serie[n - 1] ?? 0);
  const hayHuecos = ranuras.some((r) => !r.conDatos);

  const marcas = useMemo(
    () => marcasEjeX(n, Math.max(2, Math.min(8, Math.floor(anchoInterior / 88)))),
    [n, anchoInterior],
  );

  const colorSerie = color ?? (metrica === "neto" ? "var(--mint)" : "var(--ink)");
  const rellenoBarra = (v: number) =>
    metrica === "neto" ? (v >= 0 ? "var(--mint)" : "var(--danger)") : colorSerie;

  /** Índice de ranura bajo el puntero, o null fuera del área de datos. */
  const indiceEn = (clientX: number, el: HTMLElement): number | null => {
    const caja = el.getBoundingClientRect();
    const rel = clientX - caja.left - MARGEN.izquierda;
    const i = Math.floor(rel / slot);
    return rel >= 0 && i >= 0 && i < n ? i : null;
  };
  const fijarSeleccion = (i: number, j: number) => onSeleccion(i === j ? null : { a: Math.min(i, j), b: Math.max(i, j) });

  const puntosMM = mm
    .map((v, i) => (v === null ? null : ([xc(i), y(v)] as const)))
    .filter((p): p is readonly [number, number] => p !== null);
  const dMM =
    puntosMM.length >= 2
      ? puntosMM.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")
      : null;

  const dLinea = serie.map((v, i) => `${i ? "L" : "M"}${xc(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dArea =
    n >= 2
      ? `${dLinea} L${xc(n - 1).toFixed(1)},${yCero.toFixed(1)} L${xc(0).toFixed(1)},${yCero.toFixed(1)} Z`
      : null;

  const mover = (paso: number) =>
    setFoco((f) => Math.max(0, Math.min(n - 1, (f ?? (paso > 0 ? -1 : n)) + paso)));

  const r = foco !== null ? ranuras[foco] : undefined;
  const salto =
    foco !== null && foco > 0 ? (modo === "dia" ? serie[foco]! - serie[foco - 1]! : ranuras[foco]!.valor) : null;
  const saltoRel =
    foco !== null && foco > 0 && serie[foco - 1] !== 0 && modo === "dia"
      ? (serie[foco]! - serie[foco - 1]!) / Math.abs(serie[foco - 1]!)
      : null;

  return (
    <div>
      <div
        className="ux-plot"
        ref={cajaRef}
        tabIndex={0}
        role="group"
        aria-label={aria}
        onPointerMove={(e) => {
          const i = indiceEn(e.clientX, e.currentTarget);
          setFoco(i);
          // Arrastrando: la selección crece con el puntero. Se PINTA en vivo y
          // las estadísticas se recalculan al soltar (ver onPointerUp).
          if (arrastre !== null && i !== null) fijarSeleccion(arrastre, i);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const i = indiceEn(e.clientX, e.currentTarget);
          if (i === null) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setArrastre(i);
          onSeleccion(null);
        }}
        onPointerUp={(e) => {
          if (arrastre === null) return;
          const i = indiceEn(e.clientX, e.currentTarget);
          if (i !== null) fijarSeleccion(arrastre, i);
          setArrastre(null);
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={() => setArrastre(null)}
        onPointerLeave={() => { if (arrastre === null) setFoco(null); }}
        onBlur={() => setFoco(null)}
        onKeyDown={(e) => {
          // Con Mayús, las flechas EXTIENDEN la selección desde el ancla; sin
          // ella, mueven el foco como siempre. Escape quita foco y selección.
          const extender = (destino: number) => {
            const ancla = seleccion ? (foco === seleccion.b ? seleccion.a : seleccion.b) : (foco ?? destino);
            fijarSeleccion(ancla, destino);
            setFoco(destino);
          };
          const paso = (d: number) => Math.max(0, Math.min(n - 1, (foco ?? (d > 0 ? -1 : n)) + d));
          if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? extender(paso(1)) : mover(1); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); e.shiftKey ? extender(paso(-1)) : mover(-1); }
          else if (e.key === "Home") { e.preventDefault(); e.shiftKey ? extender(0) : setFoco(0); }
          else if (e.key === "End") { e.preventDefault(); e.shiftKey ? extender(n - 1) : setFoco(n - 1); }
          else if (e.key === "Escape") { setFoco(null); onSeleccion(null); }
        }}
      >
        <svg width={ancho} height={ALTO} viewBox={`0 0 ${ancho} ${ALTO}`} role="img" aria-label={aria}>
          {/* Rejilla y eje Y. El cero se marca más fuerte: es la referencia. */}
          {esc.ticks.map((tk) => (
            <g key={tk}>
              <line
                x1={MARGEN.izquierda}
                x2={ancho - MARGEN.derecha}
                y1={yNitido(tk)}
                y2={yNitido(tk)}
                stroke={tk === 0 ? "var(--ink-soft)" : "var(--line)"}
                strokeOpacity={tk === 0 ? 0.45 : 1}
                shapeRendering="crispEdges"
              />
              <text
                x={MARGEN.izquierda - 9}
                y={y(tk)}
                textAnchor="end"
                dominantBaseline="middle"
                fontFamily="var(--mono)"
                fontSize="9.5"
                fill="var(--ink-soft)"
              >
                {fmt(tk)}
              </text>
            </g>
          ))}

          {/* Tramo seleccionado, debajo de todo: el contexto sigue visible y el
              tramo se lee como una ventana sobre el periodo, no como un zoom. */}
          {seleccion && (
            <rect
              x={MARGEN.izquierda + seleccion.a * slot}
              y={MARGEN.arriba}
              width={(seleccion.b - seleccion.a + 1) * slot}
              height={altoInterior}
              fill="var(--brand)"
              fillOpacity="0.08"
              stroke="var(--brand)"
              strokeOpacity="0.45"
              strokeDasharray="3 3"
              shapeRendering="crispEdges"
            />
          )}

          {/* Columna resaltada por debajo de los datos, nunca encima. */}
          {foco !== null && (
            <rect
              x={MARGEN.izquierda + foco * slot}
              y={MARGEN.arriba}
              width={slot}
              height={altoInterior}
              fill="var(--ink)"
              fillOpacity="0.05"
            />
          )}

          {modo === "dia" ? (
            <>
              {ranuras.map((rr, i) => {
                const x = MARGEN.izquierda + i * slot + (slot - anchoBarra) / 2;
                if (!rr.conDatos) {
                  // Día sin fila: cero real, pero cero SIN MEDIR. Se marca aparte
                  // para que un fin de semana o una caída del gateway se vean.
                  return (
                    <rect key={rr.day} x={x} y={yCero - 1} width={anchoBarra} height={2} fill="var(--muted)" fillOpacity="0.5" />
                  );
                }
                const yv = y(rr.valor);
                const alto = Math.max(1.5, Math.abs(yv - yCero));
                return (
                  <rect
                    key={rr.day}
                    x={x.toFixed(1)}
                    y={Math.min(yv, yCero).toFixed(1)}
                    width={anchoBarra.toFixed(1)}
                    height={alto.toFixed(1)}
                    rx={anchoBarra > 4 ? 1.5 : 0}
                    fill={rellenoBarra(rr.valor)}
                    fillOpacity={foco === null || foco === i ? 0.92 : 0.5}
                  />
                );
              })}
              {n >= 2 && (
                <line
                  x1={MARGEN.izquierda}
                  x2={ancho - MARGEN.derecha}
                  y1={yNitido(media)}
                  y2={yNitido(media)}
                  stroke="var(--ink-soft)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                  strokeOpacity="0.75"
                />
              )}
              {dMM && <path d={dMM} fill="none" stroke="var(--brand)" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />}
            </>
          ) : (
            <>
              {dArea && <path d={dArea} fill={`color-mix(in srgb, ${colorSerie} 13%, transparent)`} />}
              <path d={dLinea} fill="none" stroke={colorSerie} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {n >= 1 && <circle cx={xc(n - 1)} cy={y(serie[n - 1]!)} r="3" fill={colorSerie} />}
            </>
          )}

          {/* Marca del punto enfocado: el mismo gesto en las dos vistas. */}
          {foco !== null && (
            <circle cx={xc(foco)} cy={y(serie[foco]!)} r="3.5" fill="var(--surface)" stroke={colorSerie} strokeWidth="2" />
          )}

          {/* Eje X. Los extremos se anclan al borde para que no se recorten. */}
          {marcas.map((i) => (
            <text
              key={i}
              x={i === 0 ? MARGEN.izquierda : i === n - 1 ? ancho - MARGEN.derecha : xc(i)}
              y={ALTO - 8}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontFamily="var(--mono)"
              fontSize="9.5"
              fill="var(--ink-soft)"
            >
              {etiquetaDia(ranuras[i]!.day)}
            </text>
          ))}
        </svg>

        {r && (
          <div className="ux-tip" style={{ left: Math.max(84, Math.min(ancho - 84, xc(foco!))), top: 2 }}>
            <div className="d">
              {r.day}
              {!r.conDatos && ` · ${t("usageExplorer.noTraffic")}`}
            </div>
            <div className={`v ${metrica === "neto" ? (serie[foco!]! >= 0 ? "pos" : "neg") : ""}`.trim()}>
              {fmtExact(serie[foco!]!)}
            </div>
            {salto !== null && (
              <div className="r">
                <span>{t("usageExplorer.tipDelta")}</span>
                <b className={salto > 0 ? "pos" : salto < 0 ? "neg" : ""}>
                  {salto > 0 ? "+" : salto < 0 ? "−" : ""}
                  {fmtExact(Math.abs(salto))}
                  {saltoRel !== null && ` (${pctFirmado(saltoRel)})`}
                </b>
              </div>
            )}
            {totalSerie !== 0 && (
              <div className="r">
                <span>{t("usageExplorer.tipShare")}</span>
                <b>{pct0(Math.abs((modo === "dia" ? r.valor : serie[foco!]!) / totalSerie))}</b>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ux-legend">
        {modo === "dia" && dMM && (
          <span><i className="mm" />{t("usageExplorer.movingAvg", { n: MM_VENTANA })}</span>
        )}
        {modo === "dia" && n >= 2 && (
          <span><i className="med" />{t("usageExplorer.meanLine")} {fmt(media)}</span>
        )}
        {modo === "dia" && hayHuecos && (
          <span><i className="gap" />{t("usageExplorer.noTraffic")}</span>
        )}
      </div>
    </div>
  );
}

/* ── Por modelo ─────────────────────────────────────────────────────────── */

/** Tabla de Pareto por modelo: cuota y cuota ACUMULADA, que es la que dice
 *  cuántos modelos hay que tocar para mover la factura de verdad. */
function VistaModelo({
  barras,
  totalModelos,
  metrica,
  fmt,
  fmtExact,
  t,
}: {
  barras: { model: string; valor: number }[];
  totalModelos: number;
  metrica: Metrica;
  fmt: Fmt;
  fmtExact: Fmt;
  t: T;
}) {
  if (barras.length === 0) return <p className="ck-note">{t("usageExplorer.modelEmpty")}</p>;

  const total = barras.reduce((s, b) => s + b.valor, 0);
  // La barra más larga es la del mayor valor. El suelo era 1 (un dólar, un
  // token): con importes por debajo de 1 $ todas las barras salían a ras de
  // cero. Solo se protege la división cuando todo vale 0.
  const max = Math.max(...barras.map((b) => Math.abs(b.valor))) || 1;
  const cuota = (v: number) => (total !== 0 ? v / total : 0);
  let acc = 0;
  const filas = barras.map((b) => {
    acc += b.valor;
    return { ...b, cuota: cuota(b.valor), acumulada: cuota(acc) };
  });
  const top3 = cuota(barras.slice(0, 3).reduce((s, b) => s + b.valor, 0));
  const color = metrica === "neto" ? "var(--mint)" : "var(--ink)";

  return (
    <div>
      <div className="ux-stats c4">
        <Casilla k={t("usageExplorer.statModels")} v={intfmt(totalModelos)} s={t("usageExplorer.colModel")} />
        <Casilla k={t("usageExplorer.statTop1")} v={pct0(Math.abs(filas[0]!.cuota))} s={filas[0]!.model} />
        <Casilla k={t("usageExplorer.statTop3")} v={pct0(Math.abs(top3))} s={fmt(barras.slice(0, 3).reduce((s, b) => s + b.valor, 0))} />
        <Casilla k={t("usageExplorer.statTotal")} v={fmt(total)} s={t("usageExplorer.rowTotal")} />
      </div>

      <table className="ux-tbl">
        <thead>
          <tr>
            <th scope="col">{t("usageExplorer.colModel")}</th>
            <th scope="col" className="b" aria-hidden />
            <th scope="col">{t("usageExplorer.colValue")}</th>
            <th scope="col">{t("usageExplorer.colShare")}</th>
            <th scope="col">{t("usageExplorer.colCumulative")}</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.model}>
              <td className="m" title={f.model}>{f.model}</td>
              <td className="b">
                <div className="track2" title={`${f.model} · ${fmtExact(f.valor)}`}>
                  <div className="fill2" style={{ width: `${Math.max(2, (Math.abs(f.valor) / max) * 100)}%`, background: color }} />
                </div>
              </td>
              <td>{fmt(f.valor)}</td>
              <td className="q">{pct0(Math.abs(f.cuota))}</td>
              <td className="q">{pct0(Math.abs(f.acumulada))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("usageExplorer.rowTotal")}</td>
            <td className="b" />
            <td>{fmt(total)}</td>
            <td className="q">{pct0(total !== 0 ? 1 : 0)}</td>
            <td className="q" />
          </tr>
        </tfoot>
      </table>

      <p className="ux-foot">{t("usageExplorer.summaryModels", { value: fmt(total), n: totalModelos })}</p>
    </div>
  );
}

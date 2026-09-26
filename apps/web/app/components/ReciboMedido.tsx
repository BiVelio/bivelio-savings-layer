import type { CSSProperties } from "react";

import type { AbArtifact } from "@/app/[locale]/dashboard/data";
import { librosConPiezaDelBanco, midioElSdkInstalado, sueloPublicable } from "@/lib/bench/sdk-instalado";

/**
 * El recibo medido, en el héroe. Es la tesis del producto convertida en la
 * primera cosa que se ve: una tarjeta tinta con forma de recibo/terminal que
 * enseña la tirada publicada tal cual sale del artefacto — el suelo del
 * intervalo, el modelo, las parejas, la calidad y cada libro contable con su
 * propio intervalo. Ni un dígito escrito a mano: todo llega de
 * `public/data/ab-live.json`, el mismo fichero que lee el panel y que la verja
 * `cifra-del-heroe.test.ts` compara con lo prometido.
 *
 * SALVO QUE LA TIRADA NO MIDIERA EL SDK QUE SE INSTALA. La del 2026-09-12
 * llevaba el compresor del banco, que npm no trae, y su suelo (≥ 23,2 %) era la
 * primera cifra de la portada mientras el titular ya decía menos. Sin
 * `sdk.asShipped: true`, el número grande es el que el paquete sostiene
 * (`sueloPublicable`), no se enseña el punto de esa tirada, los libros que
 * mezclan esa pieza no salen y una línea dice por qué (lib/bench/sdk-instalado.ts).
 */
export function ReciboMedido({
  ab,
  locale,
  labels,
  filas,
}: {
  ab: AbArtifact;
  locale: string;
  labels: {
    title: string;
    modelo: string;
    parejas: string;
    calidad: string;
    suelo: string;
    punto: string;
    libros: string;
    pie: string;
    fecha: string;
    /** Sustituye a `suelo` cuando la tirada no midió el SDK tal como se instala. */
    sdkPendiente: string;
  };
  /** Título humano por libro (de `cascade.steps`), en el idioma de la página. */
  filas: { ledger: string; title: string }[];
}) {
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const entero = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const meta = ab as unknown as { commit?: string; trials?: number; generatedAt?: string; model?: string };
  const modelo = (meta.model ?? "").split("/").pop() ?? "";
  const fecha = meta.generatedAt
    ? new Date(meta.generatedAt).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" })
    : "";

  const instalado = midioElSdkInstalado(ab);
  const conPiezaDelBanco = librosConPiezaDelBanco(ab);
  const porLibro = new Map((ab.ledgers ?? []).map((l) => [l.ledger, l]));
  // Solo los libros que despejaron el cero y cuyo ahorro entrega el paquete de
  // npm; el orden es el de la cascada.
  const rows = filas
    .map((f) => ({ ...f, m: porLibro.get(f.ledger) }))
    .filter(
      (r): r is typeof r & { m: NonNullable<typeof r.m> } => !!r.m && r.m.proven && !conPiezaDelBanco.has(r.ledger),
    );
  const dmax = Math.max(0.5, ...rows.map((r) => r.m.savings.upper)) + 0.04;
  const x = (v: number) => `${Math.max(0, Math.min(100, (v / dmax) * 100)).toFixed(2)}%`;

  return (
    <div className="recibo" aria-label={labels.title}>
      <div className="recibo-bar">
        <span className="dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="fn">{labels.title}</span>
        <span className="live">{ab.mode}</span>
      </div>

      <div className="recibo-head">
        <div className="recibo-big">
          <span className="ge">≥</span>
          {pct.format(sueloPublicable(ab))}
        </div>
        <dl className="recibo-meta">
          <div>
            <dt>{labels.modelo}</dt>
            <dd>
              <code>{modelo}</code>
            </dd>
          </div>
          <div>
            <dt>{labels.parejas}</dt>
            <dd>{entero.format(meta.trials ?? 0)}</dd>
          </div>
          <div>
            <dt>{labels.calidad}</dt>
            <dd>{pct.format(ab.aggregate.qualityPassRate)}</dd>
          </div>
          {instalado ? (
            <div>
              <dt>{labels.punto}</dt>
              <dd>{pct.format(ab.aggregate.savings.point)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="recibo-suelo">{instalado ? labels.suelo : labels.sdkPendiente}</p>
      </div>

      <div className="recibo-libros">
        <span className="recibo-k">{labels.libros}</span>
        {rows.map((r, i) => (
          <div className="recibo-row" key={r.ledger} style={{ "--i": i } as CSSProperties}>
            <span className="rn">
              {r.title}
              <code>{r.ledger}</code>
            </span>
            <span className="rbar" aria-hidden="true">
              <i className="rfill" style={{ left: x(r.m.savings.lower), width: `calc(${x(r.m.savings.upper)} - ${x(r.m.savings.lower)})` }} />
              <i className="rpt" style={{ left: x(r.m.savings.point) }} />
            </span>
            <span className="rval">{pct.format(r.m.savings.lower)}</span>
          </div>
        ))}
      </div>

      <p className="recibo-pie">
        {labels.pie}
        <span className="recibo-fecha">
          {labels.fecha} {fecha}
          {meta.commit ? <code> · {meta.commit}</code> : null}
          <span className="caret" aria-hidden="true" />
        </span>
      </p>
    </div>
  );
}

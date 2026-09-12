import type { CSSProperties } from "react";

import type { AbArtifact } from "@/app/[locale]/dashboard/data";

/**
 * El recibo medido, en el héroe. Es la tesis del producto convertida en la
 * primera cosa que se ve: una tarjeta tinta con forma de recibo/terminal que
 * enseña la tirada publicada tal cual sale del artefacto — el suelo del
 * intervalo, el modelo, las parejas, la calidad y cada libro contable con su
 * propio intervalo. Ni un dígito escrito a mano: todo llega de
 * `public/data/ab-live.json`, el mismo fichero que lee el panel y que la verja
 * `cifra-del-heroe.test.ts` compara con lo prometido.
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

  const porLibro = new Map((ab.ledgers ?? []).map((l) => [l.ledger, l]));
  // Solo los libros que despejaron el cero; el orden es el de la cascada.
  const rows = filas
    .map((f) => ({ ...f, m: porLibro.get(f.ledger) }))
    .filter((r): r is typeof r & { m: NonNullable<typeof r.m> } => !!r.m && r.m.proven);
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
          {pct.format(ab.aggregate.savings.lower)}
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
          <div>
            <dt>{labels.punto}</dt>
            <dd>{pct.format(ab.aggregate.savings.point)}</dd>
          </div>
        </dl>
        <p className="recibo-suelo">{labels.suelo}</p>
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

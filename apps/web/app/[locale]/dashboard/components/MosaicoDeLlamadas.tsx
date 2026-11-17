import { getLocale, getTranslations } from "next-intl/server";

import type { UsageRollup } from "../data";
import { intfmt } from "../format";

/**
 * EL MOSAICO DE LLAMADAS — la pieza de la Firma de campaña (dirección A) en
 * el Resumen: una columna por día, partida en lo que se RESPONDIÓ SIN LLAMAR
 * AL PROVEEDOR (en cian, el único sitio del panel donde el cian es dato) y lo
 * que se EJECUTÓ (en tinta).
 *
 * NO CALCULA NADA NUEVO. Lee las dos columnas diarias que ya leen la tarjeta
 * «Tráfico» (`TrafficModelMix`: `avoidedLlm` y `actualLlm`) y el explorador
 * («Llamadas evitadas»), del mismo uso ya cortado al rango del titular; los
 * dos totales de la leyenda son exactamente los de esa tarjeta.
 *
 * LA ESCALA ES LITERAL Y LA DICE EL PIE: cada tesela vale `k` llamadas (1, 2,
 * 5, 10, 20, 25, 50…, la menor que deja la columna más alta en 24 teselas) y
 * una tesela incompleta se pinta incompleta: la altura es la cifra exacta. Un
 * día sin fila es un HUECO (ni columna ni cero), como en el pulso del periodo.
 *
 * Sin llamadas en todo el periodo no se pinta: el titular ya explica qué pasa.
 */

const DIA_MS = 86_400_000;
/** Altura de una tesela (6 px de color + 1 px de junta) y tope de teselas. */
const TESELA_PX = 7;
const MAX_TESELAS = 24;

/** La menor escala «redonda» que deja `max` llamadas en MAX_TESELAS teselas. */
export function escalaDeTeselas(max: number): number {
  if (!(max > 0)) return 1;
  for (let p = 1; ; p *= 10) {
    for (const m of [1, 2, 2.5, 5]) {
      const k = m * p;
      if (Number.isInteger(k) && max / k <= MAX_TESELAS) return k;
    }
  }
}

export interface DiaDelMosaico {
  day: string;
  /** null = día sin fila en el rango: un hueco. */
  sinProveedor: number | null;
  ejecutadas: number | null;
}

/** Un día natural por columna entre el primero y el último con fila. */
export function diasDelMosaico(usage: UsageRollup[]): DiaDelMosaico[] {
  const porDia = new Map<string, { a: number; e: number }>();
  for (const r of usage) {
    const g = porDia.get(r.day) ?? { a: 0, e: 0 };
    g.a += r.avoidedLlm;
    g.e += r.actualLlm;
    porDia.set(r.day, g);
  }
  const dias = [...porDia.keys()].sort();
  if (dias.length === 0) return [];
  const desde = Date.parse(`${dias[0]}T00:00:00Z`);
  const hasta = Date.parse(`${dias[dias.length - 1]}T00:00:00Z`);
  if (Number.isNaN(desde) || Number.isNaN(hasta) || hasta - desde > 400 * DIA_MS) return [];
  const out: DiaDelMosaico[] = [];
  for (let d = desde; d <= hasta; d += DIA_MS) {
    const day = new Date(d).toISOString().slice(0, 10);
    const g = porDia.get(day);
    out.push({ day, sinProveedor: g ? g.a : null, ejecutadas: g ? g.e : null });
  }
  return out;
}

export async function MosaicoDeLlamadas({ usage }: { usage: UsageRollup[] }) {
  const dias = diasDelMosaico(usage);
  const sinProveedor = dias.reduce((n, d) => n + (d.sinProveedor ?? 0), 0);
  const ejecutadas = dias.reduce((n, d) => n + (d.ejecutadas ?? 0), 0);
  const total = sinProveedor + ejecutadas;
  if (dias.length === 0 || total <= 0) return null;

  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const corto = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const fecha = (day: string) => corto.format(new Date(`${day}T00:00:00Z`));

  const max = Math.max(...dias.map((d) => (d.sinProveedor ?? 0) + (d.ejecutadas ?? 0)));
  const k = escalaDeTeselas(max);
  const alto = (n: number) => `${((n / k) * TESELA_PX).toFixed(2)}px`;
  const b = (chunks: React.ReactNode) => <b>{chunks}</b>;
  // Tres fechas en el eje: la primera, la del medio y la última.
  const marcas = dias.length > 2 ? [0, Math.floor((dias.length - 1) / 2), dias.length - 1] : [0, dias.length - 1];

  return (
    <section className="pfr-mosaico" aria-labelledby="pfr-mosaico-t">
      <div className="pfr-mosaico-cab">
        <h3 className="pfc-rotulo pfr-mosaico-t" id="pfr-mosaico-t">
          {t("mosaico.title")}
        </h3>
        <ul className="pfr-mosaico-leyenda">
          <li>
            <span className="pfc-muestra pfc-muestra--cian" aria-hidden />
            {t.rich("mosaico.sinProveedor", { count: sinProveedor, n: intfmt(sinProveedor), b })}
          </li>
          <li>
            <span className="pfc-muestra" aria-hidden />
            {t.rich("mosaico.ejecutadas", { count: ejecutadas, n: intfmt(ejecutadas), b })}
          </li>
        </ul>
      </div>
      <div
        className="pfr-mosaico-area"
        role="img"
        aria-label={t("mosaico.aria", { sinProveedor: intfmt(sinProveedor), ejecutadas: intfmt(ejecutadas), dias: dias.length })}
        style={{ height: `${MAX_TESELAS * TESELA_PX}px` }}
      >
        {dias.map((d) =>
          d.sinProveedor === null || d.ejecutadas === null ? (
            <span key={d.day} className="pfr-mosaico-col pfr-mosaico-col--hueco" />
          ) : (
            <span key={d.day} className="pfr-mosaico-col">
              <i className="pfr-tesela" style={{ height: alto(d.ejecutadas) }} />
              <i className="pfr-tesela pfr-tesela--cian" style={{ height: alto(d.sinProveedor) }} />
            </span>
          ),
        )}
      </div>
      <div className="pfr-mosaico-eje" aria-hidden>
        {marcas.map((i) => (
          <span key={dias[i]!.day}>{fecha(dias[i]!.day)}</span>
        ))}
      </div>
      <p className="pfr-mosaico-pie">
        {t("mosaico.foot", { k, kn: intfmt(k), total: intfmt(total) })}
      </p>
    </section>
  );
}

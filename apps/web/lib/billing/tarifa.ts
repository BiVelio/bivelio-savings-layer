/**
 * LA TARIFA VARIABLE — única fuente de verdad.
 *
 * Decidida por el dueño el 2026-08-23 (plan maestro «La medición manda») y
 * revisada por el dueño el 2026-09-01: SIN MÍNIMO.
 *
 *   · Se comisiona SOLO el ahorro MEDIDO (basis=measured): el que el cliente
 *     puede contrastar con la factura de su proveedor. Lo estimado nunca.
 *   · SIN umbral ni rampa: la comisión por tramos aplica desde el primer euro
 *     medido. (Hasta el 2026-09-01 existía un umbral del 30% con rampa hasta
 *     el 35%; los clientes con ratio ≥35% no notan el cambio — la franja
 *     0–35% pasa de comisión 0 a comisión por tramos.)
 *   · La garantía que lo sustituye, testeada y por construcción: el cliente
 *     se queda SIEMPRE con GARANTIA_NETA_RATIO o más de cada euro ahorrado,
 *     porque ningún tramo supera el tipo máximo. Solo cobramos si ahorra.
 *   · Escalado A — marginal por volumen, cada tramo a su tipo (como el IRPF):
 *     10% / 8% / 6% / 4% con cortes en 1.000 / 5.000 / 20.000 €.
 *   · Mes de calibración: el primer período de cada organización no se cobra;
 *     su extracto existe igualmente, etiquetado, con la cifra que HABRÍA sido.
 *
 * Cuando la web publique estos números (F3/GA), su test de anclaje debe leer
 * ESTAS constantes — nunca duplicarlas. Patrón `precio-publicado.test.ts`.
 */

/** Tramos marginales sobre el ahorro medido del período, en EUR. */
export const TRAMOS: readonly { hastaEur: number; tipo: number }[] = [
  { hastaEur: 1_000, tipo: 0.1 },
  { hastaEur: 5_000, tipo: 0.08 },
  { hastaEur: 20_000, tipo: 0.06 },
  { hastaEur: Number.POSITIVE_INFINITY, tipo: 0.04 },
];

/**
 * La fracción de cada euro ahorrado que el cliente conserva COMO MÍNIMO.
 * Derivada del tramo más caro — no es una constante aparte que pueda divergir:
 * si la tarifa cambia, la garantía publicada cambia con ella, sola.
 */
export const GARANTIA_NETA_RATIO = 1 - Math.max(...TRAMOS.map((t) => t.tipo));

export interface TramoAplicado {
  desdeEur: number;
  hastaEur: number;
  tipo: number;
  baseEur: number;
  comisionEur: number;
}

/** Comisión marginal por tramos (SIN rampa): cada tramo cobra su tipo. */
export function comisionPorTramos(ahorroEur: number): { totalEur: number; tramos: TramoAplicado[] } {
  const tramos: TramoAplicado[] = [];
  let restante = Math.max(0, ahorroEur);
  let desde = 0;
  let total = 0;
  for (const t of TRAMOS) {
    if (restante <= 0) break;
    const anchura = t.hastaEur - desde;
    const base = Math.min(restante, anchura);
    const comision = base * t.tipo;
    tramos.push({ desdeEur: desde, hastaEur: t.hastaEur, tipo: t.tipo, baseEur: base, comisionEur: comision });
    total += comision;
    restante -= base;
    desde = t.hastaEur;
  }
  return { totalEur: total, tramos };
}

export interface ComisionCalculada {
  /** Base medida del período (lo que habría costado sin la capa), EUR. */
  baseMedidaEur: number;
  /** Ahorro medido del período, EUR. */
  ahorroMedidoEur: number;
  /** ahorroMedido / baseMedida, o 0 si la base es 0. Informativo. */
  ratio: number;
  /** Desglose marginal (lo que enseña el extracto). */
  tramos: TramoAplicado[];
  /** La comisión del período: los tramos, sin más. 0 solo si el ahorro es 0. */
  comisionEur: number;
  /** Ahorro que le queda al cliente tras la comisión, EUR. */
  netoClienteEur: number;
}

/**
 * La comisión de un período: tramos marginales sobre el ahorro medido, desde
 * el primer euro. Redondeada a céntimos (half-up), porque es una cifra de
 * factura.
 */
export function calcularComision(baseMedidaEur: number, ahorroMedidoEur: number): ComisionCalculada {
  const base = Math.max(0, baseMedidaEur);
  const ahorro = Math.max(0, ahorroMedidoEur);
  const ratio = base > 0 ? ahorro / base : 0;
  const { totalEur, tramos } = comisionPorTramos(ahorro);
  const comision = redondearCentimos(totalEur);
  return {
    baseMedidaEur: base,
    ahorroMedidoEur: ahorro,
    ratio,
    tramos,
    comisionEur: comision,
    netoClienteEur: redondearCentimos(ahorro - comision),
  };
}

export function redondearCentimos(eur: number): number {
  return Math.round(eur * 100) / 100;
}

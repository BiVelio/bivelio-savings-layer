/**
 * LA TARIFA VARIABLE — única fuente de verdad.
 *
 * Decidida por el dueño el 2026-08-23 (plan maestro «La medición manda»):
 *
 *   · Se comisiona SOLO el ahorro MEDIDO (basis=measured): el que el cliente
 *     puede contrastar con la factura de su proveedor. Lo estimado nunca.
 *   · Umbral: solo si el ratio de ahorro medido supera el 30%.
 *   · Rampa 30→35%: la comisión entra linealmente entre ambos, sin acantilado.
 *     Propiedad garantizada (y testeada): el ahorro NETO del cliente nunca
 *     baja del 30% de su base medida.
 *   · Escalado A — marginal por volumen, cada tramo a su tipo (como el IRPF):
 *     10% / 8% / 6% / 4% con cortes en 1.000 / 5.000 / 20.000 €.
 *   · Mes de calibración: el primer período de cada organización no se cobra;
 *     su extracto existe igualmente, etiquetado, con la cifra que HABRÍA sido.
 *
 * Cuando la web publique estos números (F3/GA), su test de anclaje debe leer
 * ESTAS constantes — nunca duplicarlas. Patrón `precio-publicado.test.ts`.
 */

/** Ratio de ahorro medido por debajo del cual la comisión es siempre 0. */
export const UMBRAL_RATIO = 0.3;

/** Fin de la rampa: a partir de aquí la comisión aplica al 100%. */
export const FIN_RAMPA_RATIO = 0.35;

/** Tramos marginales sobre el ahorro medido del período, en EUR. */
export const TRAMOS: readonly { hastaEur: number; tipo: number }[] = [
  { hastaEur: 1_000, tipo: 0.1 },
  { hastaEur: 5_000, tipo: 0.08 },
  { hastaEur: 20_000, tipo: 0.06 },
  { hastaEur: Number.POSITIVE_INFINITY, tipo: 0.04 },
];

/** Factor de entrada gradual: 0 en el umbral, 1 al final de la rampa. */
export function factorDeRampa(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= UMBRAL_RATIO) return 0;
  return Math.min(1, (ratio - UMBRAL_RATIO) / (FIN_RAMPA_RATIO - UMBRAL_RATIO));
}

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
  /** ahorroMedido / baseMedida, o 0 si la base es 0. */
  ratio: number;
  /** Factor de la rampa 30→35% ya aplicado a la cifra final. */
  factorRampa: number;
  /** Desglose marginal ANTES de la rampa (lo que enseña el extracto). */
  tramos: TramoAplicado[];
  /** La comisión del período: tramos × rampa. 0 bajo el umbral. */
  comisionEur: number;
  /** Ahorro que le queda al cliente tras la comisión, EUR. */
  netoClienteEur: number;
}

/**
 * La comisión de un período: tramos marginales sobre el ahorro medido, por la
 * rampa. Redondeada a céntimos (half-up), porque es una cifra de factura.
 */
export function calcularComision(baseMedidaEur: number, ahorroMedidoEur: number): ComisionCalculada {
  const base = Math.max(0, baseMedidaEur);
  const ahorro = Math.max(0, ahorroMedidoEur);
  const ratio = base > 0 ? ahorro / base : 0;
  const factor = factorDeRampa(ratio);
  const { totalEur, tramos } = comisionPorTramos(ahorro);
  const comision = redondearCentimos(totalEur * factor);
  return {
    baseMedidaEur: base,
    ahorroMedidoEur: ahorro,
    ratio,
    factorRampa: factor,
    tramos,
    comisionEur: comision,
    netoClienteEur: redondearCentimos(ahorro - comision),
  };
}

export function redondearCentimos(eur: number): number {
  return Math.round(eur * 100) / 100;
}

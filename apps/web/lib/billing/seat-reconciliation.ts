/**
 * Reconciliación de asientos (seat true-up).
 *
 * Compara los asientos USADOS —`bvsala.billable_seats`: seats distintos, no-CI,
 * activos ≥3 días en el mes— contra los asientos PAGADOS en la suscripción de
 * Stripe. Si se usan más de los pagados, hay que cobrar la diferencia (true-up).
 *
 * Robustez que exigió la auditoría: el `seat_id` es AUTODECLARADO (se puede fijar
 * con `BVSALA_SEAT_ID`), así que un cliente podría colapsar mil máquinas en un
 * solo asiento e infra-pagar. `billable_seats` cuenta seat_ids distintos, así que
 * ese abuso INFRA-declara, no sobre-declara. La defensa es un contraste por
 * VOLUMEN: si las peticiones por asiento son implausiblemente altas, el propio
 * recuento de asientos deja de ser de fiar y se marca para revisión HUMANA — no
 * se cobra de más por una heurística, pero tampoco se deja pasar en silencio.
 *
 * Función pura para poder probarla sin Stripe ni base de datos. El cobro del
 * exceso (invoice item al precio del plan y, hacia delante, la `quantity`) lo
 * decide lib/billing/cobro-asientos.ts a partir de esto y lo ejecuta el cron
 * /api/cron/cobrar-asientos, una vez por mes cerrado.
 */

export interface ReconciliationInput {
  /** Asientos facturables usados en el mes (bvsala.billable_seats). */
  usedSeats: number;
  /** Asientos pagados en la suscripción activa. `null` si no hay suscripción. */
  paidSeats: number | null;
  /** Peticiones totales de la org en el mes (para el contraste de volumen). */
  requests: number;
  /**
   * Umbral de peticiones por asiento a partir del cual el recuento se considera
   * sospechoso de colapso de seat_id. Alto a propósito para no marcar a un
   * usuario legítimamente intensivo. Por defecto ~100k/mes ≈ 3.300/día.
   */
  suspiciousRequestsPerSeat?: number;
}

export interface ReconciliationDecision {
  /** Asientos a cobrar de más (used − paid, nunca negativo). */
  overage: number;
  /**
   * `none`   — dentro de lo pagado.
   * `true-up`— usa más de lo pagado; hay que subir la quantity de Stripe.
   * `review` — el volumen por asiento no cuadra; recuento no fiable, revisar a mano.
   */
  action: "none" | "true-up" | "review";
  /** El contraste de volumen disparó: posible colapso de seat_id. */
  suspicious: boolean;
  detail: string;
}

const DEFAULT_SUSPICIOUS_RPS = 100_000;

export function reconcileSeats(input: ReconciliationInput): ReconciliationDecision {
  const used = Math.max(0, Math.floor(input.usedSeats));
  const paid = input.paidSeats == null ? 0 : Math.max(0, Math.floor(input.paidSeats));
  const umbral = input.suspiciousRequestsPerSeat ?? DEFAULT_SUSPICIOUS_RPS;

  // Contraste de volumen: si por cada asiento declarado hay una cantidad
  // implausible de peticiones, el recuento en sí es sospechoso. Se mide contra
  // el MÁXIMO entre los asientos usados y los pagados: pagar por 1 y declarar 1
  // mientras se hacen millones de peticiones es justo el patrón a cazar.
  const asientosReferencia = Math.max(1, used, paid);
  const peticionesPorAsiento = input.requests / asientosReferencia;
  const suspicious = peticionesPorAsiento > umbral;

  const overage = Math.max(0, used - paid);

  if (suspicious) {
    // El recuento no es de fiar, así que NO se cobra automáticamente por él: se
    // marca para revisión. Cobrar de más por una heurística sería el error
    // opuesto y peor.
    return {
      overage,
      action: "review",
      suspicious: true,
      detail:
        `${Math.round(peticionesPorAsiento).toLocaleString()} peticiones por asiento ` +
        `(umbral ${umbral.toLocaleString()}): posible colapso de seat_id, recuento no fiable.`,
    };
  }

  if (overage > 0) {
    return {
      overage,
      action: "true-up",
      suspicious: false,
      detail: `Usa ${used} asientos, paga ${paid}: cobrar ${overage} de más.`,
    };
  }

  return {
    overage: 0,
    action: "none",
    suspicious: false,
    detail: `Usa ${used} asientos, paga ${paid}: dentro de lo pagado.`,
  };
}

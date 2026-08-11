/**
 * Los días de gracia: UNA sola verdad para la licencia, el cron de impago y el panel.
 *
 * POR QUÉ ESTE FICHERO EXISTE. El número estaba escrito a mano en dos sitios
 * (`issue.ts` con `?? 14` y `0001_init.sql` con `default 14`) y no se había
 * derivado de nada. La gracia no es una preferencia: es el tiempo que el cliente
 * tiene que seguir funcionando MIENTRAS STRIPE SIGUE INTENTANDO COBRARLE. Si la
 * nuestra es más corta que la ventana de reintentos de Stripe, apagamos a alguien
 * cuyo cobro todavía puede prosperar.
 *
 * De ahí el 21: los Smart Retries de Stripe reintentan una factura hasta cuatro
 * veces a lo largo de ~3 semanas con la configuración por defecto. La asimetría
 * manda — una semana de servicio regalado a un moroso cuesta 4 €; cortarle el
 * servicio a un cliente que sí paga cuesta el cliente.
 *
 * Se puede ajustar sin tocar código con `BVSALA_GRACE_DAYS`, para cuando se sepa
 * la configuración exacta de reintentos de la cuenta.
 */

/** Valor por defecto si no hay variable de entorno: ventana de Smart Retries + margen. */
export const DIAS_DE_GRACIA_POR_DEFECTO = 21;

/**
 * Días de gracia efectivos. Se lee en cada llamada (no se congela en un módulo)
 * para que un cambio de variable de entorno no exija redesplegar dos veces.
 *
 * Un valor inválido NO degrada a algo agresivo: cae al de por defecto. Un dedazo
 * en una variable de entorno no debe poder cortarle el servicio a nadie.
 */
export function diasDeGracia(): number {
  const crudo = process.env.BVSALA_GRACE_DAYS;
  if (!crudo) return DIAS_DE_GRACIA_POR_DEFECTO;
  const n = Number(crudo);
  if (!Number.isFinite(n) || n < 0 || n > 365) return DIAS_DE_GRACIA_POR_DEFECTO;
  return Math.floor(n);
}

export const MS_POR_DIA = 86_400_000;

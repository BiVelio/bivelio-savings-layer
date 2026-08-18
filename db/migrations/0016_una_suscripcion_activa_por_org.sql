-- 0016 — una suscripción ACTIVA por organización (el índice que 0013 aplazó).
--
-- 0013 aplazó a propósito la unicidad de «una suscripción de pago por
-- organización», con una condición explícita: «Ponerlo aquí, antes de que el
-- webhook sepa manejar el conflicto, convertiría una carrera improbable en un 500
-- seguro.» Esa condición ya se cumple: `api/stripe/webhook/route.ts` detecta una
-- segunda suscripción activa (`otraSuscripcionActiva`) en `handleCheckout` y
-- `handleSubUpsert` ANTES de escribir una segunda fila activa, la rechaza y alerta.
--
-- Este índice es el RESPALDO a nivel de base: aunque la comprobación de la app
-- fallara o dos eventos concurrentes se colaran, la BD garantiza que una org no
-- puede tener dos filas en estado de pago a la vez. El único caso en que dispara
-- es la carrera concurrente pura: una de las dos inserciones falla, Stripe la
-- reintenta, y en el reintento la comprobación de la app ya ve a la ganadora y la
-- rechaza con un 200. Es decir, un 500 TRANSITORIO que se autocura, no el bucle
-- permanente que 0013 temía sin el manejo.
--
-- Estados de pago: los mismos que `planForStatus` y `hasActiveSubscription` tratan
-- como cubiertos (active, trialing, past_due). Los demás (canceled, incomplete,
-- unpaid, incomplete_expired) no cuentan, así que cancelar una y suscribir otra
-- vuelve a estar permitido.
--
-- PRECONDICIÓN DE DATOS: el índice único no se puede crear si ya existen dos filas
-- activas para una misma org. El circuito Stripe no se ha ejercitado (0 eventos),
-- así que no hay datos que lo violen; si algún día los hubiera, hay que resolver
-- el duplicado (cancelar+reembolsar una en Stripe) ANTES de aplicar esto.

create unique index if not exists subscriptions_una_activa_por_org
  on bvsala.subscriptions (org_id)
  where status in ('active', 'trialing', 'past_due');

-- 0012 — guardia de ORDEN para los eventos de suscripción de Stripe.
--
-- EL DEFECTO: el webhook no comparaba el evento entrante con el estado guardado.
-- Stripe NO garantiza orden y reintenta durante días lo que respondió 5xx, así
-- que un `customer.subscription.updated` que reentra tarde podía des-cancelar una
-- org: la fila volvía a `active`, `setOrgPlan` la ponía en `pro` y `reconcile` la
-- contaba con asientos pagados — todo sin licencia viva y sin ningún error. La
-- base quedaba con dos verdades contradictorias (plan pro + cero licencias) que
-- ningún invariante comprobaba.
--
-- LA CORRECCIÓN: guardamos el `event.created` (marca de tiempo que Stripe pone en
-- el ORIGEN del evento, inmutable entre reintentos) y el webhook ignora cualquier
-- evento de suscripción cuyo `created` sea anterior al último aplicado. "La
-- última escritura, por tiempo de origen, gana."

alter table bvsala.subscriptions
  add column if not exists last_event_at timestamptz;

comment on column bvsala.subscriptions.last_event_at is
  'event.created del ultimo evento de Stripe aplicado a esta fila. El webhook '
  'descarta eventos con created anterior (Stripe no garantiza orden y reintenta '
  'durante dias). Ver apps/web/app/api/stripe/webhook/route.ts.';

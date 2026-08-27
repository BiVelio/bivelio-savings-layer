-- 0018 — el candado contra la emisión duplicada de licencias.
--
-- EL BUG (reproducido en el banco de pruebas del 2026-08-27, y con evidencia en
-- producción del 2026-08-12): los eventos de Stripe llegan en ráfaga y varios
-- manejadores (checkout.session.completed, customer.subscription.created,
-- invoice.paid) comprueban «¿hay licencia viva?» a la vez, todos ven que no, y
-- todos emiten. Resultado: 2–3 licencias idénticas por alta. El modelo es
-- append (la renovación AÑADE licencia), así que no rompe nada — pero ensucia,
-- firma de más, y deja al azar cuál descarga el panel.
--
-- EL CANDADO: única viva por (org, caducidad, asientos). Las tres columnas son
-- deliberadas —
--   · la RENOVACIÓN cambia expires_at            → pasa;
--   · el CAMBIO DE ASIENTOS cambia seats          → pasa;
--   · volver al MISMO nº de asientos en el mismo período choca con la licencia
--     original viva… que otorga exactamente lo mismo: el código, ante el
--     conflicto, devuelve la existente (idempotencia, ver lib/license/issue.ts);
--   · el DUPLICADO de la carrera (todo igual)     → bloqueado, que es el punto.
--
-- LA LIMPIEZA PREVIA, y por qué BORRA en vez de revocar: el índice no se puede
-- crear con los duplicados del 12-08 dentro. Revocar el sobrante apagaría el
-- SDK de un cliente real si es JUSTO el token que su máquina guarda (la
-- revocación viaja al ledger y el SDK es fail-closed). Borrar la fila no toca
-- ningún token en el campo: la verificación del SDK es firma + caducidad +
-- ledger de revocación, y ninguna de las tres mira esta tabla. Se conserva la
-- más nueva de cada grupo.

delete from bvsala.licenses l
using bvsala.licenses m
where l.org_id = m.org_id
  and l.expires_at = m.expires_at
  and l.seats = m.seats
  and l.revoked = false
  and m.revoked = false
  and (l.created_at, l.id) < (m.created_at, m.id);

create unique index if not exists licenses_una_viva_por_periodo
  on bvsala.licenses (org_id, expires_at, seats)
  where revoked = false;

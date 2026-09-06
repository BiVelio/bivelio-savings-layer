-- 0023 — las palancas de dinero pasan a ser features del plan PRO (relleno).
--
-- EL FALLO: la palanca de elisión del gateway se cerró con tres interruptores
-- (gateway/servidor.ts:333-337) y el de en medio es el feature per-org, servido
-- por /api/org/entitlements desde `licenses.features`. Ese literal solo vivía
-- en la allow-list del trial (anillo interno del dueño). PRO_FEATURES —lo que
-- firma y persiste la emisión por Stripe— no lo llevaba.
--
-- La consecuencia era MUDA, que es lo peor: el canal de entitlements es
-- FAIL-CLOSED a apagado, así que el cliente que paga no veía ni un error;
-- `tiene("context_elision")` devolvía false y el gateway reenviaba el cuerpo
-- intacto. Una palanca de producto vendida y estructuralmente inalcanzable.
--
-- El arreglo tiene DOS mitades y esta es la segunda:
--   1) apps/web/lib/license/issue.ts — el literal entra en PRO_FEATURES; cubre
--      las licencias que se emitan A PARTIR DE AHORA.
--   2) esta migración — las YA EMITIDAS llevan el array viejo congelado en su
--      columna. Sin este relleno, quien compró antes de hoy se queda fuera.
--
-- Por qué NO hace falta re-emitir ni re-firmar: el gateway no lee el token
-- firmado, lee la FILA (route.ts hace `select ... features` y devuelve la unión
-- de las licencias vivas). El token firmado sigue siendo válido tal cual; su
-- claim `features` solo lo consume la verificación offline del SDK, que no
-- gobierna esta palanca.
--
-- Viaja con `cache_ttl_tuning`, la palanca hermana que entra en el mismo PR:
-- rebajar el TTL de escritura de caché de 1h (2x el precio de entrada) a 5m
-- (1,25x) cuando la sesion esta caliente. Mismo carril de entitlement, misma
-- necesidad de relleno.
--
-- Alcance deliberadamente ESTRECHO: solo filas de plan 'pro' vivas (no
-- revocadas, dentro de validez + gracia) a las que les falte algun literal.
-- Idempotente: correrla dos veces no cambia nada la segunda.

update bvsala.licenses
   set features = (
         select array_agg(distinct f order by f)
           from unnest(
                  coalesce(features, array[]::text[])
                  || array['context_elision', 'cache_ttl_tuning']
                ) as f
       )
 where plan = 'pro'
   and not revoked
   and expires_at + make_interval(days => coalesce(grace_days, 0)) >= now()
   and not (coalesce(features, array[]::text[]) @> array['context_elision', 'cache_ttl_tuning']);

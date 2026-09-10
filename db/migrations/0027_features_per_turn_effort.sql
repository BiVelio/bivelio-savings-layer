-- 0027 — la palanca D (esfuerzo por turno) pasa a ser feature del plan PRO (relleno).
--
-- Misma forma y misma razón que 0023 y 0026: el gateway cierra la palanca con
-- tres interruptores (nivel declarado por el operador en
-- BVSALA_GATEWAY_ESFUERZO, feature per-org `per_turn_effort` servido por
-- /api/org/entitlements desde `licenses.features`, y el canal S4a abierto). El
-- literal ya viaja en PRO_FEATURES (apps/web/lib/license/issue.ts) para lo que
-- se emita a partir de ahora; las licencias pro YA EMITIDAS llevan el array
-- viejo congelado en su columna y sin este relleno quien paga y la enciende ve
-- el cuerpo pasar intacto — en silencio, porque el canal es fail-closed.
--
-- Qué hace la palanca (gateway/esfuerzo.ts): añade AL FINAL de `messages` un
-- mensaje `role: "system"` con `output_config.effort`, más la beta
-- `mid-conversation-output-config-2026-07-01`. Es la primera palanca que llega
-- a la SALIDA —lo único que paga precio de lista— y la primera que no paga
-- peaje de caché: cambiar `output_config` en la RAÍZ invalidaría la caché de
-- mensajes, pero un mensaje añadido no reescribe nada anterior, así que el
-- prefijo sigue casando y los bloques de pensamiento anteriores siguen válidos.
--
-- Solo `claude-fable-5-1`, `claude-mythos-5-1` y `claude-opus-5`. Cualquier otro
-- modelo devuelve 400, `claude-fable-5` incluido pese a ser de la misma familia.
--
-- Por qué NO hace falta re-emitir ni re-firmar: el gateway lee la FILA, no el
-- token firmado (ver 0023).
--
-- Alcance deliberadamente ESTRECHO: solo filas de plan 'pro' vivas (no
-- revocadas, dentro de validez + gracia) a las que les falte el literal.
-- Idempotente: correrla dos veces no cambia nada la segunda.

update bvsala.licenses
   set features = (
         select array_agg(distinct f order by f)
           from unnest(
                  coalesce(features, array[]::text[])
                  || array['per_turn_effort']
                ) as f
       )
 where plan = 'pro'
   and not revoked
   and expires_at + make_interval(days => coalesce(grace_days, 0)) >= now()
   and not (coalesce(features, array[]::text[]) @> array['per_turn_effort']);

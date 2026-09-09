-- 0026 — la palanca C (modelo hermano) pasa a ser feature del plan PRO (relleno).
--
-- Misma forma y misma razón que 0023: el gateway cierra la palanca con tres
-- interruptores (bandera local BVSALA_GATEWAY_MODELO_HERMANO=1, feature per-org
-- `sibling_model_routing` servido por /api/org/entitlements desde
-- `licenses.features`, y el canal S4a abierto). El literal entra en
-- PRO_FEATURES (apps/web/lib/license/issue.ts) para las licencias que se emitan
-- A PARTIR DE AHORA; las YA EMITIDAS llevan el array viejo congelado en su
-- columna y sin este relleno quien compró antes se queda fuera — en silencio,
-- porque el canal es fail-closed a apagado.
--
-- Qué hace la palanca (gateway/hermano.ts): sirve `claude-fable-5` con
-- `claude-fable-5-1`. Misma entrada, salida y primas de escritura; la LECTURA
-- de caché baja de 0,001 a 0,00025 por 1K (catálogo). El ahorro es el mismo
-- usage a dos precios de catálogo: `measured`, sin A/B. El cliente la enciende
-- él (cambia el `model` que ve en la respuesta); este relleno solo la hace
-- ALCANZABLE para quien paga.
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
                  || array['sibling_model_routing']
                ) as f
       )
 where plan = 'pro'
   and not revoked
   and expires_at + make_interval(days => coalesce(grace_days, 0)) >= now()
   and not (coalesce(features, array[]::text[]) @> array['sibling_model_routing']);

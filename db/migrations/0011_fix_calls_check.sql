-- 0011 — corrige usage_daily_calls_add_up, que rompía la ingesta en producción.
--
-- EL DEFECTO: 0008 exigía `avoided_llm + actual_llm <= requests`, pero ese
-- invariante es FALSO para el propio SDK: una petición cuya respuesta incumple el
-- contrato dispara UNA reparación y emite `actualLlm = 2` para `requests = 1`
-- (pipeline.ts, rama de reparación). Y esa es la ruta POR DEFECTO, porque
-- `constraintBackends: []` fuerza `backend: "none"`. Bastaba una reparación al
-- día para que el CHECK saltara, la transacción del lote entero revirtiera, la
-- ruta devolviera 500 y el emisor reencolara el lote al frente para siempre: la
-- org dejaba de reportar (panel congelado, asientos sin contar, facturación de
-- menos), sin un solo error visible para nadie.
--
-- Lo encontró la auditoría del 2026-08-10 contrastando el esquema contra lo que
-- el runtime escribe DE VERDAD — ningún test tocaba .sql. Ahora existe
-- test/esquema-vs-sdk.test.ts, que reproduce esta aritmética con informes reales
-- del pipeline para que el esquema y el SDK no vuelvan a divergir en silencio.
--
-- EL INVARIANTE VERDADERO, por petición:
--   · avoided ∈ {0,1}   (se evitó o no)
--   · actual  ∈ {0,1,2} (primaria + como mucho UNA reparación; el fail-open ya no
--                        puede añadir llamadas tras facturar, corregido 2026-08-10)
--   · avoided = 1 → actual = 0
-- Agregado por día, eso es exactamente:
--   avoided_llm <= requests           (no se evita más de lo que se pide)
--   avoided_llm + actual_llm <= 2*requests  (tope real con reparaciones)

alter table bvsala.usage_daily
  drop constraint if exists usage_daily_calls_add_up;

alter table bvsala.usage_daily
  add constraint usage_daily_calls_add_up check (
    avoided_llm <= requests
    and avoided_llm + actual_llm <= 2 * requests
  ) not valid;

-- NOT VALID a propósito, como en 0008: no se escanea el histórico al aplicar.
-- Postgres SÍ la verifica en cada INSERT/UPDATE nuevo, que es lo que importa.

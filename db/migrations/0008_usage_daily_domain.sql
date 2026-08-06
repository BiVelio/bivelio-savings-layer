-- 0008 · Dominio de bvsala.usage_daily: que no entren negativos.
--
-- CONTEXTO. La tabla no tiene ni una restricción de dominio: todas sus columnas
-- son `bigint not null default 0` o `numeric not null default 0`, y ninguna
-- impide un valor negativo. La única defensa está en el validador de la ruta de
-- ingest, que hasta esta tanda solo exigía `Number.isFinite`.
--
-- Un recuento negativo no revienta nada: se suma al agregado del día, lo baja, y
-- el panel enseña un número plausible pero falso. Con `baseline_cost` o
-- `actual_cost` negativos el titular de ahorro puede pasar del 100%, que es
-- justo la cifra imposible que un producto de "verify-don't-trust" no se puede
-- permitir enseñar.
--
-- Esto es defensa en profundidad, no un duplicado: el validador protege la
-- puerta de la API, y estos CHECK protegen la tabla de cualquier camino futuro
-- —una RPC nueva, una corrección manual, un backfill— que no pase por ella.
--
-- NOT VALID es deliberado. Aplica la restricción a toda fila nueva o modificada
-- desde ya, pero NO escanea las que existen: en una base compartida en
-- producción un ADD CONSTRAINT normal toma un ACCESS EXCLUSIVE mientras recorre
-- la tabla entera, y si hubiera una sola fila corrupta la migración fallaría
-- dejando el despliegue a medias. Para validar el histórico cuando convenga:
--
--     alter table bvsala.usage_daily validate constraint usage_daily_no_negatives;
--
-- (ese VALIDATE sí escanea, pero solo toma un SHARE UPDATE EXCLUSIVE, así que no
-- bloquea lecturas ni escrituras normales).

alter table bvsala.usage_daily
  add constraint usage_daily_no_negatives check (
    requests                     >= 0 and
    avoided_llm                  >= 0 and
    actual_llm                   >= 0 and
    eliminated_input_tokens      >= 0 and
    compressed_input_tokens      >= 0 and
    provider_cached_input_tokens >= 0 and
    baseline_cost                >= 0 and
    actual_cost                  >= 0 and
    active_seats                 >= 0
  ) not valid;

-- Coherencia entre los dos contadores de llamadas y el total de peticiones: una
-- petición o se atendió llamando al modelo o se evitó, nunca las dos ni ninguna.
-- Se deja aparte de la anterior para que, si alguna vez salta, el mensaje diga
-- exactamente cuál de las dos familias de invariante se ha roto.
alter table bvsala.usage_daily
  add constraint usage_daily_calls_add_up check (
    avoided_llm + actual_llm <= requests
  ) not valid;

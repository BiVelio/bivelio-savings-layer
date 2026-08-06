-- 0007 · Privilegios del esquema bvsala: cerrar la puerta por defecto y sacar
--       las credenciales del alcance de la anon key.
--
-- CONTEXTO. La 0005 cerró DOS funciones concretas (ingest_usage_batch y
-- billable_seats) y dijo arreglar «la causa raíz» con:
--
--     alter default privileges in schema bvsala revoke all on functions
--       from anon, authenticated;
--
-- Eso NO es la causa raíz. PostgreSQL concede EXECUTE a PUBLIC en toda función
-- nueva por su propio comportamiento por defecto, no por ninguna regla nuestra;
-- y anon y authenticated son miembros de PUBLIC. Revocarles a ellos deja intacta
-- la concesión a PUBLIC, así que la SIGUIENTE función que alguien cree en
-- bvsala vuelve a nacer invocable con la anon key. Es una trampa que se rearma
-- sola: la 0006 ya creó una (`create or replace function ingest_usage_batch`) y
-- solo se salvó porque REPLACE conserva las ACL de la 0005.
--
-- Esta migración corta las dos vías que quedan abiertas:
--   1. el EXECUTE por defecto a PUBLIC sobre funciones futuras;
--   2. el SELECT sobre las columnas de credencial (licenses.token y
--      service_accounts.key_hash), hoy legibles por cualquier miembro de la
--      organización a través de las políticas lic_read / sa_read.
--
-- Idempotente: revoke y grant son declarativos, se puede reejecutar.

-- ---------------------------------------------------------------------------
-- 1. Funciones: que ninguna función futura de bvsala nazca abierta.
-- ---------------------------------------------------------------------------

-- La causa raíz de verdad. Sin esto, todo lo demás es tapar agujeros uno a uno.
alter default privileges in schema bvsala revoke execute on functions from public;

-- Y por si el rol que ejecuta esta migración no es el mismo que creó los objetos
-- (las default privileges son POR ROL CREADOR), se barre también lo ya existente.
-- is_org_member se vuelve a conceder abajo: la usan las propias políticas RLS.
revoke execute on all functions in schema bvsala from public, anon, authenticated;

-- is_org_member(uuid) tiene que seguir siendo invocable: se evalúa DENTRO de las
-- políticas RLS de cada tabla, con el auth.uid() de quien consulta, así que sólo
-- puede informar de la pertenencia del propio llamante (ver la nota de la 0005).
grant execute on function bvsala.is_org_member(uuid) to anon, authenticated, service_role;

-- Las dos funciones sensibles siguen siendo exclusivas del service_role. Se
-- reafirma aquí para que este fichero sea autocontenido y el revoke de arriba
-- no las deje sin ejecutor.
grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;
grant execute on function bvsala.billable_seats(uuid, date)      to service_role;

-- ---------------------------------------------------------------------------
-- 2. Tablas: quitar las credenciales del alcance de lectura.
-- ---------------------------------------------------------------------------
--
-- La RLS decide QUÉ FILAS se ven; los grants deciden QUÉ COLUMNAS. Hoy
-- `grant select on tables to authenticated, anon` (0001) concede la tabla
-- ENTERA, así que lic_read/sa_read dejan a cualquier miembro de la organización
-- leer `licenses.token` (la licencia firmada completa, reutilizable en otra
-- máquina) y `service_accounts.key_hash`.
--
-- En Postgres no se revoca una sola columna: se revoca la tabla y se reconceden
-- las columnas seguras. Verificado antes de escribir esto que ningún camino de
-- la app lee las dos columnas con el rol de usuario — el dashboard selecciona
-- `key_prefix, last_used_at` (data.ts:105) y todas las escrituras de credencial
-- van por el cliente admin (service_role, que salta RLS y conserva `grant all`).

revoke select on bvsala.licenses         from anon, authenticated;
revoke select on bvsala.service_accounts from anon, authenticated;

-- Sin `token`. Es lo único que sale del alcance.
grant select (id, org_id, plan, seats, features, issued_at, expires_at, grace_days, revoked, created_at)
  on bvsala.licenses to authenticated;

-- Sin `key_hash`. `key_prefix` se queda: es el fragmento que el panel muestra.
grant select (id, org_id, label, key_prefix, last_used_at, created_at)
  on bvsala.service_accounts to authenticated;

-- anon no recupera nada de estas dos tablas: la RLS ya lo bloqueaba (sin
-- auth.uid() no hay pertenencia), pero dejarlo también sin grant es la defensa
-- en profundidad que corresponde a una tabla con credenciales.

-- ---------------------------------------------------------------------------
-- 3. Tablas futuras: que anon no herede SELECT.
-- ---------------------------------------------------------------------------
-- La 0001 dejó `alter default privileges ... grant select on tables to
-- authenticated, anon`. Toda tabla nueva de bvsala nace legible por la anon key
-- y depende por completo de que alguien se acuerde de activarle RLS. Se quita
-- anon de esa concesión por defecto; authenticated se mantiene, que es sobre
-- quien de verdad operan las políticas.
alter default privileges in schema bvsala revoke select on tables from anon;

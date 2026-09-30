-- 0035 · ajustes_asientos: nadie la borra ni la trunca (2026-09-30).
--
-- 0034 concedió al service role solo select/insert/update, pero en Supabase las
-- tablas nuevas de un esquema reciben TODOS los privilegios por defecto para
-- service_role (ALTER DEFAULT PRIVILEGES), así que DELETE y TRUNCATE quedaban
-- concedidos: comprobado en producción tras aplicar 0034
-- (`has_table_privilege('service_role','bvsala.ajustes_asientos','delete')` →
-- true). El registro de lo cobrado tiene que ser inmutable, como el extracto.
--
-- Sin trigger de borrado a propósito: el ON DELETE CASCADE desde
-- organizations se ejecuta con los privilegios del dueño de la tabla, no con los
-- del service role, y tiene que seguir funcionando al eliminar una organización.
-- Idempotente.
do $$
begin
  if to_regclass('bvsala.ajustes_asientos') is null then
    raise exception '0035: base 0034 ausente — aplicar 0034 antes, en orden ascendente';
  end if;
end $$;

revoke delete, truncate on bvsala.ajustes_asientos from service_role;

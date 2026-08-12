-- 0014 — transferir la propiedad de una organización, atómicamente.
--
-- POR QUÉ UNA FUNCIÓN Y NO DOS PETICIONES. Transferir es degradar al dueño viejo y
-- promover al nuevo. Hechas por separado desde la aplicación, entre las dos hay
-- una ventana en la que la organización tiene DOS dueños o NINGUNO — y si el
-- proceso muere justo ahí (un despliegue, un timeout de Vercel, un 502), la
-- organización se queda así para siempre. Sin dueño no se puede cambiar la
-- tarjeta ni cancelar, y la suscripción sigue cobrando todos los meses.
--
-- Esto es posible porque 0013 declaró `un_solo_owner_por_org` como una restricción
-- EXCLUDE **deferrable initially deferred**, y no como un índice único. Un índice
-- único se comprueba POR FILA y no admite diferirse: el `update` intermedio
-- chocaría contra él aunque la transacción terminase en un estado válido. Aquí la
-- comprobación se hace en el COMMIT, cuando ya hay exactamente un dueño.
--
-- 100 % ADITIVA: crea una función y no toca ninguna fila.

create or replace function bvsala.transferir_propiedad(
  p_org        uuid,
  p_nuevo      uuid,
  p_rol_viejo  text default 'admin'
) returns void
language plpgsql
security invoker           -- se llama con service_role; no hace falta elevar nada
set search_path = bvsala, pg_catalog
as $$
declare
  v_viejo uuid;
begin
  if p_rol_viejo not in ('admin','member','billing') then
    raise exception 'rol destino invalido para el dueno saliente: %', p_rol_viejo
      using errcode = '22023';
  end if;

  -- Se BLOQUEAN las filas de pertenencia de la organización antes de tocarlas. Sin
  -- esto, dos transferencias simultáneas pueden leer las dos el mismo dueño viejo
  -- y dejar la organización con dos dueños o con ninguno; la restricción diferida
  -- salvaría el caso de los dos, pero no el de ninguno.
  perform 1 from bvsala.org_members where org_id = p_org for update;

  select user_id into v_viejo
    from bvsala.org_members
   where org_id = p_org and role = 'owner';

  if v_viejo is null then
    raise exception 'la organizacion % no tiene dueno: no hay nada que transferir', p_org
      using errcode = 'P0002';
  end if;

  if v_viejo = p_nuevo then
    return;                                   -- idempotente: ya es suyo
  end if;

  -- El destinatario tiene que ser YA miembro. Transferir la propiedad a alguien de
  -- fuera saltándose la invitación sería una forma de meter a un tercero en una
  -- organización sin que nadie lo aceptara.
  if not exists (select 1 from bvsala.org_members where org_id = p_org and user_id = p_nuevo) then
    raise exception 'el destinatario % no es miembro de la organizacion %', p_nuevo, p_org
      using errcode = 'P0002';
  end if;

  update bvsala.org_members set role = p_rol_viejo where org_id = p_org and user_id = v_viejo;
  update bvsala.org_members set role = 'owner'      where org_id = p_org and user_id = p_nuevo;
  update bvsala.organizations set owner_user_id = p_nuevo where id = p_org;
end $$;

-- Solo el servidor. `authenticated` no la puede invocar: la autorización (¿es el
-- que llama el dueño actual?) se decide en TypeScript, porque con `service_role`
-- `auth.uid()` es NULL y una comprobación dentro de la función no vería a nadie.
revoke all on function bvsala.transferir_propiedad(uuid, uuid, text) from public, anon, authenticated;
grant execute on function bvsala.transferir_propiedad(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Índice para caducar invitaciones sin recorrer la tabla entera.
-- ---------------------------------------------------------------------------
create index if not exists org_invitations_expira_idx
  on bvsala.org_invitations (expires_at)
  where accepted_at is null;

-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACIÓN NO HACE
--
-- · NO borra las invitaciones caducadas. Se filtran al leer y se limpian aparte:
--   un borrado automático destruiría la prueba de a quién se invitó y cuándo, que
--   es justo lo que hay que poder enseñar si alguien pregunta cómo entró.
--
-- · NO toca los asientos. Un asiento es una MÁQUINA (`deriveSeatId` = HMAC de la
--   huella del equipo), no una persona: invitar a un compañero NO consume asiento
--   y no debe tocar la facturación. Si algún día alguien ata miembros a asientos,
--   que sea una decisión explícita y no un efecto colateral de esta tabla.
-- ---------------------------------------------------------------------------

-- 0013 — la organización deja de ser una persona.
--
-- EL DEFECTO: `org_id == user_id` en 21 puntos de llamada de 7 ficheros. La
-- organización no tenía identidad propia, así que no había forma de invitar a
-- nadie, de repartir permisos ni de transferir la propiedad — si el que compraba
-- se iba de la empresa, se iba con la facturación.
--
-- ⚠️ ESTA MIGRACIÓN NO RENUMERA NADA, Y ESO ES DELIBERADO. `organizations.id` ya
-- era un uuid propio sin clave ajena contra `auth.users` (0001:32-39): la atadura
-- vivía solo en el código. Las organizaciones existentes se quedan EXACTAMENTE
-- como están. Cambiar un `organizations.id` apagaría la flota del cliente que
-- paga —el org_id va FIRMADO dentro de las licencias ya desplegadas y
-- `src/license/refresher.ts:155` descarta en silencio cualquier token renovado
-- que no case— y ni siquiera pasaría de la base: las claves ajenas contra
-- `organizations(id)` están declaradas sin `on update cascade`, y tres llevan
-- `org_id` DENTRO de su clave primaria (`usage_daily`, `seat_activity`,
-- `usage_ingest_seen`), que es la base de la facturación.
--
-- 100% ADITIVA: cuando se aplique, ningún código la lee todavía. Ver las fases en
-- docs/PLAN-ORGANIZACION-REAL.md.

-- ---------------------------------------------------------------------------
-- 1. La propiedad pasa a ser un DATO de la fila, no la clave primaria.
--    `on delete set null` a propósito: `auth.users` es un proyecto COMPARTIDO con
--    el resto de productos de BiVelio, así que un borrado desde cualquiera de
--    ellos llegaría hasta aquí. Con `set null` queda una organización viva y sin
--    dueño —visible, y detectable por el invariante— en vez de una cascada que se
--    llevaría por delante suscripciones, licencias y todo el histórico de uso.
-- ---------------------------------------------------------------------------
alter table bvsala.organizations
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null;

update bvsala.organizations o
   set owner_user_id = m.user_id
  from bvsala.org_members m
 where m.org_id = o.id
   and m.role = 'owner'
   and o.owner_user_id is null;

-- Que aborte es el resultado BUENO. Una organización sin dueño no se puede
-- gestionar: nadie podría cambiar la tarjeta ni cancelar, y la suscripción
-- seguiría cobrando. Preferimos no aplicar la migración a dejarla así.
do $$
declare huerfanas int;
begin
  select count(*) into huerfanas from bvsala.organizations where owner_user_id is null;
  if huerfanas > 0 then
    raise exception
      'ABORTADA: % organizacion(es) sin owner_user_id. Revisa bvsala.org_members: '
      'cada organizacion necesita exactamente una fila con role=''owner'' antes de esta migracion.',
      huerfanas;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Una organización, un solo dueño.
--
--    NO es un índice único parcial, y la diferencia importa: un índice único se
--    comprueba POR FILA y no admite DEFERRABLE, así que haría IMPOSIBLE la
--    transferencia de propiedad atómica — degradar al dueño viejo y promover al
--    nuevo dentro de una transacción chocaría en la instrucción intermedia.
--    Una restricción EXCLUDE sí se puede diferir al COMMIT.
--
--    `using btree` (no gist) porque el operador es `=`: eso evita tener que
--    instalar la extensión `btree_gist` en una base de datos COMPARTIDA, que es
--    justo lo que todo el aislamiento en esquemas propios existe para no hacer.
-- ---------------------------------------------------------------------------
alter table bvsala.org_members
  drop constraint if exists un_solo_owner_por_org;
alter table bvsala.org_members
  add constraint un_solo_owner_por_org
  exclude using btree (org_id with =) where (role = 'owner')
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- 3. Invitaciones.
--
--    `email` es TEXT y la unicidad va por `lower(email)`. NO se usa `citext`:
--    no está instalada, y `create extension citext` sin `with schema` la
--    instalaría en `public` — el esquema de OTRA aplicación de la plataforma.
--
--    Del token solo se guarda el sha256, igual que `service_accounts.key_hash`
--    (0001:59). El texto plano se enseña UNA vez y no se puede reconstruir.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.org_invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references bvsala.organizations(id) on delete cascade,
  email       text not null,
  role        text not null default 'member'
                check (role in ('admin','member','billing')),   -- 'owner' NO: se transfiere, no se invita
  token_hash  text not null unique,
  invited_by  uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Una invitación VIVA por dirección y organización. Las ya aceptadas no estorban,
-- así que se puede volver a invitar a quien salió del equipo.
create unique index if not exists org_invitations_viva_idx
  on bvsala.org_invitations (org_id, lower(email))
  where accepted_at is null;
create index if not exists org_invitations_org_idx on bvsala.org_invitations (org_id);

-- RLS ENCENDIDA Y SIN NINGUNA POLÍTICA: nadie lee esta tabla desde el navegador.
-- Es la misma postura que `usage_ingest_seen` en 0009. Contiene direcciones de
-- correo de terceros y hashes de tokens de invitación; se maneja entera desde el
-- servidor con `service_role`, que salta la RLS.
alter table bvsala.org_invitations enable row level security;

-- El `revoke` explícito NO es redundante: 0007 quitó `anon` de los privilegios
-- por defecto del esquema (0007:88) pero `authenticated` los sigue heredando, así
-- que sin esto una tabla nueva nace legible para cualquier sesión.
revoke all on bvsala.org_invitations from anon, authenticated;
grant all on bvsala.org_invitations to service_role;

-- ---------------------------------------------------------------------------
-- LO QUE ESTA MIGRACIÓN NO HACE, Y POR QUÉ
--
-- · NO se crea una función `rol_en_org()` SECURITY DEFINER. Resolvería por
--   `auth.uid()`, y TODAS las decisiones de autorización de este producto se
--   toman con el cliente `service_role`, donde `auth.uid()` es NULL siempre:
--   devolvería NULL en el 100% de los casos y —según cómo se interpretara— o
--   deniega todo o abre todo. El chequeo de rol va en TypeScript (fase 7).
--
-- · NO se toca `bvsala.is_org_member` (0001:123). La usan las políticas RLS de
--   seis tablas; cambiarle la semántica movería la visibilidad de todas a la vez.
--
-- · NO se añade todavía la unicidad de "una suscripción de pago por organización".
--   Hoy la guardia vive en `api/stripe/checkout/route.ts` y es leer-y-luego-crear,
--   así que dos miembros pulsando a la vez la pasan los dos — pero eso solo puede
--   ocurrir cuando una organización TENGA dos miembros, y eso llega en la fase 8.
--   Ponerlo aquí, antes de que el webhook sepa manejar el conflicto, convertiría
--   una carrera improbable en un 500 seguro.
-- ---------------------------------------------------------------------------

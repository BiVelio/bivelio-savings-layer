-- 0033 — la licencia «Medir» (plan `measure`): gratuita, permanente, sin tarjeta.
--
-- QUÉ ES: el SDK y la pasarela en SOMBRA —calculan lo que habrían ahorrado— y
-- SIN palancas: la petición del cliente sale intacta al proveedor y nada se
-- sirve de caché. Una licencia firmada más, verificada offline como las otras.
-- Revierte EN PARTE #314: la org SIN ninguna licencia sigue bloqueada (402).
--
-- QUÉ HACE ESTA MIGRACIÓN (ninguna fila existente cambia):
--   1. admite `measure` en el CHECK de `licenses.plan`;
--   2. UNA Medir viva por organización (índice único parcial);
--   3. `medir_altas`: quién reclamó Medir para qué organización. La clave
--      primaria es el USUARIO (una organización Medir por cuenta verificada) y
--      `org_id` es único (un alta por organización). Guarda el DOMINIO del
--      correo, no la dirección, para detectar granjas de cuentas; y `bloqueada`
--      para que el operador corte una organización que abusa sin que el alta la
--      pueda reactivar (la revocación de su licencia va por el ledger, como
--      siempre: lib/license/issue.ts#revokeLicense).
--
-- LO QUE NO NECESITA MIGRACIÓN: el uso de una org Medir entra por la RPC de
-- siempre (la de 0032, que esta migración NO redefine ni toca). La ingesta (app/api/metering/usage) lo NEUTRALIZA antes (baseline ==
-- actual, sin referencia), así que no puede crear base de comisión; y lo que
-- habría ahorrado viaja con basis 'shadow', que 0021 acumula solo en shadow_*.
--
-- NUMERACIÓN Y GUARD: 0033 va DESPUÉS de 0032 (el ahorro nativo, PR #412) y lo
-- exige aplicado, igual que 0032 exige 0031: se aplica en orden ascendente
-- estricto (regla 2 del runbook) y un prod a medias ABORTA aquí antes de tocar
-- nada. No depende de nada de 0032 para funcionar —no toca `ingest_usage_batch`
-- ni `usage_daily`, así que no puede regresar la RPC de 0032 (regla 1 intacta)—;
-- el guard fija el ORDEN, no una dependencia técnica.
--
-- ORDEN DE DESPLIEGUE: 0029 → 0030 → 0031 → 0032 → 0033, y esta migración ANTES
-- del código web (la ruta /api/license/measure escribe `medir_altas` y licencias
-- con plan 'measure', que sin el CHECK nuevo fallan con 23514 — fail-closed: no
-- se emite nada). Después la web; el paquete npm, el último.
-- Idempotente: correrla dos veces no cambia nada la segunda.

-- Diagnóstico: to_regclass('bvsala.medir_altas') is not null
--   and to_regclass('bvsala.licenses_una_medir_viva_por_org') is not null

do $$
begin
  if to_regclass('bvsala.organizations') is null or to_regclass('bvsala.licenses') is null then
    raise exception '0033: base ausente (organizations / licenses)';
  end if;
  -- 0032 (el ahorro nativo): su columna Y su versión de la RPC. Abortar es el
  -- resultado BUENO: aplicar 0032 (y antes 0031) y volver a lanzar 0033.
  if not exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='native_cache_read_savings')
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                       and p.prosrc like '%nativeCacheReadSavings%' and p.prosrc like '%seat_activity.reference_baseline_cost%')
  then
    raise exception '0033: base 0032 ausente — aplicar 0032 antes, en orden ascendente';
  end if;
end $$;

-- 1 · el plan
alter table bvsala.licenses drop constraint if exists licenses_plan_check;
alter table bvsala.licenses
  add constraint licenses_plan_check
  check (plan in ('free', 'measure', 'pro', 'team', 'enterprise'));

-- 2 · una Medir viva por organización. El código (lib/license/medir.ts) trata el
-- 23505 de una doble pulsación devolviendo la que ganó. La vuelta a Medir al
-- cancelar (webhook) o al degradar por impago (cron) emite solo si no hay una
-- viva, y la cancelación CONSERVA la viva: el índice no choca con ninguna de las dos.
create unique index if not exists licenses_una_medir_viva_por_org
  on bvsala.licenses (org_id)
  where plan = 'measure' and revoked = false;

-- 3 · las altas
create table if not exists bvsala.medir_altas (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  org_id        uuid not null unique references bvsala.organizations(id) on delete cascade,
  email_dominio text,
  bloqueada     boolean not null default false,
  bloqueo_nota  text,
  created_at    timestamptz not null default now()
);
create index if not exists medir_altas_dominio_idx on bvsala.medir_altas (email_dominio);

-- Solo el service role (la ruta de alta y el operador). Sin políticas: RLS
-- activa y ningún grant a anon/authenticated = nadie más la lee ni la escribe.
alter table bvsala.medir_altas enable row level security;
revoke all on bvsala.medir_altas from anon, authenticated;
grant select, insert, update on bvsala.medir_altas to service_role;

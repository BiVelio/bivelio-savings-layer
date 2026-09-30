-- 0034 — el cobro de los asientos usados de más: una fila por (org, período).
--
-- QUÉ ES (decisión del dueño, 2026-09-30, «(a)»): el día 1, el cron
-- /api/cron/cobrar-asientos compara, para el mes CERRADO, los asientos USADOS
-- (`bvsala.billable_seats`) con los PAGADOS (la `quantity` de la suscripción) y
-- cobra la diferencia al precio real del plan con un invoice item de Stripe
-- (apps/web/lib/billing/cobro-asientos.ts). Esta tabla es el CANDADO: la fila se
-- escribe ANTES de tocar Stripe (`pendiente`) y después pasa a `cobrado` o
-- `fallido`. Un (org, período) con fila `cobrado` no se vuelve a cobrar nunca;
-- el segundo candado son las claves de idempotencia de Stripe
-- (`bvsala-asientos-{org}-{período}-…`), como en 0017.
--
-- INMUTABLE EN LO QUE IMPORTA: las cifras (usados, pagados, exceso, importe,
-- plan) se fijan al pasar de `seco` a cualquier otro estado y ya no cambian —
-- el reintento de un `fallido` cobra LA MISMA cifra, no una recalculada—; un
-- `cobrado` es terminal; y nadie tiene DELETE. Lo garantiza el trigger de abajo,
-- no la costumbre del cron. `seco` es el ensayo del primer ciclo
-- (BVSALA_COBRO_ASIENTOS=seco): se recalcula libremente y se sustituye al
-- pasar a `vivo`; a `seco` no se puede volver desde ningún otro estado.
--
-- SOLO EL SERVICE ROLE: RLS activa sin políticas y ningún grant a
-- anon/authenticated. El panel la lee con el cliente de servicio y el org_id de
-- la sesión (lib/billing/asientos-usados.ts), como billable_seats.
--
-- NUMERACIÓN Y GUARD: 0034 va DESPUÉS de 0033 (la licencia Medir) y la exige
-- aplicada, como 0033 exige 0032: orden ascendente estricto (regla 2 del
-- runbook). No depende técnicamente de 0033; el guard fija el ORDEN. No toca
-- `ingest_usage_batch` ni `usage_daily` (regla 1 intacta).
--
-- ORDEN DE DESPLIEGUE: 0034 ANTES de la web. Sin la tabla, el cron responde 503
-- con alerta crítica y no cobra nada (fail-closed); el panel no enseña el
-- ajuste del mes pasado.
-- Idempotente: correrla dos veces no cambia nada la segunda.

-- Diagnóstico: to_regclass('bvsala.ajustes_asientos') is not null
--   and to_regprocedure('bvsala.ajustes_asientos_inmutable()') is not null

do $$
begin
  if to_regclass('bvsala.organizations') is null or to_regclass('bvsala.subscriptions') is null
     or to_regprocedure('bvsala.billable_seats(uuid, date)') is null then
    raise exception '0034: base ausente (organizations / subscriptions / billable_seats)';
  end if;
  -- 0033 (la licencia Medir): su tabla Y su índice. Abortar es el resultado
  -- BUENO: aplicar 0033 (y antes 0032) y volver a lanzar 0034.
  if to_regclass('bvsala.medir_altas') is null or to_regclass('bvsala.licenses_una_medir_viva_por_org') is null then
    raise exception '0034: base 0033 ausente — aplicar 0033 antes, en orden ascendente';
  end if;
end $$;

create table if not exists bvsala.ajustes_asientos (
  org_id                  uuid not null references bvsala.organizations(id) on delete cascade,
  periodo                 text not null check (periodo ~ '^\d{4}-\d{2}$'),
  -- El plan y el período de pago con los que se calculó el importe.
  -- `periodo_pago` es null solo si el price no es uno configurado (sin precio).
  plan                    text not null check (plan in ('pro', 'equipo', 'comision')),
  periodo_pago            text check (periodo_pago in ('monthly', 'yearly')),
  stripe_subscription_id  text,
  usados                  integer not null check (usados >= 0),
  pagados                 integer not null check (pagados >= 0),
  exceso                  integer not null check (exceso >= 0),
  importe_eur             numeric(12,2) not null check (importe_eur >= 0),
  estado                  text not null check (estado in (
                            'seco', 'pendiente', 'cobrado', 'fallido', 'revision_humana',
                            'omitido_bajo_minimo', 'omitido_sin_precio', 'omitido_no_activa'
                          )),
  stripe_invoice_item_id  text unique,
  -- Por qué está en ese estado (la causa de un omitido, de una revisión o de un fallo).
  motivo                  text not null default '',
  detalle                 jsonb not null default '{}'::jsonb,
  creado_en               timestamptz not null default now(),
  actualizado_en          timestamptz not null default now(),
  primary key (org_id, periodo),
  constraint ajustes_asientos_exceso_cuadra check (exceso = greatest(usados - pagados, 0)),
  -- Un cobrado SIEMPRE tiene su invoice item.
  constraint ajustes_asientos_cobrado_con_item check (estado <> 'cobrado' or stripe_invoice_item_id is not null)
);

create index if not exists ajustes_asientos_periodo_idx on bvsala.ajustes_asientos (periodo, estado);

create or replace function bvsala.ajustes_asientos_inmutable()
returns trigger
language plpgsql
set search_path = bvsala, pg_temp
as $fn$
begin
  if new.org_id is distinct from old.org_id or new.periodo is distinct from old.periodo then
    raise exception 'ajustes_asientos: (org_id, periodo) no cambia';
  end if;
  if old.estado = 'cobrado' then
    raise exception 'ajustes_asientos: un ajuste cobrado es terminal (%, %)', old.org_id, old.periodo;
  end if;
  if new.estado = 'seco' and old.estado <> 'seco' then
    raise exception 'ajustes_asientos: no se vuelve a seco desde %', old.estado;
  end if;
  if old.estado <> 'seco' and (
       new.plan is distinct from old.plan
       or new.periodo_pago is distinct from old.periodo_pago
       or new.usados is distinct from old.usados
       or new.pagados is distinct from old.pagados
       or new.exceso is distinct from old.exceso
       or new.importe_eur is distinct from old.importe_eur
     ) then
    raise exception 'ajustes_asientos: las cifras de un ajuste fijado no cambian (%, %)', old.org_id, old.periodo;
  end if;
  new.actualizado_en := now();
  return new;
end
$fn$;

drop trigger if exists ajustes_asientos_inmutable on bvsala.ajustes_asientos;
create trigger ajustes_asientos_inmutable
  before update on bvsala.ajustes_asientos
  for each row execute function bvsala.ajustes_asientos_inmutable();

-- Solo el service role (el cron y el panel con el org_id de la sesión). Sin
-- políticas: RLS activa y ningún grant a anon/authenticated. Sin DELETE: el
-- rastro de un cobro no se borra (el borrado de la organización cascada igual).
alter table bvsala.ajustes_asientos enable row level security;
revoke all on bvsala.ajustes_asientos from anon, authenticated;
grant select, insert, update on bvsala.ajustes_asientos to service_role;
revoke all on function bvsala.ajustes_asientos_inmutable() from public, anon, authenticated;

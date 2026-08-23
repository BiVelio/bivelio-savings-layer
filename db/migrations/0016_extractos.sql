-- 0016 · Los extractos cerrados — el documento del modelo a comisión.
--
-- El plan maestro («La medición manda», 2026-08-23) fija que el extracto en
-- sombra y el facturable son EL MISMO documento. Esta tabla es donde el cierre
-- mensual lo DEJA FIJADO: una fila por organización y período, calculada una
-- sola vez al cerrar el mes y nunca reescrita. La página del dashboard enseña
-- el período en curso EN VIVO (se recalcula de usage_daily); lo cerrado se lee
-- de aquí, que es lo que una factura puede citar.
--
-- INMUTABLE POR DISEÑO: el cierre inserta con ON CONFLICT DO NOTHING (la
-- clave es org+período). Un extracto cerrado que cambiara después de citado en
-- una factura sería exactamente la clase de mentira que este producto existe
-- para no contar. Si un cierre salió mal, el camino es una fila de corrección
-- explícita en una futura migración de proceso — jamás un UPDATE silencioso.

create table if not exists bvsala.extractos (
  org_id            uuid not null references bvsala.organizations(id) on delete cascade,
  periodo           text not null check (periodo ~ '^\d{4}-\d{2}$'),
  es_calibracion    boolean not null,
  dias              integer not null default 0,
  requests_medidas  bigint  not null default 0,
  -- El dinero, en las dos monedas del documento: USD (precios de proveedor)
  -- y EUR (la factura), con el FX y su fuente fijados en la propia fila.
  base_medida_usd   numeric(14,6) not null default 0,
  ahorro_medido_usd numeric(14,6) not null default 0,
  base_medida_eur   numeric(14,6) not null default 0,
  ahorro_medido_eur numeric(14,6) not null default 0,
  ratio             numeric(8,6)  not null default 0,
  factor_rampa      numeric(8,6)  not null default 0,
  comision_eur      numeric(14,6) not null default 0,
  cargo_eur         numeric(14,6) not null default 0,
  ahorro_estimado_excluido_usd numeric(14,6) not null default 0,
  version_precios   text not null,
  fx_eur_por_usd    numeric(12,6) not null,
  fx_fuente         text not null,
  -- El desglose por tramos, tal cual lo produjo la tarifa vigente al cierre.
  tramos            jsonb not null default '[]'::jsonb,
  cerrado_en        timestamptz not null default now(),
  primary key (org_id, periodo),
  constraint extractos_sin_negativos check (
    base_medida_usd >= 0 and ahorro_medido_usd >= 0 and
    base_medida_eur >= 0 and ahorro_medido_eur >= 0 and
    comision_eur   >= 0 and cargo_eur >= 0
  ),
  -- La promesa del mes de calibración, como restricción y no como costumbre:
  -- un extracto de calibración con cargo es imposible de INSERTAR.
  constraint extractos_calibracion_cobra_cero check (not es_calibracion or cargo_eur = 0),
  -- Y el cargo jamás excede la comisión calculada (es ella o cero).
  constraint extractos_cargo_acotado check (cargo_eur <= comision_eur)
);

alter table bvsala.extractos enable row level security;

-- Los miembros de la organización leen sus extractos (mismo patrón que
-- usage_daily en 0001); escribe solo el service_role del cierre.
create policy extractos_read on bvsala.extractos
  for select using (bvsala.is_org_member(org_id));

grant select on bvsala.extractos to authenticated;
grant all    on bvsala.extractos to service_role;

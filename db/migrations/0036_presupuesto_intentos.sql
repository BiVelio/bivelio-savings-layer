-- 0036 — el presupuesto por intento: reservar antes de enviar, liquidar con el
-- recibo (plan Caveman 2026-10-14, p. 8 · D07). ESCRITA, SIN APLICAR.
--
-- QUÉ ES. La versión duradera de `BudgetLedgerEnMemoria`
-- (src/metering/presupuesto.ts): un tope por (org, proyecto) y la máquina de
-- estados de cada INTENTO (cada solicitud que pudo generar coste):
--
--   reserved ─▶ dispatched ─▶ settled
--      │            └──────▶ uncertain ─▶ settled | estimated
--      ├─▶ released   (SOLO con prueba de no-envío; un timeout local no lo es)
--      └─▶ uncertain
--
-- · Reservar es UN UPDATE condicional sobre la fila del presupuesto:
--   gastado + estimado + reservado + incierto + importe <= tope. La fila se
--   bloquea (FOR UPDATE) antes de mirar nada, así que cien reservas a la vez se
--   serializan y ninguna carrera pasa del tope.
-- · Un reintento al proveedor es OTRO intento (otro ordinal) con su reserva.
--   Reservar el mismo intento con el mismo sobre es idempotente (huella).
-- · Liquidar exige el recibo de D02 (src/metering/intento.ts): UNIQUE por
--   receipt_event_id y por intento. Repetir el mismo recibo es un no-op; otro
--   cuerpo para el mismo evento ABORTA.
-- · Lo desconocido nunca cuesta 0: un intento incierto RETIENE su exposición
--   (como mínimo lo reservado) hasta conciliarse o estimarse (etiquetado).
-- · Dinero en micro-USD ENTEROS (`bigint`), moneda explícita y solo USD: sin
--   FX, sin `numeric` de coma.
-- · Cada transición escribe su evento en la OUTBOX en la MISMA transacción.
--   Entrega al menos una vez, dedup por event_id, orden por proyecto + llamada
--   lógica (seq); el agregador tolera el desorden (src/metering/presupuesto.ts,
--   `AgregadorDePresupuesto`).
--
-- QUÉ NO ES. Ni contenido (ningún prompt, completion ni tool_result: ids,
-- estados y dinero), ni el precio: el importe lo calcula el SDK con el
-- catálogo versionado (`tarifarIntento`, `cotaDeSobre`) y la RPC lo recibe del
-- service role. No toca `ingest_usage_batch`, `usage_daily` ni el cable de uso
-- (regla 1 del runbook intacta). Nada la usa todavía: ni el gateway ni el
-- ingest están cableados a estas RPC.
--
-- SOLO EL SERVICE ROLE ESCRIBE, y solo por RPC: ninguna tabla tiene INSERT,
-- UPDATE ni DELETE para nadie —el UPDATE condicional no se puede saltar con un
-- UPDATE a mano—. Los miembros de la organización LEEN su presupuesto
-- (`is_org_member`, el patrón de 0016/0017); intentos, recibos y outbox son
-- solo del service role.
--
-- NUMERACIÓN Y GUARD: 0036 va DESPUÉS de 0035 y la exige aplicada (orden
-- ascendente estricto, regla 2). No depende técnicamente de 0035; el guard fija
-- el ORDEN. Idempotente: correrla dos veces no cambia nada la segunda.

-- Diagnóstico: to_regclass('bvsala.presupuesto_intentos') is not null
--   and to_regprocedure('bvsala.presupuesto_reservar(uuid, text, text, integer, text, text, bigint, text, text, integer, text, text, text)') is not null

do $$
begin
  if to_regclass('bvsala.organizations') is null or to_regprocedure('bvsala.is_org_member(uuid)') is null then
    raise exception '0036: base ausente (organizations / is_org_member)';
  end if;
  -- 0035: service_role SIN delete sobre ajustes_asientos. Abortar es el
  -- resultado BUENO: aplicar 0034 y 0035 y volver a lanzar 0036.
  if to_regclass('bvsala.ajustes_asientos') is null
     or has_table_privilege('service_role', 'bvsala.ajustes_asientos', 'delete') then
    raise exception '0036: base 0035 ausente — aplicar 0035 antes, en orden ascendente';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- El presupuesto de un proyecto: el tope y lo comprometido, en micro-USD.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.presupuestos_proyecto (
  org_id                          uuid not null references bvsala.organizations(id) on delete cascade,
  project_id                      text not null check (project_id ~ '^[A-Za-z0-9._:/-]{1,96}$'),
  moneda                          text not null default 'USD' check (moneda = 'USD'),
  tope_micro_usd                  bigint not null check (tope_micro_usd >= 0),
  -- Estricto: un sobre sin cota fiable se rechaza. No estricto: se reserva la
  -- política conservadora (si la hay; si no, se rechaza igual).
  estricto                        boolean not null,
  reserva_conservadora_micro_usd  bigint check (reserva_conservadora_micro_usd > 0),
  -- Lo comprometido. `disponible = tope − gastado − estimado − reservado − incierto`
  -- puede ser NEGATIVO: un coste real que superó su reserva se apunta entero.
  gastado_micro_usd               bigint not null default 0 check (gastado_micro_usd >= 0),
  estimado_micro_usd              bigint not null default 0 check (estimado_micro_usd >= 0),
  reservado_micro_usd             bigint not null default 0 check (reservado_micro_usd >= 0),
  incierto_micro_usd              bigint not null default 0 check (incierto_micro_usd >= 0),
  creado_en                       timestamptz not null default now(),
  actualizado_en                  timestamptz not null default now(),
  primary key (org_id, project_id),
  constraint presupuestos_estricto_sin_conservadora check (not estricto or reserva_conservadora_micro_usd is null)
);

-- ---------------------------------------------------------------------------
-- Los intentos: uno por solicitud que pudo generar coste.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.presupuesto_intentos (
  org_id                  uuid not null,
  project_id              text not null,
  attempt_id              text not null,
  logical_call_id         text not null check (logical_call_id ~ '^[A-Za-z0-9._:/-]{1,96}$'),
  ordinal                 integer not null check (ordinal >= 0),
  kind                    text not null check (kind in ('primary', 'retry', 'repair', 'discovery', 'fallback')),
  experiment_run_id       text,
  arm_id                  text,
  modelo                  text not null check (modelo <> ''),
  estado                  text not null check (estado in (
                            'reserved', 'dispatched', 'settled', 'released', 'uncertain', 'estimated'
                          )),
  base_reserva            text not null check (base_reserva in ('upper_bound', 'conservative_policy')),
  -- Lo reservado, fijado al reservar: nunca cambia (lo guarda el trigger).
  reservado_micro_usd     bigint not null check (reservado_micro_usd > 0),
  -- Lo que el intento ocupa AHORA del tope sin estar liquidado.
  exposicion_micro_usd    bigint not null check (exposicion_micro_usd >= 0),
  coste_micro_usd         bigint check (coste_micro_usd >= 0),
  estimado_micro_usd      bigint check (estimado_micro_usd > 0),
  suelo_micro_usd         bigint check (suelo_micro_usd >= 0),
  receipt_event_id        text check (receipt_event_id ~ '^ev_[0-9a-f]{32}$'),
  huella_sobre            text not null check (huella_sobre ~ '^[0-9a-f]{64}$'),
  version_precios         text,
  correlacion_proveedor   text,
  prueba_no_envio         text check (prueba_no_envio in ('abortado_antes_de_enviar', 'rechazado_localmente', 'sin_conexion')),
  motivo_incierto         text check (motivo_incierto in (
                            'cancelado', 'stream_truncado', 'uso_ausente', 'uso_parcial',
                            'timeout_local', 'sin_precio', 'precio_incierto', 'estado_desconocido'
                          )),
  fuente_estimacion       text,
  reservado_en            timestamptz not null default now(),
  enviado_en              timestamptz,
  cerrado_en              timestamptz,
  primary key (org_id, project_id, attempt_id),
  foreign key (org_id, project_id) references bvsala.presupuestos_proyecto(org_id, project_id) on delete cascade,
  -- El id es el de D02 (`idDeIntento`): la llamada lógica y su ordinal.
  constraint presupuesto_intentos_id_derivado check (attempt_id = logical_call_id || ':a' || ordinal::text),
  constraint presupuesto_intentos_ordinal_unico unique (org_id, project_id, logical_call_id, ordinal),
  constraint presupuesto_intentos_recibo_unico unique (org_id, receipt_event_id),
  -- Coherencia de cada estado, como restricción y no como costumbre de la RPC.
  constraint presupuesto_intentos_abierto_retiene check (
    estado not in ('reserved', 'dispatched') or exposicion_micro_usd = reservado_micro_usd
  ),
  constraint presupuesto_intentos_incierto_retiene check (
    estado <> 'uncertain' or (exposicion_micro_usd >= reservado_micro_usd and motivo_incierto is not null)
  ),
  constraint presupuesto_intentos_cerrado_sin_exposicion check (
    estado not in ('settled', 'released', 'estimated') or (exposicion_micro_usd = 0 and cerrado_en is not null)
  ),
  constraint presupuesto_intentos_liquidado_con_recibo check (
    (estado = 'settled') = (coste_micro_usd is not null and receipt_event_id is not null)
  ),
  constraint presupuesto_intentos_estimado_con_fuente check (
    (estado = 'estimated') = (estimado_micro_usd is not null and fuente_estimacion is not null)
  ),
  constraint presupuesto_intentos_liberado_con_prueba check (
    (estado = 'released') = (prueba_no_envio is not null)
  ),
  constraint presupuesto_intentos_liberado_no_enviado check (estado <> 'released' or enviado_en is null),
  constraint presupuesto_intentos_enviado_con_hora check (estado <> 'dispatched' or enviado_en is not null)
);

create index if not exists presupuesto_intentos_abiertos_idx
  on bvsala.presupuesto_intentos (org_id, project_id, reservado_en)
  where estado in ('reserved', 'dispatched', 'uncertain');

-- Las transiciones permitidas (las mismas que `TRANSICIONES` en el SDK) y la
-- identidad y la reserva, inmutables.
create or replace function bvsala.presupuesto_intentos_transicion()
returns trigger
language plpgsql
set search_path = bvsala, pg_temp
as $fn$
begin
  if new.org_id is distinct from old.org_id
     or new.project_id is distinct from old.project_id
     or new.attempt_id is distinct from old.attempt_id
     or new.logical_call_id is distinct from old.logical_call_id
     or new.ordinal is distinct from old.ordinal
     or new.kind is distinct from old.kind
     or new.experiment_run_id is distinct from old.experiment_run_id
     or new.arm_id is distinct from old.arm_id
     or new.modelo is distinct from old.modelo
     or new.base_reserva is distinct from old.base_reserva
     or new.reservado_micro_usd is distinct from old.reservado_micro_usd
     or new.huella_sobre is distinct from old.huella_sobre
     or new.reservado_en is distinct from old.reservado_en then
    raise exception 'presupuesto_intentos: la identidad y la reserva de % no cambian', old.attempt_id;
  end if;
  if not (
       (old.estado = 'reserved'   and new.estado in ('dispatched', 'released', 'uncertain'))
    or (old.estado = 'dispatched' and new.estado in ('settled', 'uncertain'))
    or (old.estado = 'uncertain'  and new.estado in ('settled', 'estimated', 'uncertain'))
  ) then
    raise exception 'presupuesto_intentos: transición inválida % → % (%)', old.estado, new.estado, old.attempt_id;
  end if;
  return new;
end
$fn$;

drop trigger if exists presupuesto_intentos_transicion on bvsala.presupuesto_intentos;
create trigger presupuesto_intentos_transicion
  before update on bvsala.presupuesto_intentos
  for each row execute function bvsala.presupuesto_intentos_transicion();

-- ---------------------------------------------------------------------------
-- Los recibos liquidados (el `ReciboDeIntento` de D02): inmutables.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.presupuesto_recibos (
  org_id            uuid not null,
  receipt_event_id  text not null check (receipt_event_id ~ '^ev_[0-9a-f]{32}$'),
  project_id        text not null,
  attempt_id        text not null,
  coste_micro_usd   bigint not null check (coste_micro_usd >= 0),
  -- El importe exacto en atto-USD (1e-18) como entero decimal: sumar sin arrastrar redondeos.
  exact_atto_usd    numeric(40, 0) not null check (exact_atto_usd >= 0),
  moneda            text not null default 'USD' check (moneda = 'USD'),
  version_precios   text not null,
  dia_precio        date not null,
  -- sha256 del recibo canónico: el mismo evento con OTRO cuerpo se detecta aquí.
  huella            text not null check (huella ~ '^[0-9a-f]{64}$'),
  creado_en         timestamptz not null default now(),
  primary key (org_id, receipt_event_id),
  constraint presupuesto_recibos_un_recibo_por_intento unique (org_id, project_id, attempt_id),
  foreign key (org_id, project_id, attempt_id)
    references bvsala.presupuesto_intentos(org_id, project_id, attempt_id) on delete cascade
);

create or replace function bvsala.presupuesto_recibos_inmutable()
returns trigger
language plpgsql
set search_path = bvsala, pg_temp
as $fn$
begin
  raise exception 'presupuesto_recibos: un recibo liquidado no se reescribe (%)', old.receipt_event_id;
end
$fn$;

drop trigger if exists presupuesto_recibos_inmutable on bvsala.presupuesto_recibos;
create trigger presupuesto_recibos_inmutable
  before update on bvsala.presupuesto_recibos
  for each row execute function bvsala.presupuesto_recibos_inmutable();

-- ---------------------------------------------------------------------------
-- El orden: un contador por (org, proyecto, llamada lógica).
-- ---------------------------------------------------------------------------
create table if not exists bvsala.presupuesto_llamadas (
  org_id           uuid not null,
  project_id       text not null,
  logical_call_id  text not null,
  ultimo_seq       bigint not null check (ultimo_seq >= 1),
  primary key (org_id, project_id, logical_call_id),
  foreign key (org_id, project_id) references bvsala.presupuestos_proyecto(org_id, project_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- La outbox: un evento por transición, en la misma transacción.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.presupuesto_outbox (
  org_id                uuid not null,
  event_id              text not null check (event_id ~ '^bud_[0-9a-f]{32}$'),
  project_id            text not null,
  logical_call_id       text not null,
  attempt_id            text not null,
  seq                   bigint not null check (seq >= 1),
  estado                text not null check (estado in (
                          'reserved', 'dispatched', 'settled', 'released', 'uncertain', 'estimated'
                        )),
  importe_micro_usd     bigint not null check (importe_micro_usd >= 0),
  exposicion_micro_usd  bigint not null check (exposicion_micro_usd >= 0),
  moneda                text not null default 'USD' check (moneda = 'USD'),
  etiqueta              text not null check (etiqueta in ('verified', 'estimated', 'exposure', 'released')),
  experiment_run_id     text,
  arm_id                text,
  receipt_event_id      text,
  creado_en             timestamptz not null default now(),
  entregado_en          timestamptz,
  primary key (org_id, event_id),
  constraint presupuesto_outbox_orden_unico unique (org_id, project_id, logical_call_id, seq),
  foreign key (org_id, project_id) references bvsala.presupuestos_proyecto(org_id, project_id) on delete cascade
);

create index if not exists presupuesto_outbox_pendientes_idx
  on bvsala.presupuesto_outbox (org_id, project_id, logical_call_id, seq)
  where entregado_en is null;

-- Lo único que cambia de un evento es que se entregó, y una vez.
create or replace function bvsala.presupuesto_outbox_inmutable()
returns trigger
language plpgsql
set search_path = bvsala, pg_temp
as $fn$
begin
  if (to_jsonb(new) - 'entregado_en') is distinct from (to_jsonb(old) - 'entregado_en') then
    raise exception 'presupuesto_outbox: un evento no se reescribe (%)', old.event_id;
  end if;
  if old.entregado_en is not null and new.entregado_en is distinct from old.entregado_en then
    raise exception 'presupuesto_outbox: la entrega de % ya se confirmó', old.event_id;
  end if;
  return new;
end
$fn$;

drop trigger if exists presupuesto_outbox_inmutable on bvsala.presupuesto_outbox;
create trigger presupuesto_outbox_inmutable
  before update on bvsala.presupuesto_outbox
  for each row execute function bvsala.presupuesto_outbox_inmutable();

-- ---------------------------------------------------------------------------
-- Privilegios: lectura para el service role, escritura solo por RPC.
-- ---------------------------------------------------------------------------
alter table bvsala.presupuestos_proyecto enable row level security;
alter table bvsala.presupuesto_intentos  enable row level security;
alter table bvsala.presupuesto_recibos   enable row level security;
alter table bvsala.presupuesto_llamadas  enable row level security;
alter table bvsala.presupuesto_outbox    enable row level security;

revoke all on bvsala.presupuestos_proyecto from anon, authenticated, service_role;
revoke all on bvsala.presupuesto_intentos  from anon, authenticated, service_role;
revoke all on bvsala.presupuesto_recibos   from anon, authenticated, service_role;
revoke all on bvsala.presupuesto_llamadas  from anon, authenticated, service_role;
revoke all on bvsala.presupuesto_outbox    from anon, authenticated, service_role;

grant select on bvsala.presupuestos_proyecto to service_role, authenticated;
grant select on bvsala.presupuesto_intentos  to service_role;
grant select on bvsala.presupuesto_recibos   to service_role;
grant select on bvsala.presupuesto_llamadas  to service_role;
grant select on bvsala.presupuesto_outbox    to service_role;

-- Los miembros leen el presupuesto de su organización (tope y exposición
-- pendiente: lo que la interfaz debe enseñar). Mismo patrón que 0016.
drop policy if exists presupuestos_proyecto_read on bvsala.presupuestos_proyecto;
create policy presupuestos_proyecto_read on bvsala.presupuestos_proyecto
  for select using (bvsala.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Las RPC. Todas `security definer`, todas en una transacción, todas bloquean
-- PRIMERO la fila del presupuesto y DESPUÉS la del intento (un solo orden de
-- bloqueo: sin interbloqueos entre ellas).
-- ---------------------------------------------------------------------------

-- El evento de una transición. Mismo id que `idDeEventoDePresupuesto` del SDK.
create or replace function bvsala.presupuesto_emitir(
  i bvsala.presupuesto_intentos, p_importe bigint, p_etiqueta text
) returns text
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_seq bigint;
  v_id  text;
begin
  insert into bvsala.presupuesto_llamadas as l (org_id, project_id, logical_call_id, ultimo_seq)
    values (i.org_id, i.project_id, i.logical_call_id, 1)
    on conflict (org_id, project_id, logical_call_id) do update set ultimo_seq = l.ultimo_seq + 1
    returning ultimo_seq into v_seq;
  v_id := 'bud_' || left(encode(sha256(convert_to(
            'bvsala/presupuesto/v1|' || i.project_id || '|' || i.attempt_id || '|' || i.estado || '|' || v_seq::text,
            'UTF8')), 'hex'), 32);
  insert into bvsala.presupuesto_outbox (
    org_id, event_id, project_id, logical_call_id, attempt_id, seq, estado,
    importe_micro_usd, exposicion_micro_usd, etiqueta, experiment_run_id, arm_id, receipt_event_id
  ) values (
    i.org_id, v_id, i.project_id, i.logical_call_id, i.attempt_id, v_seq, i.estado,
    p_importe, i.exposicion_micro_usd, p_etiqueta, i.experiment_run_id, i.arm_id, i.receipt_event_id
  );
  return v_id;
end
$fn$;

-- Definir o cambiar el tope. Cambiarlo no toca lo comprometido.
create or replace function bvsala.presupuesto_definir(
  p_org uuid, p_project text, p_tope bigint, p_estricto boolean, p_reserva_conservadora bigint default null
) returns void
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
begin
  insert into bvsala.presupuestos_proyecto (org_id, project_id, tope_micro_usd, estricto, reserva_conservadora_micro_usd)
    values (p_org, p_project, p_tope, p_estricto, p_reserva_conservadora)
    on conflict (org_id, project_id) do update set
      tope_micro_usd = excluded.tope_micro_usd,
      estricto = excluded.estricto,
      reserva_conservadora_micro_usd = excluded.reserva_conservadora_micro_usd,
      actualizado_en = now();
end
$fn$;

-- planned → reserved. El importe (la cota del sobre o la política
-- conservadora) llega calculado por el SDK; aquí se ADMITE o no, de forma atómica.
create or replace function bvsala.presupuesto_reservar(
  p_org uuid, p_project text, p_logical_call_id text, p_ordinal integer, p_kind text, p_modelo text,
  p_importe bigint, p_base text, p_huella_sobre text, p_max_intentos integer,
  p_version_precios text default null, p_experiment_run_id text default null, p_arm_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_attempt text := p_logical_call_id || ':a' || p_ordinal::text;
  v_pres    bvsala.presupuestos_proyecto;
  v_prev    bvsala.presupuesto_intentos;
  v_row     bvsala.presupuesto_intentos;
begin
  if p_importe is null or p_importe <= 0 then
    raise exception 'presupuesto_reservar: importe inválido %', p_importe using errcode = '22023';
  end if;
  if p_max_intentos is null or p_max_intentos < 1 then
    raise exception 'presupuesto_reservar: límite de intentos inválido %', p_max_intentos using errcode = '22023';
  end if;

  -- El candado: la fila del presupuesto, ANTES de leer nada.
  select * into v_pres from bvsala.presupuestos_proyecto
    where org_id = p_org and project_id = p_project
    for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_budget');
  end if;

  select * into v_prev from bvsala.presupuesto_intentos
    where org_id = p_org and project_id = p_project and attempt_id = v_attempt;
  if found then
    if v_prev.huella_sobre <> p_huella_sobre then
      raise exception 'presupuesto_reservar: % ya está reservado con otro sobre', v_attempt using errcode = '23505';
    end if;
    return jsonb_build_object('ok', true, 'repeated', true, 'attempt_id', v_attempt,
                              'amount_micro_usd', v_prev.reservado_micro_usd, 'basis', v_prev.base_reserva);
  end if;

  if p_ordinal >= p_max_intentos then
    return jsonb_build_object('ok', false, 'reason', 'attempt_limit');
  end if;
  -- La política conservadora solo existe en un tope no estricto, y por su importe.
  if p_base = 'conservative_policy' and (
       v_pres.estricto or v_pres.reserva_conservadora_micro_usd is distinct from p_importe
     ) then
    return jsonb_build_object('ok', false, 'reason', 'unbounded_envelope');
  end if;

  -- El UPDATE condicional: la admisión entera es esta línea.
  update bvsala.presupuestos_proyecto
     set reservado_micro_usd = reservado_micro_usd + p_importe, actualizado_en = now()
   where org_id = p_org and project_id = p_project
     and gastado_micro_usd + estimado_micro_usd + reservado_micro_usd + incierto_micro_usd + p_importe <= tope_micro_usd;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'cap_exceeded');
  end if;

  insert into bvsala.presupuesto_intentos (
    org_id, project_id, attempt_id, logical_call_id, ordinal, kind, experiment_run_id, arm_id, modelo,
    estado, base_reserva, reservado_micro_usd, exposicion_micro_usd, huella_sobre, version_precios
  ) values (
    p_org, p_project, v_attempt, p_logical_call_id, p_ordinal, p_kind, p_experiment_run_id, p_arm_id, p_modelo,
    'reserved', p_base, p_importe, p_importe, p_huella_sobre, p_version_precios
  ) returning * into v_row;
  perform bvsala.presupuesto_emitir(v_row, p_importe, 'exposure');

  return jsonb_build_object('ok', true, 'repeated', false, 'attempt_id', v_attempt,
                            'amount_micro_usd', p_importe, 'basis', p_base);
end
$fn$;

-- reserved → dispatched. Se llama ANTES del primer byte del cuerpo.
create or replace function bvsala.presupuesto_enviar(
  p_org uuid, p_project text, p_attempt_id text, p_correlacion text default null
) returns void
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_row bvsala.presupuesto_intentos;
begin
  perform 1 from bvsala.presupuestos_proyecto where org_id = p_org and project_id = p_project for update;
  update bvsala.presupuesto_intentos
     set estado = 'dispatched', enviado_en = now(), correlacion_proveedor = coalesce(p_correlacion, correlacion_proveedor)
   where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id and estado = 'reserved'
   returning * into v_row;
  if not found then
    raise exception 'presupuesto_enviar: % no está reservado', p_attempt_id using errcode = '55000';
  end if;
  perform bvsala.presupuesto_emitir(v_row, v_row.exposicion_micro_usd, 'exposure');
end
$fn$;

-- dispatched | uncertain → settled, con el recibo de D02. Idempotente por recibo.
create or replace function bvsala.presupuesto_liquidar(
  p_org uuid, p_project text, p_attempt_id text, p_receipt_event_id text,
  p_coste bigint, p_exact_atto numeric, p_version_precios text, p_dia_precio date, p_huella text,
  p_correlacion text default null
) returns jsonb
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_int   bvsala.presupuesto_intentos;
  v_rec   bvsala.presupuesto_recibos;
  v_row   bvsala.presupuesto_intentos;
begin
  -- Solo se liquida con un precio VERIFICADO (`priced` de D02): lo incierto o
  -- sin precio va por `presupuesto_incierto`. El importe redondeado tiene que
  -- salir del exacto (al más cercano, mitades hacia arriba, como el SDK).
  if p_coste is null or p_coste < 0 or p_exact_atto is null or p_exact_atto < 0
     or p_exact_atto <> trunc(p_exact_atto)
     or p_coste <> floor((p_exact_atto + 500000000000) / 1000000000000) then
    raise exception 'presupuesto_liquidar: el coste % no sale de su importe exacto %', p_coste, p_exact_atto using errcode = '22023';
  end if;
  perform 1 from bvsala.presupuestos_proyecto where org_id = p_org and project_id = p_project for update;
  select * into v_int from bvsala.presupuesto_intentos
    where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
    for update;
  if not found then
    raise exception 'presupuesto_liquidar: intento % desconocido', p_attempt_id using errcode = '55000';
  end if;

  if v_int.estado = 'settled' then
    -- El recibo reintentado: el mismo cuerpo es un no-op; otro, un conflicto.
    select * into v_rec from bvsala.presupuesto_recibos where org_id = p_org and receipt_event_id = p_receipt_event_id;
    if found and v_rec.attempt_id = p_attempt_id and v_rec.huella = p_huella then
      return jsonb_build_object('state', 'settled', 'repeated', true,
                                'cost_micro_usd', v_int.coste_micro_usd, 'receipt_event_id', v_int.receipt_event_id);
    end if;
    raise exception 'presupuesto_liquidar: % ya liquidado con otro recibo', p_attempt_id using errcode = '23505';
  end if;
  if v_int.estado not in ('dispatched', 'uncertain') then
    raise exception 'presupuesto_liquidar: transición inválida % → settled (%)', v_int.estado, p_attempt_id using errcode = '55000';
  end if;

  -- UNIQUE (org, receipt_event_id) y UNIQUE (org, proyecto, intento): un
  -- recibo que ya existe aquí con otro intento revienta en el INSERT.
  insert into bvsala.presupuesto_recibos (
    org_id, receipt_event_id, project_id, attempt_id, coste_micro_usd, exact_atto_usd,
    version_precios, dia_precio, huella
  ) values (
    p_org, p_receipt_event_id, p_project, p_attempt_id, p_coste, p_exact_atto,
    p_version_precios, p_dia_precio, p_huella
  );

  update bvsala.presupuestos_proyecto
     set reservado_micro_usd = reservado_micro_usd - case when v_int.estado = 'uncertain' then 0 else v_int.exposicion_micro_usd end,
         incierto_micro_usd  = incierto_micro_usd  - case when v_int.estado = 'uncertain' then v_int.exposicion_micro_usd else 0 end,
         gastado_micro_usd   = gastado_micro_usd + p_coste,
         actualizado_en      = now()
   where org_id = p_org and project_id = p_project;

  update bvsala.presupuesto_intentos
     set estado = 'settled', exposicion_micro_usd = 0, coste_micro_usd = p_coste,
         receipt_event_id = p_receipt_event_id, version_precios = p_version_precios,
         correlacion_proveedor = coalesce(p_correlacion, correlacion_proveedor),
         motivo_incierto = null, cerrado_en = now()
   where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
   returning * into v_row;
  perform bvsala.presupuesto_emitir(v_row, p_coste, 'verified');

  return jsonb_build_object('state', 'settled', 'repeated', false, 'cost_micro_usd', p_coste,
                            'receipt_event_id', p_receipt_event_id,
                            'exceeded_reservation', p_coste > v_int.reservado_micro_usd);
end
$fn$;

-- reserved | dispatched | uncertain → uncertain. Retiene la exposición:
-- como mínimo lo reservado, y el suelo conocido si lo supera.
create or replace function bvsala.presupuesto_incierto(
  p_org uuid, p_project text, p_attempt_id text, p_motivo text, p_suelo bigint default null
) returns bigint
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_int   bvsala.presupuesto_intentos;
  v_row   bvsala.presupuesto_intentos;
  v_suelo bigint;
  v_expo  bigint;
begin
  if p_suelo is not null and p_suelo < 0 then
    raise exception 'presupuesto_incierto: suelo inválido %', p_suelo using errcode = '22023';
  end if;
  perform 1 from bvsala.presupuestos_proyecto where org_id = p_org and project_id = p_project for update;
  select * into v_int from bvsala.presupuesto_intentos
    where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
    for update;
  if not found or v_int.estado not in ('reserved', 'dispatched', 'uncertain') then
    raise exception 'presupuesto_incierto: % no está abierto', p_attempt_id using errcode = '55000';
  end if;
  v_suelo := case when p_suelo is null and v_int.suelo_micro_usd is null then null
                  else greatest(coalesce(v_int.suelo_micro_usd, 0), coalesce(p_suelo, 0)) end;
  v_expo := greatest(v_int.exposicion_micro_usd, v_int.reservado_micro_usd, coalesce(v_suelo, 0));

  update bvsala.presupuestos_proyecto
     set reservado_micro_usd = reservado_micro_usd - case when v_int.estado = 'uncertain' then 0 else v_int.exposicion_micro_usd end,
         incierto_micro_usd  = incierto_micro_usd  - case when v_int.estado = 'uncertain' then v_int.exposicion_micro_usd else 0 end + v_expo,
         actualizado_en      = now()
   where org_id = p_org and project_id = p_project;

  update bvsala.presupuesto_intentos
     set estado = 'uncertain', exposicion_micro_usd = v_expo, suelo_micro_usd = v_suelo, motivo_incierto = p_motivo
   where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
   returning * into v_row;
  perform bvsala.presupuesto_emitir(v_row, v_expo, 'exposure');
  return v_expo;
end
$fn$;

-- reserved → released, SOLO con prueba de no-envío. Un timeout local no está
-- en la lista, y un intento enviado no se libera nunca: se concilia.
create or replace function bvsala.presupuesto_liberar(
  p_org uuid, p_project text, p_attempt_id text, p_prueba text
) returns void
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_int bvsala.presupuesto_intentos;
  v_row bvsala.presupuesto_intentos;
begin
  if p_prueba is null or p_prueba not in ('abortado_antes_de_enviar', 'rechazado_localmente', 'sin_conexion') then
    raise exception 'presupuesto_liberar: prueba de no-envío insuficiente (%)', coalesce(p_prueba, 'null') using errcode = '22023';
  end if;
  perform 1 from bvsala.presupuestos_proyecto where org_id = p_org and project_id = p_project for update;
  select * into v_int from bvsala.presupuesto_intentos
    where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
    for update;
  if not found or v_int.estado <> 'reserved' then
    raise exception 'presupuesto_liberar: solo se libera un intento reservado y no enviado (%)', p_attempt_id using errcode = '55000';
  end if;

  update bvsala.presupuestos_proyecto
     set reservado_micro_usd = reservado_micro_usd - v_int.exposicion_micro_usd, actualizado_en = now()
   where org_id = p_org and project_id = p_project;
  update bvsala.presupuesto_intentos
     set estado = 'released', exposicion_micro_usd = 0, prueba_no_envio = p_prueba, cerrado_en = now()
   where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
   returning * into v_row;
  perform bvsala.presupuesto_emitir(v_row, 0, 'released');
end
$fn$;

-- uncertain → estimated: una liquidación ETIQUETADA. Nunca 0 y nunca por
-- debajo del suelo conocido; nunca cuenta como coste (ni ahorro) verificado.
create or replace function bvsala.presupuesto_estimar(
  p_org uuid, p_project text, p_attempt_id text, p_importe bigint, p_fuente text
) returns bigint
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  v_int     bvsala.presupuesto_intentos;
  v_row     bvsala.presupuesto_intentos;
  v_importe bigint;
begin
  if p_importe is null or p_importe <= 0 then
    raise exception 'presupuesto_estimar: una estimación es un entero positivo de micro-USD (%)', p_importe using errcode = '22023';
  end if;
  if p_fuente is null or p_fuente = '' then
    raise exception 'presupuesto_estimar: una estimación nombra su fuente' using errcode = '22023';
  end if;
  perform 1 from bvsala.presupuestos_proyecto where org_id = p_org and project_id = p_project for update;
  select * into v_int from bvsala.presupuesto_intentos
    where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
    for update;
  if not found or v_int.estado <> 'uncertain' then
    raise exception 'presupuesto_estimar: solo se estima un intento incierto (%)', p_attempt_id using errcode = '55000';
  end if;
  v_importe := greatest(p_importe, coalesce(v_int.suelo_micro_usd, 0));

  update bvsala.presupuestos_proyecto
     set incierto_micro_usd = incierto_micro_usd - v_int.exposicion_micro_usd,
         estimado_micro_usd = estimado_micro_usd + v_importe,
         actualizado_en     = now()
   where org_id = p_org and project_id = p_project;
  update bvsala.presupuesto_intentos
     set estado = 'estimated', exposicion_micro_usd = 0, estimado_micro_usd = v_importe,
         fuente_estimacion = p_fuente, cerrado_en = now()
   where org_id = p_org and project_id = p_project and attempt_id = p_attempt_id
   returning * into v_row;
  perform bvsala.presupuesto_emitir(v_row, v_importe, 'estimated');
  return v_importe;
end
$fn$;

-- La alerta por antigüedad: los intentos abiertos más viejos que `p_edad`.
-- Un recibo incompleto se queda abierto (nunca se cierra solo) y esto lo
-- enseña para la conciliación manual.
create or replace function bvsala.presupuesto_abiertos(p_org uuid, p_project text, p_edad interval)
returns setof bvsala.presupuesto_intentos
language sql
stable
security definer
set search_path = bvsala, pg_temp
as $fn$
  select * from bvsala.presupuesto_intentos
   where org_id = p_org and project_id = p_project
     and estado in ('reserved', 'dispatched', 'uncertain')
     and reservado_en < now() - p_edad
   order by reservado_en;
$fn$;

-- La outbox, vista por el publicador: lo no entregado, en orden.
create or replace function bvsala.presupuesto_outbox_pendientes(p_org uuid, p_limite integer default 500)
returns setof bvsala.presupuesto_outbox
language sql
stable
security definer
set search_path = bvsala, pg_temp
as $fn$
  select * from bvsala.presupuesto_outbox
   where org_id = p_org and entregado_en is null
   order by project_id, logical_call_id, seq
   limit greatest(1, least(coalesce(p_limite, 500), 5000));
$fn$;

-- Confirmar la entrega. Confirmar dos veces no hace nada la segunda.
create or replace function bvsala.presupuesto_outbox_confirmar(p_org uuid, p_event_ids text[])
returns integer
language plpgsql
security definer
set search_path = bvsala, pg_temp
as $fn$
declare
  n integer;
begin
  update bvsala.presupuesto_outbox
     set entregado_en = now()
   where org_id = p_org and event_id = any (p_event_ids) and entregado_en is null;
  get diagnostics n = row_count;
  return n;
end
$fn$;

-- Ninguna de estas funciones nace invocable por PUBLIC (el defecto de
-- Postgres) ni con la anon key: solo el service role.
revoke all on function bvsala.presupuesto_intentos_transicion() from public, anon, authenticated;
revoke all on function bvsala.presupuesto_recibos_inmutable() from public, anon, authenticated;
revoke all on function bvsala.presupuesto_outbox_inmutable() from public, anon, authenticated;
revoke all on function bvsala.presupuesto_emitir(bvsala.presupuesto_intentos, bigint, text) from public, anon, authenticated, service_role;
revoke all on function bvsala.presupuesto_definir(uuid, text, bigint, boolean, bigint) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_reservar(uuid, text, text, integer, text, text, bigint, text, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_enviar(uuid, text, text, text) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_liquidar(uuid, text, text, text, bigint, numeric, text, date, text, text) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_incierto(uuid, text, text, text, bigint) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_liberar(uuid, text, text, text) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_estimar(uuid, text, text, bigint, text) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_abiertos(uuid, text, interval) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_outbox_pendientes(uuid, integer) from public, anon, authenticated;
revoke all on function bvsala.presupuesto_outbox_confirmar(uuid, text[]) from public, anon, authenticated;

grant execute on function bvsala.presupuesto_definir(uuid, text, bigint, boolean, bigint) to service_role;
grant execute on function bvsala.presupuesto_reservar(uuid, text, text, integer, text, text, bigint, text, text, integer, text, text, text) to service_role;
grant execute on function bvsala.presupuesto_enviar(uuid, text, text, text) to service_role;
grant execute on function bvsala.presupuesto_liquidar(uuid, text, text, text, bigint, numeric, text, date, text, text) to service_role;
grant execute on function bvsala.presupuesto_incierto(uuid, text, text, text, bigint) to service_role;
grant execute on function bvsala.presupuesto_liberar(uuid, text, text, text) to service_role;
grant execute on function bvsala.presupuesto_estimar(uuid, text, text, bigint, text) to service_role;
grant execute on function bvsala.presupuesto_abiertos(uuid, text, interval) to service_role;
grant execute on function bvsala.presupuesto_outbox_pendientes(uuid, integer) to service_role;
grant execute on function bvsala.presupuesto_outbox_confirmar(uuid, text[]) to service_role;

-- RETENCIÓN. La outbox entregada se poda fuera del camino caliente, como
-- usage_ingest_seen en 0009 (los intentos y recibos NO: son el registro):
--
--     delete from bvsala.presupuesto_outbox
--      where entregado_en is not null and entregado_en < now() - interval '30 days';
--
-- Nota: el service role no tiene DELETE sobre la outbox; la poda la corre el
-- propietario (la misma vía de la Management API del runbook).

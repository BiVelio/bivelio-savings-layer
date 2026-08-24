-- 0017 · Los cargos de la comisión — el estado del COBRO, aparte del extracto.
--
-- El extracto (0016) es la MEDICIÓN y es inmutable. El cobro es un PROCESO:
-- tiene estados (facturado, pagado, fallido…) y cambia con los webhooks de
-- Stripe. Mezclarlos habría obligado a hacer UPDATE sobre extractos — justo lo
-- que 0016 prohíbe — así que el proceso vive en su propia tabla, una fila por
-- (org, período), y el extracto queda como el documento que la factura CITA.
--
-- La clave (org, período) es también el candado de idempotencia del cron de
-- facturación: reintentar un mes ya facturado inserta cero filas y no crea una
-- segunda factura. El candado de VERDAD son además las claves de idempotencia
-- de Stripe (`bvsala-cargo-{org}-{período}`): aunque esta tabla se perdiera,
-- Stripe no crearía dos facturas para el mismo período.

create table if not exists bvsala.cargos (
  org_id             uuid not null references bvsala.organizations(id) on delete cascade,
  periodo            text not null check (periodo ~ '^\d{4}-\d{2}$'),
  -- Lo facturado, copiado del extracto EN EL MOMENTO de facturar. Si alguna
  -- vez difiere del extracto es un bug grave, y por eso se guarda: para poder
  -- verlo, no para poder inventarlo (el check de abajo lo ata a >= 0).
  importe_eur        numeric(14,6) not null check (importe_eur >= 0),
  -- El ciclo de vida del cobro. `omitido_*` deja rastro de POR QUÉ un cargo
  -- con importe no se facturó: sin cliente de Stripe, o bajo el mínimo
  -- cobrable. Un hueco sin fila significa "aún no se intentó" — nunca "no toca".
  estado             text not null check (estado in (
                       'facturado', 'pagado', 'fallido',
                       'omitido_sin_cliente', 'omitido_bajo_minimo'
                     )),
  stripe_invoice_id  text unique,
  -- Diagnóstico del último cambio de estado (webhook o cron), para el panel.
  detalle            jsonb not null default '{}'::jsonb,
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now(),
  primary key (org_id, periodo),
  -- Un cargo facturado/pagado/fallido SIEMPRE tiene factura; un omitido, nunca.
  constraint cargos_factura_coherente check (
    (estado in ('facturado','pagado','fallido')) = (stripe_invoice_id is not null)
  )
);

alter table bvsala.cargos enable row level security;

-- Los miembros leen los cargos de su organización (mismo patrón que extractos);
-- escriben solo el cron y el webhook, con service_role.
create policy cargos_read on bvsala.cargos
  for select using (bvsala.is_org_member(org_id));

grant select on bvsala.cargos to authenticated;
grant all    on bvsala.cargos to service_role;

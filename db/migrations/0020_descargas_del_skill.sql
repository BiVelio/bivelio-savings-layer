-- 0020 · Descargas del skill savings-mode, con identidad.
--
-- Decisión del dueño (2026-09-01): la adopción del skill tiene que ser una
-- métrica medible con exactitud. El zip de claude.ai se sirve detrás de la
-- cuenta (gratuita) y cada descarga se registra aquí. El canal npx queda
-- abierto a propósito (npm no se cierra; sus números son agregados).
--
-- Escribe SOLO el service_role desde /api/skill/descargar (fail-open: si esta
-- tabla no existe, la descarga sale igual). Sin grants a `authenticated`: hoy
-- nadie lee esto desde el navegador; cuando el panel quiera enseñarlo, su
-- lectura llegará con política propia en su migración.

create table if not exists bvsala.skill_downloads (
  id            bigint generated always as identity primary key,
  user_id       uuid        not null,
  -- `set null` y no `cascade`: la métrica de adopción sobrevive a la baja de
  -- una organización (queda el user_id); el resto de tablas usan cascade
  -- porque son datos DE la organización — esto es un contador nuestro.
  org_id        uuid        null references bvsala.organizations(id) on delete set null,
  skill         text        not null default 'savings-mode',
  downloaded_at timestamptz not null default now()
);

comment on table bvsala.skill_downloads is
  'Cada descarga autenticada del zip del skill (la métrica de adopción con identidad). Inserta solo service_role; npx queda fuera a propósito.';

alter table bvsala.skill_downloads enable row level security;
-- Sin políticas: service_role las salta; authenticated no ve nada (aún).

create index if not exists skill_downloads_por_dia
  on bvsala.skill_downloads (downloaded_at desc);

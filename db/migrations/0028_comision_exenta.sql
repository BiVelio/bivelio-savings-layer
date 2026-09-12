-- 0028 — probadores y cuentas de cortesía: EXENTOS de la comisión sobre lo ahorrado.
--
-- EL FALLO QUE TAPA: la comisión se factura el día 1 en una factura de Stripe
-- aparte, con cobro automático y un mínimo de 0,50 €. El cupón del 100 % del
-- grupo de probadores solo cubre el asiento, y un probador con cupón no tiene
-- tarjeta: la factura de comisión fallaría, entraría en impagos y a los 14 días
-- de gracia se le revocaría la licencia. Un probador castigado por probar.
--
-- QUÉ HACE: una marca por organización (`comision_exenta`) con su nota, y una
-- marca por extracto (`es_exento`) que obliga a cargo 0, igual que hace
-- `es_calibracion`. El extracto sigue calculando la comisión que HABRÍA sido:
-- el probador ve lo que pagaría, y no paga.
--
-- Quién la pone: el webhook, cuando el checkout termina con total 0 € y un
-- descuento (compra con cupón del 100 %); o el dueño, a mano, para una cuenta
-- de cortesía. Idempotente: correrla dos veces no cambia nada la segunda.

alter table bvsala.organizations
  add column if not exists comision_exenta boolean not null default false,
  add column if not exists exencion_nota   text;

alter table bvsala.extractos
  add column if not exists es_exento boolean not null default false;

alter table bvsala.extractos drop constraint if exists extractos_exento_cobra_cero;
alter table bvsala.extractos
  add constraint extractos_exento_cobra_cero check (not es_exento or cargo_eur = 0);

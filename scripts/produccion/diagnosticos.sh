#!/usr/bin/env bash
# Diagnósticos de SOLO LECTURA contra producción, por la Management API (runbook, regla 3).
# Uso:  TOKEN_FICHERO=<fichero que contiene SOLO el token sbp_…> bash scripts/produccion/diagnosticos.sh
# El token se usa inline y jamás se imprime (regla 0c). Nada de esto escribe en la base.
set -euo pipefail
: "${TOKEN_FICHERO:?pon TOKEN_FICHERO=<ruta del fichero con el token de la Management API>}"
[ -r "$TOKEN_FICHERO" ] || { echo "no puedo leer $TOKEN_FICHERO"; exit 1; }
REF=rsxebsvguppssbociwiu

consulta() {
  jq -Rs '{query:.}' | curl -sf -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" -H "Content-Type: application/json" -d @-
}

echo "== A · orgs con uso en 30 días, SIN licencia y SIN suscripción (las que #314 pasará a bloquear)"
consulta <<'SQL' | jq -r '(if length==0 then "  (ninguna: el cierre del free tier no bloquea a nadie)" else .[] | "  \(.org_id)  \(.peticiones_30d) peticiones  último día \(.ultimo_dia)" end)'
select u.org_id, sum(u.requests) as peticiones_30d, max(u.day) as ultimo_dia
from bvsala.usage_daily u
where u.day >= current_date - 30
  and not exists (select 1 from bvsala.licenses l where l.org_id = u.org_id)
  and not exists (select 1 from bvsala.subscriptions s
                  where s.org_id = u.org_id
                    and s.status in ('active','trialing','past_due')
                    and (s.current_period_end is null or s.current_period_end > now() - interval '3 days'))
group by u.org_id order by peticiones_30d desc;
SQL

echo "== B · licencias vivas (NUNCA se selecciona la columna token)"
consulta <<'SQL' | jq -r '.[] | "  \(.org_id)  \(.plan)  caduca \(.expires_at)  gracia \(.grace_days)d  token:\(.tiene_token)"'
select org_id, plan, expires_at, grace_days, (token is not null) as tiene_token
from bvsala.licenses where revoked = false order by expires_at;
SQL

echo "== C · estado de la migración 0029 (medido por referencia)"
consulta <<'SQL' | jq -r '.[0] | to_entries[] | "  \(.value)\t\(.key)"'
select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='reference_baseline_cost') as columna_0029,
       to_regclass('bvsala.reference_hits') is not null as tabla_0029,
       exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='extractos' and column_name='regla_referencia') as extractos_0029,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0029,
       to_regclass('bvsala.extractos') is not null as base_0016,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                and p.prosrc like '%eliminatedInputFloorCost%') as base_rpc_0025;
SQL

#!/usr/bin/env bash
# Aplica en producción las migraciones pendientes de main (0029, 0030, 0031) siguiendo el runbook:
# diagnóstico → hora para PITR → cada fichero en su propia llamada begin/commit → re-diagnóstico.
# Lee los ficheros de origin/main (lo que revisó la CI), nunca de un checkout local.
# Orden ascendente estricto: 0031 lleva versión de la RPC de ingest; re-ejecutar 0029
# DESPUÉS de 0031 la regresaría en silencio (regla 1 del runbook).
# Uso:  TOKEN_FICHERO=<fichero que contiene SOLO el token sbp_…> bash scripts/produccion/aplicar-migraciones.sh
set -euo pipefail
: "${TOKEN_FICHERO:?pon TOKEN_FICHERO=<ruta del fichero con el token de la Management API>}"
[ -r "$TOKEN_FICHERO" ] || { echo "no puedo leer $TOKEN_FICHERO"; exit 1; }
REF=rsxebsvguppssbociwiu
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
consulta() {
  jq -Rs '{query:.}' | curl -sf -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" -H "Content-Type: application/json" -d @-
}
detector() {  # imprime true/false
  case "$1" in
    0029) consulta <<'SQL' | jq -r '.[0] | [.[]] | all'
select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='reference_baseline_cost') as a,
       to_regclass('bvsala.reference_hits') is not null as b,
       exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='extractos' and column_name='regla_referencia') as c,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as d;
SQL
    ;;
    0030) consulta <<'SQL' | jq -r '.[0].x'
select to_regclass('bvsala.verification_samples') is not null
   and to_regclass('bvsala.verification_daily') is not null
   and to_regprocedure('bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb)') is not null
   and to_regprocedure('bvsala.verification_summary(uuid, date, date)') is not null as x;
SQL
    ;;
    0031) consulta <<'SQL' | jq -r '.[0].x'
select exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='seat_activity' and column_name='reference_baseline_cost')
   and exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                 and p.prosrc like '%reference_hits%' and p.prosrc like '%seat_activity.reference_baseline_cost%') as x;
SQL
    ;;
  esac
}
git -C "$REPO" fetch -q origin
echo "== diagnóstico previo"
PENDIENTES=""
for n in 0029 0030 0031; do
  if ! git -C "$REPO" ls-tree --name-only origin/main db/migrations/ | grep -q "/${n}_"; then echo "  (${n} aún no está en main: se salta)"; continue; fi
  v=$(detector $n); echo "  $v	$n"; [ "$v" = "true" ] || PENDIENTES="$PENDIENTES $n"; done
[ -z "$PENDIENTES" ] && { echo "Nada pendiente."; exit 0; }
echo "== hora para PITR: $(date -u +%Y-%m-%dT%H:%M:%SZ)   pendientes:$PENDIENTES"
for n in $PENDIENTES; do
  f=$(git -C "$REPO" ls-tree --name-only origin/main db/migrations/ | grep "/${n}_" ) || { echo "no encuentro $n en main"; exit 1; }
  echo "── aplicando $f"
  printf 'begin;\n%s\ncommit;\n' "$(git -C "$REPO" show "origin/main:$f")" | consulta >/dev/null \
    || { echo "✗ FALLÓ $f: su transacción se revierte entera. Paro aquí."; exit 1; }
  echo "✓ $f"
done
echo "== diagnóstico posterior"
for n in 0029 0030 0031; do git -C "$REPO" ls-tree --name-only origin/main db/migrations/ | grep -q "/${n}_" && echo "  $(detector $n)	$n" || true; done

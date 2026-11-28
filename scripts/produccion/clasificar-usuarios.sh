#!/usr/bin/env bash
# De quién es cada cuenta del proyecto de Supabase COMPARTIDO: de Savings, de Privacy, de los dos,
# de otro producto (GPOS…) o de ninguno. SOLO LECTURA y SOLO NÚMEROS: de aquí no sale ni un correo,
# ni un id, ni un hash. Es el paso 0 de docs/RUNBOOK-INDEPENDENCIA-DE-PRIVACY.md: antes de separar
# Savings y Privacy hay que saber cuántas cuentas son de cada uno y que ninguna se quede sin dueño.
#
# Uso (producción, lo corre una PERSONA):
#   TOKEN_FICHERO=<fichero con SOLO el token sbp_…> bash scripts/produccion/clasificar-usuarios.sh
# Uso (ensayo contra un Postgres local de pruebas):
#   PSQL_URL=postgres://… bash scripts/produccion/clasificar-usuarios.sh
#
# QUE=cuentas (por defecto)  imprime los recuentos.
# QUE=sql-savings            imprime (sin ejecutarla) la consulta con los ids que hay que copiar si
#                            SAVINGS se va a un proyecto propio: Savings + los que no son de nadie.
# QUE=sql-borrables          imprime (sin ejecutarla) la consulta con los ids que solo son de Privacy:
#                            los ÚNICOS candidatos a borrar de este proyecto cuando Privacy ya esté fuera.
#
# QUÉ CUENTA COMO «DE SAVINGS». Toda columna con clave ajena a auth.users en el esquema bvsala (se
# descubren en el catálogo, no se listan a mano), más tres señales sin clave ajena que el esquema de
# Savings sí tiene: bvsala.skill_downloads.user_id, el correo de una invitación pendiente
# (bvsala.org_invitations.email) y el correo de facturación (bvsala.organizations.billing_email).
# «DE PRIVACY» = toda columna con clave ajena a auth.users en el esquema bvprga. «OTROS» = las de
# cualquier otro esquema menos auth. Una columna de Privacy u otros SIN clave ajena no se ve: por eso
# «ninguno» nunca se borra (ver el runbook).
#
# El token se usa inline y jamás se imprime (regla 0c). Todas las consultas son SELECT.
set -euo pipefail
REF=${REF:-rsxebsvguppssbociwiu}
QUE=${QUE:-cuentas}

if [ -n "${PSQL_URL:-}" ]; then
  # Ensayo local: misma forma de respuesta que la Management API (un array JSON de filas), y la
  # sesión en solo lectura para que ni por error pueda escribir.
  consulta() {
    local sql
    sql=$(cat | sed -e 's/;[[:space:]]*$//')
    PGOPTIONS='-c default_transaction_read_only=on' psql "$PSQL_URL" -X -q -A -t -v ON_ERROR_STOP=1 \
      -c "select coalesce(json_agg(q), '[]'::json) from ($sql) q"
  }
else
  : "${TOKEN_FICHERO:?pon TOKEN_FICHERO=<ruta del fichero con el token de la Management API> (o PSQL_URL para un ensayo local)}"
  [ -r "$TOKEN_FICHERO" ] || { echo "no puedo leer $TOKEN_FICHERO"; exit 1; }
  consulta() {
    jq -Rs '{query:.}' | curl -sf -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
      -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" -H "Content-Type: application/json" -d @-
  }
fi

# 1 · El catálogo: qué columnas apuntan a auth.users, y en qué esquema. Ningún dato de usuario.
COLUMNAS=$(consulta <<'SQL'
select n.nspname as esquema, c.relname as tabla, a.attname as columna
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
where con.contype = 'f'
  and con.confrelid = 'auth.users'::regclass
  and n.nspname <> 'auth'
order by 1, 2, 3
SQL
)

# Las señales de Savings sin clave ajena, solo si existen en esta base (0013, 0004 y 0020 pueden no
# estar aplicadas en un ensayo): una consulta que nombra una tabla que no existe no se puede ni planificar.
EXTRAS=$(consulta <<'SQL'
select to_regclass('bvsala.skill_downloads') is not null as descargas,
       to_regclass('bvsala.org_invitations') is not null as invitaciones,
       exists (select 1 from information_schema.columns
               where table_schema = 'bvsala' and table_name = 'organizations' and column_name = 'billing_email') as facturacion
SQL
)

# «"esquema"."tabla"."columna"» con las comillas dobles escapadas, para cada grupo.
union_de() {  # $1 = filtro jq sobre .esquema
  echo "$COLUMNAS" | jq -r --arg x "$1" '
    def id: "\"" + (gsub("\""; "\"\"")) + "\"";
    [ .[] | select(if $x == "otros" then (.esquema != "bvsala" and .esquema != "bvprga") else .esquema == $x end)
      | "select \(.columna|id) as uid from \(.esquema|id).\(.tabla|id) where \(.columna|id) is not null" ]
    | if length == 0 then "select null::uuid as uid where false" else join("\n    union ") end'
}

S=$(union_de bvsala)
if [ "$(echo "$EXTRAS" | jq -r '.[0].descargas')" = "true" ]; then
  S="$S
    union select user_id from bvsala.skill_downloads where user_id is not null"
fi
if [ "$(echo "$EXTRAS" | jq -r '.[0].invitaciones')" = "true" ]; then
  S="$S
    union select u2.id from auth.users u2 join bvsala.org_invitations i on lower(i.email) = lower(u2.email) where i.accepted_at is null"
fi
if [ "$(echo "$EXTRAS" | jq -r '.[0].facturacion')" = "true" ]; then
  S="$S
    union select u3.id from auth.users u3 join bvsala.organizations o on lower(o.billing_email) = lower(u3.email)"
fi
P=$(union_de bvprga)
O=$(union_de otros)

MARCAS="with s as (
    $S
), p as (
    $P
), o as (
    $O
), marcas as (
  select u.id, u.email_confirmed_at,
         exists (select 1 from s where s.uid = u.id) as de_savings,
         exists (select 1 from p where p.uid = u.id) as de_privacy,
         exists (select 1 from o where o.uid = u.id) as de_otros
  from auth.users u
)"

case "$QUE" in
  sql-savings)
    echo "-- Los ids que hay que copiar si Savings se va a un proyecto propio: Savings + los de nadie."
    echo "$MARCAS"
    echo "select id from marcas where de_savings or not (de_privacy or de_otros)"
    exit 0 ;;
  sql-borrables)
    echo "-- Los ÚNICOS candidatos a borrar cuando Privacy ya esté fuera: solo Privacy, nada de Savings ni de otros."
    echo "$MARCAS"
    echo "select id from marcas where de_privacy and not de_savings and not de_otros"
    exit 0 ;;
  cuentas) ;;
  *) echo "QUE no válido: $QUE (cuentas | sql-savings | sql-borrables)"; exit 1 ;;
esac

echo "== Columnas con clave ajena a auth.users (fuera de auth)"
echo "$COLUMNAS" | jq -r 'if length == 0 then "  (ninguna)" else .[] | "  \(.esquema).\(.tabla).\(.columna)" end'
echo "== Señales de Savings sin clave ajena presentes en esta base"
echo "$EXTRAS" | jq -r '.[0] | "  skill_downloads: \(.descargas)   invitaciones pendientes: \(.invitaciones)   billing_email: \(.facturacion)"'

echo "== Cuentas de auth.users por producto (S = Savings, P = Privacy, O = otros)"
consulta <<SQL | jq -r '
  def m(b; l): if b then l else "-" end;
  (.[] | "  \(m(.de_savings; "S")) \(m(.de_privacy; "P")) \(m(.de_otros; "O"))   \(.cuentas) cuentas (\(.confirmadas) con el correo confirmado)"),
  "  total: \(map(.cuentas) | add // 0)",
  "  a copiar si Savings se va (S, o sin nadie): \(map(select(.de_savings or ((.de_privacy or .de_otros) | not)) | .cuentas) | add // 0)",
  "  candidatas a borrar cuando Privacy esté fuera (solo P): \(map(select(.de_privacy and (.de_savings | not) and (.de_otros | not))) | map(.cuentas) | add // 0)",
  "  sin nadie (NUNCA se borran: pueden ser altas de cualquiera que aún no han hecho nada): \(map(select((.de_savings or .de_privacy or .de_otros) | not)) | map(.cuentas) | add // 0)"'
$MARCAS
select de_savings, de_privacy, de_otros, count(*) as cuentas, count(email_confirmed_at) as confirmadas
from marcas
group by 1, 2, 3
order by 1 desc, 2 desc, 3 desc
SQL

#!/usr/bin/env bash
# De quién es cada cuenta del proyecto de Supabase COMPARTIDO: de Savings, de Privacy, de los dos,
# de otro producto (GPOS…) o de ninguno. SOLO LECTURA y SOLO NÚMEROS: de aquí no sale ni un correo,
# ni un id, ni un hash. Es el paso 0 de docs/RUNBOOK-INDEPENDENCIA-DE-PRIVACY.md: antes de separar
# Savings y Privacy hay que saber cuántas cuentas son de cada uno y que ninguna se quede sin dueño.
# Savings se queda en este proyecto y es Privacy quien se va a uno propio de la misma organización
# (decisión del fundador del 2026-11-28): aquí no se copia ninguna cuenta, solo se cuentan y, al final,
# se dice cuáles se podrían borrar.
#
# Uso (producción, lo corre una PERSONA):
#   TOKEN_FICHERO=<fichero con SOLO el token sbp_…> bash scripts/produccion/clasificar-usuarios.sh
# Uso (ensayo contra un Postgres local de pruebas):
#   PSQL_URL=postgres://… bash scripts/produccion/clasificar-usuarios.sh
#
# QUE=cuentas (por defecto)  imprime los recuentos.
# QUE=sql-borrables          imprime (sin ejecutarla) la consulta con los ids que solo son de Privacy y
#                            que no han entrado en este proyecto desde PRIVACY_FUERA_DESDE=AAAA-MM-DD
#                            (obligatoria): los ÚNICOS candidatos a borrar cuando Privacy ya esté fuera.
# PRIVACY_FUERA_DESDE        (opcional en QUE=cuentas) el día desde el que Privacy ya no usa este
#                            proyecto; con ella, los recuentos separan a quien ha entrado desde entonces.
#
# QUÉ CUENTA COMO «DE SAVINGS». Toda columna con clave ajena a auth.users en el esquema bvsala (se
# descubren en el catálogo, no se listan a mano), más cuatro señales sin clave ajena que el esquema de
# Savings sí tiene: bvsala.skill_downloads.user_id, el correo de una invitación pendiente
# (bvsala.org_invitations.email), el correo de facturación (bvsala.organizations.billing_email) y la
# marca `invitado_por_org` que el alta por invitación pone en los metadatos de la cuenta
# (apps/web/app/api/org/invitations/registrar/route.ts). «DE PRIVACY» = toda columna con clave ajena a
# auth.users en el esquema bvprga. «OTROS» = las de cualquier otro esquema menos auth. Una columna de
# Privacy u otros SIN clave ajena no se ve: por eso «ninguno» nunca se borra (ver el runbook).
#
# LO QUE ESTE SCRIPT NO VE (revisión de #632). Una cuenta de Savings solo deja filas en bvsala cuando
# hace algo: crear su organización (lib/org/resolver.ts la crea al empezar un pago en
# /api/stripe/checkout, al pedir Medir o la prueba y al crear una cuenta de servicio), descargar el
# skill o ser invitada. Darse de alta y entrar en el panel no escribe nada en bvsala. Quien se dio de
# alta en Savings y no hizo nada más, y además tiene filas en bvprga, sale como «solo de Privacy»; si
# las tiene en otro esquema, como «otros». Es justo quien leyó en la web «la misma cuenta te sirve
# aquí». No pierde licencias ni datos de Savings (no tiene), pero si su cuenta se borra, pierde el
# acceso y tiene que darse de alta otra vez. Por eso:
#   · QUE=sql-borrables deja fuera a toda cuenta que haya entrado en este proyecto desde
#     PRIVACY_FUERA_DESDE (auth.users.last_sign_in_at, o una sesión de auth.sessions creada o
#     actualizada desde ese día). Con Privacy ya fuera, quien entra aquí entra en Savings (o en otro
#     producto que siga aquí, y entonces también se queda). Las que no han entrado desde entonces
#     siguen sin distinguirse: borrarlas lo decide el fundador (runbook, A5).
#
# El token se usa inline y jamás se imprime (regla 0c). Todas las consultas son SELECT.
set -euo pipefail
REF=${REF:-rsxebsvguppssbociwiu}
QUE=${QUE:-cuentas}
FUERA=${PRIVACY_FUERA_DESDE:-}

case "$QUE" in
  cuentas | sql-borrables) ;;
  *) echo "QUE no válido: $QUE (cuentas | sql-borrables)"; exit 1 ;;
esac
# La fecha va dentro del SQL: solo AAAA-MM-DD, nada más.
if [ -n "$FUERA" ] && ! [[ $FUERA =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "PRIVACY_FUERA_DESDE tiene que ser una fecha AAAA-MM-DD"; exit 1
fi
if [ "$QUE" = sql-borrables ] && [ -z "$FUERA" ]; then
  echo "QUE=sql-borrables necesita PRIVACY_FUERA_DESDE=AAAA-MM-DD: el día desde el que Privacy ya no usa este proyecto (runbook, A5)"
  exit 1
fi

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

# Las señales sin clave ajena, solo si existen en esta base (0013, 0004 y 0020 pueden no estar
# aplicadas en un ensayo, y el `auth` de un ensayo es de juguete): una consulta que nombra una tabla o
# una columna que no existe no se puede ni planificar.
EXTRAS=$(consulta <<'SQL'
select to_regclass('bvsala.skill_downloads') is not null as descargas,
       to_regclass('bvsala.org_invitations') is not null as invitaciones,
       exists (select 1 from information_schema.columns
               where table_schema = 'bvsala' and table_name = 'organizations' and column_name = 'billing_email') as facturacion,
       exists (select 1 from information_schema.columns
               where table_schema = 'auth' and table_name = 'users' and column_name = 'raw_user_meta_data') as metadatos,
       exists (select 1 from information_schema.columns
               where table_schema = 'auth' and table_name = 'users' and column_name = 'last_sign_in_at') as ultima_entrada,
       (select count(*) = 2 from information_schema.columns
        where table_schema = 'auth' and table_name = 'sessions' and column_name in ('created_at', 'updated_at')) as sesiones
SQL
)
extra() { echo "$EXTRAS" | jq -r ".[0].$1"; }

# «"esquema"."tabla"."columna"» con las comillas dobles escapadas, para cada grupo.
union_de() {  # $1 = filtro jq sobre .esquema
  echo "$COLUMNAS" | jq -r --arg x "$1" '
    def id: "\"" + (gsub("\""; "\"\"")) + "\"";
    [ .[] | select(if $x == "otros" then (.esquema != "bvsala" and .esquema != "bvprga") else .esquema == $x end)
      | "select \(.columna|id) as uid from \(.esquema|id).\(.tabla|id) where \(.columna|id) is not null" ]
    | if length == 0 then "select null::uuid as uid where false" else join("\n    union ") end'
}

S=$(union_de bvsala)
if [ "$(extra descargas)" = "true" ]; then
  S="$S
    union select user_id from bvsala.skill_downloads where user_id is not null"
fi
if [ "$(extra invitaciones)" = "true" ]; then
  S="$S
    union select u2.id from auth.users u2 join bvsala.org_invitations i on lower(i.email) = lower(u2.email) where i.accepted_at is null"
fi
if [ "$(extra facturacion)" = "true" ]; then
  S="$S
    union select u3.id from auth.users u3 join bvsala.organizations o on lower(o.billing_email) = lower(u3.email)"
fi
if [ "$(extra metadatos)" = "true" ]; then
  S="$S
    union select u4.id from auth.users u4 where u4.raw_user_meta_data ->> 'invitado_por_org' is not null"
fi
P=$(union_de bvprga)
O=$(union_de otros)

# ¿Ha entrado en este proyecto desde PRIVACY_FUERA_DESDE? Sin fecha, nadie (y no se usa para nada).
ENTRO="false"
if [ -n "$FUERA" ]; then
  # Falla CERRADA: sin la última entrada no hay forma de saber quién sigue usando la cuenta, y la
  # lista de borrables saldría más larga de lo que es.
  if [ "$(extra ultima_entrada)" != "true" ]; then
    echo "no encuentro auth.users.last_sign_in_at: sin ella no puedo separar a quien ha entrado desde $FUERA"
    exit 1
  fi
  ENTRO="coalesce(u.last_sign_in_at >= date '$FUERA', false)"
  if [ "$(extra sesiones)" = "true" ]; then
    ENTRO="$ENTRO
         or exists (select 1 from auth.sessions se where se.user_id = u.id
                    and greatest(se.created_at, se.updated_at) >= date '$FUERA')"
  fi
fi

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
         exists (select 1 from o where o.uid = u.id) as de_otros,
         ($ENTRO) as entro_despues
  from auth.users u
)"

case "$QUE" in
  sql-borrables)
    echo "-- Candidatos a borrar con Privacy ya fuera: solo Privacy, nada de Savings ni de otros, y sin entrar aquí desde $FUERA. Pueden ser altas de Savings sin actividad: lo decide el fundador (runbook, A5)."
    echo "$MARCAS"
    echo "select id from marcas where de_privacy and not de_savings and not de_otros and not entro_despues"
    exit 0 ;;
esac

echo "== Columnas con clave ajena a auth.users (fuera de auth)"
echo "$COLUMNAS" | jq -r 'if length == 0 then "  (ninguna)" else .[] | "  \(.esquema).\(.tabla).\(.columna)" end'
echo "== Señales sin clave ajena presentes en esta base"
echo "$EXTRAS" | jq -r '.[0] | "  skill_downloads: \(.descargas)   invitaciones pendientes: \(.invitaciones)   billing_email: \(.facturacion)   invitado_por_org: \(.metadatos)",
  "  last_sign_in_at: \(.ultima_entrada)   auth.sessions: \(.sesiones)"'

echo "== Cuentas de auth.users por producto (S = Savings, P = Privacy, O = otros${FUERA:+, E = ha entrado desde $FUERA})"
consulta <<SQL | jq -r --arg fuera "$FUERA" '
  def m(b; l): if b then l else "-" end;
  def suma(f): map(select(f) | .cuentas) | add // 0;
  (.[] | "  \(m(.de_savings; "S")) \(m(.de_privacy; "P")) \(m(.de_otros; "O"))\(if $fuera != "" then " " + m(.entro_despues; "E") else "" end)   \(.cuentas) cuentas (\(.confirmadas) con el correo confirmado)"),
  "  total: \(suma(true))",
  "  sin rastro de Savings pero con filas de Privacy u otros (pueden ser altas de Savings sin actividad; el script NO las distingue): \(suma((.de_savings | not) and (.de_privacy or .de_otros)))",
  "  solo P (sin Savings ni otros): \(suma(.de_privacy and (.de_savings | not) and (.de_otros | not)))",
  (if $fuera != "" then
     "    · de ellas, han entrado desde \($fuera) y se quedan: \(suma(.de_privacy and (.de_savings | not) and (.de_otros | not) and .entro_despues))",
     "    · candidatas a borrar (QUE=sql-borrables): \(suma(.de_privacy and (.de_savings | not) and (.de_otros | not) and (.entro_despues | not)))"
   else
     "    · candidatas a borrar: pon PRIVACY_FUERA_DESDE=AAAA-MM-DD para contarlas (runbook, A5)"
   end),
  "  sin nadie (NUNCA se borran: pueden ser altas de cualquiera que aún no han hecho nada): \(suma((.de_savings or .de_privacy or .de_otros) | not))"'
$MARCAS
select de_savings, de_privacy, de_otros, entro_despues, count(*) as cuentas, count(email_confirmed_at) as confirmadas
from marcas
group by 1, 2, 3, 4
order by 1 desc, 2 desc, 3 desc, 4 desc
SQL

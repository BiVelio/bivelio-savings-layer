# Runbook — migraciones 0007–0017 en producción (+ anexos 0024/0025 … 0032)

**Escrito el 2026-08-26.** Estado de partida conocido: 0001–0006 aplicadas
(bitácoras de julio), 0012 **confirmada** aplicada (verificación del 2026-08-11
vía Management API). Las demás —0007–0011 y 0013–0017— están *sin verificar*:
los PR #112 y #119 las dejaron «escritas y esperando» la autorización del dueño.

**Por qué corre prisa:** los crons `cierre-extractos` (día 1, 05:00) y
`facturar-extractos` (día 1, 07:00) ya están desplegados y armados en Vercel.
Sin `bvsala.extractos` (0016) y `bvsala.cargos` (0017), el 1 de septiembre
fallarán con error de tabla — alertado, pero sin extractos ni facturas.

---

## Las reglas antes de tocar nada

1. **Diagnóstico primero, aplicar después.** Nunca «re-ejecutar todo por si
   acaso»: 0009, 0010 y 0015 llevan **cada una su versión** de
   `bvsala.ingest_usage_batch` (`CREATE OR REPLACE`). Re-ejecutar una vieja
   después de una nueva **regresa la RPC** en silencio — el ingest volvería a
   escribir sin las columnas de tokens y el dashboard mediría de menos.
2. **Orden ascendente estricto**, y solo las que falten. Si el diagnóstico da
   un estado raro (falta una intermedia pero una posterior está), **parar** y
   entender por qué antes de seguir.
3. **La vía es la Management API** (`api.supabase.com`), no la CLI de Supabase
   (apunta al stack local) ni `psql` con `DATABASE_URL` (deja la credencial en
   el historial del shell). Proyecto: `rsxebsvguppssbociwiu`.
4. **El token no se imprime jamás.** Se usa inline —
   `-H "Authorization: Bearer $(cat "$TOKEN_FICHERO")"` — y ese fichero no se
   abre, no se copia, no se pega en ningún sitio.
5. **La base de datos es COMPARTIDA.** Todo lo nuestro vive en el esquema
   `bvsala`; ninguna migración toca `public` ni instala extensiones (0013
   evita `citext` a propósito por esto). Cualquier SQL que se escriba a mano
   durante una incidencia respeta lo mismo.
6. **Anota la hora antes de aplicar** (para el punto de restauración PITR de
   Supabase). Dicho esto, las once son aditivas: ningún `DROP` de datos.

---

## Paso 1 — Diagnóstico (solo lectura)

```bash
TOKEN_FICHERO=~/Documents/Secrets/<el-token-de-la-management-api>
REF=rsxebsvguppssbociwiu

cat > /tmp/diagnostico.sql <<'SQL'
select m.mig, m.aplicada from (values
  ('0007 privilegios',        not has_function_privilege('anon','bvsala.ingest_usage_batch(uuid, jsonb)','execute')),
  ('0008 dominio usage_daily',exists (select 1 from pg_constraint where conrelid='bvsala.usage_daily'::regclass and conname='usage_daily_no_negatives')),
  ('0009 idempotencia ingest',to_regclass('bvsala.usage_ingest_seen') is not null),
  ('0010 medido vs estimado', exists (select 1 from pg_constraint where conrelid='bvsala.usage_daily'::regclass and conname='usage_daily_measured_no_negatives')),
  ('0011 fix calls check',    exists (select 1 from pg_constraint where conrelid='bvsala.usage_daily'::regclass and conname='usage_daily_calls_add_up' and pg_get_constraintdef(oid) like '%2 * requests%')),
  ('0012 orden eventos stripe',exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='subscriptions' and column_name='last_event_at')),
  ('0013 identidad de la org',to_regclass('bvsala.org_invitations') is not null and exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='organizations' and column_name='owner_user_id')),
  ('0014 transferencia',      to_regprocedure('bvsala.transferir_propiedad(uuid, uuid, text)') is not null),
  ('0015 tokens gastados',    exists (select 1 from pg_constraint where conrelid='bvsala.usage_daily'::regclass and conname='usage_daily_token_totals_no_negatives')),
  ('0016 extractos',          to_regclass('bvsala.extractos') is not null),
  ('0017 cargos',             to_regclass('bvsala.cargos') is not null),
  ('0033 licencia Medir',     to_regclass('bvsala.medir_altas') is not null and to_regclass('bvsala.licenses_una_medir_viva_por_org') is not null),
  ('0029 medido por referencia', to_regclass('bvsala.reference_hits') is not null),
  ('0030 tu propio banco', to_regclass('bvsala.verification_samples') is not null and to_regclass('bvsala.verification_daily') is not null and to_regprocedure('bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb)') is not null and to_regprocedure('bvsala.verification_summary(uuid, date, date)') is not null),
  ('0031 referencia por asiento', exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='seat_activity' and column_name='reference_baseline_cost')),
  ('0032 ahorro nativo', exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='native_cache_read_savings')),
  ('RPC en version final (0032)', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch' and p.prosrc like '%reference_hits%' and p.prosrc like '%seat_activity.reference_baseline_cost%' and p.prosrc like '%nativeCacheReadSavings%'))
) as m(mig, aplicada) order by 1;
SQL

jq -Rs '{query:.}' < /tmp/diagnostico.sql | curl -sf \
  -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" \
  -H "Content-Type: application/json" -d @- | jq -r '.[] | "\(.aplicada)\t\(.mig)"'
```

Interpretación fila a fila — el detector de cada una es el objeto que solo esa
migración crea:

| Migración | Detector | Nota |
|---|---|---|
| 0007 | `anon` **sin** execute sobre la RPC de ingest | Heurístico: los privilegios no dejan otra huella. Ante la duda, 0007 es la única que **sí** puede re-ejecutarse siempre: solo `revoke`/`grant`, sin efectos de versión |
| 0008 | check `usage_daily_no_negatives` | |
| 0009 | tabla `usage_ingest_seen` | Lleva versión de la RPC — regla 1 |
| 0010 | check `usage_daily_measured_no_negatives` | Lleva versión de la RPC — regla 1 |
| 0011 | `usage_daily_calls_add_up` con `2 * requests` en la definición | La versión vieja (0008) del mismo check no lleva el `2 *` |
| 0012 | columna `subscriptions.last_event_at` | Ya confirmada el 11-08; debería salir `true` |
| 0013 | tabla `org_invitations` + columna `organizations.owner_user_id` | |
| 0014 | función `transferir_propiedad` | |
| 0015 | check `usage_daily_token_totals_no_negatives` | Lleva versión de la RPC — regla 1 (fue la final de este lote; hoy la final es la de 0031: fila «RPC final») |
| 0016 | tabla `extractos` | La que necesita el cron del día 1 a las 05:00 |
| 0017 | tabla `cargos` | La que necesita el cron del día 1 a las 07:00 |
| 0029 | tabla `reference_hits` | El carril medido por referencia (anexo 0029). Lleva versión de la RPC — regla 1 |
| 0030 | tablas `verification_samples` y `verification_daily` + funciones `ingest_verification_batch` y `verification_summary` | «Tu propio banco» (anexo 0030). Aditiva; **no** lleva versión de la función de uso: el orden respecto a 0029 y a 0031 da igual |
| 0031 | columna `seat_activity.reference_baseline_cost` | Lo medido por referencia, también por asiento (anexo 0031, al final). Lleva versión de la RPC — regla 1 |
| 0032 | columna `usage_daily.native_cache_read_savings` + check `usage_daily_native_no_negatives` | El ahorro nativo de la caché del proveedor, aparte y sin comisión (anexo 0032, al final). Lleva versión de la RPC — regla 1 |
| RPC final | el fuente de `ingest_usage_batch` menciona `reference_hits`, `seat_activity.reference_baseline_cost` **y** `nativeCacheReadSavings` | La versión **final** de la RPC es la de 0032 (antes lo fue la de 0015, luego 0024, 0025, 0029 y 0031). Si 0032 sale `true` pero esto sale `false`, alguien regresó la RPC: re-aplicar **solo** el bloque de función de 0032 |

## Paso 2 — Aplicar lo que falte, en orden

Editar la lista `PENDIENTES` con **exactamente** las que el diagnóstico marcó
`false`, en orden ascendente, y ejecutar. Cada fichero viaja en su propia
llamada envuelto en `begin`/`commit`: o entra entero o no entra (el aviso
«there is already a transaction in progress», si aparece, es inofensivo — el
endpoint ya la había abierto). El bucle **para en el primer fallo**.

```bash
PENDIENTES="0007 0008 0009 0010 0011 0013 0014 0015 0016 0017"   # ← EDITAR según el diagnóstico

cd db/migrations
for n in $PENDIENTES; do
  f=$(ls ${n}_*.sql) || exit 1
  echo "── aplicando $f"
  printf 'begin;\n%s\ncommit;\n' "$(cat "$f")" | jq -Rs '{query:.}' | curl -sf \
    -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" \
    -H "Content-Type: application/json" -d @- \
    || { echo "✗ FALLÓ $f — parar aquí, no seguir con las siguientes"; exit 1; }
  echo "✓ $f"
done
```

### Fallos esperables, y qué significan

- **0013 aborta con «ABORTADA: N organizacion(es) sin owner_user_id»** — ese
  aborto es el resultado *bueno*: la migración se niega a dejar organizaciones
  ingobernables. Arreglar los datos (cada org necesita exactamente una fila
  `role='owner'` en `bvsala.org_members`), y volver a lanzar 0013 — es
  re-ejecutable: el backfill solo toca filas con `owner_user_id is null`.
- **«constraint … already exists» en 0008/0010/0015** — el diagnóstico dijo
  `false` pero el objeto está: estado mixto (una aplicación anterior a medias,
  de antes de envolver en transacción). Parar y comparar a mano qué
  instrucciones de ese fichero faltan; no relanzar el fichero entero.
- **«policy … already exists» en 0016/0017** — mismo caso: la tabla entró y la
  política también, pero algo posterior falló. Mirar qué `grant` falta.

## Paso 3 — Verificar

1. **Re-lanzar el diagnóstico del paso 1**: todas `true`, incluida la fila de
   la RPC final.
2. **Ejercitar los crons sin esperar al día 1**, desde el panel de Vercel
   (proyecto `bivelio-savings-web` → Cron Jobs → Run), que no exige manejar
   `CRON_SECRET` a mano:
   - `invariantes` — el vigilante; debe terminar 200 y sin alertas nuevas.
   - `cierre-extractos` — cierra **julio** (el mes anterior; el intento del 1
     de agosto falló por tabla inexistente, así que esto es el atraso
     legítimo). Idempotente: relanzarlo no reescribe extractos cerrados.
   - `facturar-extractos` — con 0 suscripciones reales no factura nada; los
     saltos («sin cliente de Stripe», «bajo mínimo») quedan con causa
     registrada, nunca en silencio.
3. El siguiente ciclo automático de `invariantes` (cada 6 h) es la red de
   seguridad: si algo quedó incoherente, alerta él.

---

## Añadido 2026-09-07 — 0024, el canal de versión (con 0021–0023 delante)

0024 añade a `bvsala.seat_activity` cinco columnas (`client_version_min`,
`client_version_max`, `requests_sin_version`, `measured_baseline_cost`,
`measured_actual_cost`), el helper `bvsala.semver_key(text)` y **otra versión
de `ingest_usage_batch`**: el cuerpo de 0022 entero con un solo upsert distinto.
Lo que se juega aquí es la RPC, no las columnas, así que las reglas que pesan:

- **Regla 1, explícita para 0024:** lleva versión de la RPC. Re-ejecutar 0022
  (o 0015/0010/0009) DESPUÉS de 0024 la regresa **en silencio**: dejan de
  sellarse versiones y de acumularse el dinero por asiento, y el panel lo pinta
  como «sin declarar» — indistinguible de «nadie ha actualizado el gateway».
  La siguiente migración que toque la RPC (0025) copia el cuerpo de **0024**,
  no el de 0022.
- **Regla 6:** anota la hora antes (PITR). 0024 es aditiva (sin DROP ni CHECK
  nuevo: un CHECK que fallase revertiría el lote entero, lección de 0011), pero
  la RPC se sustituye entera.
- **0024 ABORTA sola** si no encuentra la base 0021/0022 (guard al principio
  del fichero, antes de tocar nada): ese aborto es el resultado *bueno*.
  Aplicar 0021/0022 en orden y volver a lanzar 0024.
- **0023 no deja objeto**: es un `update bvsala.licenses` (relleno de
  `context_elision` y `cache_ttl_tuning` en las licencias pro vivas). No se
  detecta por esquema; se comprueba por DATOS (fila «0023» de abajo) y es
  idempotente: relanzarla no cambia nada la segunda vez.

### Diagnóstico (solo lectura)

```bash
cat > /tmp/diagnostico-0024.sql <<'SQL'
select m.mig, m.aplicada from (values
  ('0021 carril sombra',   exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='shadow_requests')),
  ('0022 uso por modelo',  to_regclass('bvsala.usage_daily_by_model') is not null),
  ('0023 features pro (por datos: 0 licencias pro vivas sin cache_ttl_tuning)',
                           not exists (select 1 from bvsala.licenses
                                        where plan = 'pro' and not revoked
                                          and expires_at + make_interval(days => coalesce(grace_days, 0)) >= now()
                                          and not (coalesce(features, array[]::text[]) @> array['context_elision', 'cache_ttl_tuning']))),
  ('0024 columnas',        exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='seat_activity' and column_name='client_version_min')),
  ('0024 semver_key',      to_regprocedure('bvsala.semver_key(text)') is not null),
  ('RPC en versión 0024',  exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch' and p.prosrc like '%clientVersion%')),
  ('RPC conserva 0022',    exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch' and p.prosrc like '%usage_daily_by_model%'))
) as m(mig, aplicada) order by 1;
SQL

jq -Rs '{query:.}' < /tmp/diagnostico-0024.sql | curl -sf \
  -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" \
  -H "Content-Type: application/json" -d @- | jq -r '.[] | "\(.aplicada)\t\(.mig)"'
```

| Fila | Qué significa |
|---|---|
| 0021 / 0022 `false` | Falta la base: aplicar en orden ANTES de 0024 (y 0024 abortaría igual por el guard) |
| 0023 `false` | Hay licencias pro vivas sin los dos features: relanzar 0023 (idempotente) |
| 0024 columnas `true` pero RPC 0024 `false` | Alguien regresó la RPC (regla 1): re-aplicar **solo** el bloque `create or replace function bvsala.ingest_usage_batch` de 0024 |
| RPC 0024 `true` y RPC conserva 0022 `false` | Imposible si 0024 se aplicó del fichero (su cuerpo incluye el fold por modelo): parar y comparar el fuente de la función con el fichero |

### Aplicar

El bucle del paso 2 con `PENDIENTES="0024"` (o `"0021 0022 0023 0024"`, según el
diagnóstico), tras anotar la hora. Orden de despliegue completo del canal: esta
migración → `vercel --prod` desde la raíz del repo (la web sella
`clientVersion` y el panel lee las columnas) → npm con la cabecera. Ninguna
permutación rompe (cabecera ignorada por una web vieja; clave ignorada por la
RPC 0022; columnas ausentes toleradas por el lector del panel), pero este orden
evita ventanas de «sin declarar».

### Verificar tras el deploy, con el primer lote real

```sql
select seat_id, day, client_version_min, client_version_max, requests_sin_version,
       measured_baseline_cost - measured_actual_cost as ahorro_medido
  from bvsala.seat_activity
 where org_id = '<org>'
 order by day desc, last_seen_at desc
 limit 5;
```

Lo esperable: un gateway con la cabecera deja `client_version_min = client_version_max
= 'gateway/x.y.z'` y `requests_sin_version = 0`; un gateway anterior al canal
en la MISMA máquina sube `requests_sin_version` en la MISMA fila sin borrar el
min/max (un NULL nunca pisa un valor guardado); `ahorro_medido > 0` solo si la
rebaja de TTL actuó ese día. En los logs de Vercel de `/api/metering/usage`
durante la ventana: 0 × 400 y 0 × 500.

## Anexo — 0024 y 0025 (septiembre de 2026): dos versiones de la RPC, en orden

Las dos llevan **cada una su versión** de `bvsala.ingest_usage_batch`
(regla 1). 0025 se escribió copiando el cuerpo ENTERO de 0024 (no el de 0022):
`test/migracion-0025.test.ts` lo compara línea a línea. Consecuencias:

- **Orden:** 0024 → 0025, en la misma sesión de Management API, ascendente.
  Las dos llevan guard de precondición y ABORTAN si falta la base (0022 para
  0024; 0024 para 0025) — ese aborto es el resultado *bueno*.
- **Regla 1, literal:** re-ejecutar 0024 DESPUÉS de 0025 **regresa la RPC** en
  silencio: dejan de acumularse `eliminated_floor_cost` y
  `eliminated_credited_requests`, la tarjeta «Borrado del proveedor» desaparece
  del panel y nadie ve un error. Si pasa, re-aplicar **solo** el bloque de
  función de 0025.
- **Diagnóstico (solo lectura)** — las TRES deben salir `true`; la última exige
  a la vez la pieza de 0024 y la de 0025 en la RPC viva:

```sql
select exists(select 1 from information_schema.columns
              where table_schema='bvsala' and table_name='seat_activity'
                and column_name='client_version_min')                      as columna_0024,
       exists(select 1 from information_schema.columns
              where table_schema='bvsala' and table_name='usage_daily'
                and column_name='eliminated_floor_cost')                   as columna_0025,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                and p.prosrc like '%clientVersion%'
                and p.prosrc like '%eliminatedInputFloorCost%')            as rpc_0024_y_0025;
```

- **Despliegue (doctrina de emitter.ts: un 4xx del ingest descarta el lote sin
  reintento):** migraciones → `vercel --prod` desde la raíz (la lista blanca
  acepta `eliminatedInputFloorCost` como OPCIONAL; un gateway 0.4.16 sigue en
  202) → SOLO ENTONCES `npm publish` de un gateway que emita el campo (B2).
  Migración antes que web no es obligatorio para no romper (la RPC de 0022/0024
  ignora la clave: solo se PIERDE el dólar hasta aplicarla); **web antes que
  npm SÍ**.
- **Verificación post-deploy sin gateway nuevo:** los lotes de los gateways
  0.4.16 siguen en 202 (ningún 400/500 en los logs de Vercel); la tarjeta
  «Borrado del proveedor» NO aparece (0 acreditadas); VerdictHero y extracto
  idénticos a antes.

## Anexo — 0027 (septiembre de 2026): la palanca D (esfuerzo por turno) entra en el plan PRO

Relleno calcado de **0023** y **0026**, misma razón y misma forma. El literal es
`per_turn_effort` y ya viaja en `PRO_FEATURES`; las licencias pro YA EMITIDAS
necesitan este `update` o quien paga y la enciende
(`BVSALA_GATEWAY_ESFUERZO=low`) verá el cuerpo pasar intacto sin ningún error.

**Qué hace la palanca.** Añade al FINAL de `messages` un mensaje `role: "system"`
con `output_config.effort`, más la beta `mid-conversation-output-config-2026-07-01`.
Es la primera que llega a la **salida**, que es lo único que paga precio de lista
($486,06 de $3.959,73, con el pensamiento en el 37,7 %), y la primera que **no
paga peaje de caché**: cambiar `output_config` en la RAÍZ invalidaría la caché de
mensajes —la trampa que mató a la poda, a la elisión y al patrón de
`context-mode`—, pero un mensaje añadido no reescribe nada anterior.

- **No deja objeto**: se comprueba por DATOS, idempotente.
- **Orden**: independiente de 0024/0025/0026 (no toca la RPC). Puede ir sola.
- **Web antes que npm**: la palanca la ejerce el gateway; la web solo tiene que
  servir el feature por `/api/org/entitlements`, que ya lo hace.

### Diagnóstico (solo lectura)

```sql
select not exists (select 1 from bvsala.licenses
                    where plan = 'pro' and not revoked
                      and expires_at + make_interval(days => coalesce(grace_days, 0)) >= now()
                      and not (coalesce(features, array[]::text[]) @> array['per_turn_effort']))
       as "0027 aplicada (0 licencias pro vivas sin per_turn_effort)";
```

`false` → hay licencias pro vivas sin el feature: lanzar 0027 con el bucle del
paso 2 (`PENDIENTES="0027"`). Relanzarla no cambia nada la segunda vez.

### Verificar tras aplicar

Un gateway con `BVSALA_GATEWAY_ESFUERZO=low` de una org pro dice al arrancar
`esfuerzo por turno (D): ARMADO a "low"`. La primera petición a `claude-fable-5-1`,
`claude-mythos-5-1` o `claude-opus-5` llega al proveedor con un mensaje
`{"role":"system","content":[],"output_config":{"effort":"low"}}` al final y la
beta en la cabecera. **Cualquier otro modelo pasa intacto**, `claude-fable-5`
incluido: ahí es un 400.

⚠️ **La beta podía estar en acceso limitado.** Si la org no lo tiene, el
proveedor devuelve 400 — y el gateway **reenvía la petición intacta una vez**
(el mismo reintento que protege a la palanca C), así que el cliente no ve el
fallo. Si eso pasa, aparece en el log: «el upstream rechazó (400) la petición
reescrita (esfuerzo por turno); se reenvía intacta».

---

## Anexo — 0026 (septiembre de 2026): la palanca C entra en el plan PRO

Relleno calcado de **0023**, misma razón y misma forma: la palanca C (servir
`claude-fable-5` con `claude-fable-5-1`, misma entrada/salida/primas y la
lectura de caché a 0,00025/1K en vez de 0,001/1K, catálogo) se cierra con el
feature per-org `sibling_model_routing`. El literal ya viaja en PRO_FEATURES
(`apps/web/lib/license/issue.ts`) para lo que se emita a partir de ahora; las
licencias pro YA EMITIDAS necesitan este `update` o el cliente que paga y la
enciende (`BVSALA_GATEWAY_MODELO_HERMANO=1`) verá el cuerpo pasar intacto sin
ningún error (el canal es fail-closed a apagado).

- **No deja objeto**: se comprueba por DATOS, idempotente.
- **Orden**: independiente de 0024/0025 (no toca la RPC). Puede ir sola.
- **Web antes que npm**: la palanca la ejerce el gateway; la web solo tiene que
  servir el feature por `/api/org/entitlements`, que ya lo hace (lee la fila).

### Diagnóstico (solo lectura)

```sql
select not exists (select 1 from bvsala.licenses
                    where plan = 'pro' and not revoked
                      and expires_at + make_interval(days => coalesce(grace_days, 0)) >= now()
                      and not (coalesce(features, array[]::text[]) @> array['sibling_model_routing']))
       as "0026 aplicada (0 licencias pro vivas sin sibling_model_routing)";
```

`false` → hay licencias pro vivas sin el feature: lanzar 0026 con el bucle del
paso 2 (`PENDIENTES="0026"`). Relanzarla no cambia nada la segunda vez.

### Verificar tras aplicar

**Encender y apagar C entre hilos, nunca a mitad de uno.** Los bloques de
razonamiento van firmados por el modelo que los produjo y la atadura es de un
solo sentido: fable-5-1 lee los de fable-5 (subir a C no pierde nada), pero
fable-5 **no** lee los de 5.1. Si C deja de aplicarse a mitad de una
conversación — la licencia caduca, se quita la bandera, o una petición cae por
la verja de `tool_choice` o por el reintento intacto — el proveedor descarta los
bloques de 5.1 de esa petición (sin cobrarlos y sin error) y el prefijo de caché
cambia desde ahí: cuesta una escritura fría y el modelo replanifica sin ese
razonamiento. Nada se rompe, pero es la razón de que la palanca se mueva entre
sesiones.

Un gateway con `BVSALA_GATEWAY_MODELO_HERMANO=1` de una org pro dice al
arrancar `modelo hermano (C): ARMADO` (sin la fila, la primera petición a
fable-5 avisa una vez de que la licencia no trae `sibling_model_routing` y
pasa intacta) y la primera petición con `model: claude-fable-5` llega al
proveedor como `claude-fable-5-1`; en el panel el registro trae
`basis = measured` y `baselineCost − actualCost` = lectura de caché ×
(0,001 − 0,00025)/1K exactos, con los precios del catálogo del momento.

---

*Relacionado: `db/README.md` (esquema y aislamiento), `docs/RUNBOOK-ALERTAS.md`
(qué hacer cuando `invariantes` habla), PR #112 y #119 (origen de 0016/0017).*

## Anexo — 0028 (septiembre de 2026): exentos de comisión (probadores y cortesías)

El webhook marca la exención SOLO con cupón «forever» al 100 %; un cupón del
100 % de un solo mes deja el primer checkout a 0 € y ese cliente paga después.

Añade `organizations.comision_exenta` + `exencion_nota` y `extractos.es_exento`
(con el check `extractos_exento_cobra_cero`). El webhook marca la exención
cuando un checkout termina a 0 € con descuento; el cierre del día 1 pone cargo 0
a las marcadas. **Orden:** aplicar ANTES de desplegar el código que la usa (el
cierre inserta `es_exento` y el webhook actualiza `comision_exenta`).

### Diagnóstico (solo lectura)

```sql
select exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='organizations' and column_name='comision_exenta') as columna_org,
       exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='extractos' and column_name='es_exento') as columna_extracto,
       exists (select 1 from pg_constraint where conrelid='bvsala.extractos'::regclass and conname='extractos_exento_cobra_cero') as check_exento;
```

`false` en cualquiera → lanzar 0028 con el bucle del paso 2 (`PENDIENTES="0028"`).
Idempotente.

### Marcar una cortesía a mano

```sql
update bvsala.organizations set comision_exenta = true, exencion_nota = 'cortesía · <quién y por qué>' where id = '<org_id>';
```


## Añadido 2026-09-13 — 0018, 0019 y 0020: las tres que el diagnóstico no miraba

Las tres entraron por los PR #128, #169 y #182 con un «aplicar tras el merge» y
sin constancia posterior; el diagnóstico de arriba salta de 0017 a 0021, así que
un `false` en cualquiera de ellas no lo habría cazado nadie. Lo que cada una
crea y cómo se detecta:

| Migración | Objeto que solo ella crea | Si sale `false` |
|---|---|---|
| 0018 | índice único `licenses_una_viva_por_periodo` | El candado contra la doble emisión de licencia no existe: dos manejadores de Stripe en ráfaga pueden emitir dos |
| 0019 | tabla `usage_sessions` **y** la RPC escribiendo en ella | Sin la tabla, la atribución por sesión y subagente no existe; con la tabla pero sin la RPC, alguien regresó `ingest_usage_batch` (regla 1) |
| 0020 | tabla `skill_downloads` | Las descargas del skill no se registran; la ruta de descarga fallaría al insertar |

### Diagnóstico (solo lectura)

```bash
cat > /tmp/diagnostico-0018-0020.sql <<'SQL'
select m.mig, m.aplicada from (values
  ('0018 licencias sin duplicados', to_regclass('bvsala.licenses_una_viva_por_periodo') is not null),
  ('0019 usage_sessions',           to_regclass('bvsala.usage_sessions') is not null),
  ('0019 RPC escribe sesiones',     exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch' and p.prosrc like '%usage_sessions%')),
  ('0020 skill_downloads',          to_regclass('bvsala.skill_downloads') is not null)
) as m(mig, aplicada) order by 1;
SQL

jq -Rs '{query:.}' < /tmp/diagnostico-0018-0020.sql | curl -sf \
  -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
  -H "Authorization: Bearer $(cat "$TOKEN_FICHERO")" \
  -H "Content-Type: application/json" -d @- | jq -r '.[] | "\(.aplicada)\t\(.mig)"'
```

- **Regla 1, explícita para 0019:** lleva su versión de `ingest_usage_batch`.
  Las versiones posteriores (0022, 0024) la incluyen; si «0019 RPC escribe
  sesiones» sale `false` con «RPC en versión 0024» en `true`, alguien aplicó
  0019 y 0024 en orden inverso o regresó la función: re-aplicar **solo** el
  bloque `create or replace function bvsala.ingest_usage_batch` de la migración
  más alta aplicada, nunca el de 0019 a secas.
- `false` en 0018 o 0020 → el bucle del paso 2 con `PENDIENTES="0018"` o
  `"0020"`. Las tres son idempotentes (`if not exists`).

## Anexo — 0033 (septiembre de 2026): la licencia Medir

> Va aquí y no al final para no pisar el anexo de 0032 (#412); en el orden de
> aplicación es la **última**: 0029 → 0030 → 0031 → 0032 → **0033**.

La licencia gratuita «Medir» (plan `measure`, `docs/LICENCIA-MEDIR.md`). 0033:

- admite `measure` en el CHECK de `licenses.plan`;
- el índice único parcial `licenses_una_medir_viva_por_org` (una Medir viva por
  organización);
- la tabla `medir_altas` (PK `user_id`, `org_id` único, dominio del correo,
  `bloqueada`), solo para el service role.

**No toca `ingest_usage_batch` ni `usage_daily`**: no lleva versión de la RPC, así
que no puede regresar la de 0032 (regla 1 intacta) y el orden respecto a ella no
cambia el resultado. Aun así **exige 0032 aplicada** —su columna
`usage_daily.native_cache_read_savings` y su versión de la RPC— y ABORTA sin ella,
como 0032 exige 0031: el guard fija el orden ascendente estricto (regla 2).
`test/migracion-0033.test.ts` lo comprueba.

- **Orden de producción completo:** 0029 → 0030 → 0031 → 0032 → **0033** →
  `vercel --prod` (alta Medir, ingesta con topes, vuelta a Medir al cancelar) →
  SOLO ENTONCES el npm (SDK y pasarela en sombra). 0033 **antes** de la web: sin
  el CHECK nuevo, el alta falla con 23514 (fail‑closed, no emite nada) y la vuelta
  a Medir al cancelar solo alerta (la cancelación se aplica igual).
- **Guard:** aborta si faltan `organizations`/`licenses` o la base 0032 —
  aplicar 0032 (y antes 0031) y volver a lanzar 0033. Abortar es el resultado bueno.
- **Idempotente** y aditiva (ningún DROP de datos, ninguna fila existente cambia).
- **Regla 6:** anota la hora antes (PITR).

### Diagnóstico (solo lectura)

Antes: la fila «0032 ahorro nativo» del paso 1 en `true`. Tras aplicar, las dos
en `true`:

```sql
select to_regclass('bvsala.medir_altas') is not null as tabla_0033,
       to_regclass('bvsala.licenses_una_medir_viva_por_org') is not null as indice_0033;
```

### Aplicar

El bucle del paso 2 con `PENDIENTES="0033"`, tras anotar la hora, desde
`db/migrations/0033_licencia_medir.sql`.

### Verificar tras el deploy de la web

- Panel → Instalación → «Get my free Measure license» con una cuenta verificada:
  devuelve el token; una segunda pulsación devuelve el mismo.
- Con un correo desechable (p. ej. `@mailinator.com`): 403 `disposable_email`.

## Anexo — 0029 (septiembre de 2026): medido por referencia

0029 abre el carril `basis = 'reference'`: una llamada EVITADA (acierto exacto
o seguidor coalescido) cuya repetición es byte a byte una petición que sí corrió
a través de la capa sin que la capa la tocara, valorada con el contador que el
proveedor devolvió para esa petición idéntica (entrada al precio de entrada
cacheada; salida solo con muestreo determinista, con un modelo del catálogo que
no razona y honra ese muestreo, y sin razonamiento oculto en la llamada que
corrió — regla `reference-v2`, ver `src/pipeline/referencia.ts`). El ingest solo
admite `reference` de procesos que declaran `sdk/` desde
`VERSION_MINIMA_REFERENCIA` (0.4.33); el resto entra como `estimated`, porque la
etiqueta v0.4.23 lleva la regla v1, de la 0.4.24 a la 0.4.32 el SDK podía
repetir una negativa del proveedor como referencia (hasta la 0.4.30, la que el
modelo escribe como texto: #384; hasta la 0.4.31, el `content_filter: OTHER` de
Gemini, las que #384 no veía y los temas sensibles: #393, #401, #402; hasta la
0.4.32, las negativas parciales y la carencia tras una disculpa: #422), y la
regla no viaja en el registro. La verja actúa en el ingest, antes de la RPC, y no reescribe lo que
ya esté en `reference_*`; `reference_hits` no guarda la versión, así que una
referencia de 0.4.24-0.4.32 que entrara antes de desplegar la mínima 0.4.33 no
se podría separar después. De ahí el orden de abajo. El
`gateway/` tampoco entra, a ninguna versión, hasta que un PR le lleve la regla
v2 y abra su verja en `apps/web/lib/metering/version.ts`. Añade:

- `usage_daily`: `reference_requests`, `reference_baseline_cost`,
  `reference_actual_cost` (con el CHECK `usage_daily_reference_no_negatives`,
  solo `≥ 0`). El dinero va en `numeric(20,10)`, no en el `numeric(14,6)` del
  resto de la tabla: la RPC suma registro a registro, Postgres redondea cada
  uno a la escala de la columna y un acierto por referencia vale
  micro-dólares — a 6 decimales la base subiría por encima del suelo del SDK y
  dejaría de cuadrar con el CSV;
- `usage_daily_by_model`: `reference_requests`, `reference_baseline_cost`
  (también `numeric(20,10)`);
- `extractos`: `requests_referencia`, `base_referencia_usd`,
  `ahorro_referencia_usd`, `regla_referencia` (CHECK
  `extractos_referencia_no_negativos`, solo `≥ 0`);
- la tabla `reference_hits` (una fila por acierto, RLS de miembro): lo que
  descarga el enlace CSV del extracto, con el índice `(org_id, day,
  request_id)` de la descarga por clave y un BRIN sobre `day` para la purga
  nocturna de retención (460 días);
- **otra versión de `ingest_usage_batch`**: el cuerpo de 0025 ENTERO con dos
  bloques distintos (el insert de `usage_daily` y el fold por modelo, que
  además escribe la fila de `reference_hits`). `test/migracion-0029.test.ts`
  lo compara línea a línea contra 0025.

`measured_*` no cambia: un registro `reference` suma a los totales como un
`estimated` y, además, a sus columnas propias. El interruptor de cobro vive en
la web (`COMISIONAR_REFERENCIA`, `apps/web/lib/billing/tarifa.ts`); el de
acumulación, en la ruta del ingest (`BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1`).

- **Orden:** 0029 → `vercel --prod` desde la raíz del repo → SOLO ENTONCES npm
  con el SDK que emite `basis: "reference"`. Desde que la 0.4.24-0.4.32 están
  en npm, la web desplegada tiene que llevar ya la mínima 0.4.33
  (`apps/web/lib/metering/version.ts`) ANTES de aplicar 0029-0031: si no, las
  referencias de esas versiones entran en `reference_*` durante el hueco. 0029 lleva guard de precondición y
  ABORTA si falta la base 0025 (o `extractos`, 0016) — ese aborto es el
  resultado *bueno*: aplicar 0024/0025 en orden y volver a lanzar 0029. Es
  inocua con la web actual (la RPC nueva se comporta igual con los basis
  viejos; el SELECT del cierre actual es explícito y no lee las columnas nuevas).
- **Web antes que npm SÍ** (doctrina de `emitter.ts`: un 4xx del ingest
  descarta el lote sin reintento): un SDK que emita `reference` contra una web
  sin la lista blanca recibe 400 y pierde el lote.
- **Web antes que 0029 NO rompe, pero no se hace:** el panel, el cierre del día
  1 y la purga de retención toleran que la migración no esté (leen sin el
  carril y lo avisan; el cierre, con alerta **crítica**, porque con el SDK ya
  emitiendo referencia cada mes sin 0029 sella ese ahorro fuera de la base); el
  CSV responde 503, nunca un fichero vacío. El orden de arriba evita ventanas.
- **Retroceso: NUNCA un rollback de Vercel a un despliegue anterior a este
  carril** una vez publicado el SDK que emite `reference`: ese ingest no conoce
  el basis, respondería 400 y el emisor tiraría el lote ENTERO (también el uso
  medido) sin reintento. El retroceso es `BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1`
  en Vercel y redesplegar el MISMO commit (corta la acumulación; `1`, `true`,
  `yes` u `on` valen) o `COMISIONAR_REFERENCIA = false` por PR (deja de cobrar
  lo no sellado).
- **Regla 1, literal:** 0029 lleva versión de la RPC — re-ejecutar 0025 o una
  anterior DESPUÉS regresa la RPC en silencio: dejan de acumularse las columnas
  `reference_*` y de escribirse `reference_hits`, y el extracto deja de ver la
  referencia sin que nadie vea un error. Si pasa, re-aplicar **solo** el bloque
  `create or replace function bvsala.ingest_usage_batch` de 0029. La fila
  «RPC en version final (0029)» del paso 1 lo detecta.
- **Regla 6:** anota la hora antes (PITR). 0029 es aditiva (sin DROP de datos),
  pero la RPC se sustituye entera.

### Diagnóstico (solo lectura)

Antes de aplicar, el diagnóstico de 0025 (anexo 0024/0025) y el de 0028 tienen
que salir `true`. Tras aplicar, las CUATRO de abajo tienen que salir `true`; la
última exige a la vez la pieza de 0024, la de 0025 y la de 0029 en la RPC viva:

```sql
select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='reference_baseline_cost') as columna_0029,
       to_regclass('bvsala.reference_hits') is not null as tabla_0029,
       exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='extractos' and column_name='regla_referencia') as extractos_0029,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0029;
```

### Aplicar

El bucle del paso 2 con `PENDIENTES="0029"`, tras anotar la hora, desde el
fichero del PR que la trae (`db/migrations/0029_medido_por_referencia.sql`).
Relanzar el diagnóstico hasta tener las cuatro `true`.

### Verificar tras el deploy de la web

- El panel carga; `GET /api/cron/cierre-extractos?seco=1&periodo=<mes actual>`
  responde 200 y cada organización trae `requests_referencia` (0 hasta que
  llegue el SDK nuevo).
- Un lote sintético `basis: "reference"` coherente, con la clave `bvk_` de la
  organización interna de pruebas (leída de fichero, jamás impresa) → **202**,
  y en la base `usage_daily.reference_requests` +1 y una fila en
  `reference_hits`. Coherente quiere decir, además de llamada evitada sin
  coste: `referenceRequestId` y `referenceAt` presentes (epoch ms, como mucho
  30 días antes de `at`). Un lote incoherente (p. ej. `actualCost > 0`, o sin
  `referenceRequestId`) → **202** con `reference_requests` sin moverse: la verja
  lo degrada a `estimated`.
- La descarga CSV (enlace del extracto) sale en streaming, que es lo que la
  libra del límite de 4,5 MB de las respuestas de función de Vercel. La primera
  vez que una org pase de ~35.000 repeticiones en un mes (≈ 5 MB de CSV),
  bajarla entera desde el extracto y contar las filas contra
  `requests_referencia`. Un mes de más de 1.000.000 de filas no se sirve en un
  fichero (413): el extracto ofrece entonces la descarga día a día.
- Antes del primer cierre con referencia (día 1): `?seco=1` y revisar a mano
  las organizaciones con `requests_referencia > 0`. El primer período de cada
  organización es calibración (cargo 0).

## Anexo — 0030 (septiembre de 2026): tu propio banco

0030 guarda la verificación A/B **opcional** del SDK (`verification: {
sampleRate }` en `createSavingsLayer`): pares de coste medido en los dos lados
(la copia sin capa y la petición optimizada, ambos del contador del proveedor
del cliente) y recuentos diarios por estrato y exclusión. El panel los enseña en
**Prueba › Tu banco** y el cliente se los descarga en CSV
(`/api/org/verification-pairs`).

**Instrumento, jamás base.** Tablas propias (`verification_samples`,
`verification_daily`, `verification_batches_seen`), función de ingest propia
(`ingest_verification_batch`) y canal propio (`POST /api/metering/verification`).
No toca `ingest_usage_batch`, `usage_daily`, `extractos` ni ninguna columna
`measured_*`: nada de lo que entra aquí llega al extracto ni a la comisión
(`test/banco-propio-nunca-factura.test.ts`, y `test/migracion-0030.test.ts`
prueba que el fichero no nombra ninguna de esas piezas).

- **Orden:** independiente. 0030 no lleva versión de la función de uso, así que
  aplicarla antes o después de 0029 —o re-ejecutar 0025/0029 después— no
  regresa nada. Lleva guard de precondición (`organizations` e
  `is_org_member`).
- **Servidor antes que SDK, como siempre, pero sin riesgo de dinero:** un SDK con
  verificación contra una web sin la ruta recibe 404 en su canal propio y pierde
  solo pares (aviso W5 en consola del cliente); la medición de uso sigue intacta.
  Una web sin 0030 responde **503** en el ingest y «no disponible» en el panel,
  nunca ceros.
- **Interruptor de incidencias:** `BVSALA_INGEST_VERIFICATION_OFF=1` (variable de
  Vercel + redespliegue del mismo commit) hace que el ingest responda
  `202 {ingested: 0, disabled: true}` sin escribir nada.
- **Retención:** el cron `/api/cron/retencion` borra muestras y recuentos de más
  de 180 días y los lotes vistos de más de 30; `?seco=1` trae la clave
  `verificacion`.
- **Regla 6:** anota la hora antes (PITR). Aditiva, sin DROP de datos.

### Diagnóstico (solo lectura)

La fila «0030 tu propio banco» del paso 1. Suelta:

```sql
select to_regclass('bvsala.verification_samples') is not null
   and to_regclass('bvsala.verification_daily') is not null
   and to_regprocedure('bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb)') is not null
   and to_regprocedure('bvsala.verification_summary(uuid, date, date)') is not null as aplicada_0030;
```

### Aplicar

El bucle del paso 2 con `PENDIENTES="0030"`, tras anotar la hora, desde el
fichero del PR que la trae (`db/migrations/0030_banco_propio.sql`). Relanzar el
diagnóstico hasta tener `true`.

### Verificar tras el deploy de la web

- `GET /dashboard/your-bench` carga y enseña «El muestreo de verificación está
  apagado» (ninguna organización lo tiene encendido todavía).
- `GET /api/cron/retencion?seco=1` responde 200 con la clave `verificacion`
  (`{corte, dias: 180, borraria, lotesBorraria}`).
- Un `POST /api/metering/verification` con la clave `bvk_` de la organización
  interna de pruebas (leída de fichero, jamás impresa) y un sobre **solo con
  conteos** (`{"batchId":"<uuid>","samples":[],"counts":[{"day":"<hoy>","category":"unchanged","requests":1}]}`)
  → **202** y una fila en `verification_daily`. El mismo sobre otra vez (mismo
  `batchId`) → **202** sin sumar: la idempotencia por lote.

## Anexo — 0031 (septiembre de 2026): lo medido por referencia, también por asiento

0029 dejó `seat_activity` sin el carril de referencia («el dinero medido por
asiento lo infraestima; documentado»). Con `COMISIONAR_REFERENCIA` encendido,
el titular y el extracto ya suman la referencia como medida, pero la tarjeta de
máquinas y el aviso de versión leen `seat_activity`: una máquina cuyo ahorro de
la semana eran repeticiones valoradas por referencia salía con «0 € medidos» y
el panel avisaba en ámbar. 0031 añade:

- `seat_activity`: `reference_requests`, `reference_baseline_cost`,
  `reference_actual_cost`, con default 0 y **sin CHECK** (misma doctrina que
  0024: un CHECK que pudiera saltar revierte el lote entero). Dinero en
  `numeric(20,10)`, la escala de 0029, para que lo sumado por asiento cuadre con
  `usage_daily` y con `reference_hits`;
- **otra versión de `ingest_usage_batch`**: el cuerpo de 0029 ENTERO con un solo
  bloque distinto, el de `seat_activity` (tres columnas al final del insert, con
  las mismas tres expresiones `case when r->>'basis' = 'reference' …` que el de
  `usage_daily`, y sus tres acumulaciones al final del conflict).
  `test/migracion-0031.test.ts` lo compara línea a línea contra 0029.

`measured_*` no cambia. **No cambia lo que se cobra:** ninguna ruta de
facturación lee el dinero de `seat_activity` (los asientos se cobran por días
activos; la comisión sale de `usage_daily`). La web suma la referencia por
asiento solo bajo `COMISIONAR_REFERENCIA`, la misma regla del titular.

- **Orden:** 0031 → la web que lee las columnas. En cualquier orden es inocuo:
  la web tolera que falte 0031 (lee `seat_activity` en escalera sin las
  columnas nuevas y la referencia por asiento sale a 0) y la web anterior no
  las lee. 0031 lleva guard de precondición y ABORTA si falta la base 0029 —
  ese aborto es el resultado *bueno*: aplicar 0029 (anexo anterior) y volver a
  lanzar 0031.
- **Numeración:** 0031 y no 0030 porque el número 0030 lo tomó antes el PR #324
  (`0030_banco_propio.sql`). 0030 crea tablas propias y **no** toca
  `ingest_usage_batch`, así que 0031 no depende de ella (su guard solo exige
  0029). Si al aplicar 0031 todavía no existe 0030 en `main`, el diagnóstico
  del paso 1 no tendrá fila 0030 y no es un estado raro: la regla 2 se cumple
  entre las que existen.
- **Regla 1, literal:** 0031 lleva versión de la RPC — re-ejecutar 0029 o una
  anterior DESPUÉS regresa la RPC en silencio: deja de acumularse la referencia
  por asiento (solo eso; `usage_daily`, `reference_hits` y el extracto siguen
  igual) y la tarjeta de máquinas vuelve a infraestimar sin que nadie vea un
  error. Si pasa, re-aplicar **solo** el bloque
  `create or replace function bvsala.ingest_usage_batch` de 0031. La fila
  «RPC en version final (0031)» del paso 1 lo detecta.
- **Regla 6:** anota la hora antes (PITR). 0031 es aditiva (sin DROP de datos),
  pero la RPC se sustituye entera.

### Diagnóstico (solo lectura)

Antes de aplicar, el diagnóstico de 0029 (anexo anterior) tiene que salir
`true` entero. Tras aplicar, las DOS de abajo tienen que salir `true`; la
segunda exige a la vez la pieza de 0024, la de 0025, la de 0029 y la de 0031 en
la RPC viva:

```sql
select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='seat_activity' and column_name='reference_baseline_cost') as columna_0031,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
              and p.prosrc like '%reference_hits%' and p.prosrc like '%seat_activity.reference_baseline_cost%'
              and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0031;
```

### Aplicar

El bucle del paso 2 con `PENDIENTES="0031"`, tras anotar la hora, desde el
fichero del PR que la trae (`db/migrations/0031_referencia_por_asiento.sql`).
Relanzar el diagnóstico hasta tener las dos `true`.

### Verificar tras el deploy de la web

- El panel carga y la tarjeta de máquinas sale igual que antes en una org sin
  repeticiones por referencia.
- En una org con una repetición por referencia en los últimos 7 días: la
  columna «Measured savings (7 d)» de esa máquina la incluye, sale la nota de
  referencia bajo la tarjeta y esa máquina no dispara el aviso ámbar.

## Anexo — 0032 (septiembre de 2026): el ahorro nativo de la caché del proveedor, aparte y sin comisión

Decisión del dueño: «mostrar el ahorro de la caché de prefijo del proveedor
aparte, sin comisión». El SDK y el gateway publican `report.nativeSavings` y el
emisor manda dos campos opcionales y no negativos, `nativeCacheReadSavings` y
`nativeCacheWritePremium` (USD). 0032 añade:

- `usage_daily`: `native_cache_read_savings`, `native_cache_write_premium`
  (`numeric(20,10)`) y `native_requests` (`bigint`), con default 0 y un único
  CHECK de no negatividad (`usage_daily_native_no_negatives`), que no puede
  saltar con un lote que pasó la verja del ingest;
- `usage_daily_by_model`: las dos columnas de dólar, sin CHECK (el panel las
  agrupa por proveedor);
- **otra versión de `ingest_usage_batch`**: el cuerpo de 0031 ENTERO cambiando
  solo el bloque de `usage_daily` y el de `usage_daily_by_model`.
  `test/migracion-0032.test.ts` deshace los añadidos y compara con 0031 línea a
  línea, y afirma que ninguna expresión nativa entra en `baseline_cost`,
  `actual_cost` ni `measured_*`.

**No cambia lo que se cobra, y no hay interruptor para que cambie:** el extracto
no lee estas columnas (`apps/web/lib/billing/extracto-carril-nativo.test.ts`).

- **Orden:** 0032 → `vercel --prod` (lista blanca + panel) → SOLO ENTONCES el npm
  cuyo emisor manda los dos campos. Web antes que npm es obligatorio: un ingest
  sin la lista blanca contesta 400 y el emisor descarta el lote entero sin
  reintento. Migración antes que web no rompe nada: la RPC de 0031 ignora las
  claves (solo se pierde el dólar nativo hasta aplicarla) y el panel lee
  `usage_daily` en escalera (sin 0032 la tarjeta «Ahorro nativo activado» dice
  que no hay datos y el resto sigue).
- **Guard:** ABORTA si falta la base 0031 — aplicar 0031 (anexo anterior) y
  volver a lanzar 0032.
- **Numeración:** si otra migración toma 0032 antes de fusionar, renumerar y
  rebasar el cuerpo de la RPC sobre la de esa.
- **Regla 1, literal:** re-ejecutar 0031 o una anterior DESPUÉS regresa la RPC
  en silencio: deja de acumularse el ahorro nativo. La fila «RPC en version final
  (0032)» del paso 1 lo detecta; re-aplicar solo el bloque de función de 0032.
- **Regla 6:** anota la hora antes (PITR). Aditiva, pero la RPC se sustituye entera.

### Diagnóstico (solo lectura)

```sql
select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='native_cache_read_savings') as columna_0032,
       exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
              and p.prosrc like '%nativeCacheReadSavings%' and p.prosrc like '%seat_activity.reference_baseline_cost%'
              and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0032;
```

### Aplicar

El bucle del paso 2 con `PENDIENTES="0032"`, tras anotar la hora, desde
`db/migrations/0032_ahorro_nativo_del_proveedor.sql`.

### Comprobar

- El panel carga igual en una org sin caché de proveedor (la tarjeta dice que no
  hay datos todavía).
- Con tráfico que lea caché: la tarjeta «Ahorro nativo activado» enseña el neto
  (lectura − prima) y el reparto por proveedor, y el titular y el extracto no
  cambian.

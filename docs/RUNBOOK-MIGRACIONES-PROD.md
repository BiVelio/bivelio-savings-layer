# Runbook — migraciones 0007–0017 en producción

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
  ('RPC en version final (0015)', exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch' and p.prosrc like '%baseline_input_tokens%'))
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
| 0015 | check `usage_daily_token_totals_no_negatives` | La versión **final** de la RPC |
| 0016 | tabla `extractos` | La que necesita el cron del día 1 a las 05:00 |
| 0017 | tabla `cargos` | La que necesita el cron del día 1 a las 07:00 |
| RPC final | el fuente de `ingest_usage_batch` menciona `baseline_input_tokens` | Si 0015 sale `true` pero esto sale `false`, alguien regresó la RPC: re-aplicar **solo** el bloque de función de 0015 |

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

---

*Relacionado: `db/README.md` (esquema y aislamiento), `docs/RUNBOOK-ALERTAS.md`
(qué hacer cuando `invariantes` habla), PR #112 y #119 (origen de 0016/0017).*

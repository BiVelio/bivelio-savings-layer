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

*Relacionado: `db/README.md` (esquema y aislamiento), `docs/RUNBOOK-ALERTAS.md`
(qué hacer cuando `invariantes` habla), PR #112 y #119 (origen de 0016/0017).*

# PostgreSQL persistence: production runbook

Este runbook es la verja operativa de `@bivelio/persistence-postgres`. El paquete es opt-in y el PostgreSQL, los backups y las credenciales pertenecen al cliente. Las pruebas y el canary demuestran una configuración concreta; no constituyen un SLA.

## 1. Inventario y migración

Requisitos: Node.js 20.19+, PostgreSQL con `pgvector`, `pg` 8.23.x y una versión compatible de `@bivelio/savings-layer`. Usa un rol de migración distinto del rol de la aplicación. El rol de la aplicación solo necesita lectura/escritura sobre las tablas de `bivelio_savings`.

1. Congela las versiones del SDK y del paquete y guarda los artefactos que vas a desplegar.
2. Haz un backup y comprueba que `CREATE EXTENSION vector` está permitido en la base de destino.
3. Aplica las migraciones en orden, con `ON_ERROR_STOP`:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f node_modules/@bivelio/persistence-postgres/sql/001_exact_and_breakpoints.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f node_modules/@bivelio/persistence-postgres/sql/002_semantic_cache.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f node_modules/@bivelio/persistence-postgres/sql/003_constraint_memory.sql
```

Las migraciones son idempotentes y aditivas. No hay down destructivo ni ejecución automática al arrancar. Despliega primero el esquema y después las réplicas. Verifica las tablas y el índice vectorial:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
SELECT tablename FROM pg_tables WHERE schemaname = 'bivelio_savings' ORDER BY tablename;
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'bivelio_savings' AND indexname = 'semantic_cache_records_embedding_256_hnsw_idx';
```

Para el pool de aplicación fija `connectionTimeoutMillis`, `query_timeout`, `statement_timeout` e `idle_in_transaction_session_timeout`; el valor inicial recomendado es 250 ms. No pongas un timeout de 250 ms al rol que ejecuta migraciones, índices, dumps o restauraciones.

## 2. Backup y PITR

Protege dumps, réplicas y WAL como datos del cliente: la caché exacta contiene respuestas y la semántica contiene consultas, respuestas y embeddings. Cifra los artefactos, restringe su acceso y aplica la misma política de retención que a la base.

Como mínimo, antes de cada migración o cambio de capacidad:

```sh
export PGPASSWORD='…'  # usa el mecanismo secreto de tu plataforma, no el historial del shell
pg_dump --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" \
  --dbname "$PGDATABASE" --format=custom --no-owner --no-privileges \
  --file "bivelio-$(date -u +%Y%m%dT%H%M%SZ).dump"
unset PGPASSWORD
```

Un dump lógico es un punto en el tiempo, no PITR. Para PITR, habilita archivo continuo de WAL y backups base en PostgreSQL gestionado o en tu infraestructura. Documenta del proveedor: región, cifrado, retención de WAL, granularidad de recuperación, RPO y RTO. Restaura siempre a una base nueva, nunca sobre producción:

1. Detén escritores o registra el punto de corte.
2. Selecciona el timestamp objetivo en UTC y conserva su evidencia.
3. Restaura el backup base y repite WAL hasta ese objetivo con la herramienta del proveedor.
4. Ejecuta las comprobaciones de la sección 3 antes de admitir tráfico.
5. Cambia el endpoint solo después de validar y conserva el origen hasta cerrar el ejercicio.

Una restauración antigua no debe fusionarse con el estado actual. En particular, no reimportes un snapshot de calibración anterior: `importCalibration()` exige la revisión y la identidad del backend esperadas.

## 3. Ejercicio real de backup y restore

La prueba `disaster-recovery.integration.test.ts` crea dos bases desechables con nombres aleatorios, migra y siembra una, ejecuta `pg_dump`/`pg_restore` a la segunda y elimina ambas al terminar. Nunca restaura sobre una base existente. Requiere un rol con `CREATEDB`, permiso para crear `vector` y binarios PostgreSQL compatibles. Sin `BIVELIO_TEST_POSTGRES_URL` se omite; sin `pg_dump` o `pg_restore`, se omite con ese motivo antes de crear bases.

```sh
BIVELIO_TEST_POSTGRES_URL='postgresql://usuario:clave@localhost/base_admin_desechable' \
  pnpm --filter @bivelio/persistence-postgres exec vitest run \
  test/disaster-recovery.integration.test.ts
```

La evidencia obligatoria es:

- el valor exacto, el hit semántico y la revisión/estado de calibración sobreviven;
- una importación de calibración con revisión antigua se rechaza sin cambiar el estado;
- expiración/purga y borrado de tenant funcionan sobre la copia restaurada;
- retirar los almacenes PostgreSQL devuelve la capa a memoria.

Repite este ejercicio antes de una release y después de cambiar PostgreSQL, `pgvector`, backups o IAM. Para una restauración de producción, añade conteos por namespace, pruebas de hits conocidos y comparación de `revision`/`backend_identity` antes de abrir tráfico.

## 4. Rollback

El rollback de aplicación no requiere borrar tablas. Retira `exactCache`, `semanticCacheStore`, `cacheBreakpointStore` y `constraintMemoryStore` de `createSavingsLayer()`; el SDK vuelve a sus almacenes en memoria. Despliega esa configuración con el mismo artefacto de SDK validado.

```ts
const layer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  // Sin stores PostgreSQL: memoria local para este proceso.
});
```

Después de retirar las réplicas PostgreSQL, espera a `layer.close()` y cierra stores/pools. No reutilices una calibración de memoria como si certificara PostgreSQL: la identidad del backend es distinta. Las tablas aditivas pueden quedar inactivas; cualquier borrado posterior debe seguir retención y coordinación, no formar parte del rollback urgente.

## 5. Retención, purga y borrado de tenant

Programa la purga exacta fuera del pico y mide filas borradas/duración. `purgeExpired()` es global al schema: ejecútalo solo con la cuenta y base correctas.

```ts
const deleted = await exactCache.purgeExpired();
```

Para semántica, configura `ttlMs` y una cota `maxRecords` por namespace. El TTL impide servir registros viejos; no es una purga física. La limpieza física de registros vencidos es una operación administrativa explícita, por ejemplo dentro de una ventana y por lotes:

```sql
DELETE FROM bivelio_savings.semantic_cache_records
 WHERE namespace = $1
   AND stored_at_ms + $2 < (extract(epoch from clock_timestamp()) * 1000)::bigint;
```

`$1` es el namespace retirado y `$2` su TTL en ms; no ejecutes esta sentencia sobre namespaces sin TTL. `maxRecords` aplica FIFO por namespace, no una cuota por tenant.

Para una solicitud de borrado de tenant:

```ts
await semanticCacheStore.deleteTenant(tenantId);
await semanticCacheStore.invalidateEpoch(retiredEpoch); // solo si procede
```

`deleteTenant()` cubre los registros semánticos de ese tenant dentro del namespace. La caché exacta usa claves derivadas y no ofrece un índice por tenant: la aplicación debe conservar su catálogo de claves y llamar a `delete(key)`, o usar un namespace/base dedicado al tenant cuando el contrato exija borrado físico completo. Las calibraciones y observaciones son del namespace, no del tenant; no las borres para un tenant si otros comparten esa historia. Retira el namespace completo solo cuando todos sus tenants hayan salido, en este orden:

```sql
DELETE FROM bivelio_savings.semantic_calibration_observations WHERE namespace = $1;
DELETE FROM bivelio_savings.semantic_calibrations WHERE namespace = $1;
DELETE FROM bivelio_savings.semantic_cache_records WHERE namespace = $1;
```

Los hints de restricciones y breakpoints también requieren retirada coordinada. Documenta cómo se propaga el borrado a réplicas, backups y retención legal; un `DELETE` no reescribe dumps ya emitidos.

## 6. Canary vivo opt-in

`benchmark/live-canary.ts` empaqueta los `dist` ya construidos del SDK y de persistencia, instala esos tarballs en un consumidor temporal bajo `os.tmpdir()` y ejecuta dos procesos Node independientes (frío y reinicio). No cambia dependencias del repositorio. Usa Gemini nativo en `https://generativelanguage.googleapis.com/v1beta` y PostgreSQL+pgvector reales.

**Hace llamadas facturables.** Puede necesitar hasta 40 respuestas de calibración semántica, además de las comprobaciones de aislamiento y fail-open. No imprime credenciales, prompts ni respuestas. Sin cualquiera de las variables obligatorias, imprime instrucciones y termina sin llamar al proveedor. Genera un par Ed25519 efímero y una licencia de prueba que el SDK empaquetado verifica offline; no usa la clave privada ni una licencia de cliente.

```sh
pnpm run build
pnpm --filter @bivelio/persistence-postgres run build
BIVELIO_LIVE_CANARY=1 \
BIVELIO_TEST_POSTGRES_URL='postgresql://usuario:clave@localhost/base_desechable' \
BVSALA_DEMO_GOOGLE_API_KEY='…' \
  pnpm exec tsx packages/persistence-postgres/benchmark/live-canary.ts
```

Opcional: `CANARY_MODEL` (por defecto `google/gemini-3.8-flash`) y `BIVELIO_LIVE_CANARY_OUTPUT`. El informe seguro por defecto es `packages/persistence-postgres/benchmark/out/live-canary.json`. En GitHub, `persistence-canary.yml` ejecuta el mismo canario con PostgreSQL desechable y el secreto `GEMINI_API_KEY`.

El canary exige:

- instalación y arranque frío del paquete, reutilización exacta y semántica tras reinicio;
- calibración real, `qualityStatus` correcto y aislamiento de tenant;
- ahorro neto medido agregado positivo (solo bases `measured`/`reference`);
- p95 extremo a extremo B2 <= 3000 ms y máximo <= 5000 ms;
- locks reales de tablas: cada request hace fail-open con exactamente una llamada al proveedor, sin hit ni respuesta cruzada;
- limpieza del namespace y de las claves exactas registradas, también en rutas de fallo.

## 7. Release gates

Ejecuta primero las verificaciones sin secretos de proveedor:

```sh
pnpm --filter @bivelio/persistence-postgres run typecheck
pnpm --filter @bivelio/persistence-postgres exec vitest run test/disaster-recovery.integration.test.ts
```

Luego, sobre PostgreSQL+pgvector desechable:

```sh
BIVELIO_TEST_POSTGRES_URL='postgresql://usuario:clave@localhost/base_desechable' \
  pnpm run bench:postgres-semantica
```

El benchmark de 100k conserva las verificaciones de recall@1 >= 0,95, FIFO e índice sin `Seq Scan`, y exige además:

| Gate | Umbral |
| --- | ---: |
| cold lookup | <= 250 ms |
| warm p95, concurrencia 1/8/32 | <= 50 ms |
| warm p99, concurrencia 1/8/32 | <= 100 ms |
| warm max, concurrencia 1/8/32 | <= 100 ms |

El informe `benchmarks/out/semantic-postgres-100k.json` incluye valores y umbrales. No lances si falta una evidencia, si el backup/restore se omite por herramientas en una release que exige ese gate, o si el canary vivo falla. Guarda informe, versiones, configuración del pool, PostgreSQL/`pgvector`, modelo y fecha sin incluir secretos ni contenido de requests.

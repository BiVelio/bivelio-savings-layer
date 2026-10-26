# @bivelio/persistence-postgres

Persistencia PostgreSQL para las cachés exacta y semántica, las mediciones versionadas de breakpoints y el aprendizaje de restricciones de BV-SALA. Todo es opt-in: el SDK sigue usando memoria si no inyectas estos almacenes.

## Instalación

```sh
pnpm add @bivelio/savings-layer @bivelio/persistence-postgres pg
```

Requiere Node.js 20.19 o posterior, `@bivelio/savings-layer` 0.6 y `pg` 8.23 o posterior dentro de la línea 8. La caché semántica requiere además la extensión `pgvector` en el PostgreSQL del cliente. `pg` es peer obligatorio solo de este paquete y no se añade al SDK principal.

## Migraciones manuales

Aplica el SQL incluido con un rol que pueda crear el schema, las tablas y la extensión:

```sh
psql "$DATABASE_URL" -f node_modules/@bivelio/persistence-postgres/sql/001_exact_and_breakpoints.sql
psql "$DATABASE_URL" -f node_modules/@bivelio/persistence-postgres/sql/002_semantic_cache.sql
psql "$DATABASE_URL" -f node_modules/@bivelio/persistence-postgres/sql/003_constraint_memory.sql
```

Las migraciones son idempotentes y pueden aplicarse de nuevo. El schema fijo es `bivelio_savings`; no se interpola ningún nombre de schema o tabla. El paquete nunca ejecuta migraciones automáticamente.

## Pool y cierre

```ts
import { Pool } from "pg";
import { AnthropicProvider, createSavingsLayer } from "@bivelio/savings-layer";
import {
  PgCacheBreakpointStore,
  PgConstraintMemoryStore,
  PgExactCache,
  PgSemanticCache,
} from "@bivelio/persistence-postgres";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 250,
  query_timeout: 250,
  statement_timeout: 250,
  idle_in_transaction_session_timeout: 250,
  keepAlive: true,
});

const exactCache = new PgExactCache({ pool });
const cacheBreakpointStore = new PgCacheBreakpointStore({ pool });
const constraintMemoryStore = new PgConstraintMemoryStore({ pool });
const semanticCacheStore = new PgSemanticCache({
  pool,
  namespace: "support-answers-v1",
  calibration: { maxErrorRate: 0.02 },
});

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  exactCache,
  cacheBreakpointStore,
  cacheBreakpoints: "auto",
  constraintMemoryStore,
  semanticCacheStore,
  semanticCacheDefault: true,
});

// Después de cada invocación serverless, usa la espera de la plataforma:
// waitUntil(semanticCacheStore.settled()).
// Al cerrar la aplicación:
await layer.close();                 // Drena también semanticCacheStore.settled().
await Promise.all([
  exactCache.close(),               // No cierra un pool inyectado.
  cacheBreakpointStore.close(),
  constraintMemoryStore.close(),
  semanticCacheStore.close(),
]);
await pool.end();
```

También puedes pasar `connectionString` en lugar de `pool`. En ese caso cada store crea su propio pool y su `close()` sí lo cierra:

```ts
const exactCache = new PgExactCache({
  connectionString: process.env.DATABASE_URL,
  queryTimeoutMs: 250,
  poolConfig: { max: 4 },
});
await exactCache.close();
```

No pases `pool` y `connectionString` a la vez. `poolConfig` solo se admite cuando el store crea el pool.

## Caché exacta y breakpoints

Las decisiones TTL usan `clock_timestamp()` de PostgreSQL. Una entrada sigue válida cuando el reloj es igual a `expires_at_ms` y caduca cuando es mayor. En la exacta, `ttlMs: undefined` significa sin caducidad; `get()` elimina entradas caducadas y `purgeExpired()` permite una limpieza explícita.

Los breakpoints caducados se leen como ausentes, pero conservan fila y versión para impedir el problema ABA. `compareAndSet()` solo inserta con esperada `null` si no existe fila, o actualiza la revisión exacta. El pipeline fusiona la observación completa sobre la revisión más reciente, con un máximo de 64 intentos, pequeña espera anti-herd y un presupuesto de 1.000 ms. Si agota el presupuesto deja intacta la versión ganadora y registra `store-error`; nunca escribe encima ni repite el proveedor.

## Aprendizaje durable de restricciones

`PgConstraintMemoryStore` evita que cada instancia nueva tenga que volver a aprender qué contratos necesitan la pista `JSON limits`. El `Set` de `constraintMemory` sigue siendo la caché local y ambas opciones se pueden combinar. Un hit local no consulta PostgreSQL; un hit durable lo puebla. `remember()` es idempotente incluso con escrituras concurrentes.

La clave es un SHA-256 de una tupla versionada con tenant, permisos, proveedor, modelo servido y contrato. La tabla `constraint_value_hints` solo guarda ese hash y `created_at_ms`: no contiene prompt, esquema, respuesta ni endpoint. La escritura usa el modelo final, también si la cascada escala.

Un fallo de lectura continúa sin la pista durable; un fallo de escritura conserva el aprendizaje local. Ambos dejan `constraint-memory/store-error` y nunca añaden una llamada de fail-open ni otra reparación. La pista reduce reaprendizaje, pero no garantiza que toda respuesta futura sea válida ni deduplica respuestas.

**Rollback:** retira `constraintMemoryStore` de la configuración y el SDK vuelve a memoria local sin leer la tabla. La migración 003 es aditiva y no necesita un down destructivo. La limpieza administrativa puede borrar claves concretas o toda la tabla durante una retirada coordinada.

## Caché semántica con pgvector

`PgSemanticCache` implementa el mismo `SemanticCacheStore` que la memoria. Sin `calibration`, `lookup` sigue en modo sombra: no sirve aciertos ni produce sondas, aunque `store` conserve respuestas para una calibración futura.

- El namespace separa experimentos y configuraciones. Usa uno nuevo al cambiar de política; no borres y reinicies una calibración con la misma identidad.
- La política incorporada usa HNSW cosine, 256 dimensiones, 32 candidatos y las guardas `SemanticCacheSafety`. `candidateLimit` puede llegar a 128; por encima de 32 se usa una transacción para ajustar `hnsw.ef_search`.
- La consulta aplica tenant, permisos, principal, época, contrato, modelo, sistema/datos, locale, esquema/seguridad, herramientas/turnos, temperatura, seed y reasoning effort dentro de SQL. Los campos null usan `IS NOT DISTINCT FROM`.
- Después se revalidan similitud, números/negación/entidades y el verificador local. Solo se considera la mejor candidata de esa política; no se prueba una segunda si el suelo la rechaza.
- `embedding_256` duplica deliberadamente el vector incorporado para que HNSW tenga una dimensión declarada. La columna general conserva embedders personalizados sin truncarlos; esos usan distancia exacta y no la verja de rendimiento HNSW de 256 dimensiones.
- Una calibración incluye la identidad del backend. Un snapshot de memoria, otro límite de candidatos u otro recuperador no autoriza silenciosamente esta política.
- La política ANN se calibra como tal. No promete la misma candidata que un recorrido completo de memoria cuando un verificador pueda cambiar el orden.

La respuesta debe ser JSON compatible: objetos simples, arrays, strings, booleanos, números finitos y null. BigInt, ciclos, `undefined`, funciones, símbolos, NaN, infinitos y objetos no simples se rechazan. Cada lectura devuelve una copia nueva.

### Calibración distribuida

El juez se ejecuta fuera de la base y solo una vez por entrega. Una transacción corta bloquea la historia del namespace, deduplica `observationId`, aplica el `SemanticCalibrationJournal` compartido, actualiza revisión y piso por registro y guarda la observación. El gasto de confianza no se reinicia entre réplicas.

- Una entrega repetida devuelve el veredicto original sin contar otra etiqueta.
- Reutilizar un ID con otro payload no modifica el estado.
- Los segmentos `single_shot` y `agentic` conservan historias separadas.
- Un fallo del juez o de la base devuelve `null`; `observe` nunca rechaza.
- `failed_at_score` usa el máximo observado, también con etiquetas concurrentes.

Para administración:

```ts
const snapshot = await semanticCacheStore.exportCalibrationSnapshot();
await semanticCacheStore.importCalibration(snapshot); // CAS sobre snapshot.revision
const status = await semanticCacheStore.calibrationStatus("single_shot");
```

Una restauración con una revisión o backend distinto se rechaza. No mezcles historias: importa sobre un namespace nuevo o restaura conscientemente una revisión conocida.

### Capacidad y borrado

`maxRecords` es una cota FIFO por namespace, no una cuota por tenant. `invalidateEpoch(epoch)` borra esa época dentro del namespace; `deleteTenant(tenant)` elimina sus registros. `count()` devuelve el total actual. La limpieza de calibraciones y observaciones es administrativa y debe coordinarse con la retirada del namespace.

## Timeouts y errores

`queryTimeoutMs` vale 250 ms por defecto. Las lecturas semánticas normales combinan candidatos y calibración en una consulta acotada, no una transacción de cinco viajes. Las escrituras y calibraciones usan clientes dedicados; si vence la espera del llamante, el cliente no se devuelve al pool hasta terminar la consulta y ejecutar su limpieza/rollback.

Los pools propios reciben `connectionTimeoutMillis`, `query_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout` y `keepAlive`. Para un pool inyectado, configura esos límites en el `Pool`. Cancelar una consulta que ya salió del proceso no siempre es posible; una entrega tardía se deduplica por ID.

Los errores y timeouts se propagan en lecturas/escrituras directas para que el pipeline aplique fail-open. No se convierten en aciertos, no hay reintentos ocultos y nunca se repite una llamada al proveedor ya facturada.

## Privacidad

PostgreSQL pertenece al cliente. Este paquete no envía copias a BiVelio ni a otro servicio.

- **Exacta:** respuestas completas, datos y metadatos; protégela como el contenido original. Usa `delete(key)` y `purgeExpired()`.
- **Semántica:** consulta normalizada, embedding, respuesta y metadatos. Los embeddings son datos derivados potencialmente sensibles. Protege también backups y réplicas. Usa `deleteTenant()` o `invalidateEpoch()`.
- **Calibración:** histogramas, pisos, IDs, puntuaciones y fingerprints; no guarda el texto fresco de una observación. Su retención debe seguir la política del namespace.
- **Restricciones:** hash de la identidad de aprendizaje y timestamp; sin esquema ni contenido. Borra claves administrativamente durante la retirada.
- **Breakpoints:** huellas de prefijos, tiempos y contadores, no el prompt. Las filas caducadas permanecen para conservar revisiones; el borrado físico exige una retirada coordinada.

## Alcance

El paquete no aplica migraciones, purgas programadas ni despliegues. Incluye un benchmark local, una prueba real de backup/restore y un canary vivo opt-in como verjas de release; ninguno garantiza un SLA ni sustituye la validación con los proveedores y datos del cliente. Las instrucciones operativas completas están en [`docs/PERSISTENCIA-POSTGRES-PRODUCCION.md`](../../docs/PERSISTENCIA-POSTGRES-PRODUCCION.md).

## Pruebas y benchmark

```sh
pnpm test
BIVELIO_TEST_POSTGRES_URL='postgresql://usuario:clave@localhost/base_desechable' pnpm test
BIVELIO_TEST_POSTGRES_URL='postgresql://usuario:clave@localhost/base_desechable' pnpm run bench:postgres-semantica
```

Las pruebas de integración se omiten si falta la URL. Las pruebas existentes operan sobre la base desechable indicada; la prueba de recuperación es la excepción controlada y crea dos bases con nombres aleatorios, que destruye al terminar, sin tocar objetos existentes. Se omite con un motivo claro si faltan `pg_dump`/`pg_restore`. El benchmark carga 100.000 registros, mide concurrencia 1/8/32 y exige cold `<= 250 ms`, warm `p95 <= 50 ms`, `p99 <= 100 ms`, `max <= 100 ms`, recall `@1 >= 0.95` y FIFO. En la tirada completa exige un plan indexado sin `Seq Scan` y registra por separado si el planner eligió HNSW o el índice compuesto de identidad. `BIVELIO_BENCH_RECORDS` permite un humo menor. El resultado incluye los umbrales y se escribe en `benchmarks/out/semantic-postgres-100k.json`. `BIVELIO_BENCH_POOL_MAX` ajusta el pool (16 en la medición documentada); `BIVELIO_BENCH_P95_MS`, `BIVELIO_BENCH_P99_MS` y `BIVELIO_BENCH_MAX_MS` permiten un presupuesto explícito distinto en CI compartida; `BIVELIO_BENCH_KEEP`, `BIVELIO_BENCH_REUSE` y `BIVELIO_BENCH_NAMESPACE` permiten repeticiones de solo lectura, marcadas con `fifoChecked: false`. El canary vivo y sus credenciales opt-in se describen en el runbook enlazado arriba.

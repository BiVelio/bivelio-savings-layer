# Cierre de producto — qué queda

Estado a 2026-08-06, tras la auditoría de bugs silenciosos (172 agentes, 80
hallazgos, 14 causas raíz). **Las 14 están cerradas**, más el crítico de la
caché semántica que apareció al revisar los hallazgos sin tocar. 264 tests.

Este documento es lo que queda para poder vender el producto sin asteriscos.
Está ordenado por lo que BLOQUEA, no por esfuerzo.

---

## 1. Bloqueantes de lanzamiento

### 1.1 El SDK no está publicado

`npm view @bivelio/savings-layer` devuelve **404**. La landing enseña
`pnpm add @bivelio/savings-layer` y el panel da instrucciones de instalación
para un paquete que no existe. Un cliente que siga el onboarding se estrella en
el primer comando.

Antes de publicar hay que comprobar dos cosas que hoy no están verificadas:

- Que `__BV_SALA_ALLOW_DEV_OPEN__` se compila a `false` en el bundle publicado.
  Es lo único que impide que un instalador se salte el pago con
  `BVSALA_DEV_OPEN=1`. La definición existe en `tsup.config.ts`; falta el test
  que lo afirme sobre el artefacto construido, no sobre el fuente.
- Que `dist/` se regenera con los arreglos de esta tanda. Está en `.gitignore`,
  así que se construye al publicar — pero conviene un `npm pack --dry-run` y
  mirar qué entra.

### 1.2 El artefacto de prueba es MOCK

`apps/web/public/data/ab-live.json` tiene `mode: "MOCK"` y
`aggregate.proven: false`. Es lo que alimenta el "Paso 2" de la landing y las
tarjetas de referencia. Está honestamente etiquetado —el badge dice
"ESTIMADO · proveedor simulado"— pero significa que **el producto todavía no ha
demostrado su ahorro contra un proveedor real**.

Hace falta una ejecución `pnpm ab` LIVE contra un proveedor real. Todo lo que
la rodea ya está montado (§1.2.1); falta la clave y ejecutar.

Y ahora hay un motivo nuevo para rehacerlo: la regla de una sola regla cambia
los números. El artefacto actual se generó con el baseline heurístico, así que
sus porcentajes están inflados por el mismo sesgo que acabamos de quitar.

#### 1.2.1 Lo que ya está montado

- **`benchmarks/run.ts` exigía `usage`… salvo en LIVE.** `ab-live.ts` sí lo
  exigía; `run.ts` no, y es el que imprime *"(real provider tokens & cost)"* en
  la misma línea. Un proveedor que no devuelva `usage` dejaba el coste en 0 —
  un 100% de ahorro fabricado con la etiqueta de medido. Corregido.
- **`pnpm ab:publish`** — publicar dejó de ser un `cp` a mano. `publish-guard.ts`
  bloquea: un artefacto que no sea LIVE, degradar un LIVE ya publicado a MOCK
  (esto ni con `--allow-mock`), un fingerprint que cambió a mitad de tirada,
  unos libros que no cuadran, y cualquier ahorro >100% o con el intervalo dado
  la vuelta. `proven: false` sí se publica, pero avisando. 12 tests.
- **`.env.bench`** (en `.gitignore`) con `.env.bench.example` al lado. Los
  scripts lo cargan solos, así que la clave no pasa por el historial del shell.

### 1.3 Rotación de secretos y KMS — APLAZADO por decisión

El propietario decide no hacerla ahora (2026-08-06). La clave de firma de
licencias (`LICENSE_PRIVATE_KEY_B64`) sigue en un fichero local. La migración
0007 ya introdujo el identificador de clave (`kid`), así que cuando se quiera
hacer, la infraestructura lo soporta sin cambios de código.

---

## 2. Deuda que ya duele

### 2.1 El dashboard no tiene estados de carga ni de error

No existe un solo `loading.tsx` ni `error.tsx` en `apps/web/app`. Con
`dynamic = "force-dynamic"` en el layout del panel, cada navegación espera al
servidor sin nada en pantalla, y un fallo de render da la pantalla de error
genérica de Next.

### 2.2 Retención de `usage_ingest_seen`

La migración 0009 creó la tabla de idempotencia y **documentó** la purga, pero
no la programó. Crece con cada petición medida (~60 bytes; a un millón de
peticiones al mes, ~60 MB/mes). La sentencia está en el propio fichero:

```sql
delete from bvsala.usage_ingest_seen where seen_at < now() - interval '30 days';
```

Falta decidir dónde vive: `pg_cron` en Supabase, o una Vercel Cron.

### 2.3 Hallazgos de la auditoría sin tocar

Diez, ninguno crítico. Por orden de gravedad:

| | qué |
|---|---|
| grave | `freshnessBucket` no particiona la clave por tiempo: una consulta `live` puede replicar una respuesta rancia 24 h |
| grave | La caché exacta se permite con herramientas `write`/`destructive`, contra el invariante documentado en `contracts/types.ts` |
| grave | La compresión acredita ahorro sin la puerta de activación documentada, y reescribe system prompts y payload sin `protectedSpans` |
| grave | `baselineRetrieval` se toma de la decisión YA optimizada del router: inventa rondas evitadas cuando no hay retriever |
| medio | Los cachés devuelven el objeto almacenado **por referencia**: una mutación del llamante corrompe la entrada para todo el proceso |
| medio | `cosine()` trunca al vector más corto en vez de fallar ante dimensiones distintas |
| medio | El `ToolSelector` entrega CERO herramientas si ningún intent aparece literalmente en el texto, y cuenta sus esquemas como ahorro |
| menor | `defaultTokenizerRegistry` es un singleton mutable compartido por todos los layers del proceso |
| menor | `normalizeText` pasa a minúsculas: peticiones cuya respuesta depende de las mayúsculas colisionan en la clave |
| menor | `mergeDelta` convierte objetos a `'[object Object]'` al hacer append y los inyecta en el prompt |

Los dos de la caché (`freshnessBucket`, herramientas de escritura) son de la
misma familia que los ya cerrados y son los siguientes que yo atacaría.

---

## 3. Lo que ya no hace falta vigilar

Cerrado y con test de regresión que **falla contra el código sin arreglar** —
no basta con que pase:

- Paywall, `usage` parcial, `structurallyValid`, singleflight, claves de caché
  exacta y semántica, idempotencia del ingest, dominio de los datos, identidad
  de asiento, fail-opens de licencia, precios, honestidad del panel.
- La regla de una sola regla: con cero optimización el ahorro es cero, medido
  contra un proveedor que cuenta como un BPE real.
- Privilegios de base de datos: `licenses.token` y `service_accounts.key_hash`
  fuera del alcance de `anon` y `authenticated`, verificado antes y después
  contra producción.

Migraciones aplicadas y verificadas en producción: **0007** (privilegios),
**0008** (dominio de `usage_daily`), **0009** (idempotencia), **0010** (medido
vs estimado).

---

## 4. Orden que yo seguiría

1. ~~`requireUsage` en el benchmark LIVE~~ — hecho.
2. ~~Tubería de publicación con verja~~ — hecho (`pnpm ab:publish`).
3. **Ejecutar `pnpm ab` LIVE** y publicar. Solo falta la clave del proveedor.
   Cierra 1.2 y da por fin una cifra defendible, ya con el baseline corregido.
4. **Publicar en npm**, con el test del bundle antes.
5. **Purga de `usage_ingest_seen`** — antes de que haya volumen, no después.
6. Los dos graves de caché (2.3).
7. `loading.tsx` / `error.tsx`.
8. ~~Rotación de secretos y KMS~~ — aplazado por decisión del propietario.

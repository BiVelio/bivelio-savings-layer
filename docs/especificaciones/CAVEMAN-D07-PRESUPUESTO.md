# D07 · Reservar y liquidar — el presupuesto por intento

> Plan de desarrollo Caveman 2026-10-14, p. 8. Estado: **contrato y pruebas, sin
> cablear.** Código: `src/metering/presupuesto.ts`. Migración:
> `db/migrations/0036_presupuesto_intentos.sql` (**escrita, sin aplicar**).
> Depende de D02 (`src/metering/intento.ts`).

## Qué resuelve, y qué no

Resuelve **la admisión**: ningún trabajo entra si, con lo ya gastado, lo estimado
y la exposición pendiente, supera el tope del proyecto, tampoco cuando llegan
cien peticiones a la vez. Y hace visible **la exposición pendiente**: lo que
puede estar facturándose sin que se sepa todavía cuánto.

**No** controla el gasto del proveedor: un tope interno no para un usage que
llega tarde ni lo que el proveedor ya facturó. Un coste real por encima de su
reserva se apunta entero (`exceededReservation`) y deja `available` en negativo.

## La máquina de estados

| Transición | Cuándo | Qué pasa con el dinero |
|---|---|---|
| (planned) → `reserved` | antes de enviar | se reserva la cota del sobre, solo si `gastado + estimado + pendiente + importe <= tope` |
| `reserved` → `dispatched` | **antes del primer byte** del cuerpo | nada; se guardan la hora y la correlación del proveedor |
| `dispatched` → `settled` | usage completo del proveedor y precio propio del catálogo | la reserva se convierte en el coste del recibo de D02 |
| `reserved` → `released` | **solo con prueba** de que no salió: `abortado_antes_de_enviar`, `rechazado_localmente`, `sin_conexion` | la reserva vuelve entera |
| `dispatched` / `reserved` → `uncertain` | cancelación, stream cortado, usage ausente o parcial, timeout local, sin precio | la exposición **se retiene**: al menos lo reservado, y el suelo conocido si lo supera |
| `uncertain` → `settled` | llega el usage completo (conciliación) | como arriba |
| `uncertain` → `estimated` | solo hay una estimación | cuenta para el tope como **estimado**, nunca como coste ni ahorro verificado; nunca 0, nunca por debajo del suelo |

Un timeout local **no** es prueba de no-envío. Un intento enviado no se libera
nunca: se concilia o se estima.

## El sobre (la cota de un intento)

Máximo de entrada, `max_tokens`, razonamiento si se factura aparte, escrituras
de caché posibles y límite de intentos de la llamada lógica. La cota se calcula
con `tarifarIntento` de D02 sobre el **peor** reparto de la entrada (sin caché,
leída, escrita a 5 min, escrita a 1 h) y se redondea **hacia arriba**.

No hay cota fiable —y un tope estricto **rechaza**— cuando falta `max_tokens`,
el razonamiento facturable no está acotado, el modelo no tiene precio propio en
el catálogo (sin precio o heredado de un pariente) o la entrada pasa del umbral
de contexto largo (200K), donde la tarifa del catálogo es un suelo. Un tope no
estricto aplica entonces su `reservaConservadoraMicroUsd`, si la tiene.

## Claves

`logicalCallId` (la llamada), `attemptId = idDeIntento(logicalCallId, ordinal)`
(cada solicitud que pudo costar), `experimentRunId` y `armId` (el ensayo). Un
reintento al proveedor es **otro** ordinal y **otra** reserva. Reservar dos
veces el mismo intento con el mismo sobre no suma; con otro sobre es un
conflicto. Repetir el mismo recibo es un no-op; otro cuerpo, `ConflictoDeRecibo`.

## La outbox

Cada transición deja un evento sin contenido (ids, estado, importe, exposición,
etiqueta) en la misma sección crítica —en la base, en la misma transacción—.
Entrega al menos una vez; dedup por `eventId` (determinista, el mismo en el SDK
y en la RPC); orden por proyecto + llamada lógica (`seq`). El agregador
(`AgregadorDePresupuesto`) se queda con el evento de mayor `seq` de cada intento,
así que el resultado no depende del orden ni de los duplicados. Los intentos
abiertos no se cierran solos: `abiertosMasViejosQue` / `revisarAntiguedad` (y
`bvsala.presupuesto_abiertos`) son el gancho de la alerta por antigüedad y de la
conciliación manual.

## Decisiones provisionales (revisables por el dueño)

- Moneda: solo USD, micro-USD enteros, catálogo versionado existente, sin FX.
- Usage desconocido: se reserva la cota conservadora (entrada máxima +
  `max_tokens`) y se mantiene como exposición hasta liquidar.
- Almacenamiento del piloto: perímetro del cliente (en memoria); la migración
  0036 queda escrita para cuando el dueño quiera el libro duradero.
- Una estimación cuenta para el tope por su importe (al menos el suelo). Si se
  prefiere retener la reserva entera hasta conciliar, es un cambio de una línea.

## Límites conocidos

- Sin cablear: ni el gateway, ni el pipeline, ni el ingest lo usan. No cambia
  `USAGE_ALLOWED_FIELDS` ni el comportamiento por defecto.
- La RPC recibe el importe calculado por el SDK: el catálogo de precios vive en
  TypeScript, no en la base.
- La 0036 no se ha ejecutado nunca contra un Postgres: el repositorio no tiene
  ni parser de SQL ni base de pruebas. Está revisada a ojo y con
  `test/migracion-0036.test.ts`.
- Los niveles de servicio (priority/flex/batch) y las tarifas de herramientas
  del servidor no están en la cota (los mismos huecos que D02).

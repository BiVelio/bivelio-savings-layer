# D06 · Proyección estable (plan Caveman 2026-10-14)

Estado: **implementado en sombra, apagado por defecto, sin exportar**. Ruta piloto
única: Anthropic Messages **sin stream**, desde el SDK. Depende de D03 (#475) y
D04 (#477). No depende de D05 (motor Caveman): los transformadores son los
deterministas propios.

## Qué hay

| Pieza | Fichero | Qué hace |
|---|---|---|
| Elecciones persistidas | `src/retrieval/elecciones-persistidas.ts` | Interfaz `AlmacenDeElecciones` + `AlmacenDeEleccionesEnMemoria`. Clave `(tenant, project, session, branch, epoch, segment_id, source_hash, adapter_revision)`. Guarda bytes de sustitución, su sha256, `transformId`/`version`, huella de política y handle. Compare-and-set: el segundo escritor recibe la elección del primero. Estado de rama (época + manifiesto) también con compare-and-set. Clave de idempotencia ligada a la huella del cuerpo: otro cuerpo → `conflicto`. |
| Proyector | `src/compression/proyeccion-estable.ts` (`ProyectorEstable`) | Recibe el cuerpo del llamante y devuelve una COPIA para el proveedor. Solo cambia el `content` de `tool_result` elegidos y, en modo recuperable con ejecutor, añade `bvsala_retrieve` al FINAL de `tools`. Antes de devolver deshace los cambios y exige igualdad byte a byte con la entrada. |
| Ejecutor | `crearEjecutorDeRecuperacion(almacen)` | Lee todas las páginas del almacén D04 con el ámbito y la política de la proyección, verifica la sha256 del objeto entero y devuelve el original exacto (o un rango de líneas). Ajeno/caducado/inventado → `not_found`. |
| Bucle | `ejecutarConRecuperacion({ cuerpo, proyector, crear })` | `crear` es la llamada real (`(b) => client.messages.create(b)`). Ejecuta las llamadas a `bvsala_retrieve` y vuelve a llamar; devuelve al llamante en cuanto la respuesta no pide recuperar. Cuenta el `usage` de todas las rondas. |

## Modos

`modo` en las opciones del proyector:

- `off` (por defecto): devuelve el mismo objeto; no lee ni escribe almacenes.
- `record`: decide como lo haría `recoverable` y lo cuenta en el informe (`status: "recorded"`), pero manda el cuerpo original y no escribe nada.
- `lossless`: solo el JSON sin omisiones de D03 (`json-lossless`), persistido.
- `recoverable`: además, texto grande no-JSON ≥ 16 KiB → vista previa determinista (cabecera con el handle, 20 primeras líneas, hasta 20 líneas del medio con señales de fallo y su número de línea, 20 últimas) y original al almacén D04 **antes** de devolver la vista previa.

## Reglas que se cumplen (y qué test las fija)

Todas en `test/proyeccion-estable-d06.test.ts`.

- **Solo se decide al nacer.** Un `tool_result` detrás del último `assistant` se decide; uno anterior sin elección ya viajó tal cual y se fija `identity` (`born_before`). Así encender el modo a mitad de sesión no reescribe lo ya cacheado.
- **Segundo turno, mismos bytes.** El prefijo enviado en el turno 2 tiene la misma sha256 que el turno 1, también desde otra instancia con los mismos almacenes.
- **Dos escritores convergen.** Mismos bytes; el perdedor borra su objeto del almacén (queda uno).
- **Sin recuperación comprobada no hay omisiones.** Sin ejecutor, sin almacén, `tool_choice: none`, nombre de herramienta que choca, segmento > 1 MiB, almacén lleno o sha256 que no cuadra → JSON sin omisiones o el original, y sin herramienta.
- **JSON nunca se omite**: solo `json-lossless`. Tampoco el JSON que el parser estricto para por una clave duplicada o un surrogate suelto: va el original.
- **Protegido**: la vista de un fichero (argumentos con `path`, `file_path`…, la regla de D03), `is_error: true`, el resultado de la propia recuperación, content con imágenes o varios bloques, ids repetidos. Fuera de los `tool_result` no se toca nada (system, user, assistant, `tool_use` con id y argumentos, thinking firmado, `cache_control`).
- **Épocas.** Añadir al final conserva la época. Editar/reordenar/bifurcar (el manifiesto guardado deja de ser prefijo) abre época nueva y la historia va como la trae el llamante.
- **Política.** Antes de cada envío se compara la huella vigente con la de cada sustitución no-`identity` que se reenviaría. Distinta → época nueva y no se reenvían esos bytes (por defecto) o `ErrorDeProyeccion("policy_changed")` con `alCambiarPolitica: "denegar"`. Un handle que ya no se puede leer → época nueva (`recovery_unavailable`).
- **Revisión del adaptador.** Con otra `adapterRevision` se sigue mandando lo vigente; lo que propondría la nueva queda como sombra (`elecciones.sombras(...)`).
- **Historia intacta.** La entrada congelada (`Object.freeze` profundo) no se modifica.
- **Idempotencia.** Misma clave y cuerpo distinto → `idempotency_conflict` sin escribir nada.
- **Sin identidad no hay proyección.** Ámbito incompleto o política vacía → `invalid_request` (no un bypass).

## Límites conocidos

- **Solo Anthropic Messages sin stream.** `stream: true` → passthrough (`unsupported_route`). Chat, Responses y Gemini no pasan por aquí.
- **No está cableado** al pipeline ni al middleware `anthropicSavings`: ese middleware reenvía la petición intacta (R1) y cambiar eso es otra decisión. Hoy se usa llamando al proyector/bucle con el cliente propio.
- **Sin exportar**: la API 0.5 está congelada; publicarlo como experimental es decisión del dueño.
- **Herramienta desde el primer turno.** En modo recuperable con ejecutor, `bvsala_retrieve` va en `tools` en TODOS los turnos (al final), haya o no omisiones, para que el bloque `tools` —lo primero del prefijo de Anthropic— no cambie a mitad de sesión. Su schema es sobrecoste fijo (`estimate.overheadTokens`) y puede hacer el ahorro negativo en sesiones sin resultados grandes.
- **Estimaciones.** Los tokens son del estimador heurístico (no hay tokenizador local de Anthropic); `basis: "estimated"` siempre.
- **Respuesta mixta.** Si el modelo pide recuperar y a la vez usa una herramienta del llamante, el bucle devuelve las recuperaciones ya ejecutadas en `resultadosPendientes`; el llamante tiene que ponerlas junto a sus `tool_result`.
- **En memoria.** Ambos almacenes son de un proceso; entre procesos hace falta un backend con escritura condicional (UNIQUE en Postgres, `SET NX` en un KV). No hay migración: el contenido no va a Supabase (perímetro cliente).
- **Sin circuit breaker, timeout ni colas** (eso es D05/D09): los transformadores son síncronos y acotados por los guardarraíles de 1 MiB/segmento y 8 MiB/petición.
- **Sin recibo económico** (D02/D07): el informe es de capacidad, no facturable.

## Decisiones provisionales (revisables por el dueño)

Tomadas por el lead con los valores por defecto del plan:

- Piloto: Anthropic Messages sin stream desde el SDK; streaming, Responses y Chat en passthrough.
- Retención 24 h, lease de tarea ≤ 2 h (cada envío fija el handle 2 h), 256 MiB por sesión, 1 MiB por segmento, 8 MiB por petición.
- Privacidad al recuperar: revalidar huella; distinta → reconstruir en época nueva (por defecto) o denegar.
- Almacenamiento en el perímetro del cliente (en proceso); nada de contenido a Supabase.
- Propias de este ticket: umbral recuperable 16 KiB; JSON solo sin omisiones; herramienta presente desde el primer turno; `is_error` protegido.

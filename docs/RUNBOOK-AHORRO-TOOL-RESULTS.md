# Manual de operación — ahorro en tool results (transformador opcional)

Este manual cubre el transformador del plan Caveman (D05/D09): el que sustituye `tool_result` grandes por una vista más pequeña y recuperable, a través de un sidecar local.

**Lee esto primero: hoy NO hay nada encendido.** El contrato (`src/transformador/contrato.ts`), el adaptador (`gateway/sidecar-caveman.ts`) y el gobierno (`src/transformador/operacion.ts`) existen y están probados. Pero **no están cableados** al pipeline ni al gateway, y eso llega con D06. Por defecto el transformador está apagado y además falla cerrado. Este manual describe cómo se opera una vez cableado, y qué hay que poder hacer ANTES de encenderlo en ningún sitio.

> **Decisiones provisionales del piloto, revisables por el dueño:**
>
> - **Ruta:** Anthropic Messages sin streaming, por el SDK.
> - **Límites del sidecar:** plazo de 100 ms; 4 en vuelo y 16 en cola; el cortacircuitos se abre a los 5 fallos de infraestructura seguidos y prueba una sonda a los 30 s.
> - **Tamaños:** 1 MiB por segmento y 8 MiB por petición.
> - **Retención:** 24 h; lease de tarea ≤ 2 h; 256 MiB por sesión.
> - **Calidad:** no inferioridad de 1 pp en tareas no críticas y cero fallos en tareas críticas.
> - **Almacenamiento:** dentro del perímetro del cliente. Ningún contenido va a Supabase.
> - **Presupuesto de evaluación de pago en esta ronda:** 0.

La regla que manda en todo el manual (plan p. 15): **revertir detiene las transformaciones NUEVAS y conserva las fuentes y las representaciones vivas.** Nunca se borra una tabla, un original ni un handle vivo para «arreglar» algo.

---

## 0 · Los mandos

| Mando | Qué hace | Qué NO hace |
|---|---|---|
| `BVSALA_TRANSFORMADOR=on\|off` | Interruptor general. Por defecto `off`. | No corta `retrieve` ni `release`. |
| `BVSALA_TRANSFORMADOR_VERSION=<id>` | Versión para épocas NUEVAS. | No cambia de versión a una época viva. |
| `BVSALA_TRANSFORMADOR_RETIRADAS=<id>,…` | Esas versiones dejan de transformar, también en sus propias épocas, que pasan a `version_retired` y envían el original. | No retira sus handles: se siguen recuperando a través de ellas. |
| `BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS=<proyecto>,…` | Interruptor por proyecto. | Igual que el general: la recuperación sigue. |

- **Si un valor no se entiende, todo queda apagado.** Pasa con cualquier valor que no cumpla el formato: un id con espacios, una lista con un hueco, un `on` sin versión. `configDesdeEntorno` lo explica en `avisos`. Revisa esos avisos al arrancar.
- **La configuración se lee en cada llamada** (`TransformadorGobernado` recibe un getter). Cambiarla surte efecto sin reiniciar si quien arranca relee el entorno o su fichero. Un getter que lanza equivale a apagado.

## 1 · Vivo y listo

- **`vivo()` (liveness).** No hace E/S ni inferencia y nunca toca el sidecar. Que el sidecar esté caído NO significa que el SDK esté muerto: **no** reinicies el proceso por esto.
- **`listo()` (readiness).**
  - Apagado responde «listo» (`disabled`): sirve en passthrough.
  - Encendido exige tres cosas:
    - la versión activa existe y no está retirada;
    - la sha256 del binario declarado es la esperada;
    - `capabilities` responde con el `runtime_build` fijado.
  - Pide `capabilities` y nada más: no optimiza ni infiere.
  - Motivos de «no listo»: `version_unknown`, `version_retired`, `engine_unverified`, `version_mismatch`, `invalid_endpoint`, `runtime_unavailable`.
- **No listo no bloquea tráfico.** Las peticiones siguen con su original autorizado (bypass). Readiness sirve para que el operador lo vea y para no promover de etapa, no para tirar tráfico.

## 2 · Métricas (en proceso, `MetricasTransformador`)

**Cardinalidad acotada por construcción:**

- **Motivos:** del catálogo cerrado `MOTIVOS`; el resto cuenta como `other`.
- **Tamaño:** cuatro cubos (`lt_4k`, `lt_64k`, `lt_1m`, `ge_1m`).
- **Proyecto:** los 32 primeros; el resto va a `_otros`.
- **Versión:** solo las registradas.
- **Nunca** tenant, sesión, usuario, handle ni contenido.

`aTextoPrometheus()` da el texto de exposición. Exponerlo, y dónde, es decisión de quien arranca.

| Métrica | Alerta |
|---|---|
| `bvsala_transformador_latencia_ms{cubo,quantile}` (p50/p95/p99, ventana de las últimas 1024 por cubo) | Con ventana: p99 por encima del plazo (100 ms) durante 15 min en cualquier cubo. |
| `bvsala_transformador_decisiones_total{motivo}` | Con ventana: `deadline` + `runtime_unavailable` > 20 % de las decisiones en 15 min. `other` > 0 significa que un motor devuelve motivos fuera del catálogo: investigar. |
| `bvsala_transformador_proyecto_total{proyecto,resultado}` | Informativa (cobertura por proyecto). |
| `bvsala_transformador_recuperaciones_total{resultado}` | `not_found` que crece cuando no hay handles caducados ni ajenos: posible pérdida de originales. |
| `bvsala_transformador_integridad_total{tipo}` | **Inmediata**, a partir de 1 en `recuperacion`. `plan_invalido` > 0 sostenido: aislar la versión (§3.5). |
| `bvsala_transformador_cortacircuitos{version,estado}` | `open` más de 5 min en la versión activa o en `<versión>/recuperacion`. |

Lo que NO miden estas métricas, y hay que cruzar con el ledger (D02/D07):

- **El ahorro en dinero.** `estimate` es diagnóstico (`basis: "estimated"`) y no va a facturación.
- **La exposición pendiente** por uso desconocido. Por decisión, se reserva la cota superior conservadora (máximo de entrada estimada + `max_tokens`) y se mantiene como exposición hasta liquidar.

## 3 · Runbooks

### 3.1 · Sidecar caído (o colgado)

**Síntomas:** `deadline` o `runtime_unavailable` disparados, cortacircuitos `open` en la versión activa y `listo()` en falso.

**Qué hace el sistema solo:**

- Cada petición espera como mucho el plazo (100 ms).
- Tras 5 fallos seguidos, el circuito se abre y las peticiones pasan **al instante** con su original autorizado (`circuit_open`).
- A los 30 s, una sola sonda decide si se cierra.
- Lo probado en tests:
  - un sidecar colgado nunca retiene una petición más del plazo, ni en ráfaga (25 a la vez);
  - un puerto cerrado da bypass inmediato.

**Qué haces tú:**

1. Comprueba que el **presupuesto admite el original**. El original sin comprimir es más grande: si una ruta iba justa de contexto o de presupuesto, el bypass puede dar un error de admisión. Esto es lo único que el sistema no resuelve solo.
2. Mira el proceso del sidecar con su supervisor (launchd/systemd): ¿vive?, ¿escucha en `127.0.0.1`?, ¿lo mató el OOM?
3. **No lo reinstales ni lo actualices en caliente.** Un binario nuevo tiene otra sha256 y otra versión: el adaptador lo rechazará (`engine_unverified` / `version_mismatch`), y es lo correcto. Para cambiar de binario, sigue §4.
4. Si no vuelve en 15 min, apaga el transformador del proyecto afectado (`BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS`) para dejar de pagar la sonda. Los handles vivos se siguen recuperando si el sidecar vuelve. Si no vuelve, ve a §3.2.

### 3.2 · Recovery caído

**Síntomas:** retrieves que fallan con `recovery_unavailable` o `runtime_unavailable`, o un `integrity_failure`. El cortacircuitos `<versión>/recuperacion` está en `open`.

**Qué hace el sistema solo:**

- Tras 3 fallos de infraestructura seguidos al recuperar, esa versión **deja de emitir omisiones nuevas** durante 30 s (`recovery_unavailable`).
- **Sin recuperación comprobada no se manda contenido con omisiones.**
- El retrieve no se bloquea nunca: se sigue intentando, y pasados los 30 s el siguiente hace de sonda.
- Un handle ajeno o una política cambiada NO cuentan como caída.

**Qué haces tú:**

1. **Una tarea que necesita un original que no se puede recuperar se pausa o se reinicia desde la fuente autorizada** (historial canónico, en una época nueva). **Nunca** inventes la fuente ni dejes que el modelo siga «de memoria».
2. Mira el almacén del sidecar: disco lleno, permisos, la clave de cifrado (`CAVEMAN_MIDDLEWARE_ENCRYPTION_KEY_FILE`) rotada sin migrar.
3. Si hubo **`integrity_failure`**:
   - trátalo como incidente, aunque sea uno solo;
   - aísla la versión con `BVSALA_TRANSFORMADOR_RETIRADAS=<versión>`;
   - conserva la evidencia técnica **sin payload**: el motivo, la hora y la versión, nunca el contenido ni el handle;
   - abre el caso con el responsable del runtime.
4. Mientras dure, el sistema sigue dando servicio en passthrough.

### 3.3 · Ahorro negativo

**Síntomas:** el ledger (coste por tarea correcta) muestra que el brazo con transformador cuesta más que el de referencia, o la caché del proveedor deja de acertar: suben las escrituras de caché y bajan las lecturas.

1. **Detén el perfil afectado:** apaga el proyecto o retira la versión. Las sesiones vivas siguen recuperando lo que ya tienen.
2. Compara, por este orden:
   - **Escrituras de caché.** ¿Se rompió un prefijo establecido? Una época que cambia de bytes a mitad de sesión lo hace. Por diseño, una época viva no cambia de versión; si ha pasado, es un bug.
   - **Reintentos.** ¿Crecieron los intentos por llamada lógica (D02)?
   - **Sobrecoste de recuperación.** ¿Recupera el modelo casi todo lo que se omitió? Entonces la omisión no compensa.
3. **No borres las pérdidas.** El ahorro negativo se registra tal cual, con su denominador. Un experimento inconcluso se queda en prueba: no pasa a Active.

### 3.4 · Fuga (lectura cruzada, reidentificación, bypass de Privacy)

**Señales que alertan al momento:**

- un retrieve que devuelve algo de otro ámbito;
- un `ErrorDePrivacidad` que alguien convirtió en bypass;
- contenido, un handle o una credencial en un log;
- una conexión saliente del sidecar fuera de loopback.

**Qué haces:**

1. **Revoca los ámbitos afectados:** `release(scope)` de cada sesión implicada. Va a todas las versiones y llama a `sessions/delete` del runtime. Comprueba que devuelve `revoked: true`, o repite: es idempotente.
2. **Bloquea la ruta:** `BVSALA_TRANSFORMADOR=off`. Si el sidecar hizo salida a red, para el proceso del sidecar. Aquí sí: una fuga activa pesa más que la recuperación.
3. **Conserva la auditoría mínima, sin payload:** ámbitos (como huella, no en claro), horas, versión, motivo.
4. Activa la respuesta a incidentes de seguridad (`SECURITY.md`). **Toda credencial que haya podido verse está quemada: se rota.**

### 3.5 · Marcha atrás (rollback)

**Cuándo:** una versión nueva da más `invalid_plan`, más latencia o ahorro negativo.

1. `BVSALA_TRANSFORMADOR_VERSION=<anterior>` y `BVSALA_TRANSFORMADOR_RETIRADAS=<nueva>`.
2. Qué pasa con cada época (probado en tests):
   - las épocas **nuevas** nacen en la anterior;
   - las épocas **de la anterior** siguen con ella, sin cambio de bytes;
   - las épocas **de la nueva** dejan de transformar (`version_retired`) y envían el original, pero **sus handles se siguen recuperando a través de la nueva** hasta que caduquen (24 h) o se haga `release`.
3. **No desinstales el binario de la versión retirada** hasta que caduque la retención de la última época que la usó. Si lo quitas antes, sus handles dan `not_found` (deniega, sin fuga, pero el modelo pierde la fuente).
4. **No se borran** tablas, columnas, originales ni reemplazos de épocas vivas. La migración es expand/contract, con un solo escritor con autoridad cada vez.
5. **Ensaya** que conviven un cliente antiguo y uno nuevo **antes** de necesitar la marcha atrás, no durante.

## 4 · Etapas de despliegue (Expand → Record → Shadow → Replay → Canary → Active)

Ninguna etapa se salta. Pasar a la siguiente es una decisión registrada, con su evidencia. Retroceder siempre está permitido, y es §3.5.

| Etapa | Entrada | Operación | Salida (para avanzar) | Revertir |
|---|---|---|---|---|
| **Expand** | Este PR + D06 fusionados; sidecar sin instalar; flags apagados. | Tablas, índices o versiones nuevas si las hay (migraciones aplicadas a mano por el dueño, por runbook); RLS; flags `off`. Sin tocar el historial antiguo. | Migración verificada; cliente N-1 compatible; `vivo()` y `listo()` responden en `disabled`. | No hay nada que revertir: está todo apagado. |
| **Record** | Expand cerrada. | Instrumentar el Savings actual: usage por intento (D02) y cobertura de precio. Contrato y mocks en CI. | Baseline y catálogo de precios completos para el segmento piloto (Anthropic Messages sin streaming). | Apagar la instrumentación nueva. |
| **Shadow** | Binario verificado según `docs/especificaciones/CAVEMAN-D05-ENGINE.md` §5–§6: build reproducible, sha256, SBOM, govulncheck limpio y **auditoría de salida a red superada**. | Generar candidatos en local **sin servirlos** (modo `record`, o el plan calculado y descartado). Sin duplicar inferencia. | Cero `integrity_failure`; `invalid_plan` explicado; p99 dentro del plazo por cubo; CPU/RSS del sidecar medidos. **El shadow local no acredita calidad del modelo.** | `BVSALA_TRANSFORMADOR=off`. |
| **Replay / eval** | **Presupuesto autorizado por el dueño (hoy 0: esta etapa está BLOQUEADA).** Dataset fijado con su manifiesto. | Los cuatro brazos del plan (A referencia, B determinista, C recuperable, D competidor), pareados por caso y con cachés separadas. | Ahorro neto por tarea correcta sustentado con intervalos; no inferioridad ≤ 1 pp en tareas no críticas; **cero fallos en críticas**, con cada excepción revisada. Inconcluso = se queda aquí. | No se promueve. |
| **Canary** | Replay superado. Un proyecto interno permitido. | Asignar sesiones **completas** a la cohorte (nunca media sesión). `BVSALA_TRANSFORMADOR=on` solo para ese proyecto. | Sin fallo crítico durante la ventana acordada; métricas de §2 sin alertas; ledger sin ahorro negativo. Ampliar por segmentos, con evidencia de cada uno. | §3.5, o apagar el proyecto. |
| **Active / contract** | Canary ampliado con evidencia. | Promover el bundle y **conservar el anterior** registrado. Retirar el legado solo tras cerrar sus sesiones y caducar su retención. | — | §3.5: siempre disponible mientras viva la versión anterior. |

## 5 · Lo que este manual aún no puede prometer

- **Pins que sobreviven a un reinicio.** El registro de épocas y el de handles del adaptador viven en el proceso. Tras un reinicio, un handle anterior da `not_found` (deniega, sin fuga). Los dos son interfaces (`RegistroDeEpocas`) pensadas para respaldarse con almacenamiento duradero. Hasta que eso exista (D06), **un deploy pierde la recuperación de las sesiones vivas**, así que en Canary hay que desplegar entre sesiones, no durante.
- **Ensayos reales de caída.** No se han hecho contra el binario real de store, sidecar o base de datos. Lo probado es contra un doble (`test/helpers/sidecar-caveman-falso.ts`). Antes de Canary hay que repetir §3.1–§3.5 contra el runtime de verdad.
- **SLO.** No está aprobado. Los valores de arriba son hipótesis del piloto, no capacidad garantizada: el SLO se fija con carga representativa medida en Shadow.
- **Responsables on-call.** Están sin asignar (decisión abierta del plan).

# D05 · Engine opcional: versión fijada, licencia y adaptador de sidecar (2026-10-15)

**Ticket:** D05 del «Plan de desarrollo Caveman 2026-10-14» (Runtime + Legal/OSS). **Depende de:** D03 (`src/util/json-estricto.ts`, PR #475) y D04 (`src/util/hash.ts` con `sha256DeBytes`, PR #477).
**Estado:** contrato y adaptador escritos y probados contra un sidecar FALSO. Nada cableado al pipeline ni al gateway. Ningún binario de Caveman descargado, ejecutado ni incorporado.

**Cómo se hizo la revisión:** solo lectura con `gh api` sobre `github.com/JuliusBrussee/caveman`: ficheros de licencia, `go.mod`, la comparación entre tags, la documentación del engine y del protocolo de middleware y los esquemas JSON. Los nombres de los assets de las releases se listaron sin descargar ningún binario. El único asset que se leyó es el texto de `LICENSE.caveman-blocks`, para ver qué licencia era. Todo lo citado del repositorio de Caveman son datos de terceros. Antes de encender nada, una persona tiene que volver a comprobarlo (ver §6).

> **Decisiones provisionales, revisables por el dueño:**
>
> - **Versión elegida:** v4.0.1 en lugar de v3.2.0 (§2).
> - **Piloto:** Anthropic Messages sin streaming a través del SDK.
> - **Límites:** plazo de 100 ms; concurrencia de 4 trabajos con cola de 16; cortacircuitos que se abre tras 5 fallos y prueba una sonda a los 30 s.
> - **Tamaños:** 1 MiB por segmento y 8 MiB por petición.
> - **Retención:** 24 h.
> - **Ubicación:** todo dentro del perímetro del cliente (proceso local, loopback). Ningún contenido va a Supabase.
> - **Presupuesto de evaluación:** 0. Solo pruebas offline y con dobles.

---

## 1 · Las dos versiones candidatas

| | v3.2.0 | v4.0.1 |
|---|---|---|
| Publicada | 2026-10-08T05:42:14Z | 2026-10-13T18:34:04Z |
| Objeto tag (anotado) | `4192fb38ae0921c7b4baa9c5fa6fa1b90dbcdaf4` | `d0be14f2dc92a99d12e717465d6908723ab9bfdb` |
| **Commit** | `e20f07e8152a0c0360f58c09e79d30ac94329991` | `d262ab3882952a59312ff3537cd86d894523c5ab` |
| Tag de binarios | `bin-v2.1.0` → commit `e20f07e8…` (el mismo) | `bin-v4.0.1` (tag `36113838…`) → commit `a5705b01a5d877c34d44c4961f14816b21bfb72a` |
| Licencia | Apache-2.0 (todo el repo desde 3.0.0) | Apache-2.0, ficheros idénticos |
| `LICENSE` sha256 | `cfc7749b…bc523d30` | igual |
| `NOTICE` sha256 | `20112dc6…18216fc` | igual |
| `LICENSING.md`, `TRADEMARKS.md`, `LICENSE-MIT` | — | byte a byte iguales que en v3.2.0 |
| Go / `golang.org/x/net` | 1.26.8 / v0.59.0 | 1.26.9 / v0.60.0 |
| Protocolo de middleware | 1.1 | 1.1: `middleware-protocol.md` idéntico; los esquemas JSON solo cambian en `$id` |

En v4.0.1 los binarios salen de un commit distinto del de la release. `bin-v4.0.1` apunta a `a5705b01`. `v4.0.1` apunta a `d262ab38`, que va un commit por delante de `a5705b01` («chore: sync SKILL.md copies»), y la comparación solo muestra cambiado `dist/caveman.skill`. El código del runtime es el mismo en los dos commits. El binario que se compile y verifique debe salir de **`a5705b01`**.

### 1.1 · Licencia, alcance y lo que queda fuera

- **Código (Apache-2.0).** Desde 3.0.0, Apache-2.0 cubre todo el repositorio: skill, CLI, SDKs, middleware, extensión y runtime (Engine, Proxy, Browse, MCP, `shrink`, `mem/`, `shared/platform/`) (`LICENSING.md`). Las versiones anteriores a 3.0.0 mantienen sus términos: MIT más BUSL-1.1 con Additional Use Grant para el runtime. Por eso el plan exige ≥ 3.0.0, y las dos candidatas lo cumplen.
- **Caveman Cloud.** Es software comercial aparte, su código no está en el repo y la licencia no lo cubre. **No se incorpora.**
- **Marcas.** «Caveman», el wordmark y el logo son marcas de Julius Brussee, con solicitud pendiente en las clases Niza 9 y 42. Apache-2.0 no concede derechos de marca (`TRADEMARKS.md`). Se permite el uso nominativo veraz: «compatible con Caveman». No podemos llamar Caveman a nada nuestro ni usar su logo, ni sugerir patrocinio. **No se incorporan las marcas.** En el código, el nombre solo aparece para identificar el protocolo (`gateway/sidecar-caveman.ts`), igual que se nombra a cualquier proveedor.
- **Terceros que viajan con los binarios** (`NOTICE`):
  - `engine/pixel/`: port de pxpipe (MIT), con glifos de Spleen (BSD-2-Clause) y GNU Unifont (OFL-1.1 / GPLv2 con excepción de embebido de fuentes).
  - `browse/`: enlaza chromedp (MIT).
  - Los binarios enlazan módulos Go MIT, BSD-3-Clause y Apache-2.0. Sus textos van en `THIRD_PARTY_GO_LICENSES.tar.gz`.
  - Los binarios de release se compilan con `zig cc`: runtime de Zig (MIT) y musl (MIT) en Linux, mingw-w64 (ZPL-2.1) en Windows.
  - La CLI porta parte de Qwen Code (Apache-2.0) y empaqueta `@clack/prompts` (MIT).
- **`LICENSE.caveman-blocks`.** Asset de `bin-v4.0.1`, también Apache-2.0. Blocks es un producto aparte que tampoco se incorpora.

### 1.2 · Dependencias Go declaradas (`go.mod`, un único módulo para todo el repo)

- **Directas:**
  - `Microsoft/go-winio` v0.6.2
  - `chromedp/cdproto` v0.0.0-20260714215040
  - `chromedp/chromedp` v0.16.0
  - `go-json-experiment/json` v0.0.0-20260623181947
  - `jackc/pgx/v5` v5.11.0
  - `klauspost/compress` v1.20.1
  - `smacker/go-tree-sitter` v0.0.0-20240827094217
  - `tiktoken-go/tokenizer` v0.8.1
  - `golang.org/x/net` (v0.59.0 en v3.2.0, v0.60.0 en v4.0.1)
  - `golang.org/x/sys` v0.48.0
  - `gopkg.in/yaml.v3` v3.0.1
  - `modernc.org/sqlite` v1.59.0
- **Indirectas (20):**
  - `chromedp/sysutil`
  - `dlclark/regexp2/v2`
  - `dustin/go-humanize`
  - `gobwas/{httphead,pool,ws}`
  - `google/uuid`
  - `jackc/{pgpassfile,pgservicefile,puddle/v2}`
  - `kr/text`
  - `mattn/go-isatty`
  - `ncruces/go-strftime`
  - `remyoudompheng/bigfft`
  - `rogpeppe/go-internal`
  - `golang.org/x/{sync,text}`
  - `modernc.org/{libc,mathutil,memory}`

`go.mod` describe el módulo, no lo que acaba enlazado en cada binario. Lo que de verdad lleva `caveman-proxy` se saca del binario compilado (§5).

### 1.3 · Qué cambió de v3.2.0 a v4.0.1 (`gh api compare`)

**Tamaño:** 554 commits por delante, 0 por detrás, 300 ficheros. Por carpeta: `packages` 144, `proxy` 81, `docs` 12, raíz 11, `agents` 11, `engine` 8, `.github` 7, `installer` 6, `deploy` 4, `mem` 4, `browse` 3.

Lo relevante para nosotros:

- **Seguridad (el motivo de §2).** El commit `9193c6d5` («fix(deps): Go 1.26.9 and golang.org/x/net 0.60.0 for GO-2026-6617») dice que govulncheck marca `net/http`, `crypto/tls`, `net/textproto` y `html/template` de Go 1.26.8 y `x/net` 0.59.0. Según el commit, esas funciones vulnerables son alcanzables desde el proxy. Los binarios de release se compilan con la versión de `go.mod`. El runtime de middleware es un servidor `net/http`.
- **Engine.** Hay 8 ficheros cambiados y ninguno toca el protocolo:
  - `ccr/store_sqlite.go`: reintento ante `SQLITE_BUSY` al abrir el WAL.
  - `compressors/code_listing.go`: números de línea verdaderos tras elidir.
  - `cmd/caveman-engine/main.go`: subcomando de versión, con tests.
- **Proxy: más superficie con salida a red.**
  - **Calentado de caché.** Con el módulo `waste-fixes` activo, el proxy reenvía a `api.anthropic.com` una copia de la petición (`max_tokens: 0`) para mantener la caché caliente. Se apaga con `CAVEMAN_CACHE_WARM=off`.
  - **Routing «Auto» a Caveman Cloud.** Envía contenido de los turnos a Cloud, pero solo con sesión iniciada y el módulo `routing` activo.
  - Nada de esto está en la ruta `/caveman/v1/middleware/*`. Aun así, va en el mismo binario, y por eso la auditoría de salida a red (§6) es obligatoria.
- **Telemetría de la CLI.** Se amplía a Caveman Blocks. Afecta a la CLI `caveman` (opt-out, activa por defecto), no a `caveman-proxy serve`: según `SECURITY.md`, «ejecutar el binario directamente no implica CLI ni telemetría». **No se usa la CLI.**
- **El resto** es instalador, CLI, hooks de agentes, Windows, catálogo de modelos y documentación.

## 2 · La versión fijada: **v4.0.1**, binarios de `bin-v4.0.1` (commit `a5705b01`)

El plan pide preferir la versión con más rodaje salvo que haya un motivo de licencia o de seguridad. **Aquí lo hay.**

- **v3.2.0 sale con vulnerabilidades conocidas.** Los binarios de v3.2.0 (`bin-v2.1.0`) se compilaron con Go 1.26.8 y `x/net` 0.59.0, y su propio autor marca vulnerabilidades alcanzables desde el proxy. El componente que usaríamos es precisamente ese servidor HTTP.
- **Parchear v3.2.0 sería otra versión.** Compilarla con un toolchain parcheado y subir `x/net` sería una modificación nuestra sin el rodaje de nadie: una versión que no existe aguas arriba.
- **Para nosotros, lo que cambia en v4.0.1 es poco.** La licencia es idéntica byte a byte, el protocolo y los esquemas son idénticos, y los cambios del engine son pequeños.
- **El coste es el rodaje.** A fecha de hoy v4.0.1 lleva 2 días publicada, frente a 7 de v3.2.0, y estrena funciones de proxy con salida a red. Se compensa con el orden de despliegue de D09: Record → Shadow (local, sin servir candidatos) antes de cualquier Canary, y con la auditoría de salida a red de §6. Si el dueño prefiere rodaje sobre parche, la alternativa es v3.2.0 compilada con Go ≥ 1.26.9 y `x/net` 0.60.0, declarada como «modificación propia» según §4.

**Qué se ejecutaría.** `caveman-proxy serve` (el runtime de middleware, `proxy/cmd/caveman-proxy`), no la CLI `caveman-engine`. El motivo es que la CLI del engine lee stdin y no tiene ámbito, idempotencia ni límites por petición. El protocolo de middleware 1.1 sí los tiene:

- un scope que se convierte en autoridad;
- handles `cmw_` de 24 bytes aleatorios;
- 404 sin revelar existencia;
- choices persistidas;
- `sessions/delete`.

**En el adaptador:** `versionFijada` debe coincidir exactamente con el `runtime_build` que anuncia `GET /caveman/v1/middleware/capabilities`. Ese valor es la variable `version` de `proxy/cmd/caveman-proxy/main.go`, que se inyecta al compilar. Hay que fijarlo a lo que imprima `caveman-proxy version` sobre el binario verificado. Además, `sha256Esperado` debe ser la del binario de un build reproducible (§6).

## 3 · Lo que se incorpora y lo que no

**Se incorpora (en este PR):**

- **`src/transformador/contrato.ts`.** El contrato del plan (p. 4): `Mode`, `Scope`, `Segment`, `OptimizeRequest`, `Replacement`, `OptimizeResult` y `SavingsTransformer` con `optimize`, `retrieve` y `release`. Incluye:
  - un catálogo cerrado de motivos;
  - `validarPlan`, que valida el plan entero;
  - `aplicarPlan`, que aplica sobre una copia y comprueba que los segmentos protegidos salen idénticos;
  - `recuperarEntero`, que reensambla el original y lo verifica contra la sha256 apuntada al emitirlo;
  - errores que **detienen** la petición en lugar de hacer bypass (`ErrorDePrivacidad`, `PeticionInvalida`).
- **`src/transformador/guardas.ts`.** El cortacircuitos (5 fallos seguidos, 30 s, una sola sonda, reloj monótono) y `ColaJusta` (4 en vuelo, 16 en cola, turnos por tenant, máximo la mitad de la cola por tenant).
- **`gateway/sidecar-caveman.ts`.** Cliente propio del protocolo de middleware 1.1, escrito desde la especificación publicada sin copiar código de Caveman. Usa `node:http`, `node:crypto` y `node:fs`, y por eso vive en `gateway/` (Node) y no en `src/`, que por invariante es seguro para navegador (`test/revocation.test.ts`).
- **Ninguna dependencia nueva.** No hay ninguna en el paquete raíz ni en ningún otro.

**No se incorpora:**

- **Código o binarios de Caveman.** Nada de eso entra en este repo: ni el SDK `@caveman-ai/*`, ni el middleware, ni la CLI, ni Cloud, ni Blocks, ni las marcas.
- **Paquetes o imágenes que lleven Caveman.** Tampoco distribuimos ninguno. El operador instala el runtime aparte, desde su build verificado.
- **Arranque del proceso.** El adaptador no lo arranca, no lo descarga y no lo instala. Habla con lo que ya escucha en loopback y lo verifica antes de usarlo.

## 4 · Obligaciones (Apache-2.0 §4) y cuándo nacen

- **Mientras no redistribuyamos el binario.** Si el operador instala el runtime aparte, que es el diseño de este PR, no copiamos ni distribuimos obra de Caveman. Nuestras obligaciones se limitan a no usar sus marcas y a citar el protocolo con atribución, como hace este documento.
- **Si un día se empaqueta o se distribuye el binario.** Esto incluye una imagen de contenedor nuestra o un instalador. En ese caso hay que:
  - acompañarlo de `LICENSE` y `NOTICE` tal cual, más los avisos de terceros de la release: `THIRD_PARTY_GO_LICENSES.tar.gz`, `NOTICE.engine-pixel`, `NOTICE.browse`, `SPLEEN_LICENSE.txt`, `UNIFONT_LICENSE.txt`, `LICENSE.zig`, `COPYRIGHT.musl` y, en Windows, `COPYING.mingw-w64`;
  - si se modifica cualquier fichero (por ejemplo, la alternativa de v3.2.0 con el toolchain parcheado), marcarlo como modificado y documentar el cambio, según §4(b);
  - no quitar avisos de copyright, patentes ni marcas de la fuente, según §4(c);
  - incluir un `NOTICE` derivado si añadimos el nuestro, según §4(d).
- **La patente (§3).** La licencia de patente termina si litigamos contra un contribuidor por patentes de la obra. Lo tiene que saber el área legal.

## 5 · Plan de SBOM

Lo hace una persona, en un entorno aislado y antes del primer Shadow:

1. Clonar `JuliusBrussee/caveman` y fijar el checkout en el commit `a5705b01a5d877c34d44c4961f14816b21bfb72a`, no en el tag (un tag se puede mover).
2. Compilar `caveman-proxy` dos veces, en dos máquinas, con el mismo toolchain (`go 1.26.9`, más `zig cc` si se replica el build de release), con `-trimpath` y `CGO` como en la release. Comparar las dos sha256. Si no coinciden, el build no es reproducible y no se habilita.
3. Comparar esa sha256 con la línea de `caveman-proxy_<os>_<arch>` del `checksums.txt` de `bin-v4.0.1`, verificando también su `checksums.txt.keysig`. Que no coincida no invalida nuestro build, pero hay que entender por qué antes de seguir.
4. SBOM del binario, no del repositorio:
   - `go version -m caveman-proxy` lista los módulos enlazados y sus versiones;
   - `cyclonedx-gomod bin` o `syft` generan el SBOM en CycloneDX;
   - `govulncheck -mode=binary caveman-proxy` debe salir limpio.
5. Guardar en `benchmarks/evidencia/<fecha>-caveman-sbom/` (un artefacto NUEVO y fechado):
   - el SBOM;
   - la salida de `go version -m`;
   - la de `govulncheck`;
   - las dos sha256;
   - las licencias de `THIRD_PARTY_GO_LICENSES.tar.gz` cotejadas con el SBOM.

   Cualquier dependencia sin licencia identificada bloquea la puesta en marcha (gate «Supply chain», plan p. 12).

## 6 · Lo que una persona tiene que verificar antes de encender el motor

El motor está apagado por defecto y el adaptador se niega a usarlo sin estos dos datos: `sha256Esperado` (64 hex) y `versionFijada` igual al `runtime_build`. Aun así, antes de configurarlos hay que comprobar lo siguiente:

1. **Checksum de un build reproducible.** Según §5, no basta con el `checksums.txt` de la release. Hay que configurar `binario.ruta` (absoluta) y `binario.sha256Esperado`. El adaptador rechaza un binario que el grupo u otros usuarios puedan modificar (modo `& 0o022`).
2. **Auditoría de salida a red.**
   - Arrancar el runtime en un sandbox que deniegue toda la red salvo loopback (por ejemplo, un netns sin rutas o `sandbox-exec` en macOS).
   - Ejecutar contra él la batería de contrato. Este PR trae la del adaptador; contra el binario real hay que escribir otra.
   - Registrar todo intento de conexión saliente. Para el piloto, cualquier conexión fuera de loopback lo bloquea.
   - Repetir la prueba con el entorno vacío y con el entorno de producción.
3. **Configuración del proceso.**
   - Usuario no root y sistema de ficheros mínimo, con escritura solo en su `CAVEMAN_HOME` y en el almacén.
   - **Sin claves de proveedor en el entorno** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). El protocolo prohíbe mandarle claves de proveedor. Sin claves, las rutas de proxy no tienen a quién reenviar.
   - Variables que hay que fijar:
     - `CAVEMAN_MIDDLEWARE_MODE=compress`;
     - `DO_NOT_TRACK=1`, `CAVEMAN_TELEMETRY=0` y `CAVEMAN_OFFLINE=1`;
     - `CAVEMAN_CACHE_WARM=off`.
   - **Sin sesión de Caveman Cloud.** No ejecutar `caveman login`.
   - Escuchar solo en `127.0.0.1`.
   - Credencial de runtime en `CAVEMAN_MIDDLEWARE_TOKEN_MAP_FILE` o `CAVEMAN_AUTH_TOKEN`. La pasa el operador por `credencial()` del adaptador y nunca se escribe en un log.
   - **Cifrado en reposo** con `CAVEMAN_MIDDLEWARE_ENCRYPTION_KEY_FILE`. No usar `CAVEMAN_MIDDLEWARE_ALLOW_PLAINTEXT_ORIGINALS`.
   - Límites alineados con las decisiones del piloto:
     - `CAVEMAN_MIDDLEWARE_RETENTION_SECONDS=86400`;
     - `CAVEMAN_MIDDLEWARE_DEADLINE_MS=100`;
     - `CAVEMAN_MIDDLEWARE_SEGMENT_BYTES=1048576`;
     - `CAVEMAN_MIDDLEWARE_REQUEST_BYTES=8388608`;
     - `CAVEMAN_MIDDLEWARE_QUEUE_DEPTH=16`.

     Los nombres salen de `proxy/internal/config/middleware.go` en v4.0.1. Hay que comprobar su semántica en el binario elegido, y que `QUOTA_BYTES` equivale a los 256 MiB por sesión.
4. **Revisión de lo que el plan pide revisar** (p. 10): el parser, la persistencia (`engine/ccr`, `modernc.org/sqlite`), los tests del protocolo (`proxy/internal/middleware/protocol_v11_test.go`) y los cambios entre tags (§1.3).
5. **Conformance contra el binario real.** Antes del Shadow, el adaptador tiene que pasar contra el runtime de verdad lo mismo que pasa contra el falso. El repo de Caveman publica vectores (`packages/sdk/parity/middleware-v1_1.fixtures.json`) que se pueden reutilizar.

## 7 · Garantías del adaptador y sus límites conocidos

**Lo que garantiza y está probado** (`test/transformador-sidecar-d05.test.ts`, contra `test/helpers/sidecar-caveman-falso.ts`):

- **Sin E/S de red cuando el motor no está listo.** Si el binario no verifica, si la versión no es la fijada o si el endpoint no es un loopback literal, no se hace ninguna petición.
- **Plazos.** Al vencer el plazo (100 ms) se hace bypass y no se espera más.
- **Cancelación.** Una cancelación se queda en bypass, no cuenta como fallo del motor.
- **Cortacircuitos.** Pasa de cerrado a abierto, luego a medio abierto y vuelve a cerrado, con una sola sonda. `no_candidate` no cuenta como fallo.
- **Tamaños.** Lo que pasa de 1 MiB o de 8 MiB se omite y no se trunca.
- **Respuestas rotas.** Una respuesta que no es JSON, con claves duplicadas, con UTF-8 inválido o con redirección se queda en bypass y cuenta para el cortacircuitos.
- **Planes inválidos.** Un plan con cualquier sustitución mala se rechaza entero: segmento no declarado o protegido, huella mal, sin prefijo, handle mal formado, transformación no pedida, duplicada o no más pequeña.
- **Retrieve.**
  - Si cambió la política, la petición se detiene.
  - Ámbito ajeno, handle inventado o handle tras `release` dan `not_found`, sin E/S.
  - Una huella distinta da `integrity_failure`.
  - Un extracto no se acepta como original.
  - Tiene cola propia, así que se puede recuperar aunque el optimizador esté saturado.
- **Credencial.** No aparece en `JSON.stringify` ni en `inspect`.

**Límites conocidos (abiertos):**

- **La sha256 verifica el fichero, no el proceso que escucha.** Que el binario en `ruta` sea el que tiene el puerto abierto lo garantiza el operador con su supervisor de procesos. El adaptador además exige el `runtime_build`, pero ese valor lo declara el propio proceso.
- **El registro de handles es de este proceso.** Tiene un máximo de 65 536 entradas y retención de 24 h, y sirve para revalidar la política al recuperar.
  - Tras un reinicio, un handle emitido antes da `not_found`, es decir, deniega por defecto.
  - Si está lleno, no se emite ninguna omisión nueva (bypass `capacity`).
  - Que los pins sobrevivan a un reinicio lo exige D09. Para eso hace falta que el registro esté respaldado por almacenamiento duradero, lo que llegará con D06 o D09 sobre la interfaz de D04.
- **El `input_digest` del plan no se recalcula,** porque su algoritmo no está en la especificación publicada. Sí se recalculan las sha256 de cada original y de cada sustitución.
- **No se implementa la «memoria de reemplazados» de §11 del protocolo** (prioridad tier A). Se admite en orden de entrada, así que el reparto del presupuesto entre segmentos puede diferir del de un cliente oficial. Nunca se trunca nada.
- **La cancelación no recupera trabajo ya enviado.** Cancelar aborta la petición HTTP, pero si el runtime ya guardó un original, se queda hasta que caduque. El protocolo dice que un plan no publicado no persiste; está por verificar en el binario real.
- **Ningún motor de Caveman es «sin pérdida».** Todas sus transformaciones utilizables son `exact_ccr` (omiten y se recuperan), así que en modo `lossless` el adaptador hace bypass (`unknown_capability`) sin E/S. El modo sin pérdida de verdad es el perfil `lossless-data` de D03, en el propio SDK.

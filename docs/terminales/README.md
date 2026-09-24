# Guías por terminal — medir el gasto de IA con el gateway local

**Fecha:** 2026-08-30 · **Fuente de verdad:** `docs/PASARELA-S3-TERMINALES.md`
§3 (formas de URL y mecanismos de enrutado verificados contra el código de cada
terminal). Cada afirmación va marcada **[V]** (verificada en fuente) o **[I]**
(inferida). Si una guía contradice a ese documento, manda el documento.

## Qué es esto

`bvsala gateway` es un proxy local medidor: escucha en `127.0.0.1`, reenvía
cada petición **byte a byte** al proveedor (`https://api.anthropic.com` por
defecto) y, una vez servida la respuesta, lee el `usage` del stream y lo
convierte en coste. Tus prompts jamás salen de tu máquina hacia BiVelio — solo
cuentas y coste. Es fail-closed como el SDK: arranca solo con tu clave de
servicio (`BIVELIO_SERVICE_KEY`) y una licencia BiVelio activa, que recoge con
esa clave y cuya firma verifica en tu máquina. Una vez arrancado, jamás corta
una petición en curso: si la licencia caduca o se revoca, solo las peticiones
NUEVAS reciben un HTTP 402 hasta renovarla. La medición es best-effort: con la
ingesta caída, reenvía y avisa.

Mide cada petición. Con licencia PRO aplica por defecto **una sola palanca**:
rebaja el TTL de escritura de caché mientras la sesión sigue caliente — cambia la
tarifa, nunca el contenido que lee el modelo. Las demás (modelo hermano, esfuerzo
por turno) van apagadas hasta que las enciendes. Y mide **todo el tráfico de inferencia**
que el terminal enruta por el base URL — no «todo el tráfico»: cada guía dice
lo que su terminal manda por fuera.

En suscripción (login de claude.ai en Claude Code, cuenta ChatGPT en Codex) no
hay factura por tokens: ese tráfico se mide a precio de lista equivalente y
nunca se le acredita ahorro ni comisión; la licencia por asiento hace falta
igual.

## Índice

| Guía | Base URL exacto | `/v1` | Enrutado [V] | Envoltorio | Estado |
|---|---|---|---|---|---|
| [Claude Code](claude-code.md) | `http://127.0.0.1:8402` | **sin** | env `ANTHROPIC_BASE_URL` | `bvsala claude` ✅ | [V] en producción |
| [Codex CLI](codex.md) | `http://127.0.0.1:8402/v1` (API key) · `…/backend-api/codex` (ChatGPT) | **con** | `codex -c openai_base_url=…` | `bvsala codex` ✅ | [V] validado en mano el 30-08 (426 → fallback HTTP, stream íntegro) |
| [Goose](goose.md) | `http://127.0.0.1:8402` | **sin** | env `ANTHROPIC_HOST` | `bvsala goose` ✅ | [V] |
| [Qwen Code](qwen-code.md) | `http://127.0.0.1:8402` | **sin** | env `ANTHROPIC_BASE_URL` + `~/.qwen/settings.json` | `bvsala qwen` ✅ | [V] |
| [opencode](opencode.md) | `http://127.0.0.1:8402/v1` | **con** | `~/.config/opencode/opencode.json` | — (config de usuario) | [V] |
| [Crush](crush.md) | `http://127.0.0.1:8402/v1` | **con**, sin barra final | `~/.config/crush/crushrc` | — (config de usuario) | [V] |
| [Droid](droid.md) | `http://127.0.0.1:8402` | sin **[I]** | `~/.factory/settings.json` | — (config de usuario) | validar en mano |
| [Cline](cline.md) | `http://127.0.0.1:8402/v1` | **con** | UI | — | [V] |
| [Kilo Code](kilo.md) | `http://127.0.0.1:8402/v1` | con **[I]** | UI | — | validar en mano |

Reglas de la columna «Base URL»: **nunca barra final**, **nunca redirecciones**
(un 3xx en el base URL es fallo por diseño del cliente, y el gateway lo reenvía
en vez de seguirlo). Y nunca copies el URL de un terminal a otro: cada SDK añade
su propio tramo de ruta y el error es silencioso (§ «Comprobar que mide»).

Claude Code, Codex, Goose y Qwen Code tienen **envoltorio propio** (`bvsala
claude|codex|goose|qwen`): arrancan un gateway en puerto efímero, lanzan el
terminal apuntándole y lo apagan al salir. Cero configuración persistente. La
receta manual de cada guía hace exactamente lo mismo. Para el resto,
`bvsala doctor` imprime el bloque exacto de cada terminal instalado.

## Lo común a todas las guías

### 1 · Instalar y arrancar el gateway

```bash
npm i -g @bivelio/savings-layer      # trae el binario `bvsala`
export BIVELIO_SERVICE_KEY=bvk_…     # clave de servicio, desde tu panel. Obligatoria: sin ella el gateway no arranca
bvsala gateway                        # escucha en http://127.0.0.1:8402
bvsala gateway --port 8500            # otro puerto si el 8402 está ocupado
```

Al arrancar imprime, entre otras, estas líneas:

```
[bvsala gateway] v0.4.x listening on http://127.0.0.1:8402 → https://api.anthropic.com
[bvsala gateway] license: PRO, active until 2026-10-24 (+14 days grace), collected with your service key and verified on this machine
[bvsala gateway] metering: ON (service key present)
```

Si no arranca (sale con código 1), el mensaje dice exactamente qué falta:

| Mensaje | Qué pasa | Arreglo |
|---|---|---|
| `BIVELIO_SERVICE_KEY is not set` | falta la clave de servicio | créala en el panel (Instalar, paso 2), expórtala y relanza |
| `BIVELIO_SERVICE_KEY is not recognised` | clave borrada, rotada o copiada a medias | crea otra |
| `your organization has no active BiVelio license` | no hay suscripción | suscríbete en Cuenta y relanza |
| `your BiVelio license expired on …` | licencia caducada y sin gracia | renueva en Cuenta |
| `could not collect your license from savings.bivelio.com` | sin acceso a savings.bivelio.com | revisa la conexión; como respaldo, `BIVELIO_LICENSE_KEY` (se verifica sin red y se sustituye a mano cada período) |
| un HTTP 402 en el terminal a mitad de sesión | la licencia caducó o se revocó con la sesión abierta | renueva; las peticiones que ya estaban en curso no se cortaron |

Si lanzas `bvsala gateway` como servicio (launchd/systemd), un fallo de licencia
queda en el log del servicio con código 1 y el terminal solo verá «connection
refused»: mira ese log.

Un gateway habla con **un** upstream (`BVSALA_GATEWAY_UPSTREAM`, por defecto
`https://api.anthropic.com`). Los terminales del dialecto Anthropic comparten
instancia; Codex necesita la suya contra OpenAI — `bvsala codex` la arranca
sola con el upstream correcto según tu modo de auth (ver su guía).

### 2 · Comprobar que mide: el log del gateway

Por cada llamada de inferencia servida y medida, el gateway escribe una línea
con el coste:

```
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 cache↓46792, out 8)
```

Si ves esa línea con `$`, el terminal está enrutado y medido. Lo que significan
las otras líneas:

| Línea en el log | Qué pasa | Arreglo |
|---|---|---|
| `[gateway] POST /v1/v1/messages → 404` | el base URL lleva `/v1` **de más** para ese terminal | quita el `/v1` |
| `[gateway] POST /messages → 404` | al base URL le **falta** `/v1` (el SDK solo añade `/messages`) | añade el `/v1` |
| `[bvsala gateway] el modelo "…" no está en el catálogo de precios; su uso se reenvía pero no se mide.` | modelo fuera de catálogo (a propósito: presente-y-mal es peor que ausente) | nada; se reenvía sin medir |
| `[gateway] POST /v1/messages → 402 (license expired)` | la licencia caducó, se revocó o la org está bloqueada: las peticiones NUEVAS se rechazan (las que estaban en curso terminaron) | renueva en Cuenta; el terminal enseña el motivo |
| nada de nada | el terminal no está apuntando al gateway (config no leída, env pisado por config, otro puerto) | revisa la trampa de su guía |

Claude Code manda además un `HEAD /api/hello` antes de la primera llamada: es
la sonda de vida, no una inferencia.

`bvsala doctor [--port N]`: sondea el PATH y la existencia de las configs de
usuario (nunca lee su contenido) e imprime el bloque exacto por terminal con el
puerto indicado. Solo imprime: no escribe ninguna configuración.

### 3 · Windows

`npm i -g @bivelio/savings-layer` y `bvsala claude` son idénticos en los tres
sistemas. Lo que cambia es cómo se fija la clave en la sesión — el `export` de
estas guías es POSIX; en PowerShell:

```powershell
$env:BIVELIO_SERVICE_KEY = "bvk_…"
bvsala claude
```

(En `cmd`: `set BIVELIO_SERVICE_KEY=bvk_…`.) El prefijo `VAR=valor comando` de
las recetas manuales también es POSIX: en Windows, fija la variable primero y
lanza después.

Y una condición dura: el terminal debe estar instalado con su **instalador
nativo** (un `claude.exe` / `codex.exe` en el PATH — Claude Code, Codex, Goose
y Qwen Code lo tienen [V]). El shim `.cmd` que deja `npm i -g <terminal>` no
puede lanzarse de forma segura con argumentos (CVE-2024-27980) y `bvsala` se
niega con una guía en vez de fallar con un ENOENT mudo.

### 4 · Regla BYOK, sin excepción

Todas las recetas del anillo 2 (Goose, Qwen Code, opencode, Crush, Droid, Cline,
Kilo) son **API key exclusivamente**. Anthropic prohíbe usar el OAuth de Claude
Pro/Max en harnesses de terceros (opencode lo documenta; Crush retiró su OAuth en
ene-2026). El gateway reenviaría un Bearer de suscripción sin inmutarse — y eso
no se promociona ni se documenta como receta.

### 5 · Wording honesto

«Anthropic doesn't endorse, maintain, or audit third-party gateway products»
[V]. El modo BV-SALA es **configuración soportada del binario sin modificar**:
di eso, nunca «aprobado por Anthropic». El contrato del gateway es una lista
abierta de cabeceras y campos que crece con cada release del terminal; el
passthrough byte a byte es lo que lo mantiene vivo sin tocar nada.

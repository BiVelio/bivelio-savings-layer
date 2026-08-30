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
cuentas y coste. Nunca corta el tráfico: sin clave o con la ingesta caída,
reenvía y avisa.

Hoy **mide**; no optimiza todavía. Y mide **todo el tráfico de inferencia**
que el terminal enruta por el base URL — no «todo el tráfico»: cada guía dice
lo que su terminal manda por fuera.

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
export BIVELIO_SERVICE_KEY=bvk_…     # clave de servicio, desde tu panel. Sin ella: reenvía, NO mide
bvsala gateway                        # escucha en http://127.0.0.1:8402
bvsala gateway --puerto 8500          # otro puerto si el 8402 está ocupado
```

Al arrancar imprime dos líneas; la segunda te dice si estás midiendo:

```
[bvsala gateway] v0.4.4 escuchando en http://127.0.0.1:8402
[bvsala gateway] medición: ACTIVA (clave de servicio presente)
```

`medición: APAGADA (falta BIVELIO_SERVICE_KEY)` = el terminal funciona igual,
pero nada llega a tu panel.

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
| nada de nada | el terminal no está apuntando al gateway (config no leída, env pisado por config, otro puerto) | revisa la trampa de su guía |

Claude Code manda además un `HEAD /api/hello` antes de la primera llamada: es
la sonda de vida, no una inferencia.

`bvsala doctor [--puerto N]`: sondea el PATH y la existencia de las configs de
usuario (nunca lee su contenido) e imprime el bloque exacto por terminal con el
puerto indicado. Solo imprime: no escribe ninguna configuración.

### 3 · Regla BYOK, sin excepción

Todas las recetas del anillo 2 (Goose, Qwen Code, opencode, Crush, Droid, Cline,
Kilo) son **API key exclusivamente**. Anthropic prohíbe usar el OAuth de Claude
Pro/Max en harnesses de terceros (opencode lo documenta; Crush retiró su OAuth en
ene-2026). El gateway reenviaría un Bearer de suscripción sin inmutarse — y eso
no se promociona ni se documenta como receta.

### 4 · Wording honesto

«Anthropic doesn't endorse, maintain, or audit third-party gateway products»
[V]. El modo BV-SALA es **configuración soportada del binario sin modificar**:
di eso, nunca «aprobado por Anthropic». El contrato del gateway es una lista
abierta de cabeceras y campos que crece con cada release del terminal; el
passthrough byte a byte es lo que lo mantiene vivo sin tocar nada.

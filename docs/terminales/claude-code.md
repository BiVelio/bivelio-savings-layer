# Claude Code a través del gateway

**Fuente:** `docs/PASARELA-S3-TERMINALES.md` §1 (conformidad con el protocolo
oficial de gateway de Claude Code, leído íntegro el 2026-08-30). Es el terminal
de referencia: 10 de 12 requisitos del protocolo los cumple el passthrough por
construcción, con test.

## Qué necesitas

- `claude` en el PATH.
- **Una API key de Anthropic** (`ANTHROPIC_API_KEY`, o `ANTHROPIC_AUTH_TOKEN` /
  `apiKeyHelper`): es el segmento que BV-SALA mide y factura. Con login de
  claude.ai el enrutado también funciona — la doc oficial lo sanciona: el login
  sigue siendo la credencial activa y «its usage limits and billing apply» [V] —
  pero ahí no hay factura por token: el gateway lo mide a precio de lista
  equivalente y nunca le acredita ahorro ni comisión (la licencia por asiento
  hace falta igual).
- `bvsala` instalado. Open core: sin claves el gateway arranca en modo Community (todo el ahorro local, cero telemetría); `BIVELIO_SERVICE_KEY` añade el panel y los entitlements de la org (ver [README](README.md)).

## Envoltorio: `bvsala claude` (recomendado)

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPCIONAL: panel + entitlements de org (sin ella: modo Community)
bvsala claude                    # cualquier argumento pasa tal cual: bvsala claude -p "hola"
```

Arranca el gateway en un **puerto efímero**, lanza `claude` con
`ANTHROPIC_BASE_URL=http://127.0.0.1:<puerto>` en su entorno, hereda tu
terminal entera (el TUI funciona tal cual) y apaga el gateway cuando `claude`
sale. No escribe ninguna configuración. No toca credenciales: el reenvío de
`Authorization` / `x-api-key` es íntegro.

## Manual: `ANTHROPIC_BASE_URL`

Si prefieres un gateway compartido en un puerto fijo (por ejemplo para varios
terminales a la vez):

```bash
bvsala gateway                                       # ventana 1: http://127.0.0.1:8402
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude   # ventana 2 — SIN /v1
```

Claude Code añade `/v1/messages` por su cuenta. Sin barra final.

**`ENABLE_TOOL_SEARCH=true` no es opcional.** Al ver un `ANTHROPIC_BASE_URL`
que no es el oficial, Claude Code apaga por defecto la búsqueda de herramientas
y mete TODAS las definiciones (las de tus servidores MCP incluidas) en el
prefijo cacheado de cada petición. Medido el 2026-09-09 en un montaje con 226
herramientas MCP: 450 KB por petición, el 66 % de los bytes y el 25 % de la
factura del día. El gateway reenvía la beta y los bloques `tool_reference`
intactos, así que la búsqueda funciona a través de él. `bvsala claude` la
activa solo; si ya tienes la variable fijada (`false`, `auto`, `auto:N`), se
respeta tu valor.

## Comprobar que funciona

**Con `bvsala claude` (el envoltorio), la comprobación es tu dashboard**: el
log por petición va silenciado por defecto desde la 0.4.8 — imprimirlo pisaba
el TUI de Claude Code (las palabras se montaban sobre los diálogos). Si lo
quieres ver igualmente, `BVSALA_GATEWAY_LOG=1 bvsala claude`.

Con `bvsala gateway` a secas (dos terminales), el log sí es la comprobación,
en este orden:

```
[gateway] HEAD /api/hello → 200
[gateway] POST /v1/messages  · <modelo> · $0.001234 (in 120, cache↑0 (1h 49268) cache↓43430, out 8)
```

El `HEAD /api/hello` es la sonda de vida que Claude Code manda antes de la
primera llamada. La línea con `$` es la inferencia medida. La cifra `cache↑ …
(1h …)` es normal: Claude Code escribe caché a 1 h, y es más de la mitad de la
entrada en sesiones reales.

## Model discovery (opcional, solo con API key)

```bash
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 bvsala claude
```

Con la bandera, Claude Code pide `GET /v1/models?limit=1000` al gateway
(timeout 3 s, credencial en `Authorization` **y** `x-api-key`) y filtra ids que
contengan «claude»/«anthropic» [V]. El passthrough lo sirve por construcción
(api.anthropic.com responde `{data:[{id,display_name}]}`) y en `/model` debería
aparecer «From gateway».

Honestidad sobre el estado: el passthrough de `GET /v1/models` **tiene test**
(pasa íntegro y no factura); la validación en mano con API key está pendiente
(S3 §1.2). Y las únicas fuentes de credencial
del discovery son `ANTHROPIC_AUTH_TOKEN`/`apiKeyHelper` y `ANTHROPIC_API_KEY`: un
login claude.ai **no** es fuente, así que en suscripción pura el cliente escribe
`[gatewayDiscovery] skipped` y ni pregunta.

## La trampa típica

1. **`/v1` en el base URL.** `ANTHROPIC_BASE_URL=http://127.0.0.1:8402/v1` da
   `[gateway] POST /v1/v1/messages → 404` y Claude Code reporta un error
   genérico. Sin `/v1`.
2. **Watchdog de 300 s.** En conexiones por `ANTHROPIC_BASE_URL` Claude Code
   corta un stream sin bytes durante 300 s (único valor que documenta hoy la doc
   oficial). En el camino normal el gateway no bufferiza y reenvía los pings
   como bytes, así que no salta. Solo bajo `BVSALA_GATEWAY_COALESCE=1` (apagada
   por defecto) una petición gemela espera a que termine la primaria, y una
   primaria de más de 300 s la mataría — está identificado en S3 §1.1 y no se
   enciende por defecto hasta arreglarlo.
3. **Redirecciones.** Cualquier 3xx en el base URL es fallo de discovery por
   diseño del cliente; el gateway reenvía el 3xx en vez de seguirlo con tu
   credencial (`redirect: "manual"`, verificado).

## Lo que NO pasa por el gateway (aviso honesto)

La promesa de medición es «todo el tráfico de **inferencia**», no «todo el
tráfico»: **fast-mode y el safety-check de WebFetch van directos a
api.anthropic.com por diseño del cliente** [V]. Ese gasto no aparece en tu panel
y no es computable desde el gateway. El contrato es una lista abierta que crece
con cada release de Claude Code; BV-SALA repite el smoke test de `bvsala claude`
contra cada versión nueva.

Las cabeceras `x-claude-code-session-id` / `agent-id` / `parent-agent-id`
llegan en el tráfico real y se reenvían al proveedor sin tocarlas. Además, el
gateway LEE las dos primeras y, si tienen forma de identificador, adjunta su
valor (`sessionId`, `agentId`) al registro de uso que manda a BiVelio: es lo que
reparte el coste por sesión y por subagente en el panel. Son los ids que Claude
Code ya pone en sus propias peticiones, no una persona ni un contenido;
`parent-agent-id` no se lee. La lista completa de lo que viaja está en la
LICENSE §5.

## Nota BYOK y wording

El modo BV-SALA es **configuración soportada del binario sin modificar**, nunca
«aprobado por Anthropic» («Anthropic doesn't endorse, maintain, or audit
third-party gateway products» [V]). Lo que BV-SALA mide y factura es el uso por
API key; el gateway no persiste ninguna credencial, sea cual sea.

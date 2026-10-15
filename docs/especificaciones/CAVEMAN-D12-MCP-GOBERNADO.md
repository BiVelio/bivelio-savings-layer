# D12 · MCP gobernado (plan Caveman 2026-10-14)

**Estado:** opt-in, de solo lectura. Hasta esta PR el repositorio no tenía
ningún servidor MCP. «MCP» solo aparecía como catálogo de herramientas del
cliente (`src/router/schema-on-demand.ts`) y como tráfico que el gateway mide
(`gateway/tarifa.ts`). El SDK de MCP no es una dependencia, y esta PR no añade
ninguna: el marco JSON-RPC se hace a mano.

## Qué hace

```
bvsala mcp [--gateway http://127.0.0.1:<port> | --port <port>]     # por defecto 127.0.0.1:8402
```

Un servidor MCP por **stdio** (JSON-RPC 2.0, un mensaje por línea; stdout solo
lleva protocolo) que lee las rutas locales de un `bvsala gateway` que ya corre:

| Herramienta | Lee | Devuelve |
| --- | --- | --- |
| `gateway_status` | `GET /_bvsala/v1/status` | versión, origen del upstream, estado y plan de la licencia, si mide. Sin claves |
| `session_costs` | `GET /_bvsala/v1/summary` (nueva) | por sesión de Claude Code (`attribution.sessionId`): peticiones medidas, no medidas y por qué, pendientes; dinero **por base de coste**, nunca sumado entre bases |
| `compaction_opportunities` | `GET /_bvsala/v1/summary` | decisiones de `lossless-data` (D03) por código de motivo, con su significado, la cobertura y los tokens **estimados** antes → después |

Métodos que atiende:

- `initialize`, que negocia la versión entre `2025-06-18`, `2025-03-26` y `2024-11-05`;
- `ping`;
- `tools/list`, paginado de dos en dos con `nextCursor`; el catálogo se sirve bajo demanda;
- `tools/call`.

Los errores siguen la spec:

| Caso | Código |
| --- | --- |
| JSON roto | −32700 |
| No es una petición, o llega un lote | −32600 |
| Método desconocido | −32601 |
| Herramienta desconocida, argumentos o cursor inválido | −32602 |

Las notificaciones no reciben respuesta.

`GET /_bvsala/v1/summary` es una ruta local nueva del gateway, detrás de la
misma verja que las demás:

- solo GET;
- solo un `Host` de loopback;
- detrás de la licencia (402 sin ella).

Es una **suma**: no devuelve ni un `requestId` ni un `responseId`, así que no
sirve para pedir un informe, y la regla del buzón («sin el id no hay informe»)
sigue intacta.

## Gobierno

- **Solo lectura.** Las cuatro anotaciones van fijas en todas las herramientas: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` y `openWorldHint: false`. Ninguna acepta argumentos y ninguna muta nada.
- **Solo metadatos.** Las herramientas devuelven contadores, USD, modelos, ids opacos de sesión y códigos de motivo. Nunca devuelven el prompt, la respuesta, un tool output, ids de petición, de respuesta o de tool call, ni la ruta.
- **Solo el gateway local.** `--gateway` tiene que ser `http` de loopback y sin credenciales. Nada habla con BiVelio ni con el proveedor.
- **Mutaciones aplazadas.** Proponer o lanzar experimentos (encender una palanca, un A/B) queda **diferido hasta que exista la API canónica** que los autorice y los audite. Hasta entonces, un agente no tiene por dónde tocar la configuración ni el gasto.

## Límites

- **El buzón solo guarda las peticiones que pidieron informe** (`x-bvsala-report: 1`), las últimas 1000 y como mucho una hora. `session_costs` no es la factura: es esa ventana, y lo dice.
- **El gateway no compacta tool outputs.** `lossless-data` corre en el SDK, así que en el gateway `compaction_opportunities` sale casi siempre a cero, con una nota que lo explica, nunca como un ahorro.
- **Una sola instancia.** La URL por defecto es la de `bvsala gateway` (8402). Un gateway arrancado como envoltorio (`bvsala claude`) usa un puerto efímero, y hay que pasarlo con `--port`.
- **La «sesión» es la de Claude Code** (`x-claude-code-session-id`). Sin esa cabecera, las peticiones van a `sessionId: null`.

## Evidencia

`test/mcp-gobernado.test.ts`, 20 tests:

- el marco por stdio: troceado, CRLF, orden, una línea gigante;
- cada código de error;
- la paginación;
- las anotaciones y que no haya herramientas que muten;
- el loopback;
- las sumas a mano;
- canarios sembrados en ids, ruta y texto libre, de los que no sale ninguno;
- que solo salgan GET a `status` y `summary`;
- una prueba de punta a punta: un gateway de verdad delante de un Anthropic falso, una petición con informe, y el binario `bvsala mcp` leyéndola por stdio.

# F0 · El espía de tráfico — catálogo de la superficie real de Claude Code

**Fecha:** 2026-08-23 · **Herramienta:** `scripts/espia-anthropic.mjs` · **Sesión:**
Claude Code CLI 2.1.237 real, autenticado por suscripción (OAuth), a través de
`ANTHROPIC_BASE_URL=http://127.0.0.1:8402`. La captura completa (con prompts)
queda SOLO en la máquina local (`~/.bvsala-f0/`); aquí va el catálogo sin
contenido.

## Veredicto de viabilidad

**La puerta funciona.** Claude Code respeta `ANTHROPIC_BASE_URL` de punta a
punta — la sesión completó con la respuesta correcta a través del proxy, sin
cambio alguno de comportamiento ni latencia perceptible. Incluso con
autenticación OAuth de suscripción (el caso que NO facturamos, pero que
confirma que el enrutado es total).

## La superficie que el gateway de F1 debe soportar

| Petición | Notas |
| --- | --- |
| `HEAD /api/hello` | Comprobación de vida ANTES de la primera llamada. El gateway debe responderla (passthrough vale). |
| `POST /v1/messages?beta=true` | La llamada principal. Siempre `stream: true` → respuesta SSE. |

**Cuerpo de `/v1/messages`** (claves observadas): `model`, `messages`,
`system`, `tools`, `metadata`, `max_tokens`, `thinking`, `context_management`,
`stream`.

**Cabeceras `anthropic-beta` observadas** (la lista que el passthrough debe
dejar pasar intacta, y que cambiará sin avisar):
`oauth-2025-04-20`, `interleaved-thinking-2025-05-14`,
`thinking-token-count-2026-05-13`, `context-management-2025-06-27`,
`prompt-caching-scope-2026-01-05`, `claude-code-20250219`,
`advisor-tool-2026-03-01`, `extended-cache-ttl-2025-04-11`.

**Eventos SSE observados**: `message_start`, `content_block_start`, `ping`,
`content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

**Los eventos `usage`** (lo que alimenta el SavingsReport del gateway):

- En `message_start`: `input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens,
  ephemeral_1h_input_tokens}`, `output_tokens`, `service_tier`, `inference_geo`.
- En `message_delta` (el definitivo): lo anterior +
  `output_tokens_details.thinking_tokens` + `iterations[]` (desglose por
  iteración de servidor).

## Hallazgos que ya son requisitos de F1

1. **Descompresión (cazado en vivo):** el `fetch` de Node descomprime `br`/
   `gzip` y reenviar el `content-encoding` original rompe el cliente
   (`BrotliDecompressionError`). El gateway debe retirar `content-encoding`,
   `content-length` y `transfer-encoding` de la respuesta reenviada. (El espía
   ya lo hace; ese es el bug nº1 que un gateway ingenuo habría tenido.)
2. **El prompt caching es masivo y es sagrado:** una petición trivial («responde
   OK») leyó **46.792 tokens de caché** (`cache_read_input_tokens`). Cualquier
   alteración del prompt que invalide esa caché multiplicaría la factura del
   cliente. Obligación nº1 del plan, ahora con cifra.
3. **El `usage` del stream llega completo y estructurado** — la medición de F1
   no necesita tocar NADA: basta observar `message_start`/`message_delta` como
   hace el espía. Incluye desglose de caché por TTL y de thinking.
4. **`?beta=true` y las betas por cabecera cambian con cada versión del CLI:**
   el gateway nunca valida listas conocidas; passthrough byte a byte de lo que
   no entiende (principio del plan, confirmado necesario).
5. **Salud primero:** `HEAD /api/hello` llega antes que la primera llamada; si
   el gateway no la responde, Claude Code puede degradar. Passthrough directo.

## Cómo repetir una captura

```bash
node scripts/espia-anthropic.mjs 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude -p "Responde solo OK"
# catálogo: ~/.bvsala-f0/captura-*.jsonl (credenciales redactadas siempre)
```

Sesiones más ricas (con herramientas, ficheros, subagentes) ampliarán el
catálogo; el formato JSONL está pensado para diffearlas. Ese corpus es también
el arnés de evaluación de F2.

## El arnés F2 (`scripts/arnes-pasarela.mjs`)

La puerta que una palanca cruza antes de encenderse por defecto: repite el
corpus contra el **binario real** de `dist/` (lanzado como proceso, no
importado) con la palanca apagada y encendida — incluida una pasada de
duplicados concurrentes — y solo PASA si cada respuesta, gemelas incluidas,
es **byte a byte idéntica** a la referencia. Todo en 127.0.0.1.

```bash
npm run build
node scripts/espia-anthropic.mjs 8402          # graba (ya con cuerpos de respuesta)
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
node scripts/arnes-pasarela.mjs                 # veredicto sobre la última captura
```

Primer veredicto (2026-08-23, corpus de 1 sesión): **PASA** — la coalescencia
no cambia ni un byte. La regla del plan sigue en pie: se enciende por defecto
cuando el corpus sea representativo (sesiones con herramientas y subagentes),
no antes.

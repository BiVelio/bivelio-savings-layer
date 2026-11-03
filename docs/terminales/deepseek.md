# Claude Code con DeepSeek (endpoint en formato Anthropic)

DeepSeek publica un endpoint compatible con el protocolo Anthropic
(`https://api.deepseek.com/anthropic`): el gateway reescribe `/v1/messages` hacia
`/anthropic/v1/messages` automáticamente, así que Claude Code habla con DeepSeek
sin tocar su configuración **[V] en test** (`test/gateway-gemini.test.ts`).

Por qué merece la pena: las lecturas de caché de DeepSeek cuestan $0,003/1M y la
entrada off-peak $0,15/1M — el hermano barato más agresivo para tráfico Claude.

## Receta

```bash
bvsala gateway --upstream deepseek --port 8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 \
ANTHROPIC_AUTH_TOKEN=<tu API key de DeepSeek> \
ANTHROPIC_MODEL=deepseek-flash \
claude
```

## Notas

- Se mide a precio de lista para `deepseek-flash` y `deepseek-v4-pro` (el
  catálogo los tarifa a PEAK, el lado conservador: off-peak es la mitad).
- `deepseek-chat` (el alias clásico) no tiene fila propia: se reenvía y el log
  dice «not metered». Usa `deepseek-flash`.
- La calidad del modelo es asunto tuyo: el gateway no enruta por calidad, solo
  mide lo que le mandas.

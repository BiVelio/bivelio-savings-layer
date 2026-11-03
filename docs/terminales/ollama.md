# Ollama, vLLM y LM Studio (modelos locales)

El gateway también se pone delante de un servidor local OpenAI-compatible: útil
para dar a un agente un tier local gratis mientras el gateway sigue midiendo las
llamadas de pago.

```bash
bvsala gateway --upstream ollama --port 8402    # http://localhost:11434
bvsala gateway --upstream vllm --port 8402      # http://localhost:8000
bvsala gateway --upstream lmstudio --port 8402  # http://localhost:1234
```

Luego apunta cualquier SDK OpenAI a `http://127.0.0.1:8402/v1` (**con** `/v1`).

**Honestidad de la medición:** los modelos locales no tienen precio de lista, así
que este tráfico se reenvía y el log lo dice (`not metered: model "…" has no
list price in the catalog`). En dólares no se acredita nada; el valor es
operativo: un solo base URL para todos los modelos, con el metering de los
providers de pago funcionando al lado.

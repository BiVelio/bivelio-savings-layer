# Launch Kit — BV-SALA 1.0 (open core)

Fecha objetivo: lanzar en cuanto el CI de #524 esté verde y npm sirva 1.0.0.

## El mensaje (una línea)

> Cut your LLM bill 30–75 % — and see exactly why, measured with your provider's
> own usage counter. Zero dependencies. Zero telemetry. One command.

## Los tres públicos y sus ganchos

1. **Devs que pagan APIs** («mi factura de OpenAI/Anthropic sube cada mes»):
   `npx @bivelio/savings-layer gateway --upstream openai` + un base_url. El
   gancho: **auditable por request** — no es un dashboard que promete; es un
   informe por llamada valorado con el contador del proveedor.
2. **Devs de agentes** (Claude Code/Cursor/Codex/Gemini CLI):
   `npx @bivelio/savings-layer claude` — cero configuración; a la salida dice
   cuánto midió. El gancho: **DeepSeek como hermano de Claude Code a $0,003/1M
   de caché** (una línea: `bvsala gateway --upstream deepseek`).
3. **Empresas** (CISO/CTO): open core + cero telemetría + la nube opcional. El
   gancho: los prompts nunca llegan a BiVelio, y la nube es un flat fee sin
   comisión sobre lo que ahorras.

## Materiales listos

- README (npm + GitHub) — ya reescrito en open core, con los 60 segundos.
- [YC-ONEPAGER.md](YC-ONEPAGER.md) — el pitch.
- Benchmarks publicados (GSM8K 31,5 % / 75,1 % con bootstrap por clúster) en
  savings.bivelio.com/en/how-it-works + el paper v2.
- CHANGELOG 1.0.0.

## Orden de lanzamiento

1. Merge #524 (CI verde) → main.
2. `gh repo edit BiVelio/bivelio-savings-layer --visibility public` +
   `--description "The savings layer for your LLM bill — audited per request. Apache-2.0, zero telemetry."`
   + `--homepage https://savings.bivelio.com` + topics:
   `llm cost-optimization gateway ai-infrastructure openai anthropic claude-code deepseek qwen glm caching typescript`.
3. Disparar `banco-semanal.yml` en main (workflow_dispatch) y esperar verde
   (es la puerta de publish.yml: el run tiene que ser del commit de release).
4. `gh release create v1.0.0 --generate-notes --title "1.0.0 — open core"` →
   publish.yml (npm trusted publishing + SBOM).
   `gh release create py-v1.0.0 --generate-notes --title "Python client 1.0.0 — open core"` →
   publish-pypi.yml.
5. Verificar: `npm view @bivelio/savings-layer@1.0.0` y
   `pip index versions bivelio-savings-layer`.

## Show HN (EN)

**Title:** Show HN: BV-SALA — cut your LLM bill 30–75 %, audited per request, zero telemetry

```
We built the thing we wanted for ourselves: a savings layer that sits between
your code (or your coding agent) and the LLM provider, and lets through only
what has to be paid for.

What it does, in order, per request:
 1. Can I skip this call? (exact + calibrated semantic cache, dedup)
 2. Can I send less? (prompt-cache placement, context/tool-output compaction)
 3. Can a cheaper model do it? (cascade, sibling routing, failover)
 4. And for every answer: a SavingsReport with FOUR ledgers —
    avoided_calls, eliminated_tokens, compressed_tokens, provider_cached_tokens —
    each valued with your provider's own usage counter at versioned list prices.

Why we think it is different:
 - measured, not promised: basis is "measured" | "reference" | "estimated" per
   request; estimates are never billed;
 - open core: Apache-2.0, zero runtime dependencies, zero telemetry by default;
   prompts never reach us;
 - one command for agents: npx @bivelio/savings-layer claude  (codex, gemini,
   qwen, aider, goose too) — and DeepSeek/Qwen/GLM as first-class upstreams.

Numbers (public benchmark, cluster bootstrap, 10k resamples):
 - gpt-4o-mini: 31.5 % [25.7–36.7] cost reduction
 - claude-sonnet-5: 75.1 % [69.3–79.6] (~41 pp from a cache effect we enable)
 - counterfactual gateway replay: 2.49 % [1.50–3.57]

Repo: github.com/BiVelio/bivelio-savings-layer (Apache-2.0)
npm: npmjs.com/package/@bivelio/savings-layer
Happy to answer anything — especially about why we keep "estimated" out of the invoice.
```

## Reddit (variantes)

- r/LocalLLaMA: «Local gateway + DeepSeek/Qwen/GLM upstreams — cache reads at
  $0.003/1M for Claude Code traffic; Apache-2.0, no telemetry.»
- r/ClaudeAI / r/OpenAI: el gancho del TTL/caché + el informe por request.
- r/programming: la parte de ingeniería honesta (cuatro ledgers, medición vs
  estimación, paper con bootstrap).

## X/LinkedIn (thread de 5)

1. «Pagas por lo que ENVÍAS, no por lo que necesitas.»
2. «El 75,1 % de ahorro en Claude Sonnet 5: 41 pp son caché que TU app no marcaba.»
3. «Nuestra regla: estimated nunca se factura. measured lleva el contador del proveedor.»
4. «Claude Code + DeepSeek = una línea: bvsala gateway --upstream deepseek.»
5. «Apache-2.0. Cero dependencias. Cero telemetría. El README son 60 segundos.»

## Métricas del lanzamiento (a seguir en el panel de la nube)

- Instalaciones/día de `@bivelio/savings-layer` (npm downloads).
- Estrellas GitHub / forks / issues abiertos.
- Sesiones de gateway que activan la nube (conversión).
- Hilos que se comparten (trackear en HN/Reddit).

## Riesgos y respuestas preparadas

- «Otro router más» → no: corre en tu máquina/VPC, audita por request, no
  toca tus prompts; el wedge post-Stripe/OpenRouter es el autohospedado auditable.
- «¿Por qué gratis?» → la nube (panel de equipo, cachés compartidas) es el
  producto de pago; nunca comisionamos tu ahorro.
- «¿El 75 % es real?» → el paper publica workload, intervalos y la distinción
  medida/estimada; las cifras estimadas no se facturan.

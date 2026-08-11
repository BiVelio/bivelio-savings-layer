# @bivelio/savings-layer — BV‑SALA

**A provider‑neutral LLM execution optimizer.** BV‑SALA sits in front of any LLM
provider and, for every request, picks the **cheapest execution that still meets
your quality bar** — then hands you a full, auditable `SavingsReport`.

It is **not** a prompt compressor. Compression is the *fourth* thing it tries, not
the first.

> **Commercial software — © 2026 BiVelio Inc.** Free to install, **paid to run**:
> BV‑SALA is **fail‑closed** and executes only with a valid, active BiVelio license
> key. Verification is **offline** (no phone‑home to answer a request) and **your
> prompts never leave your infrastructure** — only counts and cost are ever reported.
> Use is governed by the [LICENSE](./LICENSE) and the BiVelio Terms. Not affiliated
> with, and not a wrapper around, any third‑party library.

## Install

```bash
pnpm add @bivelio/savings-layer
# or: npm i @bivelio/savings-layer  ·  yarn add @bivelio/savings-layer
```

You also need a **license key**. Try the optimizer **free in your browser** — paste
your own data and watch the meter — at **[savings.bivelio.com](https://savings.bivelio.com)**,
then subscribe (**€4 / seat / month** or **€39 / seat / year**, EUR) to get your key.

## Quick start

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

// Your provider. LLM traffic goes straight to it — BV-SALA never proxies it.
// Any OpenAI-compatible endpoint works: OpenAI, Azure, vLLM, SGLang, a gateway.
const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
});

const layer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,        // required — from your savings.bivelio.com dashboard
  licenseServerUrl: "https://savings.bivelio.com",    // license check + kill-switch
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY, // seat metering + AUTO-RENEWAL pickup
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});

console.log(text);                    // "8"  (computed locally — no LLM call)
console.log(report.calls.avoidedLlm); // → whole calls you never paid for
console.log(report.cost.netSavings);  // → verified savings, per request
```

Ask for a **structured contract** and you also get `data`, validated against your
schema — the JSON-repair and constrained-decoding levers switch on here:

```ts
const { data, text } = await layer.generate<{ answer: number }>({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
  response: {
    contractId: "answer:v1",
    schema: {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
      additionalProperties: false,
    },
    maxOutputTokens: 220,
  },
});

console.log(data.answer); // 8
```

The hard requirements are a `provider` and a valid `licenseKey`: BV‑SALA is a paid
product and **refuses to run unlicensed, expired, or tampered** (it throws
`LicenseError` at the `generate()` entry). Get a key at
[savings.bivelio.com](https://savings.bivelio.com).

> **Set `serviceAccountKey` on every long‑running deployment.** Your licence token
> expires at the end of the billing period; each renewal mints a **new** token. With
> a service‑account key (`bvk_…`, same dashboard) the SDK picks the renewed token up
> by itself and swaps it in without a restart. **Without it there is no machine
> pickup**, so somebody has to paste the new token by hand every cycle — and if
> nobody does, the deployment stops with `LicenseError` once the grace period ends,
> while the subscription is paid and current. The key also enables seat metering
> (counts only — never prompts or completions).

### Seats (how you are billed)

A **seat is a machine**, never a person. The SDK derives a stable, opaque id per
machine + service-account key and reports it with the counts; the control plane
bills a seat only once it has been seen on **3 separate days**.

**Set `BVSALA_SEAT_ID` (one value per replica or service) whenever the machine
identity can't be deduced** — Kubernetes, or any fleet where the hostname is
assigned dynamically. Without it, every pod of a deployment shares one fingerprint
and the whole deployment counts as a **single** seat. It is also the way to keep
seat ids stable across an SDK upgrade: the fingerprint changed in v0.1.x, so a
fleet that never set it may be counted twice in the month it upgrades.

```bash
BVSALA_SEAT_ID=worker-03   # stable per replica; [A-Za-z0-9._:/-], max 128 chars
```

CI runners are auto-detected and excluded from billable seats.

### Tool calls

When you pass `tools` and the model asks to invoke one, the reply is not the final
answer: `text` is empty by design and the request is in `toolCalls`. Execute it,
append the result to `messages`, and call `generate()` again.

```ts
import type { ToolDescriptor } from "@bivelio/savings-layer";

const tools: ToolDescriptor[] = [
  {
    id: "get_weather",
    intents: ["weather", "forecast"],
    risk: "read",
    description: "Current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

const res = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What's the weather in Madrid?" }],
  tools,
});

if (res.toolCalls?.length) {
  // res.finishReason === "tool_calls"
  for (const call of res.toolCalls) {
    const args = JSON.parse(call.arguments) as { city: string };
    console.log(call.name, args); // ← run your tool here, then append its result
  }
} else {
  console.log(res.text);
}
```

A tool‑call turn is never served from cache and never counted as an avoided call:
an action that has not run yet cannot be a saving.

> The `devUnlicensed` flag and `BVSALA_DEV_OPEN=1` are development‑only, honored
> **only when building from source** (this repo's tests and benchmarks). They are
> **disabled in this published package** — a valid `licenseKey` is the only way to
> run it. They are not a way to use the product for free.

Every component ships with an in‑memory default and is independently swappable
(Redis exact cache, pgvector/Qdrant semantic cache, a real tokenizer, an LLMLingua
sidecar, XGrammar/llguidance backends, …).

## The optimization order (cheapest first)

1. **Avoid the call entirely** — resolvers, exact & semantic cache, singleflight.
2. **Avoid auxiliary calls** — retrieval, tools, planners, validators, retries.
3. **Eliminate unnecessary context** before trying to compress it.
4. **Compress** the tokens that genuinely must be sent.
5. **Constrain generation** to emit only the structure and length required.

Provider prompt/KV caching is treated as a cost/latency saving — **never** as a
reduction of the logical prompt size.

## Four separate ledgers (never summed)

Mixing these produces misleading metrics, so BV‑SALA keeps them apart:

| Ledger | Meaning |
| --- | --- |
| `avoided_calls` | LLM / retrieval / tool calls that never executed |
| `eliminated_tokens` | information dropped because it was not needed |
| `compressed_tokens` | information kept, but encoded with fewer tokens |
| `provider_cached_tokens` | tokens still in the prompt, billed/processed more cheaply |

A cache hit removes a whole call. A re‑encode makes a payload smaller. Compression
drops redundant words. A prefix cache makes tokens cheaper without removing them.
Four different things — summing them would lie to you, so the report never does.

## The decision cascade

```
Request
  → Canonicalize + Policy (risk & freshness)
  → Deterministic resolvers ─────────────► answer (0 calls)
  → Exact cache ─────────────────────────► answer (0 calls)
  → Singleflight (coalesce in-flight)
      → Safe semantic cache ─────────────► answer (0 calls)
      → Execution router (NO / SINGLE / MULTI / TOOL)
      → Tool selector (drop irrelevant, gate writes)
      → Retrieval: retrieve → dedupe → rerank → adaptive-k
      → Context projection (memory deltas)
      → Compression (only when net-positive)
      → JSON / TOON / CSV selector (tokenizer-aware)
      → Output contract + constrained decoding
      → ONE primary LLM call
      → Structural + semantic validation (+ ≤1 repair)
      → Local render / transcode / cache write
  → SavingsReport + traces
```

## Why formats are chosen, not assumed

A compact encoding can be *larger* than plain JSON on nested/non‑uniform data, so
BV‑SALA counts — with the destination model's tokenizer — before switching:

```
tokens(encoded payload) + tokens(instruction to understand it) + quality penalty
```

…and only moves away from JSON when a challenger clears both an absolute (`≥64`
tokens) and a relative (`≥8%`) threshold:

```
big uniform table   → json 1716, toon 708  → chosen: toon (−58.7%)
small nested object → json 44,   toon 116  → chosen: json-compact
```

## What's inside

Canonicalization & safe cache keys · risk/freshness policy · exact + singleflight +
safe semantic cache · deterministic resolvers · Adaptive‑RAG execution router & tool
selector · retrieval dedupe→rerank→adaptive‑k · conversation memory & context
projection · tokenizer‑aware JSON/TOON/CSV selection · JSON‑Schema validation &
constrained decoding · net‑positive compression · a provider‑neutral adapter · and a
trace collector that builds the `SavingsReport`. Every piece is pluggable.

## Licensing & privacy

BV‑SALA is commercial, per‑seat software (**€4 / seat / month** or **€39 / seat /
year**, EUR). The license is a signed token your SDK verifies **offline**; the
managed control plane (semantic cache, learned thresholds, dashboards) and the
revocation kill‑switch are served from BiVelio. Your LLM traffic goes **straight to
your provider** — BiVelio sees counts and cost, never prompts or completions.

Get a key and read the terms at **[savings.bivelio.com](https://savings.bivelio.com)**.
Onboarding & general questions: **support@bivelio.com** · licensing & compliance:
**privacy@bivelio.com** · technical: **team@bivelio.com**.

---

© 2026 BiVelio Inc. All rights reserved. BV‑SALA is a trademark of BiVelio Inc.

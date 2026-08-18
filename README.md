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

## Requirements

- **ESM-only.** The package is `"type": "module"`. Add `"type": "module"` to your
  own `package.json`, or use `.mjs` files. From CommonJS, `require()` works on
  **Node ≥ 22** (native `require(esm)`); on older Node, import it instead.
- **Node ≥ 20.**
- To run the `.ts` snippets below **as-is**: Node ≥ 23.6 (native type-stripping) or
  `npx tsx file.ts`. On Node 20, compile with `tsc` first or use `tsx`. The
  JavaScript equivalents (below each TS snippet) run on any supported Node.
- For `tsc --noEmit` against your own code: install `@types/node` and make sure
  `"types": ["node"]` is in your `tsconfig` if you don't already pull it in.
- Optional peer `gpt-tokenizer`: install it for exact OpenAI token counts; without
  it the layer uses a built-in estimator — not required to get started.

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
schema — the JSON-repair and output contracts levers switch on here.

**TypeScript** (the generic types `data`):

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

**JavaScript** — identical, just drop the `<{ answer: number }>` type argument (a
TS-only construct; in plain JS it throws `ReferenceError: number is not defined`):

```js
const { data, text } = await layer.generate({
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
`LicenseError` at the `generate()` entry, carrying a `status` of `none`,
`invalid`, `expired`, `grace`, `revoked` or `stale`). Your key — and this snippet
with the key already filled in — is at
[savings.bivelio.com/dashboard/install](https://savings.bivelio.com/dashboard/install).

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

Every component ships with an in‑memory default and is independently swappable:
plug in your own cache, vector store, tokenizer, compressor or constraint backend
behind the same interfaces.

## The optimization order (cheapest first)

1. **Avoid the call entirely** when the answer can be produced or reused safely.
2. **Avoid auxiliary calls** — the retrievals, tool hops and retries around it.
3. **Eliminate unnecessary context** before trying to shrink what remains.
4. **Shrink** the tokens that genuinely must be sent.
5. **Constrain generation** to emit only the structure and length required.

The order is the point: work removed at step 1 costs nothing to compress at step 4.

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
  → Concurrent duplicates coalesced ─────► answer (0 calls)
      → Near-duplicate reuse ────────────► answer (0 calls)
      → Execution planning (how much work this really needs)
      → Context reduction (only when it pays for itself)
      → Payload encoding chosen by measurement, not by default
      → Output contract enforced
      → ONE primary LLM call
      → Structural + semantic validation (+ ≤1 repair)
      → Local render / transcode / cache write
  → SavingsReport + traces
```

## Why formats are chosen, not assumed

A compact encoding can be *larger* than plain JSON on nested or non‑uniform data,
so BV‑SALA never assumes one. It counts the candidates with the destination
model's own tokenizer — including the cost of explaining the encoding to the
model — and only moves away from JSON when the saving clears a margin worth the
change.

On a wide, uniform table that is a large reduction. On a small nested object it
leaves JSON alone. Whichever it picks, `report.serialization` tells you what was
chosen and what each candidate would have cost, so the decision is auditable
rather than promised.

## What's inside

Safe cache keys and a risk/freshness policy · several independent ways to answer
without spending a call · execution planning · context reduction that must pay for
itself · measured payload encoding · output contracts with validation · a
provider‑neutral adapter · and a trace collector that builds the `SavingsReport`.

Every piece is pluggable, and every saving it claims is reported per request with
the token counts behind it.

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

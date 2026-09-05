<p align="center">
  <img src="https://savings.bivelio.com/brand/savings-logo.png" alt="Savings. by BiVelio" width="360">
</p>

<h1 align="center">The savings layer for your LLM bill</h1>

<p align="center">
  <em>Cut your AI bill — and see exactly why, measured on the same meter your provider bills you with.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bivelio/savings-layer"><img src="https://img.shields.io/npm/v/%40bivelio%2Fsavings-layer?color=2F63D8&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-14A06F" alt="Node ≥ 20">
  <img src="https://img.shields.io/badge/license-commercial-0F1218" alt="Commercial license">
</p>

### In plain words

Every request your app sends to an AI is paid for by the text going in and out.
**Savings** sits on that path and lets through only what's needed — skipping calls
that don't have to happen, and trimming what does — so you pay for less. It is not a
promise you take on faith: **every saving is measured with the provider's official
meter, the same one on your bill**, and handed back to you request by request.

**We only earn when you save.** Our commission comes out of the measured saving,
never out of your pocket — most of what you save stays with you, and a month with no
saving is zero commission. And your prompts **never leave your infrastructure**:
BiVelio only ever sees counts and cost, never your content.

### For engineers, in one line

`@bivelio/savings-layer` (**BV‑SALA**) is one layer you add inside your code, right
where your app calls the OpenAI‑compatible or Anthropic API. For every request it
picks the cheapest execution that still meets your quality bar and hands you an
auditable `SavingsReport` — the same numbers your dashboard reads. Traffic still
goes straight from your app to your provider; the SDK is never a middleman server.

> **Commercial software — © 2026 BiVelio Inc.** Free to install, **paid to run**:
> BV‑SALA is fail‑closed and executes only with an active BiVelio license key.
> License checks are **offline** and **your prompts never leave your infrastructure** —
> only counts and cost are ever reported. Use is governed by the [LICENSE](./LICENSE)
> and the BiVelio Terms. Not a wrapper around any third‑party library.

## Where it installs

<p align="center">
  <img src="https://savings.bivelio.com/en/how-it-works/opengraph-image" alt="Your application → BV-SALA → provider API. The bill drops from $330 to $160 a month, measured." width="720">
</p>

Your application → **BV‑SALA** → provider API. Traffic always goes straight from
your app to your provider — BV‑SALA is a library inside your code, never a
middleman server, and it works with any OpenAI‑compatible endpoint (OpenAI, Azure,
vLLM, SGLang, a gateway) as well as Anthropic.

**Is this for me?** If your product or automation calls the AI **with its own API
key** — and pays a per‑token bill for it — yes: this is exactly where the saving
installs. **Only use ChatGPT or Claude?** Then there is nothing to install: those
products charge a flat subscription, so there is no per‑token bill to cut. The whole
story, in plain words:
**[Where does the saving install?](https://savings.bivelio.com/en/how-it-works)**

**Claude Code, Codex CLI, Goose or Qwen Code with an API key?** The package also
ships a local measuring gateway: `bvsala claude` (or `bvsala codex`, `bvsala
goose`, `bvsala qwen`) launches the terminal through it and your real spend
shows up in your dashboard, token by token — nothing to configure, nothing
persisted. For opencode, Crush, Droid, Cline or Kilo Code, `bvsala doctor`
prints the exact config block for each one you have installed. Today it
measures; it does not optimize yet.

## Try it before you install

Run the real optimizer **free in your browser** — pick an example or paste your own
data and watch the meter — at **[savings.bivelio.com](https://savings.bivelio.com)**.

## Install in three steps

**1 · The package**

```bash
pnpm add @bivelio/savings-layer
# or: npm i @bivelio/savings-layer  ·  yarn add @bivelio/savings-layer
```

**2 · The license** — from your [dashboard](https://savings.bivelio.com/dashboard/install)
(**€4 / seat / month** or **€39 / seat / year**, EUR)

```bash
export BIVELIO_LICENSE_KEY=…   # your license key
export BIVELIO_SERVICE_KEY=…   # service-account key: auto-renewal + seat metering
```

**3 · Wrap the call** — this is the entire code change:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

// Your provider. LLM traffic goes straight to it — the SDK never proxies it.
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

That's it. From the first request, `report` carries the saving — measured, not
estimated.

## What you get on every request

A `SavingsReport` with the numbers behind every claim, kept in **four separate
ledgers** that are never summed into one flattering figure:

| Ledger | Meaning |
| --- | --- |
| `avoided_calls` | LLM / retrieval / tool calls that never executed |
| `eliminated_tokens` | information dropped because it was not needed |
| `compressed_tokens` | information kept, but encoded with fewer tokens |
| `provider_cached_tokens` | tokens still in the prompt, billed/processed more cheaply |

And a promise you can hold it to: **never worse than your JSON.** Payload encodings
are chosen by counting real tokens with the destination model's own tokenizer, and
BV‑SALA only moves away from plain JSON when the saving clearly clears the bar —
`report.serialization` shows what was chosen and what each candidate would have cost.

<details>
<summary><b>Structured output — validated <code>data</code>, not just text</b></summary>

Ask for a response contract and you also get `data`, validated against your schema:

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

</details>

<details>
<summary><b>Tool calls</b></summary>

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

</details>

<details>
<summary><b>Running a fleet? Seats and renewals</b></summary>

- **A seat is a machine, never a person.** A seat is billed only once it has been
  seen on 3 separate days, and CI runners are auto‑detected and excluded.
- **Set `serviceAccountKey` on every long‑running deployment.** Renewals mint a new
  license token each billing period; with the service‑account key (`bvk_…`, same
  dashboard) the SDK picks the renewed token up by itself, without a restart.
- **Set `BVSALA_SEAT_ID` (one stable value per replica) on Kubernetes or any fleet
  with dynamic hostnames**, so each replica counts as what it is:

```bash
BVSALA_SEAT_ID=worker-03   # stable per replica; [A-Za-z0-9._:/-], max 128 chars
```

</details>

<details>
<summary><b>Requirements</b></summary>

- **Node ≥ 20.** The package is **ESM‑only** (`"type": "module"`); from CommonJS,
  `require()` works on Node ≥ 22.
- Optional peer `gpt-tokenizer` for exact OpenAI token counts — without it a
  built‑in estimator is used, so it is not required to get started.
- Every component (cache, vector store, tokenizer, compressor, constraint backend)
  ships with an in‑memory default and is independently swappable behind the same
  interfaces.

</details>

## Licensing & privacy

BV‑SALA is commercial, per‑seat software (**€4 / seat / month** or **€39 / seat /
year**, EUR). The license is a signed token your SDK verifies **offline**; the
managed control plane and the revocation kill‑switch are served from BiVelio. Your
LLM traffic goes **straight to your provider** — BiVelio sees counts and cost,
never prompts or completions.

Get a key and read the terms at **[savings.bivelio.com](https://savings.bivelio.com)**.
Onboarding & general questions: **support@bivelio.com** · licensing & compliance:
**privacy@bivelio.com** · technical: **team@bivelio.com**.

---

© 2026 BiVelio Inc. All rights reserved. BV‑SALA is a trademark of BiVelio Inc.

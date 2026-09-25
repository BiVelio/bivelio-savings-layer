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
promise you take on faith: **every saving we charge on is measured with the provider's
official meter, the same one on your bill**, and every saving — measured or estimated,
and labelled as such — is handed back to you request by request.

**We only earn when you save.** Your first month carries no commission at all: we
measure everything and show you the statement of what it would have cost. After
that, the commission comes out of the **measured** saving only — never out of your
pocket, and never from estimates: a tiered rate from 10 % down to 4 % of what you
saved, so **you always keep at least 90 % of every euro saved**, and a month with no
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
> The license signature is verified **offline**; with `licenseServerUrl` set, the SDK
> also calls `savings.bivelio.com` for the revocation list, license renewal and usage
> metering. **Your prompts never leave your infrastructure** — what travels is token
> counts, cost, the model id and opaque seat/session ids, never content. Use is governed by the [LICENSE](./LICENSE)
> and the BiVelio Terms. Not a wrapper around any third‑party library.

## Where it installs

<p align="center">
  <img src="https://savings.bivelio.com/en/how-it-works/opengraph-image" alt="Your application → BV-SALA → provider API. Traffic goes straight from your app to your provider; the layer runs inside your code." width="720">
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
goose`, `bvsala qwen`) launches the terminal through it and your real spend shows
up in your dashboard, token by token — nothing to configure, nothing persisted.
For opencode, Crush, Droid, Cline or Kilo Code, `bvsala doctor` prints the exact
config block for each one you have installed. Like the SDK, the gateway is
fail‑closed: it starts only with your service key (`BIVELIO_SERVICE_KEY`) and an
active BiVelio license, which it collects with that key and verifies against the
key embedded in the package. Once running it never interrupts a request in flight:
if the license lapses, only new requests are refused (HTTP 402) until it is
renewed. It measures every request. With a PRO license it also applies one saving
by default: it shortens the cache-write TTL while your session stays hot, which
changes the price, never the content the model reads. The other levers (sibling
model, per-turn effort) stay off until you switch them on. On a Claude or ChatGPT
subscription there is no per-token invoice, so that traffic is metered at
list-price equivalent and never carries commission; the per-seat license applies
as for any other use.

### Python and any other language: the local gateway

The same gateway sits in front of any SDK that lets you set a base URL, whatever
the language:

```bash
bvsala gateway --upstream openai --port 8403   # one gateway per upstream
bvsala gateway                                 # Anthropic, the default, on 8402
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8403/v1")   # WITH /v1
stream = client.chat.completions.create(
    model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}], stream=True,
    stream_options={"include_usage": True},  # without it a stream carries no usage and is not metered
)
for chunk in stream:
    if chunk.choices:  # the last chunk carries only the usage
        print(chunk.choices[0].delta.content or "", end="")

from anthropic import Anthropic
claude = Anthropic(base_url="http://127.0.0.1:8402")    # NO /v1
```

With `BIVELIO_SERVICE_KEY` set, the gateway measures every request whose usage the
provider reports — Anthropic Messages, OpenAI Chat Completions and Responses, streamed
or not — for models with a list price in its catalog, priced at that list price. A
request it cannot meter (a model without a list price, a body it cannot read, a stream
that never asked for usage) is still forwarded, and its log line says so and why. That
is measurement, not savings: the saving levers of the SDK are TypeScript, and the
gateway's own levers apply to Anthropic `/v1/messages` traffic with a PRO license.
`bvsala doctor` prints the recipe for each SDK.

## Check it before you install

What you can check before paying is what we have measured: the published benchmark,
trial by trial, with the raw CSV linked, at
**[savings.bivelio.com/en/how-it-works](https://savings.bivelio.com/en/how-it-works)**,
and the commission calculator on the front page, which runs on the same price
catalogue that bills you. The verifier that replays the optimizer on your own data
lives in your dashboard once you sign in.

## Install in three steps

**1 · The package**

```bash
pnpm add @bivelio/savings-layer gpt-tokenizer
# or: npm i @bivelio/savings-layer gpt-tokenizer  ·  yarn add @bivelio/savings-layer gpt-tokenizer
```

`gpt-tokenizer` is optional, but install it if you call OpenAI models: it is the
provider's own tokenizer, and the SDK loads it by itself. Without it, counts fall back
to a built‑in estimate and the reconstructed savings are less accurate. Either way, a
saving where the layer removed something is reported as `estimated`, and estimated
savings are never billed — the SDK warns once when the tokenizer is missing.

**2 · The license** — from your [dashboard](https://savings.bivelio.com/dashboard/install)
(**€4 / seat / month** or **€39 / seat / year**, EUR)

```bash
export BIVELIO_LICENSE_KEY=…   # your license key
export BIVELIO_SERVICE_KEY=…   # service-account key: auto-renewal + seat metering (required by the gateway)
```

**3 · Wrap the call** — this is the entire code change. The package is ESM only:
put this in a `"type": "module"` project or a `.mts` file.

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

// Your provider. LLM traffic goes straight to it — the SDK never proxies it.
// Any OpenAI-compatible endpoint works: OpenAI, Azure, vLLM, SGLang, a gateway.
// Model ids are qualified (`openai/gpt-4o-mini`); the prefix is stripped on the
// wire for OpenAI and Azure and kept for gateways — see `stripProviderPrefix`.
const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
});

const layer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,        // required — from your savings.bivelio.com dashboard
  licenseServerUrl: "https://savings.bivelio.com",    // revocation list, renewal + metering — omit it and the two lines below do nothing
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY, // seat metering + AUTO-RENEWAL pickup
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});

console.log(text);                    // "8"  (computed locally — no LLM call)
console.log(report.calls.avoidedLlm); // → 1: a whole call you never paid for
console.log(report.cost.netSavings);  // → 0..1 ratio of the baseline you did not pay (1 here)
console.log(report.cost.baselineEstimate - report.cost.actual); // → the same saving in USD
console.log(report.cost.basis);       // → "estimated": nothing ran, so there is no provider counter
```

That's it. From the first request, `report` carries the saving and says how it
was obtained: `actual` is what the provider metered; `basis` is `"measured"` when
the request went through untouched, `"reference"` when a repeat of a byte‑identical
request was served without calling the provider — its baseline is the provider's own
counter for the identical request that already ran and that you already paid
(`report.cache.reference` points to it), valued at the provider's cached‑input rate,
with the output counted only under deterministic sampling (`temperature: 0`), so it is a floor —
`"estimated"` when the layer removed something (the baseline is then reconstructed
with the model's tokenizer, or with a calibrated estimate where no exact tokenizer
exists, as for Anthropic models), and `"unmeasured"` when the provider returned no
usage. Only `measured` and `reference` figures reach your invoice; estimated ones
never do.

**Streaming.** `generateStream()` takes the same request and hands you the answer as
the provider writes it, then the same `SavingsReport`:

```ts
const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Summarize the release notes in one line." }],
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report: streamed } = await stream.result;
console.log(streamed.cost.basis);          // same rules as generate(), read from the provider's final usage
console.log(streamed.streaming?.delivery); // "live", or "whole" when the answer arrived in one piece
```

The SDK asks the provider for its final usage at the end of every stream (on
OpenAI‑compatible endpoints, `stream_options.include_usage`); a stream that ends
without it is reported as `unmeasured` and never billed. With an output contract, or
a request declared `deferrable`, the answer is produced exactly as `generate()` would
and arrives as a single `text` event. Breaking out of the loop while the provider is
still writing cancels its request, and nothing is cached or recorded; once its answer
is complete, or when it arrives in one piece, nothing is cancelled.
`await stream.result` tells you which happened.

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
<summary><b>Your own A/B — verification sampling (opt-in, off by default)</b></summary>

The per-request figures above are what the layer can show without running your
request twice. To see what it does on your own traffic, with both sides metered by
your provider, turn on verification sampling:

```ts
const checkedLayer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
  verification: { sampleRate: 0.02 }, // about 2 in every 100 eligible requests
});
```

For that share of eligible requests, after your answer has been returned, the SDK
sends the same request once more to your provider exactly as it would go without the
layer — the model you asked for, all your tools, your data inline, no cache marks —
and discards the second answer. Each pair (what the unoptimized copy cost and what the
optimized request cost, both from your provider's usage counters) appears under
**Proof › Your bench** in your dashboard, with the mean difference, its 95 % interval
and every pair as a CSV download.

- **It costs you money.** You pay your provider for every copy: roughly the sampling
  rate times what that traffic would cost without the layer. The SDK says so once
  per process when it starts (`silenceWarnings: true` mutes that notice too).
- **It is never billed.** Pairs travel on their own channel into their own table.
  They never enter measured savings, your statement or any commission.
- **Only requests served intact are checked.** Requests that took the fail-open path,
  were cut off, missed their output contract or came back without a provider counter
  are counted as excluded and never sent twice. `savings: { verification: false }`
  excludes a single request.
- **Both sides follow the same rule.** A pair is compared only when the copy also
  finished normally and met your contract; a copy cut off by the output limit is
  counted and exported, never scored as a saving.
- **The headline is the floor, and it waits.** It is the lower bound of the 95 %
  interval, shown once there are enough pairs overall and groups with too few pairs
  of their own are a small share of your traffic, so a group where the layer costs
  you money cannot be left out of it.
- **Only counts leave your infrastructure.** The copy goes to your own provider, like
  the original; BiVelio receives token counts, costs, model ids and outcomes — never
  prompts or answers.
- **`close()` settles every copy still running:** it is recorded as abandoned, never
  as a pair. On serverless platforms, pass your runtime's `waitUntil` as
  `verification.waitUntil` so checks can finish.

</details>

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
- Optional peer `gpt-tokenizer` for exact OpenAI token counts, loaded automatically
  when installed — without it a built‑in estimator is used. It improves the accuracy
  of estimated figures; what reaches your invoice is `measured` and `reference`, which
  come from the provider's own counter either way.
- Every component (cache, vector store, tokenizer, compressor, constraint backend)
  ships with an in‑memory default and is independently swappable behind the same
  interfaces.

</details>

## Licensing & privacy

BV‑SALA is commercial, per‑seat software (**€4 / seat / month** or **€39 / seat /
year**, EUR; VAT not included). No free tier and no trial: what you can check before
paying is the published measurement. The license is a signed token your SDK and the gateway verify **offline**; the
managed control plane and the revocation kill‑switch are served from BiVelio. Your
LLM traffic goes **straight to your provider** — BiVelio sees counts and cost,
never prompts or completions.

Get a key and read the terms at **[savings.bivelio.com](https://savings.bivelio.com)**.
Onboarding & general questions: **support@bivelio.com** · licensing & compliance:
**privacy@bivelio.com** · technical: **team@bivelio.com**.

---

© 2026 BiVelio Inc. All rights reserved. BV‑SALA is a trademark of BiVelio Inc.

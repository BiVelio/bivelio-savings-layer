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
promise you take on faith: **every saving we charge on is measured with your provider's
own usage counter, the one your bill is built from** (for a repeat served without
calling the provider, the counter of the identical call that ran), and every saving —
measured or estimated, and labelled as such — is handed back to you request by request.

**A small per‑seat fee, and a commission only on savings measured against your
provider's counter.** The seat fee is paid whether or not you save. Your
first month carries no commission at all — it is the first calendar month (UTC) in
which your organization reports usage, so starting late in a month makes it a short one —
and at its close you see the statement of what the commission would have been. After
that, the commission is charged on the **measured** saving only — never from estimates:
a tiered rate from 10 % down to 4 % of what you saved, so **you keep
at least 90 % of every euro saved** (before the invoice is rounded to the cent; the
seat fee is separate). A month with no measured saving is zero commission. And your
prompts and completions **never reach BiVelio**: what BiVelio receives is per‑request
usage — token counts, cost, the model id and opaque ids — never your content
([LICENSE](./LICENSE) §5 lists every field; [savings.bivelio.com/privacy](https://savings.bivelio.com/privacy)
explains each one and how long it is kept).

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
> metering. **Your prompts, completions and provider keys never reach BiVelio** — what
> travels is per‑request usage: token counts, cost, the model id, a request id and
> opaque seat and session ids (the exact list is in [LICENSE](./LICENSE) §5). Use is
> governed by the LICENSE, which also sets out the seat fee and the commission, and the
> BiVelio Terms. Not a wrapper around any third‑party library.

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

**The gateway forwards what your terminal sends.** With no lever armed, your
provider receives the request body byte for byte and every header your client
sends (see the limits): `cache_control` and its 1-hour TTL, tool search and
`tool_reference` blocks, the advisor, every `anthropic-beta` value. An armed lever
changes only what it declares, and a request it cannot rewrite exactly travels
untouched. A test suite checks this against a fake upstream on every change
(`test/gateway-no-empeora.test.ts`; the repository is private, so the linked
section lists exactly what it checks). The gateway also logs, once per session,
requests that come out worse than your client asked for: cache markers the
provider ignored, a 1-hour TTL written at 5 minutes upstream, and tool search off
(Claude Code turns it off by default behind any proxy, this one included;
`bvsala claude` turns it back on). What it checks, and its limits:
[docs/terminales/README.md](./docs/terminales/README.md#what-the-gateway-guarantees-it-forwards-what-your-client-sends).

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
(`report.cache.reference` points to it; with an output schema, only when your schema
traveled exactly as sent, in strict mode, in the provider's native response‑format
parameter, with nothing added to the prompt), valued at the provider's cached‑input
rate, the lowest it bills for repeating a prompt; the output counts only under deterministic
sampling (`temperature: 0`), on a model with a list price in the catalog that does not
reason and honors that setting, and when the call that ran carried no hidden reasoning (the
provider reported zero reasoning tokens or, where it does not break them out, its answer
had no reasoning block), and then at 95 % of its counter, a margin for the small drift
`temperature: 0` still has —
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

**Quality, kept apart from money.** `report.qualityLedger` records how the answer you
received earned its place: whether it came from your provider, a replay, or the answer
to a reworded question (with its similarity score); whether it was checked against your
output contract, repaired or cut off by the output limit; and what the model cascade
decided. It holds no money, is never added to the four ledgers, and never leaves your
process. Reusing answers to reworded questions is opt-in, and by default it covers
single-shot requests only: requests that declare tools, carry tool calls or results, or
hold more than one user turn are left out unless you set
`savings.semanticCache: "include-agentic"`.

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
<summary><b>Provider price levers (opt-in, off by default)</b></summary>

Two request flags ask your provider for a lower price on the same tokens. Neither
changes the answer, and what they are worth is reported next to the four ledgers:
never folded into `cost.*`, never part of any commission.

**`savings.deferrable`** asks for the provider's Flex tier: OpenAI, and Gemini through
its OpenAI‑compatible endpoint. Anthropic has no cheaper synchronous tier (its
discount lives only in Message Batches, which the layer does not support yet).
Bedrock and DeepSeek off‑peak pricing are not supported.

- **Latency.** OpenAI publishes no latency commitment for Flex; Google publishes a
  target of minutes. Keep deferrable requests off user‑facing paths.
  `report.deferred.latency` quotes what the provider documents.
- **Risk.** Without capacity the provider refuses the request (429, or 503 on Gemini)
  instead of waiting; OpenAI documents that the refusal is not charged. With
  `priceLevers: { onCapacityError: "standard" }` the layer repeats it once at the
  standard tier and price, and says so in `report.deferred.capacityFallback`.
- **What it is worth.** Your provider's usage counter for that call, priced at the two
  published rate cards (standard, and the tier that actually served it), component
  by component, with the date the prices were checked. It is `measured` only when
  the served tier was read back from the provider's own API, the prices are list
  prices and the counter says how much of the input was read from (or written to)
  the prompt cache; otherwise `estimated`, and `basisReason` says why. It never
  exceeds the difference between the two published rate cards, even with your own
  `costModels`. A tier the provider did not confirm is never credited.

**`savings.standalone`** (GPT‑5.6 and later, on OpenAI's own API) declares that nothing
after the stable prefix of this request will be sent again. The provider then writes
its prompt cache only at the end of that prefix, or nowhere, instead of at the end of
your message, which on these models costs more than plain input. The trade‑off:
repeats and continuations of this exact prompt lose the cache reads the provider
default would give them, so leave it off conversation turns you will continue. Its
figure, `report.cacheWrites.avoidedWritePremium`, is always `estimated`: the provider
default was not run.

```ts
const leveredLayer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  priceLevers: { deferrable: true, onCapacityError: "standard" }, // layer-wide defaults
});

const { report } = await leveredLayer.generate({
  model: "openai/gpt-5.6-luna",
  messages: [
    { role: "system", content: "…your long, fixed instructions…" },
    { role: "user", content: "Classify ticket 42." },
  ],
  savings: { standalone: true }, // a request's own value always wins
});

report.deferred?.tierSaving; // { amount, basis, standardCost, appliedCost, pricesCheckedOn, basisReason }
report.cacheWrites;          // { mode, breakpoints, avoidedWritePremium?, reason }
```

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
<summary><b>Your ledgers in your tracing — OpenTelemetry, Langfuse, Datadog</b></summary>

Wrap the layer once and every request becomes a span on the OpenTelemetry pipeline
you already run (`@opentelemetry/api` is an optional peer; the SDK never imports it):

```ts
import { trace } from "@opentelemetry/api";
import { instrumentSavingsLayer } from "@bivelio/savings-layer";

// One span per request, on the OpenTelemetry pipeline you already run.
const traced = instrumentSavingsLayer(layer, { tracer: trace });
const { report: tracedReport } = await traced.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(tracedReport.cost.basis); // the span carries the same figures
```

- **Standard spans, plus your ledgers.** Spans follow the
  [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/model/gen-ai/registry.yaml)
  as last published (OpenTelemetry semantic conventions v1.41.1): `chat {model}`,
  kind CLIENT, provider, model and usage from your provider's counter (0 on an avoided
  call: no token was billed). On top, `com.bivelio.*` carries the four ledgers, the
  `basis`, the cost and the ids; `com.bivelio.request_id` is the same id as your usage
  record. Same results, same errors: `traced` hands back the very objects `layer` does.
- **Money is kept apart by basis.** The money saved is
  `com.bivelio.cost.saved.measured`, `.reference` or `.estimated` — one key per span,
  the one of its basis — so a sum over one key never mixes measured and estimated
  money; `unmeasured` spans carry counts and no money. `report.cost.netSavings` is a
  ratio and goes out as `com.bivelio.cost.net_savings_ratio`; the money is
  `baselineEstimate − actual`, and that is what `saved.*` holds.
- **None of this talks to BiVelio.** Spans go to your exporter; files stay where you
  write them. Your prompts, completions and provider keys never reach BiVelio, and no
  span carries them either: ids, counts, money and enums only, and a failed request
  records its `error.type`, never its message.
- **Langfuse.** Add the `LangfuseSpanProcessor` from `@langfuse/otel` to your tracer
  provider. These spans carry `gen_ai.*`, so its default filter exports them
  ([Langfuse OpenTelemetry docs](https://langfuse.com/integrations/native/opentelemetry)).
  `instrumentSavingsLayer(layer, { tracer: trace, langfuse: { metadata: true } })`
  makes the figures filterable metadata, and `langfuse: { cost: true }` hands Langfuse
  the report's own cost (in USD) instead of its estimate. Tracing with `@langfuse/tracing` by
  hand? Pass `toLangfuseGeneration(report)` to `generation.update()`.
- **Datadog LLM Observability** reads these spans over OTLP
  ([Datadog OpenTelemetry docs](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/)):

  ```bash
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<your Datadog site's OTLP traces endpoint>
  OTEL_EXPORTER_OTLP_TRACES_HEADERS=dd-api-key=<your Datadog API key>,dd-otlp-source=llmobs
  ```

  The `com.bivelio.*` attributes arrive as tags; with `datadog: { metadata: true }`
  they also arrive as span metadata. Datadog drops spans that carry no `gen_ai.*`
  attribute, so use `instrumentSavingsLayer` there rather than `recordSavingsOnSpan`
  (which writes `com.bivelio.*` on a span you already have, and no `gen_ai.*` unless
  you ask for it with `genAi: true`).

| Attribute | What it holds |
| --- | --- |
| `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model` | `chat`, the provider and the model (without a known provider prefix) |
| `gen_ai.usage.input_tokens`, `.output_tokens`, `.cache_read.input_tokens` | your provider's counter; absent when it reported no usage |
| `com.bivelio.cost.basis`, `.currency`, `.baseline`, `.actual` | where the money comes from, its currency (USD by default), and both sides |
| `com.bivelio.cost.saved.measured` \| `.reference` \| `.estimated` | the money saved, in the key of its basis only |
| `com.bivelio.cost.net_savings_ratio` | `cost.netSavings`, a 0..1 ratio — not money |
| `com.bivelio.calls.*`, `com.bivelio.tokens.*` | the four ledgers: avoided calls, eliminated, compressed and provider‑cached tokens |
| `com.bivelio.request_id`, `.model.id`, `.cache.result`, `.quality.status` | ids and outcomes |

</details>

<details>
<summary><b>Your ledgers in your FinOps tool — FOCUS rows and a daily savings series</b></summary>

Keep each report with the time it came back, and export whenever you like:

```ts
import { writeFileSync } from "node:fs";
import { toFocusRows, toSavingsSeries, toCsv, type SavingsRecord } from "@bivelio/savings-layer";

const records: SavingsRecord[] = [];
const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
records.push({ at: Date.now(), report: answer.report }); // keep reports as they come back

// FOCUS 1.4 rows, one per day, model and basis. Every cost column is 0 by design:
// your provider's bill already has the spend, so these rows add savings, never cost.
const rows = toFocusRows(records, { billingAccountId: "org-XXXXXXXX" }); // your provider billing account id
writeFileSync("bv-sala-focus.csv", toCsv(rows));

// A daily series for tools that take savings as a metric: one file per basis.
const measured = toSavingsSeries(records).filter((r) => r.measuredSavings !== null);
writeFileSync(
  "vantage-measured-savings.csv",
  toCsv(measured.map((r) => ({ date: r.date, amount: r.measuredSavings, model: r.model }))),
);
```

The rows follow [FOCUS 1.4](https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec/tree/v1.4),
the FinOps Open Cost and Usage Specification: `ChargeCategory` is `Adjustment`, the
service provider is the one in the model id (`OpenAI`, `Anthropic`…; pass
`serviceProviderName`, `invoiceIssuerName` or `hostProviderName` when a cloud or a
gateway bills you), and no SKU or unit price is invented. Nothing is sent anywhere:
`toFocusRows`, `toSavingsSeries` and `toCsv` are plain functions over the reports you
kept. Where each file goes, as each tool documents it in September 2026:

- **A FOCUS data lake or warehouse** reads every column, the `x_BiVelio*` ones included.
- **[Finout](https://docs.finout.io/get-started-with-finout/cost-and-usage-types/focus-in-finout)**
  loads a FOCUS CSV as a custom cost center; you send the file to Finout support.
- **[Vantage](https://docs.vantage.sh/connecting_custom_providers)** Custom Providers
  accept FOCUS 1.1–1.3 files but use only a few columns for cost reporting, and say
  nothing about `x_` columns, so the savings would not show. Upload the series as a
  [Business Metric](https://docs.vantage.sh/per_unit_costs) instead
  (`date,amount,<labels>`), one file per basis, so a metric never mixes bases.
  Vantage rejects two rows with the same date and labels: with `dimensions`, add
  them as label columns too.
- **[CloudZero](https://docs.cloudzero.com/docs/anycost-common-bill-format-cbf)** AnyCost
  takes its own Common Bill Format; the series can go in as a
  [Telemetry Stream](https://docs.cloudzero.com/docs/telemetry-streams).

The custom columns, in the currency you pass (`currency`, USD by default):

| Column | What it holds |
| --- | --- |
| `x_BiVelioBasis`, `x_BiVelioModelId` | the basis of every figure in the row, and the model id |
| `x_BiVelioRequestCount`, `x_BiVelioProviderCallCount`, `x_BiVelioAvoidedCallCount` | requests, calls that reached the provider, calls avoided |
| `x_BiVelioBaselineCost`, `x_BiVelioActualCost` | both sides of the saving; empty when the basis is `unmeasured` |
| `x_BiVelioMeasuredSavings`, `x_BiVelioReferenceSavings`, `x_BiVelioEstimatedSavings` | `baseline − actual`, in the column of the row's basis only; negative when the layer cost you money |
| `x_BiVelioEliminatedInputFloorCost` | the separate floor lane for context your provider cleared |
| `x_BiVelio…InputTokens`, `x_BiVelio…OutputTokens` | the token ledgers: baseline, actual, eliminated, compressed, provider‑cached |

`Tags` carries `bivelio/basis` and `bivelio/model`, plus any tags you return from the
`tags` option. Sum `measured` and `reference` for what you can check against your
provider invoice; `estimated` has its own column on purpose.

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

BV‑SALA is commercial software: a per‑seat subscription (**€4 / seat / month** or
**€39 / seat / year**, EUR; VAT not included), paid whether or not you save, plus a
tiered commission on measured savings only, as described at the top of this page, in
[LICENSE](./LICENSE) §6 and in the Published Pricing it refers to,
**[savings.bivelio.com/pricing](https://savings.bivelio.com/pricing)**. No free tier and no trial: what you can check before
paying is the published measurement. The license is a signed token your SDK and the
gateway verify **offline**; the managed control plane and the revocation kill‑switch
are served from BiVelio. Your LLM traffic goes **straight to your provider** —
BiVelio receives per‑request usage (counts, cost, the model id and opaque ids), never
prompts, completions or provider keys; [LICENSE](./LICENSE) §5 lists every field, and
**[savings.bivelio.com/privacy](https://savings.bivelio.com/privacy)** says how long
each one is kept.

Get a key at **[savings.bivelio.com](https://savings.bivelio.com)**.
Onboarding & general questions: **support@bivelio.com** · licensing & compliance:
**privacy@bivelio.com** · technical: **team@bivelio.com**.

---

© 2026 BiVelio Inc. All rights reserved. BV‑SALA is a trademark of BiVelio Inc.

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
promise you take on faith: **every saving we report is measured with your provider's
own usage counter, the one your bill is built from** (for a repeat served without
calling the provider, the counter of the identical call that ran), and every saving —
measured or estimated, and labelled as such — is handed back to you request by request.

**Measure for free, then pay per seat — with no commission on your savings.** The
free **Measure** license (no card) runs the layer in shadow mode on your own traffic and
shows what it would have saved, valued with your provider's counter. To turn the levers
on, **Pro** is **€15 / seat / month** or **€150 / seat / year**, and **Team** is **€129 / month
with 10 seats included** (€12 per extra seat; €1,290 / year, €120 per extra seat), EUR,
VAT not included — a fixed fee, paid whether or not you save, and no commission on what
you save. Enterprise (more seats, your own contract or invoicing terms) is by contract.
And your prompts and completions **never reach BiVelio**: what BiVelio receives is per‑request
usage — token counts, cost, the model id and opaque ids — never your content
([LICENSE](./LICENSE) §5 lists every field; [savings.bivelio.com/privacy](https://savings.bivelio.com/privacy)
explains each one and how long it is kept).

### For engineers, in one line

`@bivelio/savings-layer` (**BV‑SALA**) is one layer you add inside your code, right
where your app calls the OpenAI‑compatible or Anthropic API. For every request it
picks the cheapest execution that still meets your quality bar and hands you an
auditable `SavingsReport` — the same numbers your dashboard reads. Traffic still
goes straight from your app to your provider; the SDK is never a middleman server.

> **Commercial software — © 2026 BiVelio Inc.** Free to install, **paid to save**:
> BV‑SALA is fail‑closed and executes only with an active BiVelio license key. The
> free **Measure** license (no card) runs it in shadow mode: nothing you send is
> changed, nothing is served from cache, and you see what it would have saved.
> The license signature is verified **offline**; with `licenseServerUrl` set, the SDK
> also calls `savings.bivelio.com` for the revocation list, license renewal and usage
> metering. **Your prompts, completions and provider keys never reach BiVelio** — what
> travels is per‑request usage: token counts, cost, the model id, a request id and
> opaque seat and session ids (the exact list is in [LICENSE](./LICENSE) §5). Use is
> governed by the LICENSE, which also sets out the fees, and the
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

**A coding agent with an API key?** The package also ships a local measuring
gateway: `bvsala claude` (or `bvsala codex`, `goose`, `qwen`, `opencode`, `kilo`,
`copilot` with your own Anthropic key, `aider`) launches the agent through it and your real
spend shows up in your dashboard, token by token — nothing to configure, nothing
persisted. On exit it tells you how many requests it metered and which ones it
could not, and why. For Crush, Droid, Cline, Continue or Copilot in VS Code,
`bvsala doctor` prints the exact config block. Gemini CLI and Cursor cannot be
metered today, and the doctor says so. Like the SDK, the gateway is
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
sends except `x-bvsala-report`, which asks the gateway itself for a report (see
the limits): `cache_control` and its 1-hour TTL, tool search and
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

Flags and environment variables are in English (`--port`, `--project`, `--force`,
`BVSALA_GATEWAY_EFFORT`, `BVSALA_GATEWAY_SIBLING_MODEL`). The Spanish spellings from
0.4.x (`--puerto`, `--proyecto`, `--forzar`, `BVSALA_GATEWAY_ESFUERZO`,
`BVSALA_GATEWAY_MODELO_HERMANO`) were removed in 0.5: using one is an error that
names the English spelling, and the gateway does not start. `bvsala --help` lists
them all.

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

Each request can also bring its report back to your code. Send the header
`x-bvsala-report: 1` (in Python, `default_headers={"x-bvsala-report": "1"}` on
the client) and the gateway answers with `x-bvsala-request-id`. On the same
gateway, `GET /_bvsala/v1/reports/<that id>` returns what it recorded for your
dashboard: `metered` with the `SavingsReport` (the provider's token counts, the
cost at list price and `cost.basis`), or `not_metered` with the reason from the
log line. `?response_id=<the provider's response id>` finds it too, and
`wait_ms` waits for a request still in flight. The header never reaches your
provider, and a request without it is not changed at all:
[the details](./docs/terminales/README.md#what-the-gateway-guarantees-it-forwards-what-your-client-sends).

## Check it before you install

What you can check before paying is what we have measured: the published benchmark,
trial by trial, with the raw CSV linked, at
**[savings.bivelio.com/en/how-it-works](https://savings.bivelio.com/en/how-it-works)**,
and the free **Measure** license, which runs the layer in shadow mode on your own
traffic and shows what it would have saved, valued with your provider's counter. The verifier that replays the optimizer on your own data
lives in your dashboard once you sign in.

**Upgrading from 0.4?** Every breaking change of 0.5, with a before and after for
each, is in [Migrating from 0.4 to 0.5](https://savings.bivelio.com/en/migrate-to-0.5).

## Set it up in one command

```bash
npx @bivelio/savings-layer@latest init
```

It reads your `package.json` (Next.js, Express, the Vercel AI SDK, Mastra,
LangChain.js, the Anthropic SDK or the OpenAI SDK) and prints the three steps below,
written for your stack — the install line for your package manager, which keys are
missing, the exact code for your adapter — plus a free check: a question the layer
answers on your machine, so the model is not called. It reads `package.json` files only
(yours, and those in `node_modules` for the installed versions), never a `.env` file or a
key's value; it uses no network of its own and writes nothing.
`--write` creates the new files after asking you, and never overwrites one; `--json`
prints the same plan for a script or a coding agent.

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
(free **Measure** license, no card; **Pro** €15 / seat / month or €150 / seat / year;
**Team** €129 / month with 10 seats included — EUR)

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
// For Gemini, use the native `GoogleProvider` instead (see "Gemini: the native adapter").
// Model ids are qualified (`openai/gpt-4o-mini`); the prefix is stripped on the
// wire for OpenAI, Azure and Google's Gemini API and kept for gateways — see
// `stripProviderPrefix`.
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
console.log(report.cost.netSavingsRatio); // → 0..1 ratio of the baseline you did not pay (1 here)
console.log(report.cost.netSavingsUsd);   // → the same saving in USD (baselineEstimate − actual)
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

A repeat is valued by reference only when the call that ran reached the provider's
own API (`https://api.openai.com`, `https://api.anthropic.com` or
`https://generativelanguage.googleapis.com`), because the list price it is valued at
is the invoice only there. When `OpenAICompatibleProvider`, `AnthropicProvider` or
`GoogleProvider` points anywhere else — a proxy such as LiteLLM, a gateway, Azure, Bedrock, Vertex —
or when the Anthropic SDK or LangChain adapter reads that its client does, that call
leaves no reference: its repeats stay `estimated`, and the `reference` trace of the
call that ran says `unofficial-origin`. When the layer cannot tell where the call
went (a provider of your own, the AI SDK and Mastra adapters, a LangChain model that
does not expose its base URL), the rule applies as it always has. The layer reads the
configured base URL, not the wire: a custom `fetch` that sends the request elsewhere
is not seen.

**Provider refusals.** A refusal is measured like any other call and is never cached,
repaired or replayed by reference. One kind is priced at 0: an Anthropic
`stop_reason: "refusal"` that arrives before any output (no content block, zero output
tokens) with `stop_details.category` set to `cyber`, `general_harms` or `null`. Anthropic
documents these as
[not billed](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback#how-refusals-are-billed).
Its tokens still appear in `report.tokens`. `cost.actual`, `cost.baselineEstimate` and
`cost.netSavingsRatio` are all 0, so the request credits no saving: not measured, not
estimated and not by reference. A concurrent identical request served from it credits
nothing either. The same rule applies in the gateway. Any other refusal is priced from
its `usage` as usual. That covers `bio`, `frontier_llm` and `reasoning_extraction`, a
refusal after partial output, and a category the table does not list.

Most refusals carry no signal from the API: the model writes "I can't help with that."
as ordinary text and ends with `end_turn` or `stop`. The layer also looks for these,
with a conservative text heuristic. It checks only the opening of the answer, or the
whole answer when it is short, and it needs a real refusal clause, such as "I'm sorry,
but I can't help with that", "I cannot assist", "I can't determine…" or "As an AI, I
cannot provide". After an apology, any verb counts ("I'm sorry, but I can't
determine…"), and so does a stated reason with no "I can't" ("I'm sorry, but
accessing … is illegal", "… would be a violation of…"). When the answer opens with
the refusal itself ("I can't", "I won't", "I'm not going to", "I'm unable to", and
"No puedo", "Je ne peux pas", "Ich kann … nicht"…), any verb counts too ("I can't
argue that…"), except for a tested list of idioms that are not refusals ("I can't
wait", "I won't lie", "I can't find any issues", "I can't be sure, but…").
A single word is not enough.
An answer that opens with empathy and, in its first two sentences, sends the user to
a mental health professional, a crisis line, emergency services or someone they
trust, instead of answering, counts too (rule `redirection`). It covers English,
Spanish, Catalan, French, German, Italian and Portuguese. A match is measured and
served as usual. It is not written to the exact or semantic cache, and it is not
replayed by reference. A concurrent identical request served from it is `estimated`.
The trace says why (`skipReason: "text_refusal"`, with the `rule`). A refusal
already stored by an earlier version is not served either. In the gateway, the
coalesced twin of such a response is `estimated` (`primary-text-refusal`). A false
positive costs one cache hit. A normal answer that starts with "Sorry for the delay,
here is…", praises with "I can't recommend this enough", has "I can't" later on, or
offers empathy with practical help and no referral ("I'm sorry to hear about your
flight; here are three options…") is cached as before.

**Sensitive topics.** A request whose user turns touch self-harm or suicide, a mental
health crisis or a medical emergency ("How do I commit suicide?", "I'm having a panic
attack", "my friend is not breathing") is never read from or written to the exact or
semantic cache, even when the answer is useful, and leaves no reference record. It is
measured and served as usual; a concurrent identical request served from it is
`estimated`. The `policy` and `cache-write` traces say why
(`skipReason: "sensitive_topic"`, with the `category`). The check is lexical and
conservative: phrases, not single words ("kill a Python process", "Suicide Squad" and
"cut my hair" do not count). It covers the same twelve languages as the freshness
and personalization checks, with shorter lists outside English, Spanish, Catalan,
French, German, Italian and Portuguese. In the gateway, the coalesced twin of such a
request is `estimated` (`sensitive-topic`). A false positive costs one cache hit.

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

## Inside your framework

Already on an agent framework? The layer plugs in at that framework's own extension
point, from a subpath of this same package. The four adapters behave alike:

- **They answer without calling the model when they can** — a computed answer (the
  arithmetic above), an exact repeat of a request that already ran, an identical
  request already in flight — and otherwise let your framework make exactly the call
  it was going to make. They never rewrite what your framework sends.
- **Tools are treated as having side effects** unless you list them in
  `readOnlyTools`: a request that offers any other tool is never answered from a
  cache, because the action has to run.
- **Fail‑closed, like the SDK**: without an active license the call fails with
  `LicenseError` (a framework may wrap it, keeping its name and message) and the
  model is not called. **Put the adapter last**, so nothing sits between it and the
  model.

Every model call gets the same `SavingsReport` as with the SDK — its `basis` says
whether a figure comes from your provider's own counter — and `onReport` receives it
too.

### Vercel AI SDK

`pnpm add @bivelio/savings-layer ai @ai-sdk/openai` — a `LanguageModelMiddleware`
for `ai` 6 or 7:

```ts
import { generateText, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { savingsMiddleware, getSavingsReport } from "@bivelio/savings-layer/ai-sdk";

const savings = savingsMiddleware({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
  readOnlyTools: ["get_weather"],
});
const model = wrapLanguageModel({ model: openai("gpt-4o-mini"), middleware: savings }); // last in the list

const result = await generateText({
  model,
  prompt: "What is 2 + 2 * 3?",
  providerOptions: { bivelio: { context: { sessionId: "user-42" } } },
});
console.log(getSavingsReport(result)?.cost.basis); // "estimated": answered without calling the model
```

For `streamText`, read it with `getSavingsReport({ providerMetadata: await result.providerMetadata })`.

### Mastra

`pnpm add @bivelio/savings-layer @mastra/core` — an input processor for
`@mastra/core` 1.x:

```ts
import { Agent } from "@mastra/core/agent";
import { savingsProcessor } from "@bivelio/savings-layer/mastra";

const bivelio = savingsProcessor({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
  onReport: (r) => console.log(r.cost.basis),
});
const agent = new Agent({
  id: "support",
  name: "Support",
  instructions: "Answer briefly.",
  model: "openai/gpt-4o-mini",
  inputProcessors: [bivelio], // last in the list
});
console.log((await agent.generate("What is 2 + 2 * 3?")).text); // "8"
```

It covers `generate()` and `stream()`, not `generateLegacy()`/`streamLegacy()` or a
durable agent that resumes in another process; identical requests in flight are not
shared here. `emitReportPart: true` also streams each report as a
`data-bivelio-savings-report` part.

### LangChain.js

`pnpm add @bivelio/savings-layer langchain @langchain/core @langchain/openai` — an agent
middleware for `createAgent` in `langchain` 1.x. The model string (`"openai:…"`) is loaded
through its integration package, so `@langchain/openai` (or `@langchain/anthropic`) has
to be installed:

```ts
import { createAgent } from "langchain";
import { savingsAgentMiddleware, getSavingsReportFromMessage } from "@bivelio/savings-layer/langchain";

const agentSavings = savingsAgentMiddleware({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});
const lcAgent = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [agentSavings] }); // last
const state = await lcAgent.invoke({ messages: [{ role: "user", content: "What is 2 + 2 * 3?" }] });
console.log(getSavingsReportFromMessage(state.messages.at(-1))?.cost.basis);
```

The model call is measured when it finishes; tokens you stream with
`streamMode: "messages"` keep coming from the model as usual. A chat model with its
own `cache` set is reported as `unmeasured`: its counter may be a cached copy.

### Anthropic TypeScript SDK

`pnpm add @bivelio/savings-layer @anthropic-ai/sdk` — a client middleware for
`@anthropic-ai/sdk` 0.103 or later:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";

const claudeSavings = anthropicSavings({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});
const client = new Anthropic({ middleware: [claudeSavings.middleware] }); // last in the list
const message = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 256,
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(claudeSavings.reportFor(message)?.cost.basis);
```

It runs once per HTTP attempt, inside the SDK's retries: an attempt the provider
rejects reaches the SDK unchanged and is not recorded. Only message creation goes
through the layer; `countTokens`, batches, models and files pass untouched.

The middleware forwards your request body unchanged, history included, so it never
edits a turn before a thinking block. It also does not remove parameters the model
rejects. On Claude Sonnet 5.5, Opus 5.5, Fable 5.1 and Mythos 5.1 a forced
`tool_choice` (`any` or `tool`) returns a 400. On those models, and on Opus 4.7/4.8,
Opus 5, Sonnet 5 and Fable 5, so does a non-default `temperature`, `top_p` or `top_k`.
The middleware warns once per model and cause (`silenceWarnings` turns it off) and
the API's 400 reaches you unchanged.

<details>
<summary><b>Claude Sonnet 5.5, Opus 5.5, Fable 5.1: what <code>AnthropicProvider</code> sends instead</b></summary>

These models reject some request parameters with a 400 ([forcing tool
use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use),
[Sonnet 5.5](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)).
`AnthropicProvider` sends a request they accept instead of failing:

- **Output contract.** A forced `tool_choice` returns a 400 on these models, with or
  without thinking. When your schema meets `strict` mode, the contract travels as
  structured output (`output_config.format`). Without your tools, the provider still
  enforces the contract. With your tools, they stay callable with `tool_choice: auto`
  and the final text answer comes back in the contract's shape. When your schema does
  not meet `strict`, the contract travels as a tool the model is not forced to call,
  with one sentence in the system prompt that tells it to answer through that tool.
  Models that support forced tool use (Opus 5, Sonnet 5 and the 4.x models) get the
  same request as before.
- **`temperature`.** A non-default value is dropped, with one warning per model,
  because it can only return a 400. The answer is then sampled, not deterministic.
  `temperature: 1`, the API default, is sent as is.
- **A model the table does not list** (a new model or a gateway alias): when the API
  rejects either parameter, the provider repeats the request once without it and
  remembers the model for later requests. A 400 is not billed, so the retry is not
  counted in `retries`.
- **Thinking blocks.** `ChatMessage` does not carry thinking blocks, so this adapter
  never sends one. The preserved-thinking check, which returns a 400 when a turn
  before a thinking block has been edited, has nothing to check on its requests, even
  when the levers that rewrite history are on.

</details>

## What you get on every request

A `SavingsReport` with the numbers behind every claim, kept in **four separate
ledgers** that are never summed into one flattering figure:

| Ledger | Meaning |
| --- | --- |
| `avoided_calls` | LLM / retrieval / tool calls that never executed |
| `eliminated_tokens` | information dropped because it was not needed |
| `compressed_tokens` | information kept, but encoded with fewer tokens |
| `provider_cached_tokens` | tokens still in the prompt, billed/processed more cheaply |

**Your provider's own cache discount, shown apart and never billed.** With prompt
caching, most of what you save often comes from your provider's prefix cache
(Anthropic `cache_control`, OpenAI's automatic cache, Gemini's implicit cache), not
from the layer. `cost` prices cached tokens at the cached rate on both sides, so that
discount is never credited as the layer's saving. `report.nativeSavings` shows it on
its own, from your provider's counter at list price, so the report adds up to your
invoice:

```ts
report.nativeSavings;
// {
//   provider: "anthropic", mechanism: "explicit", layerMarked: true,
//   cacheReadTokens: 40000, cacheWriteTokens: 3000, cacheWrite1hTokens: 0,
//   inputPer1k: 0.003, cachedInputPer1k: 0.0003, writeMultiplier: 1.25, write1hMultiplier: 2,
//   readDiscountUsd: 0.108,   // reads × (input − cached-input rate)
//   writePremiumUsd: 0.00225, // writes × input × (multiplier − 1)
//   netUsd: 0.10575,          // can be negative: a cold write pays before any read
//   basis: "measured",
// }
```

It is present only when a call ran and the provider reported cache reads or writes;
a cache hit or a coalesced request never carries it. It is not in `cost.netSavingsRatio`,
not in `cost.baselineEstimate`, and never in the commission base. Your dashboard shows
it as its own card, **Native savings unlocked**, next to the credited savings.

**Quality, kept apart from money.** `report.qualityLedger` records how the answer you
received earned its place: whether it came from your provider, a replay, or the answer
to a reworded question (with its similarity score); whether it was checked against your
output contract, repaired or cut off by the output limit; and what the model cascade
decided. It holds no money, is never added to the four ledgers, and never leaves your
process. Reusing answers to reworded questions is opt-in, and by default it covers
single-shot requests only: requests that declare tools, carry tool calls or results, or
hold more than one user turn are left out unless you set
`savings.semanticCache: "include-agentic"`.

**Calibrated reuse (opt-in).** A fixed similarity floor means something different for
every embedder and every workload, so you can make the cache earn its floor on your own
traffic instead: `new InMemorySemanticCache({ embed, calibration: { maxErrorRate: 0.02 } })`.
It then serves no reworded answer until your labels show, at 95 % confidence, that at
most 2 % of the answers it would reuse from some score up are wrong, and it re-tests that
floor as labels accumulate. Until then every candidate goes to your provider, exactly as
it would without the cache, and the fresh answer is compared with the stored one by your
`judge` (by default only identical answers count, which suits classification and
structured output; pass your own for free text). Each calibrated reuse carries its bound
and the labels behind it in `report.qualityLedger.cacheMatch.calibration`. Calibration
costs reuses, never an extra call, and it does not change how anything is billed. If you
already have labeled pairs, `calibrateSemanticFloor()` runs the same test offline.

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
`GoogleProvider` (`serviceTier: "flex"`) or its OpenAI‑compatible endpoint. Anthropic has no cheaper synchronous tier: its
discount lives only in Message Batches, which `layer.batches` (below) sends to.
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

**`layer.batches`** sends requests that can wait hours to the provider's own batch API,
billed at its published batch rate card: Anthropic's Message Batches through
`AnthropicProvider`, and OpenAI's Batch API through `OpenAICompatibleProvider` on
`api.openai.com`. Gemini's batch mode is not supported yet.

- **What runs.** Each request is translated by the same provider adapter as
  `generate()` and sent as you wrote it: the layer's own per‑request savings (caching,
  compression, model cascade, retrieval) do not run on batches. The layer splits the
  job at the provider's limits (and, on OpenAI, one model per file).
- **Latency.** The provider's: results arrive within its batch window, not on a
  request/response path. `submit()` returns a plain‑JSON job you can store and read
  from another process.
- **What it is worth.** Each result's usage counter at the standard and at the batch
  published rate cards, component by component, with the same `measured` /
  `estimated` rule as above. The tier is read from the provider: Anthropic reports it
  on every result; on OpenAI it is the batch the result came from. Nothing is
  metered and the batch saving is never billed.

```ts
const tickets = [{ id: "t-1", text: "My invoice is wrong." }]; // your deferrable work

const job = await layer.batches.submit(
  tickets.map((t) => ({
    customId: t.id,
    request: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: t.text }] },
  })),
);
// …later, even from another process (store `job` as JSON):
const results = await layer.batches.results(job);
results.ended;   // false while the provider is still working
results.items;   // one per request: { customId, outcome, text, usage, tierSaving?, reason }
results.summary; // { succeeded, errored, expired, credited, tierSaving, basis, pricesCheckedOn, reason, … }
```

</details>

<details>
<summary><b>Tool outputs, compacted where they are born (opt-in, off by default)</b></summary>

In an agent loop your history is re-sent on every turn and your provider reads it
from its prompt cache at a fraction of the input price. Rewriting anything it has
already cached turns everything after it back into full-price cache writes, which is
how "fewer tokens" ends up as a bigger bill. So this lever only ever changes a tool
output on the turn it arrives, and re-sends exactly the same bytes afterwards.

It removes terminal colour codes, superseded progress-bar states, whitespace between
JSON tokens and runs of identical lines (folded into one line plus a count), and
nothing else: no summaries, no dropped words. Each change either reverses exactly or
leaves what a terminal would display. Outputs of calls that name a file are left
verbatim, so an agent that edits by exact match still sees the file as it is.

```ts
const agentLayer = createSavingsLayer({
  provider,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  toolOutputCompaction: true, // or { exceptTools: ["read_logs"], minSavedChars: 512 }
});
// or per request: savings: { toolOutputCompaction: true }
```

- **Switch it on for whole conversations.** The decision depends only on each
  output's own text, so every process and every turn produces the same bytes. A
  conversation that started without it is rewritten once, on its first compacted
  request.
- **Counted, not billed.** What it removes shows in `report.tokens.compressedInput`
  and in `report.traces`; it never enters `cost.*` or any commission. Your provider's
  invoice shows the effect.
- **Inside a framework,** call `compactToolOutput(text)` in your tool before you
  return its result: your history then holds the compacted text itself.
- **Measure it by conversation, not by request.** A verification copy re-sends one
  request with the original history, which your provider has not cached, so on
  turns that re-send compacted outputs the copy costs more than going without the
  layer would have. Compare whole conversations with and without it.

</details>

<details>
<summary><b>Prompt-cache breakpoints placed from your traffic (opt-in)</b></summary>

By default the layer writes the provider's prompt cache at two fixed places: the end
of the system header and the end of the history before your last user message, and
stops marking a prefix whose measured hit rate does not pay the write premium. On
Anthropic, where a write costs 1.25x, the history and a tool catalogue sent without a
system header are marked only when the request itself shows they will be sent again:
a tool-loop step after your last user message, or a conversation already past its
second turn. The first follow-up of a conversation (`[question, answer, question]`)
marks only the system header, so two-turn chats pay no premium that nothing reads.
In an agent loop with no system header, the end of the tool list is marked once the
catalogue reaches the model's minimum cacheable size (512 tokens on Claude Sonnet 5.5
and Opus 5.5, 1,024 on Sonnet 5, 4,096 on Haiku 4.5). That discount is the provider's
cache on your bytes: it is never credited as the layer's saving.

`cacheBreakpoints: "auto"` places them from what your traffic actually does. The layer
compares each request's prefix with the ones it sent before, per model, tool set and
system header, and learns how often each part is sent again and after how long. That
costs nothing: it compares locally and marks nothing to find out. Once the evidence
is conclusive:

- **Tail.** When requests continue each other (agent tool loops, conversations), it
  also marks the last block, so the next turn reads the whole prompt from cache.
  Tool results arrive after your last user message, so the fixed placement never
  caches them.
- **History.** When the history before the question is not sent again (one-off
  requests with their own document), it moves the breakpoint back to the system
  header, so no write premium is paid on a prefix nobody reads.
- **One-hour lifetime** (Anthropic). When turns come back after more than five
  minutes but within the hour, and the size of the request makes the 2x write pay.
- **Explicit mode** (GPT‑5.6 and later, on OpenAI's own API). When continuations are
  rare, your question is not written to the cache. `savings.standalone` still wins
  when you set it, and `report.cacheWrites` says when the layer chose it.

Until then it behaves exactly like the default. Every decision and its reason is in
`report.traces` (`prefix-cache-placement`), and the effect is read from the provider's
own counters: if they do not confirm the cache reads the layer predicted, that
traffic goes back to the default placement. The write premium it causes, one-hour
writes at 2x included, is charged to `cost.actual`; the cache discount it earns is
counted in ledger 4 like any provider cache read, never credited as the layer's
saving and never part of any commission.

```ts
const placedLayer = createSavingsLayer({
  provider, // Anthropic, or OpenAI GPT-5.6+ on OpenAI's own API
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  cacheBreakpoints: "auto",
});
```

</details>

<details>
<summary><b>Serverless: keep what the layer learns between instances</b></summary>

Calibrated reuse and `cacheBreakpoints: "auto"` learn from your traffic, and by default
what they learn lives in the process. On serverless platforms (Vercel Functions, AWS
Lambda) an instance may serve one request or live a few minutes, so neither would ever
get past its starting point. Give each one somewhere to keep it. Giving the layer a
`semanticCacheStore` only says where reworded questions are kept; `semanticCacheDefault: true`
is what switches reuse on for every request (a request's own `savings.semanticCache`
still wins), and without it, or `savings.semanticCache` on each request, the cache
stays empty and learns nothing:

```ts
import { InMemorySemanticCache } from "@bivelio/savings-layer";

// Any key-value client your instances share, such as Redis.
type SharedKeyValue = {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { px: number }): Promise<unknown>;
};

async function serverlessLayer(kv: SharedKeyValue) {
  const semanticCache = new InMemorySemanticCache({ calibration: { maxErrorRate: 0.02 } });
  const saved = await kv.get("bvsala:semantic-calibration");
  if (saved) semanticCache.importCalibration(saved); // the object or its JSON text

  const layer = createSavingsLayer({
    provider,
    licenseKey: process.env.BIVELIO_LICENSE_KEY,
    semanticCacheStore: semanticCache,
    // Passing the cache does not switch it on; this asks for it on every request.
    semanticCacheDefault: true,
    cacheBreakpoints: "auto",
    cacheBreakpointStore: {
      get: (key) => kv.get(key),
      set: (key, value, ttlMs) => kv.set(key, value, { px: ttlMs }),
    },
  });

  // After handling requests with `layer`, save the calibration:
  const save = async () => {
    await semanticCache.settled();
    await kv.set("bvsala:semantic-calibration", JSON.stringify(semanticCache.exportCalibration()));
  };
  return { layer, save };
}
```

- **Breakpoint placement.** The store holds prompt-prefix fingerprints, timestamps and
  counts, one key per traffic class, never prompt text. The layer reads it before
  placing breakpoints and reads and rewrites it after the provider answers, so every
  instance extends the same measurement. If the store fails, that request is placed as
  a fresh instance would place it and nothing is written over what others learned.
  Without a store nothing changes.
- **Calibration.** The saved state is the whole experiment: both halves of the labels,
  how many tests have already drawn on the confidence budget, and the floor in force.
  Restoring it continues the same calibration, so the bound keeps holding across
  restarts; it never starts the budget over. A state recorded under another embedder,
  verifier, judge or configuration is refused with `CalibrationStateError`. If you pass
  your own `embed`, `verify` or `judge`, name them (`embedderId`, `verifierId`,
  `calibration.judgeId`) so a state can say what it was recorded with.
- **One line of history.** The bound holds along one line: restore the latest state and
  save from where it went. Instances that continue the same state at the same time
  each spend its remaining confidence again, and the last one to save overwrites the
  others' labels. For one bound across many concurrent instances, calibrate in a single
  long-lived process, or offline with `calibrateSemanticFloor()`, and give every
  instance the certified floor as `acceptThreshold`. The cached answers themselves
  still live in each instance's memory.
- **Why a predicted cache read did not happen** (Anthropic's own API). With
  `cacheMissDiagnostics: true`, the layer asks Anthropic to compare each marked request
  with the one whose cache entry it expected to read, and puts the provider's
  `cache_miss_reason` in `report.traces` when that read does not arrive. Anthropic
  keeps a short-lived fingerprint (hashes and token-count estimates) of each request
  that opts in; check that against your data-retention terms first.

</details>

<details>
<summary><b>Structured output — validated <code>data</code>, not just text</b></summary>

Ask for a response contract and you also get `data`, validated against your schema:

```ts
const { data, text } = await layer.generate<{ answer: number }>({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "How many legs does a spider have?" }],
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

A question the layer can answer on its own (the arithmetic of the first
example) is only served without the model when that answer meets your schema.
The arithmetic resolver returns `{ value: 8 }`: with a `{ answer: number }`
contract it steps aside and the request goes to the model, which answers in
your contract's shape.

</details>

<details>
<summary><b>Gemini: the native adapter</b></summary>

For Gemini, use `GoogleProvider`: it speaks Gemini's own API (`generateContent` and
`streamGenerateContent`), where what the layer measures is documented. Keep
`OpenAICompatibleProvider` for every other provider.

```ts
import { GoogleProvider } from "@bivelio/savings-layer";

const gemini = createSavingsLayer({
  provider: new GoogleProvider({ apiKey: process.env.GEMINI_API_KEY, requireUsage: true }),
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
});

const { text: answer, report: geminiReport } = await gemini.generate({
  model: "google/gemini-3.8-flash", // the `google/` prefix never travels
  messages: [
    { role: "system", content: "Answer in one sentence." },
    { role: "user", content: "Why is the sky blue?" },
  ],
  maxOutputTokens: 400,
  reasoningEffort: "low", // → thinkingLevel "LOW" (Gemini 3) or a thinking budget (2.5)
});
console.log(answer, geminiReport.cost.actual);
```

What the native API gives the layer that the OpenAI-compatible endpoint hides:

- **Thinking is billed output.** Output is `candidatesTokenCount + thoughtsTokenCount`
  (Google bills thinking as output) and the thinking is reported as reasoning. Thought
  summaries (`thinkingConfig: { includeThoughts: true }` on the adapter) are never part
  of `text`.
- **Refusals with their reason.** A blocked prompt (`promptFeedback.blockReason`) or a
  filtered answer (`finishReason` `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST`, …) is
  `finishReason: "content_filter"` with the native reason in `finishReasonDetail`:
  measured from its usage, never cached, never credited.
- **Tools.** Calls come back with their `id` and `thoughtSignature`; send the assistant
  turn back with its `toolCalls` as they came (as in the tool loop above) and the
  signature travels back untouched. The results of one turn go back together.
- **Implicit caching.** Gemini 2.5 and later cache repeated prefixes on their own; the
  cached part of the prompt (`cachedContentTokenCount`) is reported as provider-cached
  tokens. Explicit context caching (`cachedContents`) is not used: it bills storage by
  the hour, which a per-request report cannot price.
- **Output contract.** Your schema travels as written in `responseJsonSchema`. Google
  does not document that every JSON Schema feature is enforced, so a repeat of a request
  with a schema is not valued by reference.
- **Thinking level.** `reasoningEffort` follows Google's published mapping. A model that
  rejects a level (`gemini-3.8-flash` answers 400 to `MINIMAL`) is asked again once at
  `LOW`, and remembered; the rejected request was not billed. Thinking cannot be turned
  off on Gemini 3 or 2.5 Pro, so `"none"` there is the lowest level, with a warning.

</details>

<details>
<summary><b>Output cap — with or without a contract</b></summary>

`maxOutputTokens` on the request caps the answer of any request, free text
included. With `response.maxOutputTokens` as well, the smaller of the two is sent.

```ts
const { text, finishReason } = await layer.generate({
  model: "openai/gpt-5-mini",
  messages: [{ role: "user", content: "Summarize this in two sentences: …" }],
  maxOutputTokens: 300,
});
```

On the wire it becomes Anthropic's `max_tokens`; on Chat Completions,
`max_completion_tokens` when `baseUrl` is OpenAI's own API (`max_tokens` is
deprecated there and its reasoning models, o-series and gpt-5.x, reject it) and
`max_tokens` on any other OpenAI-compatible endpoint, which is the field they all
understand. If an endpoint answers 400 naming the field it got as unsupported, the
request is repeated once with the other one (nothing was generated, so nothing is
billed twice) and the model is remembered. To choose the field yourself:
`new OpenAICompatibleProvider({ baseUrl, maxTokensParam: "max_completion_tokens" })`.

**OpenAI-compatible endpoints that are not OpenAI** (Gemini's
`generativelanguage.googleapis.com/v1beta/openai`, LiteLLM, vLLM, Ollama, a router).
`prompt_cache_key`, OpenAI's prefix-cache routing hint, goes only to OpenAI's own API:
Gemini answers 400 to a field it does not know, and up to 0.4.31 every request with a
cached prefix failed there. A proxy in front of OpenAI that forwards it can opt in with
`sendPromptCacheKey: true`. Any optional field an endpoint still rejects by name
(`prompt_cache_key`, `service_tier`, `seed`, `reasoning_effort`) is dropped, the request
repeated once and the model remembered; `reasoning_effort` is never dropped on OpenAI's
own API, where its 400 is the answer. Gemini leaves its thinking tokens out of
`completion_tokens` and bills them as output, so the layer counts output as
`total_tokens − prompt_tokens` whenever the total is larger (and reports the difference
as reasoning); on OpenAI's API `completion_tokens` already include reasoning and nothing
is added. Gemini stops a filtered answer with `finish_reason: "content_filter: OTHER"`
(or another reason): it is `finishReason: "content_filter"` (the adapter keeps the
reason, which reaches you as `result.finishReasonDetail` and is named in the report's
cache trace; an Anthropic refusal brings its `stop_details.category` there too), and like every
provider refusal it is measured, never
cached and never credited. Google does not document that such refusals are free, so
they are costed from their `usage` like any call.

The cap is yours, not a saving: it is never credited as output avoided. An answer
it cut (`finishReason: "length"`) is not cached, and
`report.qualityLedger.truncation` says the limit was yours.

</details>

<details>
<summary><b>Tool calls</b></summary>

When you pass `tools` and the model asks to invoke one, the reply is not the final
answer: `text` is empty by design and the request is in `toolCalls`. Execute it,
append the assistant turn and one `role: "tool"` message per call to `messages`, and
call `generate()` again.

```ts
import type { ChatMessage, ToolDescriptor } from "@bivelio/savings-layer";

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

// ← your tool
const getWeather = async (city: string): Promise<string> => `${city}: 21 °C, clear`;

const messages: ChatMessage[] = [{ role: "user", content: "What's the weather in Madrid?" }];
let res = await layer.generate({ model: "openai/gpt-4o-mini", messages, tools });

while (res.toolCalls?.length) {
  // res.finishReason === "tool_calls". Send the calls back as they came, ids included.
  messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
  for (const call of res.toolCalls) {
    const args = JSON.parse(call.arguments) as { city: string };
    const output = await getWeather(args.city);
    messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
  }
  res = await layer.generate({ model: "openai/gpt-4o-mini", messages, tools });
}
console.log(res.text);
```

- **Ids.** Each result carries the `toolCallId` of the call it answers, and every call
  of a turn gets its result before the next user or assistant message. On Anthropic
  that is what lets the turn travel as `tool_use`/`tool_result` blocks (with the tool
  still in that request's `tools`); otherwise it is sent as plain text, as before, and
  the SDK warns once.
- **Errors.** When a tool fails, put the error in `content` and set `isError: true`.
  Anthropic receives it as `is_error`; providers without such a flag get the text.
- **Gemini 3's thought signature.** With `GoogleProvider` it travels in each call's
  `thoughtSignature` and comes back in `call.extraContent` in the same shape as below,
  so a conversation can move between the two Gemini adapters. Through its
  OpenAI-compatible endpoint Gemini
  returns each call with `extra_content.google.thought_signature` and rejects the next
  turn with a 400 if the call comes back without it. It arrives in `call.extraContent`;
  pushing `res.toolCalls` back as they came (as above) sends it back untouched. It is
  opaque and not part of any cache key.
- **gpt-5.6-sol, gpt-5.6-terra and gpt-5.6-luna with tools need `reasoningEffort: "none"`.**
  On Chat Completions OpenAI rejects function tools for these models unless
  `reasoning_effort` is `"none"` («Function tools with reasoning_effort are not supported for gpt-5.6-sol in
  /v1/chat/completions»). Declare it on the request:
  `layer.generate({ model: "openai/gpt-5.6-sol", messages, tools, reasoningEffort: "none" })`.
  The layer never picks an effort itself: without the field nothing is sent. It is part
  of the cache key, like `temperature` and `seed`.

A tool‑call turn is never served from cache and never counted as an avoided call:
an action that has not run yet cannot be a saving. The answer that follows a tool loop
can be, and its cache key covers the loop: each call's name and arguments, which call
each result answers and its `isError`. Two conversations that differ only there never
share a cached answer; the fresh call ids of a new run of the same loop are not a
difference.

**Which tools reach the model.** The layer never cuts a catalogue it cannot rank. If
your tools declare no `intents` and no `risk` (the usual shape of MCP and OpenAI tool
lists), or you pass `savings: { router: false }`, every tool goes to the provider
exactly as you sent it, and the layer credits nothing for the tool block. When your
tools declare `intents`/`risk`, the selector holds back write tools from a request
that is not an action and, since 0.4.33, sends every other tool: it prunes by
relevance only if you ask for it with `new ToolSelector({ maxTools })` (up to 0.4.32
that was the default, with 8). Whatever it leaves out, the model cannot call in that
request: the report's `tool-selector` trace lists it, the tokens count as eliminated
input, and the SDK warns once per process (`silenceWarnings` turns the warning off).

**Large catalogues: let the provider search them (opt‑in).** With hundreds of tools
(several MCP servers, say), `savings: { toolSearch: "auto" }` sends every tool deferred
behind the provider's own tool search instead of putting the whole catalogue in every
request's prompt. The model looks up what it needs, no tool you declared is out of
reach, and the cached prompt prefix stays the same from one question to the next.

- **Where.** The Anthropic adapter, on models in Anthropic's tool search compatibility
  table. OpenAI documents its tool search for the Responses and Agents APIs, not for
  Chat Completions, which is what this SDK's OpenAI adapter speaks, so OpenAI requests
  keep the selector.
- **When.** `"auto"` applies it when the adapter talks to Anthropic's own API, the
  catalogue is over the provider's documented size, and deferring it pays for one
  search on every request even with a warm prompt cache. `"always"` skips those checks
  (for example behind a proxy that forwards the search blocks). Requests with an output
  contract, or with the model cascade on, keep the selector.
- **Across turns.** Append the assistant turn with its `toolCalls` (ids as returned)
  before the tool results, as in any tool conversation. The Anthropic adapter then sends
  the earlier search results back in that turn, so the model calls the tools it already
  found without searching again. It keeps them in memory, per adapter instance and
  bounded; a turn it no longer remembers (another process, say) goes out as before and
  the model searches again.
- **Whose saving.** The provider's. Your usage counter shows it; the layer credits
  nothing for it and charges no commission on it.

```ts
import { AnthropicProvider } from "@bivelio/savings-layer";

const claude = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
});

const mcpTools: ToolDescriptor[] = []; // every tool your MCP servers list

const { report: searched } = await claude.generate({
  model: "anthropic/claude-opus-5-5",
  messages: [{ role: "user", content: "Which orders from service 17 are still open?" }],
  tools: mcpTools,
  savings: { toolSearch: { mode: "auto", alwaysLoaded: ["read_file"] } },
});

// Which path ran and why, and how many searches the provider ran.
console.log(searched.traces.filter((t) => t.stage === "tool-search"));
```

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
  money; `unmeasured` spans carry counts and no money. `report.cost.netSavingsRatio` is a
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
| `com.bivelio.cost.net_savings_ratio` | `cost.netSavingsRatio`, a 0..1 ratio — not money |
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
  If that pickup is rejected (HTTP 401/403/404: rotated key, key from another
  organization, wrong `licenseServerUrl`), the SDK warns once per cause even with
  `silenceWarnings: true`, because the license will stop renewing.
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
- Framework adapters: `ai` 6 or 7, `@mastra/core` ≥ 1.68 < 2, `langchain` ≥ 1.1 < 2
  with `@langchain/core` ≥ 1.1 < 2, and `@anthropic-ai/sdk` ≥ 0.103 < 1 — optional
  peers, needed only for the adapter you import. `ai` 7 and `@mastra/core` declare
  Node ≥ 22 in their own `engines`.
- Optional peer `gpt-tokenizer` for exact OpenAI token counts, loaded automatically
  when installed — without it a built‑in estimator is used. It improves the accuracy
  of estimated figures; what reaches your invoice is `measured` and `reference`, which
  come from the provider's own counter either way.
- Every component (cache, vector store, tokenizer, compressor, constraint backend)
  ships with an in‑memory default and is independently swappable behind the same
  interfaces.

</details>

## Licensing & privacy

BV‑SALA is commercial software. The plans are **Measure** (free), **Pro** (per seat),
**Team** (a number of seats included, plus each extra seat) and **Enterprise** (by
contract); Pro and Team are paid whether or not you save and carry **no commission** on
your savings. The prices are at the top of this page, in [LICENSE](./LICENSE) §6 and in
the Published Pricing it refers to,
**[savings.bivelio.com/pricing](https://savings.bivelio.com/pricing)**. No trial. There is one free license,
**Measure** — no card, one organization per verified account, up to 5 seats and 20,000
requests a day: the layer runs in **shadow mode**. Every request goes to your provider
exactly as you built it, nothing is served from any cache, no lever is applied, and
`report.measure.wouldHaveSaved` (with `basis: "shadow"`) says what the exact cache and
in‑flight coalescing would have saved on that request, valued with your provider's own
counter — a lower bound, never part of any commission. The levers need a paid plan: once
you upgrade, a layer with `serviceAccountKey` and `licenseServerUrl` picks up the paid
license by itself and turns them on without a restart.

The earlier plan — a lower per‑seat fee plus a tiered commission on measured savings
only — is **closed to new customers**; a subscription already on it keeps it unchanged.
On that plan your first month carries no commission (the first calendar month, UTC, in
which your organization reports usage); after that the commission is charged on the
measured saving only — never from estimates — at a tiered rate from 10 % down to 4 %, so
you keep at least 90 % of every euro saved (before rounding to the cent; the seat fee is
separate).

The license is a signed token your SDK and the
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

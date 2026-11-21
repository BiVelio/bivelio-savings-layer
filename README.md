<p align="center">
  <img src="https://savings.bivelio.com/brand/og-image.png?v=2026-11-17" alt="BiVelio Savings Layer" width="720">
</p>

<h1 align="center">The savings layer for your LLM bill</h1>

<p align="center">
  <em>Cut your AI bill — and see exactly why, measured on the same meter your provider bills you with.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bivelio/savings-layer"><img src="https://img.shields.io/npm/v/%40bivelio%2Fsavings-layer?color=2F63D8&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520.19-14A06F" alt="Node ≥ 20.19">
  <img src="https://img.shields.io/badge/license-Apache--2.0-2F63D8" alt="Apache-2.0">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-14A06F" alt="0 runtime dependencies">
  <img src="https://img.shields.io/badge/telemetry-off%20by%20default-0F1218" alt="Telemetry off by default">
</p>

`@bivelio/savings-layer` (**BV‑SALA**) sits between your app — or your coding agent —
and the LLM provider, and lets through only what has to be paid for. Every saving is
reported request by request, valued with your provider's own usage counter at
versioned list prices.

```shell
npm i @bivelio/savings-layer         # the SDK, in your TypeScript/JavaScript app
npx @bivelio/savings-layer claude    # or meter Claude Code through the local gateway (also codex, gemini, qwen, aider)
```

- **Free, with no key.** The open core is the whole savings layer, Apache-2.0. The SDK:
  install it and it saves where your traffic repeats (identical or simultaneous requests)
  and, on Anthropic, where your system prompt is long and stable; traffic that never
  repeats saves about 0 % by default. With a coding agent, the local gateway measures
  your spend on your machine, request by request; its cache-write TTL lever saves only
  when your client pays per token and asks for the one-hour cache. No key, no signup, no
  telemetry, and nothing is sent to BiVelio.
- **The cloud is the optional part.** A BiVelio key adds the team dashboard, shared
  measurement, seats and license management: free on Measure, a fixed subscription on
  Pro and Team, and never a commission on what you save. A key only adds the cloud
  (with one exception for trimming of superseded tool results), and it ties the layer
  to savings.bivelio.com (see [Community vs Cloud](#community-vs-cloud)). Prices below.
- **The evidence is public.** [The paper](https://savings.bivelio.com/paper) (v2.3-r1,
  revised after an external pre-publication review) gives the method, the results and
  every limitation; the artifacts are in
  [`benchmarks/evidencia`](https://github.com/BiVelio/bivelio-savings-layer/tree/main/benchmarks/evidencia).

### How it saves

It skips calls that don't have to happen (exact cache and deduplication; the semantic
cache once you calibrate it), trims what does (prompt-cache placement, superseded tool
results, serialization; tool-output and context compaction when you switch them on),
and can route each request to the cheapest execution that meets your quality bar (model
cascade, sibling models, provider failover — each one opt-in) — on OpenAI,
Anthropic, Gemini, **DeepSeek, Qwen, GLM, Moonshot**, any OpenAI‑compatible
endpoint, and local servers (Ollama, vLLM, LM Studio).

**What is on, and what you switch on.** Every lever is included and free, with no key. On by default: exact cache, deduplication, local resolvers, prompt-cache placement, trimming of superseded tool results and compact serialization of the structured data you pass. The rest you switch on, one line each.
The semantic cache stays in shadow until you calibrate it on your own traffic. Opt-in:
tool-output and context compaction, the model cascade, the cacheable-prefix reorder
(`savings.cachePrefix`) and the rest of
[the optional levers](#optional-levers-and-integrations). The package ships no
compressor: compaction is a lossless rewrite of JSON tool outputs that runs only when you
switch it on, and no compression figure is published. In the local gateway:
Every gateway lever is free, with no key; one is on by default (cache TTL tuning) and the others you switch on.

How much it saves depends on your traffic. Identical or simultaneous requests are not
paid twice, and a long, stable system prompt on Anthropic is billed at the cached rate.
Requests that are all different, a high `temperature`, questions with freshness words
("today", "price"), or personal wording ("my") without a `context.sessionId` are never
answered from the cache: about 0 % by default.

It is not a promise you take on faith: every saving is split into four ledgers
(`avoided_calls`, `eliminated_tokens`, `compressed_tokens`, `provider_cached_tokens`)
and labelled `measured`, `reference` or `estimated`. Nothing is sent to BiVelio
unless you choose to add a key: **zero telemetry by default**, and prompts,
completions and provider keys never reach BiVelio (the exact per-request fields a
cloud key sends are in [LICENSE-CLOUD.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md) §5).

### Measured, not promised — recomputed from the public artifacts

- **Pooled reductions on a public workload built from GSM8K questions, 30 % of them
  exact repeats** (SDK 0.4.31 artifacts from September 2026, recomputed offline with no
  new provider calls): **31.50 %** (gpt-4o-mini) and **75.08 %** (claude-sonnet-5, about
  41 points of which are a descriptive contrast of Anthropic's cache pricing, not an
  isolated effect of the layer), with bootstrap intervals; the equal-family means
  (22.88 % / 70.71 %) are reported separately, as they should be. Traffic that never
  repeats saves about 0 %.
- **Exploratory live A/B (20 requests per arm)** on the provider's own counters
  (`claude-haiku-4-5`), with the opt-in `savings.cachePrefix: true` against the layer
  itself without that option — not against calling the provider directly: the
  cacheable-prefix reorder took a poisoned prompt cache from 0 % → 95 % hit-rate,
  −82.76 % cost per request in that constructed sequence (measured with 1.2.0 on
  15 Nov 2026; later versions changed the arm without the option, so the same sequence
  now shows a smaller gap).

📄 **The paper:** [Verifiable Measurement of Cost Savings in LLM Applications
(open-core edition, v2.3-r1)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/PAPER.md) — revised after an external
pre-publication review: pooled reductions of **31.50 %** and **75.08 %** on a workload
with 30 % exact repeats, with percentile cluster-bootstrap intervals, four ledgers, and
every limitation stated.
Also at **[savings.bivelio.com/paper](https://savings.bivelio.com/paper)**, with the
arXiv-ready LaTeX in [`docs/paper/main.tex`](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/paper/main.tex).

### Install anywhere, in 60 seconds

```shell
# 1 · Any OpenAI SDK, any language — point it at the local gateway (Python, Node, Cursor, Aider, Cline, OpenWebUI…)
npx @bivelio/savings-layer gateway --upstream openai --port 8403     # or: deepseek | qwen | glm | moonshot | gemini | ollama | vllm | lmstudio
#    python: OpenAI(base_url="http://127.0.0.1:8403/v1")

# 2 · Coding agents, one command, zero configuration
npx @bivelio/savings-layer claude      # Claude Code through the gateway
npx @bivelio/savings-layer gemini      # Gemini CLI (native Gemini protocol)
npx @bivelio/savings-layer codex       # Codex CLI (OpenAI or ChatGPT auth)
npx @bivelio/savings-layer qwen        # Qwen Code
npx @bivelio/savings-layer aider       # Aider

# Claude Code with DeepSeek's Anthropic-format endpoint (cache reads at $0.003/1M):
#   ANTHROPIC_BASE_URL=http://127.0.0.1:8402 ANTHROPIC_AUTH_TOKEN=<deepseek key> claude
#   with: npx @bivelio/savings-layer gateway --upstream deepseek

# 3 · Your app, TypeScript/JavaScript — the SDK in your code (zero runtime dependencies)
npm i @bivelio/savings-layer
```

```ts
// The imports come from the "Wrap the call" block below; this block compiles
// together with it (the repo test concatenates every README block into one
// program, as if you pasted them in order).
const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
});
const layer = createSavingsLayer({
  provider,
  // OPEN CORE: nothing else is required — COMMUNITY mode, zero telemetry.
  // Savings Cloud (optional) — the same three lines your dashboard and `init` print:
  //   licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  //   licenseServerUrl: "https://savings.bivelio.com",
  //   serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text);                            // "8" — computed locally, no LLM call
console.log(report.calls.avoidedLlm);         // → 1: a whole call you never paid for
console.log(report.cost.basis);               // "estimated": nothing ran, so there is no provider counter
```

`npx @bivelio/savings-layer init` prints the exact three steps for your stack
(Next.js, Express, Vercel AI SDK, Mastra, LangChain.js, Anthropic/OpenAI SDK) and
`npx @bivelio/savings-layer doctor` prints the exact configuration for every
installed coding agent. The published benchmark, run by run, with the raw JSON
reports, is at **[savings.bivelio.com/en/benchmarks](https://savings.bivelio.com/en/benchmarks)**.

### Community vs Cloud

| | Community (default, no keys) | Cloud (optional `BIVELIO_*` keys) |
| --- | --- | --- |
| Exact + semantic cache, deduplication of identical requests | ✅ | ✅ |
| Model cascade, sibling routing, prompt-cache placement | ✅ | ✅ |
| Opt-in tool-output compaction, output contracts, four savings ledgers | ✅ | ✅ |
| One cache for several machines, in a store you run (for example Redis) | ✅ | ✅ |
| Gateway + `bvsala` CLI + MCP server | ✅ | ✅ |
| Team dashboard, shared measurement, seats and license management | — | ✅ |
| Anything sent to BiVelio | **Nothing** | Per-request usage only (counts, cost, model id, opaque ids — [LICENSE-CLOUD.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md) §5), never prompts or keys |

Both columns run the same levers. A BiVelio key only adds the cloud: the free Measure license and a paid one apply the same levers as no key, except trimming of superseded tool results, which with a key only acts inside a tool loop on Anthropic.
With a key, that trimming acts on Anthropic models with the default cache placement, never with `cacheBreakpoints: "auto"` or `AnthropicProvider({ automaticCache: true })`, and only on results after your last user message; everywhere else it stays off, as in 1.2.3 with a paid key. With no key that trimming runs as in 1.2.3: on a long agent loop on gpt-5, Gemini, DeepSeek or Qwen, or with `cacheBreakpoints: "auto"` or `automaticCache`, compare with `savings: { elision: false }`.
One dependency comes with a key, the free Measure key included: with `licenseServerUrl` set (as in the recipe your dashboard and `init` print), a layer that goes 72 hours without an answer from savings.bivelio.com fails closed with `LicenseError` on every call until it gets one or you remove the key. With no key there is no such dependency.
What the gateway needs instead, and every timeout: [SECURITY.md, Availability](https://github.com/BiVelio/bivelio-savings-layer/blob/main/SECURITY.md#availability-what-happens-if-our-servers-do-not-respond).
BiVelio hosts no cache. Want several machines to share one? Give the layer a store you
run through the `exactCache` option: you implement three methods (`get`, `set`,
`delete`) over any key-value store your instances share, such as Redis. It is free,
needs no key, and the cached answers stay in your infrastructure, never in BiVelio's.
A PostgreSQL adapter is a release candidate and is not on npm yet.

A license key that **is** configured but invalid or expired still fails closed with
`LicenseError` — only its absence is a working product.

**Pricing.** The cloud subscription is a fixed fee, paid whether or not you save —
Pro €15 / seat / month or €150 / seat / year; Team
€129 / month with 10 seats included (€12 per extra seat; €1,290 / year, €120 per
extra seat), EUR, VAT not included — and there is never a commission on what you
save (see [LICENSE-CLOUD.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md) §6).

<details>
<summary><b>Cloud pricing (the optional, paid part) — full terms</b></summary>

The cloud subscription is a fixed fee, paid whether or not you save: **Pro
€15 / seat / month** or **€150 / seat / year**; **Team €129 / month with 10 seats included** (**€12 per extra seat**; **€1,290 / year, €120 per extra seat**), EUR, VAT not included. **No commission on your savings — you keep every euro you save.** No trial. The free
**Measure** license (no card) is the free cloud plan: the layer applies the same
levers as with no key, except that trimming of superseded tool results only acts
inside a tool loop on Anthropic, and your dashboard shows the real savings. It is
never billed and never part of any commission.

**Legacy plans, closed to new customers.** An earlier modality charged a lower per-seat fee plus a tiered commission on measured savings only: the first month carries no commission, and the commission runs from **10 % down to 4 %** by volume — keeping you **at least 90 % of every euro saved**, never from estimates, and shadow-mode usage was never part of any commission. It is closed to new customers; a subscription already on it keeps it unchanged. Your
prompts, completions and provider keys never reach BiVelio: a cloud key sends
only the per-request usage fields listed in [LICENSE-CLOUD.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md) §5.

</details>

## Licensing & privacy

BV‑SALA is open core: the npm package is **Apache-2.0** and free — install it with no keys
(COMMUNITY mode: every lever included, zero telemetry, nothing sent to BiVelio). The
optional **cloud** is commercial. Its plans are **Measure** (free), **Pro** (per seat),
**Team** (a number of seats included, plus each extra seat) and **Enterprise** (by
contract); Pro and Team are paid whether or not you save and carry **no commission** on
your savings. The prices are above, in [LICENSE-CLOUD.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md) §6 and in
the Published Pricing it refers to,
**[savings.bivelio.com/pricing](https://savings.bivelio.com/pricing)**. No trial. There is one free license,
**Measure** — no card, one organization per verified account, up to 5 seats and 20,000
requests a day: the layer applies the same levers as with no key, except that
trimming of superseded tool results only acts inside a tool loop on Anthropic, and your
dashboard shows the real savings — never billed, never part of any commission. What a paid
plan adds is the cloud beyond those limits (more seats, more volume, the team dashboard),
not the saving. This is new in 1.2.4: up to 1.2.3 a Measure key ran the layer in shadow
mode, so update to save with it. Once you upgrade, a layer with `serviceAccountKey` and
`licenseServerUrl` picks up the paid license by itself, without a restart.

If you only want to watch before the layer touches your traffic, **observe-only mode** is
an explicit option on any plan — `observeOnly: true` in the SDK,
`BVSALA_GATEWAY_OBSERVE_ONLY=1` in the gateway. Every request then goes to your provider
exactly as you built it, nothing is served from any cache and no lever is applied. In the
SDK, `report.measure.wouldHaveSaved` (with `basis: "shadow"`) says what the exact cache and
in‑flight coalescing would have saved on that request, valued with your provider's own
counter — a lower bound, shown apart from measured savings. In the gateway, a
`measure (shadow)` log line says what cache TTL tuning and the sibling model would have
saved, never counted as a saving. The framework adapters have no observe-only mode:
switch their levers off with `savings`.

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
prompts, completions or provider keys; [LICENSE-CLOUD.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/LICENSE-CLOUD.md) §5 lists every field, and
**[savings.bivelio.com/privacy](https://savings.bivelio.com/privacy)** says how long
each one is kept.

Get a key at **[savings.bivelio.com](https://savings.bivelio.com)**.
Onboarding & general questions: **support@bivelio.com** · licensing & compliance:
**privacy@bivelio.com** · technical: **team@bivelio.com**.

**What the Apache-2.0 license covers.** The npm package (`src/`, `gateway/`, `skills/`,
`docs/terminales/`) and the Python client (`packages/python`) are Apache-2.0. The
cloud's control plane (`services/`, `db/`, `deploy/`), the website (`apps/web`) and the
packages marked `UNLICENSED` are in this repository for transparency only: you can read
and audit them, but they are not licensed for reuse. Third-party code keeps its own
license ([NOTICE](https://github.com/BiVelio/bivelio-savings-layer/blob/main/NOTICE)).

<details>
<summary><b>Where it installs — the full story</b></summary>

## Where it installs

<p align="center">
  <img src="https://savings.bivelio.com/en/how-it-works/opengraph-image" alt="Your application → BV-SALA → provider API. Traffic goes straight from your app to your provider; the layer runs inside your code." width="720">
</p>

Your application → **BV‑SALA** → provider API. Traffic always goes straight from
your app to your provider — the SDK is a library inside your code, never a
middleman server (the optional gateway is a local proxy on your own machine), and it works with any OpenAI‑compatible endpoint (OpenAI, Azure,
vLLM, SGLang, a gateway) as well as Anthropic.

**Is this for me?** If your product or automation calls the AI **with its own API
key** — and pays a per‑token bill for it — yes: this is exactly where the saving
installs. **Only use ChatGPT or Claude?** Then there is nothing to install: those
products charge a flat subscription, so there is no per‑token bill to cut. The whole
story, in plain words:
**[Where does the saving install?](https://savings.bivelio.com/en/how-it-works)**

**A coding agent with an API key?** The package also ships a local gateway:
`bvsala claude` (or `bvsala codex`, `goose`, `qwen`, `opencode`, `kilo`, `gemini`,
`copilot` with your own Anthropic key, `aider`) launches the agent through it and
your real spend is metered locally, token by token — nothing to configure,
nothing persisted. On exit it tells you how many requests it metered, what they
cost at list price, what the levers saved (or why they saved nothing), and which
requests it could not meter, and why. With `bvsala claude`, an `ANTHROPIC_BASE_URL` you had
already set (a company proxy, LiteLLM…) is never replaced behind your back: the
gateway forwards there, or the wrapper stops and says why. For Crush, Droid, Cline, Continue, Cursor or Copilot
in VS Code, `bvsala doctor` prints the exact config block. The gateway starts
with **no keys at all** (COMMUNITY mode: free, zero telemetry).
Every gateway lever is free, with no key; one is on by default (cache TTL tuning) and the others you switch on.
`BIVELIO_SERVICE_KEY` only adds the cloud dashboard.
Once running it never interrupts a request in flight: with a live license that
lapses, only new requests are refused (HTTP 402) until it is renewed. The
cache-write TTL lever (1h→5m, the saving that changes the rate, never the
content the model reads) is armed by default, but it only has something to lower
when the client pays per token and asks for the one-hour cache: Claude Code on an
API key asks for five minutes unless you set `promptCacheTtl` to `1h`, so out of the
box the gateway measures it and that lever saves nothing. The other levers (sibling
model, per-turn effort) switch on with their flags. On a Claude or ChatGPT subscription
there is no per-token invoice, so that traffic is metered at list-price
equivalent and is credited no saving, and the TTL lever leaves Claude Max/Pro
traffic untouched: there is no write premium to save, and a 5-minute entry would
be rewritten after any pause.

**The gateway forwards what your terminal sends.** With no lever armed, your
provider receives the request body byte for byte and every header your client
sends except `x-bvsala-report`, which asks the gateway itself for a report (see
the limits): `cache_control` and its 1-hour TTL, tool search and
`tool_reference` blocks, the advisor, every `anthropic-beta` value. An armed lever
changes only what it declares, and a request it cannot rewrite exactly travels
untouched. A test suite checks this against a fake upstream on every change
(`test/gateway-no-empeora.test.ts`; the section below lists exactly what it
checks). The gateway also logs, once per session,
requests that come out worse than your client asked for: cache markers the
provider ignored, a 1-hour TTL written at 5 minutes upstream, and tool search off
(Claude Code turns it off by default behind any proxy, this one included;
`bvsala claude` turns it back on). What it checks, and its limits:
[docs/terminales/README.md](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/terminales/README.md#what-the-gateway-guarantees-it-forwards-what-your-client-sends).

</details>

<details>
<summary><b>Python and any other language: the local gateway — details</b></summary>

### Python and any other language: the local gateway

The same gateway sits in front of any SDK that lets you set a base URL, whatever
the language:

```bash
bvsala gateway --upstream openai --port 8403   # one gateway per upstream
bvsala gateway                                 # Anthropic, the default, on 8402
bvsala gateway --upstream deepseek             # DeepSeek: /v1/messages → its /anthropic endpoint
bvsala gateway --upstream gemini               # Gemini protocol (bvsala gemini wraps the CLI)
```

Flags and environment variables are in English (`--port`, `--project`, `--force`,
`BVSALA_GATEWAY_EFFORT`, `BVSALA_GATEWAY_SIBLING_MODEL`), except
`BVSALA_GATEWAY_DIALES_ELISION` (the context elision dials, off by default). The Spanish spellings from
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
provider reports — Anthropic Messages, OpenAI Chat Completions and Responses, and
the Gemini protocol (`:generateContent` / `:streamGenerateContent`), streamed or
not — for models with a list price in its catalog, priced at that list price. A
request it cannot meter (a model without a list price, a body it cannot read, a stream
that never asked for usage) is still forwarded, and its log line says so and why.
Without a key (COMMUNITY mode) the metering numbers stay local: the local report
routes below work the same, and nothing is sent to BiVelio.
`bvsala doctor` prints the recipe for each SDK and agent.

Each request can also bring its report back to your code. Send the header
`x-bvsala-report: 1` (in Python, `default_headers={"x-bvsala-report": "1"}` on
the client) and the gateway answers with `x-bvsala-request-id`. On the same
gateway, `GET /_bvsala/v1/reports/<that id>` returns what it recorded for your
dashboard: `metered` with the `SavingsReport` (the provider's token counts, the
cost at list price and `cost.basis`), or `not_metered` with the reason from the
log line. `?response_id=<the provider's response id>` finds it too, and
`wait_ms` waits for a request still in flight. The header never reaches your
provider, and a request without it is not changed at all:
[the details](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/terminales/README.md#what-the-gateway-guarantees-it-forwards-what-your-client-sends).

</details>

## Check it before you install

What you can check before installing is what we have measured: the published
benchmark, run by run, with the raw JSON reports linked, at
**[savings.bivelio.com/en/benchmarks](https://savings.bivelio.com/en/benchmarks)**.
With no keys at all, the layer runs the full savings stack locally on your own
traffic and reports per request — nothing leaves your machine.

**Upgrading from 0.4?** Every breaking change of 0.5, with a before and after for
each, is in [Migrating from 0.4 to 0.5](https://savings.bivelio.com/en/migrate-to-0.5).

<details>
<summary><b>Full install manual: init + the three steps</b></summary>

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
saving where the layer removed something is reported as `estimated` and kept apart
from the measured figures — the SDK warns once when the tokenizer is missing.

**2 · The cloud (optional)** — a [BiVelio key](https://savings.bivelio.com/dashboard/install)
adds the team dashboard, shared measurement, seats and license management. Skip this
step and nothing changes except the dashboard: the layer keeps working, fully, offline.
Take it and no lever is switched off.
One dependency comes with a key, the free Measure key included: with `licenseServerUrl` set (as in the recipe your dashboard and `init` print), a layer that goes 72 hours without an answer from savings.bivelio.com fails closed with `LicenseError` on every call until it gets one or you remove the key. With no key there is no such dependency.
Details: [SECURITY.md, Availability](https://github.com/BiVelio/bivelio-savings-layer/blob/main/SECURITY.md#availability-what-happens-if-our-servers-do-not-respond).

One recipe, the same one your dashboard and `npx @bivelio/savings-layer init` print: the
two keys in the environment, and three lines in `createSavingsLayer` (step 3).

```bash
export BIVELIO_LICENSE_KEY=…   # optional: a key that IS set but invalid still fails closed
export BIVELIO_SERVICE_KEY=…   # optional: usage to your dashboard + license auto-renewal
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
  // OPEN CORE: nothing else is required — COMMUNITY mode, zero telemetry.
  // Savings Cloud (optional) — the same three lines your dashboard and `init` print:
  //   licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  //   licenseServerUrl: "https://savings.bivelio.com",
  //   serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
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
usage. Only `measured` and `reference` figures are credited as savings in your report
and dashboard; estimated ones are always shown apart. A model with no list price in the catalog and none in your `costModels`
(or `defaultCostModel`) is priced at an illustrative rate: its token counts are still
the provider's, but its dollar figures are `"estimated"`, never `"measured"`, and a
`price` trace says `priceSource: "illustrative"`.

**The arithmetic in the example** is answered on your machine only when the whole
request is that one question: a single user message, with no system prompt, no
earlier turns, no tools and no structured data. Anything else goes to your model,
the only one that sees what format was asked for, and so do questions the layer
cannot answer exactly or without guessing: `10 / 3`, percentages, dates and `2.500`.

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

**Empty answers and errors inside a 200.** An empty answer, or a call whose usage
counter did not arrive complete, is served as usual but never written to a cache, so
a repeat goes back to your provider. An HTTP 200 whose body is an error, or that
carries no answer at all, makes `generate()` throw instead of returning empty text.

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

**Answers that must change.** A request whose user turns ask for random or freshly
generated output (a random pick, a new UUID or password, a dice roll, a coin toss)
or for the current time or date is never read from or written to the exact or
semantic cache. It is measured and served as usual, and the `policy` trace says why.
With a `seed`, a random request is cacheable again: fixing the seed asks for the same
output. A question about the current time is not. The check is lexical, with short
lists of phrases in English and Spanish; a false positive costs one cache hit.

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
without it is reported as `unmeasured` and credits no saving. With an output contract, or
a request declared `deferrable`, the answer is produced exactly as `generate()` would
and arrives as a single `text` event. Breaking out of the loop while the provider is
still writing cancels its request, and nothing is cached or recorded; once its answer
is complete, or when it arrives in one piece, nothing is cancelled.
`await stream.result` tells you which happened.

</details>

<details>
<summary><b>Framework adapters: Vercel AI SDK, Mastra, LangChain, Anthropic SDK</b></summary>

## Inside your framework

Already on an agent framework? The layer plugs in at that framework's own extension
point, from a subpath of this same package. The four adapters behave alike:

- **They answer without calling the model when they can** — a computed answer (the
  arithmetic above, when the request is that bare question), an exact repeat of a request that already ran, an identical
  request already in flight — and otherwise let your framework make exactly the call
  it was going to make. They never rewrite what your framework sends.
- **Tools are treated as having side effects** unless you list them in
  `readOnlyTools`: a request that offers any other tool is never answered from a
  cache, because the action has to run.
- **Open core, like the SDK**: with no key the adapter runs in COMMUNITY mode; a key that is set but invalid fails closed with
  `LicenseError` (a framework may wrap it, keeping its name and message) and the
  model is not called. **Put the adapter last**, so nothing sits between it and the
  model.

Every model call gets the same `SavingsReport` as with the SDK — its `basis` says
whether a figure comes from your provider's own counter — and `onReport` receives it
too.

Minimum versions: `ai` 6, `@mastra/core` 1.68, `langchain` and `@langchain/core` 1.1,
and `@anthropic-ai/sdk` 0.103. Older ones (AI SDK 5, LangChain 0.3, `@mastra/core`
below 1.68) are not supported by the adapter; in such a project npm needs
`npm i @bivelio/savings-layer --legacy-peer-deps` (pnpm, yarn and bun only warn), and
the SDK itself and the gateway still work there.

### Vercel AI SDK

`pnpm add @bivelio/savings-layer ai @ai-sdk/openai` — a `LanguageModelMiddleware`
for `ai` 6 or 7:

```ts
import { generateText, wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { savingsMiddleware, getSavingsReport } from "@bivelio/savings-layer/ai-sdk";

const savings = savingsMiddleware({
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
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
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
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
console.log((await agent.generate("What is 2 + 2 * 3?")).text); // the model answers: with instructions, the layer does not compute it
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
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
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
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
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

</details>

<details>
<summary><b>The report in detail: ledgers, native savings, quality ledger, serialization</b></summary>

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
not in `cost.baselineEstimate`, and never in the credited savings. Your dashboard shows
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

**Calibrated reuse (required to serve).** A fixed similarity floor means something different
for every embedder and every workload, so the cache must earn its floor on your own
traffic: `new InMemorySemanticCache({ embed, calibration: { maxErrorRate: 0.02 } })`.
Without `calibration`, it runs in shadow mode: it may store answers for future calibration,
but `find()` and `lookup()` never return a hit. With calibration it serves no reworded answer
until your labels show, at 95 % confidence, that at most 2 % of the answers it would reuse
from some score up are wrong, and it re-tests that floor as labels accumulate. Until then
every candidate goes to your provider, exactly as it would without the cache, and the fresh
answer is compared with the stored one by your `judge` (by default only identical answers
count, which suits classification and structured output; pass your own for free text). Each
calibrated reuse carries its bound and the labels behind it in
`report.qualityLedger.cacheMatch.calibration`. Calibration costs reuses, never an extra call,
and it does not change how anything is billed. If you already have labeled pairs,
`calibrateSemanticFloor()` runs the same test offline.

And a promise you can hold it to: **never worse than your JSON.** Payload encodings
are chosen by counting real tokens with the destination model's own tokenizer, and
BV‑SALA only moves away from plain JSON when the saving clearly clears the bar —
`report.serialization` shows what was chosen and what each candidate would have cost.

</details>

### Optional levers and integrations

Each one, in full, on GitHub:

- [Your own A/B — verification sampling (opt-in, off by default)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/medir.md#your-own-ab--verification-sampling-opt-in-off-by-default)
- [Cross-provider shadow: what your usage would cost elsewhere (measure-only)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/medir.md#cross-provider-shadow-what-your-usage-would-cost-elsewhere-measure-only)
- [Provider price levers (opt-in, off by default)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/palancas-de-precio.md#provider-price-levers-opt-in-off-by-default)
- [Prompt-cache breakpoints placed from your traffic (opt-in)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/cache-de-prompt.md#prompt-cache-breakpoints-placed-from-your-traffic-opt-in)
- [Cache-aware prompt management: mutable tokens out of the cacheable prefix (opt-in)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/cache-de-prompt.md#cache-aware-prompt-management-mutable-tokens-out-of-the-cacheable-prefix-opt-in)
- [Tool outputs, compacted where they are born (opt-in, off by default)](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/herramientas.md#tool-outputs-compacted-where-they-are-born-opt-in-off-by-default)
- [Tool calls](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/herramientas.md#tool-calls)
- [Serverless: keep what the layer learns between instances](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/persistencia.md#serverless-keep-what-the-layer-learns-between-instances)
- [Customer-operated PostgreSQL for caches and learning](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/persistencia.md#customer-operated-postgresql-for-caches-and-learning)
- [Structured output — validated `data`, not just text](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/peticiones.md#structured-output--validated-data-not-just-text)
- [Gemini: the native adapter](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/peticiones.md#gemini-the-native-adapter)
- [Output cap — with or without a contract](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/peticiones.md#output-cap--with-or-without-a-contract)
- [Your ledgers in your tracing — OpenTelemetry, Langfuse, Datadog](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/exportar.md#your-ledgers-in-your-tracing--opentelemetry-langfuse-datadog)
- [Your ledgers in your FinOps tool — FOCUS rows and a daily savings series](https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/guias/exportar.md#your-ledgers-in-your-finops-tool--focus-rows-and-a-daily-savings-series)

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

- **Node ≥ 20.19.** The package is **ESM‑only** (`"type": "module"`); from CommonJS,
  `require()` works on Node ≥ 22.
- Framework adapters: `ai` 6 or 7, `@mastra/core` ≥ 1.68 < 2, `langchain` ≥ 1.1 < 2
  with `@langchain/core` ≥ 1.1 < 2, and `@anthropic-ai/sdk` ≥ 0.103 < 2 — optional
  peers, needed only for the adapter you import. `ai` 7 and `@mastra/core` declare
  Node ≥ 22 in their own `engines`.
- Optional peer `gpt-tokenizer` (3 or 4) for exact OpenAI token counts, loaded automatically
  when installed — without it a built‑in estimator is used. It improves the accuracy
  of estimated figures; the `measured` and `reference` figures come from the provider's
  own counter either way.
- Every component (cache, vector store, tokenizer, compressor, constraint backend)
  is independently swappable behind the same interfaces. The cache, the vector store,
  the tokenizer and the constraint backend ship with an in‑memory default; the default
  compressor does nothing (the package ships no compressor: bring your own).

</details>

---

© 2026 BiVelio Inc. All rights reserved. BV‑SALA is a trademark of BiVelio Inc.

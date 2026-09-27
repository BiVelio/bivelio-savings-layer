# BV‑SALA in front of a LiteLLM proxy

> **Draft recipe (experiment E6), not linked from the main README.** Tested on
> 2026‑09‑27 with LiteLLM proxy 1.102.1 and `@bivelio/savings-layer` 0.4.26 from
> source. Publishing it is the owner's call, and so is how a `reference` saving
> behind a proxy is billed (open question in the PR); this draft says nothing
> about billing on purpose.

Already routing your models through a [LiteLLM](https://github.com/BerriAI/litellm)
proxy? Keep it. BV‑SALA goes **inside your application**, in front of the proxy:

```
your app  →  BV‑SALA (in‑process)  →  LiteLLM proxy  →  your provider
```

LiteLLM keeps doing what it does (routing, virtual keys, budgets, fallbacks) and
nothing in its config changes. What you add is a `SavingsReport` on every call,
with each figure labelled by its basis, and exact repeats answered in your process
without reaching the proxy.

## 1 · Chat Completions (`/v1/chat/completions`)

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "http://localhost:4000/v1",   // your LiteLLM proxy, WITH /v1
    apiKey: process.env.LITELLM_API_KEY,   // a LiteLLM virtual key (sent as Bearer)
    stripProviderPrefix: true,             // LiteLLM receives `gpt-4o-mini`, its model_name
  }),
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",             // the provider's id; LiteLLM gets `gpt-4o-mini`
  messages: [{ role: "user", content: "What is the capital of France?" }],
  temperature: 0,
});
```

## 2 · Anthropic Messages (`/v1/messages`)

LiteLLM also speaks the Anthropic Messages API. Point the Anthropic adapter at it:

```ts
import { AnthropicProvider, createSavingsLayer } from "@bivelio/savings-layer";

const claude = createSavingsLayer({
  provider: new AnthropicProvider({
    baseUrl: "http://localhost:4000/v1",   // WITH /v1: the adapter appends /messages
    apiKey: process.env.LITELLM_API_KEY,   // sent as x-api-key, which LiteLLM accepts
    stripProviderPrefix: true,
  }),
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

await claude.generate({ model: "anthropic/claude-haiku-4-5", messages: [{ role: "user", content: "Hi" }] });
```

## 3 · Model names: use the provider's id

LiteLLM's `model_name` is what your application sends. Make it the provider's own
id and BV‑SALA prices every call from its built‑in list‑price catalog:

```yaml
model_list:
  - model_name: gpt-4o-mini            # the provider's id: priced by BV‑SALA
    litellm_params:
      model: openai/gpt-4o-mini
  - model_name: claude-haiku-4-5
    litellm_params:
      model: anthropic/claude-haiku-4-5
```

A name of your own (`team-fast`) tells BV‑SALA nothing about the price. The call is
still metered in tokens, but its cost falls back to an illustrative default (the SDK
warns once), and an exact repeat stays `estimated` (`report.cache.referenceRejected:
"no-cached-price"`). Declare what you pay for it:

```ts
createSavingsLayer({
  // …
  costModels: { "team-fast": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 } },
});
```

Do the same whenever LiteLLM sends a model name somewhere else than the provider's
public API (Azure, Bedrock, Vertex, a self‑hosted model, a fallback to another
model, negotiated rates): the catalog holds public list prices, and `costModels`
always wins over it.

## 4 · What each report says behind the proxy

| What happened | `report.cache.result` | `report.cost.basis` |
|---|---|---|
| The call went through LiteLLM to your provider | `miss` | `measured`: the usage LiteLLM relayed from the provider, at the model's list price (or your `costModels`) |
| A byte‑identical repeat answered in your process | `exact` | `reference`: valued at the provider's cached‑input rate against the counter of the call that ran (`report.cache.reference.requestId`); output tokens count only with `temperature: 0`. LiteLLM and your provider are not called |
| The model has no price (see § 3) | `exact` | `estimated`, never billed |

The exact cache lives in the layer instance: create the layer once per process and
reuse it. With several instances of your app, each one keeps its own cache unless
you plug a shared `exactCache`.

**If LiteLLM's own response cache is on**, a LiteLLM cache hit reaches BV‑SALA as an
ordinary response carrying the original usage; the only sign is LiteLLM's
`x-litellm-cache-key` response header. BV‑SALA reports that call as `measured` at the
full price, although your provider did not bill it. If you keep both caches, read
that header, or let BV‑SALA's exact cache handle exact repeats.

`x-litellm-response-cost` is LiteLLM's own spend figure. BV‑SALA does not read it:
its figures come from the provider's usage counter and its price catalog.

## 5 · Check it

`check.ts` in this folder sends the same question twice through your proxy and
prints `ok` when the second one comes back as an exact repeat with basis
`reference`:

```bash
LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=… BIVELIO_LICENSE_KEY=… npx tsx check.ts
```

Your LiteLLM logs should show **one** request, not two.

## 6 · Python and other languages

The local measuring gateway sits in front of LiteLLM the same way:

```bash
bvsala gateway --upstream http://localhost:4000 --port 8403
```

and your client points at `http://127.0.0.1:8403/v1` (see the main README, *Python
and any other language*). Behind a proxy the gateway never values an avoided
duplicate by reference: a coalesced duplicate stays `estimated`.

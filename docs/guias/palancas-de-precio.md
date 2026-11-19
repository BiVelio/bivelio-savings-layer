# Provider price levers

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Provider price levers (opt-in, off by default)

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
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
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

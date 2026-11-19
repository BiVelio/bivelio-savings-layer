# Measure the layer on your own traffic

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Your own A/B — verification sampling (opt-in, off by default)

The per-request figures above are what the layer can show without running your
request twice. To see what it does on your own traffic, with both sides metered by
your provider, turn on verification sampling:

```ts
const checkedLayer = createSavingsLayer({
  provider,
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
  // licenseServerUrl: "https://savings.bivelio.com",
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
- **`await close()` settles every copy still running and drains usage:** an
  unfinished copy is recorded as abandoned, never as a pair. Awaiting close makes
  a bounded final delivery attempt; calling it without await remains safe. On
  serverless platforms, pass your runtime's `waitUntil` as `verification.waitUntil`
  so checks can finish.

## Cross-provider shadow: what your usage would cost elsewhere (measure-only)

With `savings: { crossProviderShadow: true }`, each report adds
`report.crossProviderShadow`: the same measured usage priced at the list rates of
DeepSeek, Qwen and GLM siblings. Nothing is routed and nothing is billed — it is a
priced comparison for your routing decisions (`basis: "shadow"`), never credited as
a saving and never part of any commission.

```ts
const { report } = await layer.generate({
  model: "openai/gpt-5-mini",
  messages: [{ role: "user", content: "Summarize this…" }],
  savings: { crossProviderShadow: true },
});
console.log(report.crossProviderShadow);
// { servido: "openai/gpt-5-mini", servidoUsd, alternativas: [{ model, listPriceUsd, ratio }, …], basis: "shadow" }
```

# Your provider's prompt cache

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Prompt-cache breakpoints placed from your traffic (opt-in)

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
saving and never part of any charge.

```ts
const placedLayer = createSavingsLayer({
  provider, // Anthropic, or OpenAI GPT-5.6+ on OpenAI's own API
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
  cacheBreakpoints: "auto",
});
```

## Cache-aware prompt management: mutable tokens out of the cacheable prefix (opt-in)

A timestamp, UUID or epoch in your `system` prompt poisons the provider's prefix
cache: every request misses and pays a full-price cache write. With
`savings: { cachePrefix: true }`, the layer moves the mutable lines to the end of
the header and marks only the stable part with `cache_control` — the provider's
cache can hit where a mutable token used to force a miss plus a paid write on every
call.

- **The saving is the provider's**, read from its own cache counters (`nativeSavings`),
  never credited as the layer's saving and never part of any charge.
- **It abstains instead of breaking structure.** A mutable line inside a JSON/XML
  block or a code fence is never moved — that would corrupt the payload — and the
  request travels untouched. The `cache-prefix` trace reports what moved and why it
  abstained; it records counts and patterns, never your prompt text.
- **It moves whole lines.** Put the per-request value on a line of its own. When it
  shares its line with the rest of the prompt (a one-line `system`), nothing stable is
  left to keep and the request travels untouched.
- **Measured live, exploratory** (v2.3-r1 evidence, 20 requests per arm): 0 % → 95 %
  hit-rate, −82.76 % per request (claude-haiku-4-5, provider's counters;
  [`benchmarks/evidencia/cache-prefix-vivo-2026-11-15.json`](../../benchmarks/evidencia/cache-prefix-vivo-2026-11-15.json)).

```ts
const { report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: "You are a support bot.\nGenerated at 2026-11-15T10:00:00Z.\nBe brief." },
    { role: "user", content: "Where is my order?" },
  ],
  savings: { cachePrefix: true },
});
// report.traces "cache-prefix": what moved; report.nativeSavings: the provider's cache reads/writes
```

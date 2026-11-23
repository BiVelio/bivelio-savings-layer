You added `cache_control` to your Claude requests, and the bill did not move. Or `cache_read_input_tokens` comes back as `0` on every call. This guide walks through why that happens, how to find the exact byte that breaks your cache, and how to check the result against Anthropic's own usage numbers. Everything here works with any SDK. At the end you will see how the open-source BV-SALA SDK places the breakpoints for you, and the one case where you should tell it not to.

## Read the three usage fields first

Every Messages API response tells you what happened to the cache. Look at three numbers in `usage`:

| Field | What it counts |
| --- | --- |
| `cache_creation_input_tokens` | Tokens written to the cache on this call, billed above the normal input price |
| `cache_read_input_tokens` | Tokens served from the cache, billed at a fraction of the input price |
| `input_tokens` | Tokens after the last cache breakpoint, billed at the normal price |

The three patterns tell you where to look:

- **Both cache fields are 0.** Nothing was cached at all: the prefix is shorter than the model's minimum, there is no breakpoint, or something between you and the API removed it.
- **Creation is high on every call and reads stay at 0.** The cache is written and never reused: the prefix changes between calls, the entry expired, or the calls go to a different model or workspace.
- **Reads are high.** It works. Now the question is only how much of the prompt sits before the breakpoint.

## How Claude's prompt cache works, in six facts

1. It caches a **prefix**: the request from the start up to a `cache_control` breakpoint. The match is exact; one different byte and everything after it is processed again.
2. The order is **tools, then system, then messages**. A change in the tool list invalidates the system prompt and the messages after it.
3. You can place up to **four breakpoints**, and the API looks back a limited number of blocks from each one for a previous entry (20 at the time of writing).
4. Entries live **five minutes** by default, refreshed on every hit. A one-hour lifetime is available with `"ttl": "1h"`.
5. Writing costs more than reading: a five-minute write is billed at 1.25 times the input price and a one-hour write at 2 times; a read costs a small fraction of the input price (0.1 times on most models). Check [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing) for your model.
6. There is a **minimum cacheable length** that depends on the model, from 512 to 4,096 tokens. Below it, the request is simply not cached, with no error.

All of this is in [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), which is the source to trust when a number changes.

## The usual causes, in the order to check them

1. **The prefix is too short.** A 600-token system prompt is below the minimum on several models. Put the stable instructions, examples and reference text together so the cached part is long enough to matter.
2. **Something in the prefix changes on every call.** The classics: a timestamp or "Today is…" line in the system prompt, a request id, the user's name, a random example order, tool definitions built from an object whose key order is not fixed, or a JSON document serialised with different spacing.
3. **The breakpoint is on content that changes.** If the last `cache_control` sits on the user's question, every call writes a new entry that nobody reads. The breakpoint belongs at the end of the part that does not change.
4. **The entry expired.** Calls more than five minutes apart never read each other's entry. A nightly batch run one item every ten minutes pays the write premium every time and reads nothing.
5. **The calls do not share a cache.** A different model, a different workspace, or a switch between models mid-conversation each start from an empty cache.
6. **Parallel calls race.** An entry can be read only once the first response has started. Ten identical calls fired at once all write. Send one first, then the rest.
7. **A proxy removes the marker.** A gateway that strips `cache_control`, or turns a block-form `system` into a plain string, makes the whole prompt bill as uncached input while every call still succeeds. Claude Code's documentation describes exactly this failure for [LLM gateways](https://code.claude.com/docs/en/prompt-caching).

## Find the byte that breaks your cache

When reads stay at zero, log two consecutive request bodies and find where they first differ, in the order the cache reads them:

```ts
type Body = { tools?: unknown[]; system?: unknown; messages: unknown[] };

// The cache reads tools, then system, then messages. Compare in that order.
const inCacheOrder = (b: Body) => JSON.stringify([b.tools ?? [], b.system ?? "", b.messages]);

export function firstDifference(a: Body, b: Body): string | null {
  const x = inCacheOrder(a);
  const y = inCacheOrder(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return null;
  return `differs at character ${i}:\n  ${x.slice(Math.max(0, i - 40), i + 40)}\n  ${y.slice(Math.max(0, i - 40), i + 40)}`;
}
```

If the first difference sits inside the system prompt or the tool list, you have found your cache miss. Move that part to the end of the request, usually into the user message.

Then track the hit rate per call, so a regression shows up the day it ships:

```ts
interface ClaudeUsage {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Share of the input tokens that were read from the cache on this call. */
export function cacheHitRate(u: ClaudeUsage): number {
  const read = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const total = read + written + u.input_tokens;
  return total === 0 ? 0 : read / total;
}
```

## Is caching worth it for your traffic?

Because writes cost more than plain input, caching is a bet that the prefix will be read again before it expires. With the five-minute lifetime, one read already pays for the write. A prefix that is written and never read costs about 25 % more than sending it without a marker. That is why "add `cache_control` everywhere" is not a safe default: it pays on chat and agent traffic that comes back within minutes, and loses on one-off requests or on prompts that change every time.

## How BV-SALA handles it

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is an Apache-2.0 savings layer. With `AnthropicProvider`, it places the breakpoints for you, free and with no key: one at the end of the system prompt and one at the end of the part of the conversation that does not change, never more than the API allows. Each call's report shows what the cache did, from Anthropic's own counters:

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});

// Long and stable: no dates, no user names, no request ids in here.
const SYSTEM = "You are the support assistant for Acme Outdoor, an invented shop. Our return policy: …";

const { text, report } = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
});
console.log(text);
console.log(report.nativeSavings?.cacheReadTokens, report.nativeSavings?.cacheWriteTokens);
console.log(report.nativeSavings?.netUsd); // read discount minus write premium; negative on a cold write
```

`report.nativeSavings` is Anthropic's discount, shown apart: the layer never counts it as its own saving, so your report adds up to the invoice.

**The case where you should switch the marking off.** With no key, if your system prompt changes on every request (a timestamp, a user id), or your calls are more than five minutes apart in fresh processes, the default marking writes a cache entry that nobody reads, and the README states that this costs about 20 % more than no layer. Move what changes into the user message, or turn the marking off:

```ts
import { createSavingsLayer, AnthropicProvider } from "@bivelio/savings-layer";

// A system prompt that changes every time: no cache marks, no write premium.
export const noMarks = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, maxCacheBreakpoints: 0 }),
});

// Or keep the marks and, per request, let the layer move timestamp and UUID
// lines to the end of the system prompt, outside the cached part (opt-in: the
// model reads the same lines in a different order).
const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
});
export const reply = await layer.generate({
  model: "anthropic/claude-haiku-4-5",
  messages: [
    { role: "system", content: `Today is ${new Date().toISOString()}\nYou are the support assistant for Acme Outdoor, an invented shop. …` },
    { role: "user", content: "Can I return hiking boots after 20 days?" },
  ],
  savings: { cachePrefix: true },
});
```

That opt-in reorder is the lever behind an exploratory live test published in the README: on `claude-haiku-4-5`, in a constructed sequence where a timestamp poisoned the cache, it took the hit rate from 0 % to 95 % and the cost per request down by 82.76 %, compared with the layer itself without the option, 20 requests per arm, measured with version 1.2.0 on 15 November 2026. It is a small, constructed test, not a forecast for your traffic.

## Verify against Anthropic's numbers

1. **Per call.** Log `usage` from every response (or `report.nativeSavings` if you use the layer) and compute the hit rate above. A healthy chat or agent workload shows reads far above writes after the first call.
2. **Per day.** In the Claude Console, the usage page breaks input down into cache writes and cache reads per model and API key. Sum your logged `cache_read_input_tokens` and `cache_creation_input_tokens` for the same key and the same UTC day: the totals should match. For a programmatic check, the [Usage and Cost Admin API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) returns the same counters.
3. **In money.** Price reads, writes and plain input separately. A report that shows only "tokens saved" and not the write premium is hiding half the trade.

The repository's [public benchmarks](/en/benchmarks) measure both arms of every test with the provider's own usage counter. For the general method, see [how to verify LLM savings against your bill](/en/guides/verify-llm-savings-against-provider-bill). For the OpenAI side of the same problem, see [why OpenAI's cached_tokens is 0](/en/guides/openai-prompt-caching-cached-tokens). The code is on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

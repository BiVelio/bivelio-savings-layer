OpenAI caches long prompts automatically: when the beginning of a request matches one it processed recently, those input tokens are billed at a discount and the answer starts sooner. You do not have to turn anything on. That is also why it is easy to miss when it stops working. If `cached_tokens` comes back as `0` on every request, this guide lists the reasons in the order to check them, shows how to track the hit rate per request, and how to check it against OpenAI's own usage data.

## Where to read it

Every response tells you how many input tokens came from the cache:

- **Chat Completions:** `usage.prompt_tokens_details.cached_tokens`, out of `usage.prompt_tokens`.
- **Responses API:** `usage.input_tokens_details.cached_tokens`, out of `usage.input_tokens`.

The cached tokens are part of the input total, not added to it. OpenAI's [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) is the reference for the current rules. It now distinguishes newer models, which also report and bill cache writes and accept explicit cache options, from earlier ones, where writing to the cache is free. Check it for the model you use.

## Why cached_tokens is 0

1. **The prompt is too short.** Caching starts at about 1,024 tokens of prompt; the exact threshold and how the cached count is rounded depend on the model. A 600-token system prompt and a short question never hit the cache, and nothing tells you so.
2. **The beginning of the prompt changes.** The cache matches from the very first token. A timestamp, a request id or the user's name in the first message makes every request unique from token one. Tools, images and response formats are part of the prefix too, so tools listed in a different order, or a schema serialised differently, break the match.
3. **The cache was evicted.** Entries are kept for a short time after the last use, typically minutes when traffic is quiet. Requests an hour apart rarely hit.
4. **The traffic is spread out.** Requests are routed by a hash of the start of the prompt. Very high volume with the same prefix overflows to other machines that do not hold the entry. OpenAI's `prompt_cache_key` parameter groups requests that share a prefix; use one key per prompt template, not per user, and keep each key's request rate moderate, as the guide explains.
5. **You are not reading the field.** A streamed Chat Completions request carries no usage at all unless you ask for it with `stream_options: { include_usage: true }`. Many wrappers drop `prompt_tokens_details`. Some OpenAI-compatible providers and some Azure deployments report caching differently or not at all.

## Test it in two minutes

Before you debug your application, check that caching works at all for your account and model. Send the same long prompt twice, a few seconds apart, and read the usage of each answer:

```bash
# A system prompt well above the threshold, sent twice. The second answer should report cached tokens.
BODY=$(python3 -c 'import json; print(json.dumps({"model": "gpt-4o-mini", "messages": [{"role": "system", "content": "You are a careful assistant for an invented shop. " * 200}, {"role": "user", "content": "Say OK."}]}))')
for i in 1 2; do
  curl -s https://api.openai.com/v1/chat/completions \
    -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" \
    -d "$BODY" | python3 -c 'import json, sys; u = json.load(sys.stdin)["usage"]; print(u["prompt_tokens"], u.get("prompt_tokens_details"))'
done
```

If the second line shows cached tokens, the provider side works and the problem is in how your application builds its prompts: read on. If it shows none, try again a few times (caching is best effort, and the first request may land on a different machine), then check the model's entry in OpenAI's caching guide. Swap in the model you use in production; a test on a different model proves little.

This test also gives you a baseline for the next sections. Once you change the order of your prompt or add a `prompt_cache_key`, run the same comparison on a real template from your application and keep the numbers. A hit rate measured before and after the change, on a template your users actually hit, is a result you can show; "caching should help" is not.

## Put what changes last

The fix for most cases is ordering. Everything that is the same for every request goes first and stays byte-identical; everything that changes goes at the end.

```ts
type Message = { role: "system" | "user"; content: string };

const INSTRUCTIONS = "You answer questions about an invented product, Acme Notes. Rules: …"; // long, never changes
const EXAMPLES = "Example question: … Example answer: …"; // long, never changes

export function buildMessages(question: string, userName: string): Message[] {
  return [
    { role: "system", content: INSTRUCTIONS }, // cached
    { role: "system", content: EXAMPLES }, // cached
    // Everything that changes goes in the last message, after the cached part.
    { role: "user", content: `Date: ${new Date().toISOString().slice(0, 10)}. User: ${userName}.\n${question}` },
  ];
}
```

Then track the share of each prompt that was cached, so a regression shows up on the day it ships:

```ts
interface OpenAIUsage {
  prompt_tokens?: number; // Chat Completions
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number; // Responses API
  input_tokens_details?: { cached_tokens?: number };
}

/** Share of this request's input tokens that OpenAI served from its cache. */
export function cachedShare(u: OpenAIUsage): number {
  const total = u.prompt_tokens ?? u.input_tokens ?? 0;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
  return total === 0 ? 0 : cached / total;
}
```

Group it by prompt template. A template whose share stays at 0 % while its prompts are above 1,024 tokens has something changing near the start: log two requests and compare them character by character, as shown in [the Claude version of this guide](/en/guides/claude-prompt-caching-not-working#find-the-byte-that-breaks-your-cache).

## How BV-SALA helps

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is an Apache-2.0 savings layer for TypeScript that wraps any OpenAI-compatible endpoint, free and with no key. OpenAI's cache is automatic, so the layer does not mark anything on OpenAI. What it does for caching:

- **It always asks for usage on streams,** so a streamed request is measured instead of silently missing its counter.
- **It shows OpenAI's discount on every call,** in `report.nativeSavings`, from OpenAI's own counter, and keeps it apart from its own savings: the discount is OpenAI's, not the layer's.
- **It can move volatile lines out of the prefix.** With the opt-in `savings: { cachePrefix: true }`, lines of the system prompt that change on every request (ISO timestamps, UUIDs, epoch times) move to the end, so the stable part can be cached. The model reads the same lines in a different order, which is why it is your decision and never on by default.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const INSTRUCTIONS = "You write one-line summaries of release notes for an invented app. Style rules: …";

const stream = layer.generateStream({
  model: "openai/gpt-4o-mini",
  messages: [
    { role: "system", content: `Generated at ${new Date().toISOString()}\n${INSTRUCTIONS}` },
    { role: "user", content: "Summarize: fixed the export button; faster search; new dark theme." },
  ],
  savings: { cachePrefix: true }, // the timestamp line moves after the stable instructions
});
for await (const event of stream) {
  if (event.type === "text") process.stdout.write(event.delta);
}
const { report } = await stream.result;
console.log(report.tokens.providerCachedInput); // OpenAI's cached_tokens for this request
console.log(report.nativeSavings?.readDiscountUsd); // what those cached tokens saved at list price
```

The layer's own levers (skipping exact repeats and identical requests in flight) are separate from OpenAI's cache and are explained in [deduplicating identical LLM requests](/en/guides/deduplicate-llm-requests).

## Verify against OpenAI's numbers

1. **Per request:** log `cached_tokens` and the input total from each response, or `report.tokens.providerCachedInput` with the layer.
2. **Per day:** OpenAI's [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) returns completions usage in daily buckets that include cached input tokens, per model and, if you ask, per API key or project. Sum your logs for the same key, model and UTC day: the cached and uncached totals should match.
3. **In money:** price cached and uncached input separately. On models that bill cache writes, include them too, or your estimate of the saving will be too high.

For the method in full, read [how to verify LLM savings against your provider's bill](/en/guides/verify-llm-savings-against-provider-bill). For the rest of the levers on an OpenAI bill, see [how to reduce OpenAI API costs](/en/guides/reduce-openai-api-costs). Measured results, including where the layer saves nothing, are on the [benchmarks page](/en/benchmarks), and the code is on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

An OpenAI bill is the sum of a few numbers per request: uncached input tokens, cached input tokens, cache writes (on GPT-5.6 and later), output tokens (reasoning included) and the price of the model. Every way to reduce it moves one of those numbers. This guide goes through the levers in the order that usually pays off, says when each one does not, and shows how to prove each saving with OpenAI's own usage data rather than a projection. Most of it needs no tool at all; where the open-source BV-SALA SDK automates a lever, you will see how.

## Start by measuring per request

Before changing anything, log the `usage` block of every response with the feature or prompt template that produced it: `prompt_tokens`, `prompt_tokens_details.cached_tokens`, `cache_write_tokens` where the model reports it, `completion_tokens` and, for reasoning models, `completion_tokens_details.reasoning_tokens`. Price each bucket with the rates from OpenAI's pricing page and keep the date you copied them. On GPT-5.6 and later, cache writes are a bucket of their own: OpenAI bills them at 1.25 times the uncached input rate with the default 30-minute lifetime, and 2.5 times with the 12-hour lifetime ([prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching), read on 23 November 2026). Price them as plain input and you undercount. A week of this answers the only question that matters at the start: **which two or three features make most of the bill.** Optimise those; ignore the rest.

## 1. Do not pay twice for the same request

Retries, double clicks, nightly jobs that re-classify yesterday's items and parallel workers sending the same prompt all cost a full call each. An exact-match response cache and in-flight deduplication remove them without changing a single answer. How much you save depends entirely on how often your requests repeat, so measure your duplicate rate first. Full guide: [deduplicate identical LLM requests](/en/guides/deduplicate-llm-requests).

## 2. Let OpenAI's prompt cache work

Prompts of about 1,024 tokens or more are cached automatically, and cached input tokens are billed at a discount. On GPT-5.6 and later the cache is not free to fill: the part written to it is billed above the uncached rate, as described above, so a prompt that is written and never read again costs more than without the cache, and one that is read again soon costs much less. Earlier models charge nothing extra for writes. The cache only matches from the first token, so it works only when the start of your prompt is identical between requests. Put instructions, tool definitions and examples first, and dates, user names and the question last. If `cached_tokens` is stuck at 0, see [why OpenAI's cached_tokens is 0](/en/guides/openai-prompt-caching-cached-tokens).

## 3. Send work that can wait to the Batch API

Evaluations, backfills, embeddings of a document set and nightly classification do not need an answer in two seconds. OpenAI's [Batch API](https://developers.openai.com/api/docs/guides/batch) takes a file of requests, returns the results within a day, and bills them at a lower rate than the same requests sent one by one (see the [cost optimization guide](https://developers.openai.com/api/docs/guides/cost-optimization) for current terms). It is often the largest single saving for offline work, and it changes nothing about the answers.

## 4. Use the smallest model that passes your evaluation

Price differences between model tiers are large, and many tasks (classification, extraction, short rewrites, routing) do not need the largest model. Build a small evaluation set from real requests, run it against two or three models, and pick the cheapest one that passes. Re-run it when a new model comes out. Without the evaluation, a downgrade is a guess, and the cost of wrong answers does not show up on the API bill.

## 5. Control the output

Output tokens usually cost several times more than input tokens, and reasoning tokens are billed as output.

- Set `max_completion_tokens` to what the feature really needs.
- For reasoning models, lower the reasoning effort on tasks that do not need deep reasoning, and measure `reasoning_tokens` before and after.
- Ask for structured output with a JSON schema when your code parses the answer. A parse failure followed by a retry pays for the whole request twice.

## 6. Send less input

- Do not resend the whole conversation when the task only needs the last turns.
- Keep large tool outputs (logs, file contents, search results) out of later turns once they have been used.
- Send structured data compactly: pretty-printed JSON spends tokens on whitespace.
- Retrieve the three relevant paragraphs instead of pasting the whole document.

Be careful with the last two in long agent loops: editing the middle of a history that OpenAI has already cached makes everything after the edit bill again, at the uncached rate or, on GPT-5.6 and later, at the higher cache-write rate when it is cached again. Shorten what is new, not what is cached.

## How BV-SALA automates some of these

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is an Apache-2.0 savings layer that wraps any OpenAI-compatible endpoint in TypeScript. It saves with every lever **free, with no key and no signup**, and sends nothing to BiVelio unless you add a key for the optional cloud dashboard. On by default: the exact cache, deduplication of identical requests in flight, answering bare arithmetic locally, and compact serialization of the structured data you pass. Opt-in, one option each: the model cascade, tool-output compaction and the cacheable-prefix reorder. Each request returns a report that says what was saved and where the number comes from.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
});

const { text, report } = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(text); // "8": computed on your machine, no call to OpenAI
console.log(report.calls.avoidedLlm); // 1: a whole call you did not pay for
console.log(report.cost.basis); // "estimated": nothing ran, so there is no provider counter to read
```

Two honest limits. First, traffic that never repeats saves about 0 % from the cache and deduplication, by design. Second, the layer's default trimming of superseded tool results can cost more than it saves in long agent loops on a provider that caches the whole prompt: the project's changelog reports +12.2 % on a 60-step loop on `gpt-5`, measured against a fake provider with versions 1.2.3 and 1.2.4 and no key; 1.2.5 trims the same. For long agent loops, pass `savings: { elision: false }` on the request and compare.

## Prove each saving with OpenAI's numbers

A saving you cannot check is a projection. For each lever:

1. **Pick the counter it should move.** Caching and deduplication move the number of requests. Prompt caching moves `cached_tokens`, and on GPT-5.6 and later `cache_write_tokens` too. Batch moves the price. Model choice moves the price per token. Output control moves `completion_tokens`.
2. **Read that counter from OpenAI.** The [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage) returns requests, input, cached input and output tokens per day, model, project and key. The Costs endpoint and the usage dashboard give the money.
3. **Compare like with like.** Same feature, same weekdays, before and after, or better, two arms of the same traffic at the same time. Look at tokens first and dollars second: dollars also move with prices.

With the layer, every report carries `cost.basis`: `measured` and `reference` amounts come from OpenAI's own counter, `estimated` amounts are reported apart and never mixed in. The method in full: [verify LLM savings against your provider's bill](/en/guides/verify-llm-savings-against-provider-bill).

## What the published numbers say

The project's [benchmarks page](/en/benchmarks) measures both arms of each test with the provider's own usage counter. On a public workload built from GSM8K questions in which 30 % of requests were exact repeats, the pooled reduction on `gpt-4o-mini` was **31.50 %**, with a 95 % interval of 25.7 % to 36.7 % (SDK 0.4.31 artifacts, September 2026; also in the README). On two-turn chat with no repeats (MT-Bench), the differences were indistinguishable from zero or not attributable to the layer, and the page says so. The method, the intervals and every limitation are in [the paper](/en/paper). The code is on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

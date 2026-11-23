Every LLM API bills per call. If your app sends the same request twice, you pay twice, even though the second answer adds nothing. This guide shows two techniques that stop that: an **exact-match response cache** for repeats that arrive later, and **in-flight coalescing** for identical requests that arrive at the same moment. Both work in any language and with any provider. At the end you will see how the open-source BV-SALA SDK does both by default, and how to check the saving against your provider's own usage numbers.

## Where duplicate requests come from

Duplicates are more common than they look, because they rarely come from one obvious place:

- **Retries and double clicks.** A user presses "Generate" twice, or a client library retries after a timeout that the provider had in fact answered.
- **Batch jobs and crons.** A nightly job classifies the same product descriptions, FAQ entries or support macros it classified yesterday.
- **Fan-out.** Two workers, two browser tabs or a React effect that runs twice in development send the same prompt within milliseconds.
- **Agents and pipelines.** A multi-step pipeline asks the same sub-question in several branches.
- **Tests and evals.** CI runs the same fixtures against the live API on every push.

The first and the last group are repeats over time; fan-out is concurrency. They need different fixes, which is why this guide covers both.

## Measure your duplicate rate first

Before you build anything, find out how much of your traffic repeats. Hash every request body for a day and count. The key must be **canonical**: the same request must give the same bytes whatever the order of the JSON keys.

```ts
import { createHash } from "node:crypto";

// Canonical JSON: the same object gives the same text, whatever the key order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requestKey(body: object, scope = "global"): string {
  return createHash("sha256").update(`${scope}\n${canonical(body)}`).digest("hex");
}

// Feed it one day of request bodies, then read the share that repeated.
const seen = new Map<string, number>();
export function record(body: object): void {
  const key = requestKey(body);
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
export function duplicateRate(): number {
  let total = 0;
  for (const n of seen.values()) total += n;
  return total === 0 ? 0 : (total - seen.size) / total;
}
```

If the rate is close to zero, a response cache will not save you much, and you should look at [prompt caching](/en/guides/claude-prompt-caching-not-working) or [model choice](/en/guides/reduce-openai-api-costs) instead. If a noticeable share of your requests repeats, read on.

## Build a cache key that is actually safe

An exact cache is only as good as its key. The rule is simple: **everything that can change the answer goes into the key, and nothing is normalised away.**

- The model id, the full message list, the system prompt, the tool definitions, the response format or JSON schema, and every sampling parameter (`temperature`, `top_p`, `max_tokens`, `seed`, reasoning effort).
- A **scope** when the prompt carries user data. Two users asking "what is my balance?" send the same text and need different answers. Put the user or tenant id in the key, or do not cache those requests at all.
- No "clever" normalisation. Lower-casing, trimming whitespace or dropping punctuation to get more hits turns an exact cache into a fuzzy one, and a fuzzy cache can return the answer to a different question.

## What must never be served from a cache

Some requests repeat but must still reach the model every time:

- **Answers that must change**: "pick a random name", "generate a password", "what time is it", "today's price". A cached answer here is a bug, not a saving.
- **Tools with side effects.** If the response asks to call `send_email` or `create_order`, replaying it skips the action. Cache only requests whose tools are read-only, or none.
- **Sampled output that users expect to vary.** With a high `temperature`, a cached answer is just one sample, served forever.
- **Errors, empty answers, refusals and truncated answers.** Never write them to the cache; let the next request try again.
- **Sensitive topics.** A support bot that caches answers about self-harm or a medical emergency should not; send those to the model each time.

## Coalesce identical requests in flight

A cache only helps once the first answer has arrived. If ten identical requests start within the same 300 ms, all ten miss. The fix is a tiny pattern often called *singleflight*: the first caller makes the call, the others wait for the same promise.

```ts
const inFlight = new Map<string, Promise<unknown>>();

export function singleflight<T>(key: string, call: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key) as Promise<T> | undefined;
  if (running) return running; // join the call that is already on its way
  const p = call().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p; // an error reaches every caller that joined, so nobody waits forever
}
```

Three details matter in production. Errors must reach every waiting caller (the pattern above does that). One caller cancelling must not cancel the shared call for the others. And streaming is harder: a stream that has already started cannot simply be handed to a second caller, so most implementations let a plain request join a call in flight but do not let anything join a stream.

## How BV-SALA does it

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is an Apache-2.0 savings layer for TypeScript. Its SDK wraps your provider and, **with no key and no signup**, turns on both techniques by default: an exact cache and in-flight deduplication. It also applies the "never cache" rules above: requests with freshness or random wording, personal wording without a session, sensitive topics, refusals and errors stay out of the cache.

```ts
// npm i @bivelio/savings-layer   (ESM: a "type": "module" project or a .mts file)
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY,
  }),
  // Nothing else is required: the exact cache and deduplication are on by default.
});

const request = {
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: The battery lasts two days." }],
  temperature: 0,
};

const first = await layer.generate(request);
const again = await layer.generate(request);
console.log(first.report.cache.result, again.report.cache.result); // "miss" "exact"
console.log(again.report.calls.avoidedLlm); // 1: the repeat never reached the provider

// Two identical requests at the same moment: one call, shared by both.
const other = { ...request, messages: [{ role: "user" as const, content: "Classify the sentiment as positive or negative: Shipping took a month." }] };
const [a, b] = await Promise.all([layer.generate(other), layer.generate(other)]);
console.log(a.report.cache.result, b.report.cache.result); // "miss" "singleflight"
```

A request that looks personal ("my order", "our invoice") is not cached unless you say whose it is. Pass a scope and the cache works again, separately for each session:

```ts
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
});

const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Translate to French: the invoice for my order is attached." }],
  context: { sessionId: "user-42" }, // cached for this session only
});
console.log(answer.report.cache.result);
```

The default cache lives in the memory of one process. To share it between several servers or serverless instances, pass a store you run through the `exactCache` option. It needs three methods, so any key-value store works:

```ts
import { createSavingsLayer, OpenAICompatibleProvider, type ExactCache } from "@bivelio/savings-layer";

// The three calls a Redis client offers; adapt the names to yours.
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export function sharedLayer(redis: RedisLike) {
  const exactCache: ExactCache = {
    async get(key) {
      const raw = await redis.get(`bvsala:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(key, value, ttlMs) {
      await redis.set(`bvsala:${key}`, JSON.stringify(value), "PX", ttlMs ?? 3_600_000);
    },
    async delete(key) {
      await redis.del(`bvsala:${key}`);
    },
  };
  return createSavingsLayer({
    provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
    exactCache,
  });
}
```

The cached answers stay in your infrastructure. Nothing is sent to BiVelio when you run without a key.

## Verify the saving against your provider's numbers

A cache saving is easy to check, because it is a count of calls that did not happen.

1. **Count calls on both sides.** For one day, count the `generate()` calls your app made and compare them with the request count your provider shows for the same API key and model (the usage page of the OpenAI or Anthropic console, or their usage APIs). The difference should equal the sum of `report.calls.avoidedLlm`.
2. **Read how each repeat was valued.** `report.cost.basis` says where the number comes from. A repeat is `reference` when the identical call that ran went to the provider's own API: its baseline is that call's own usage counter, priced conservatively at the cached-input rate. It stays `estimated` when the call that ran went anywhere else (a proxy, Azure, a gateway), and estimated money is always reported apart.
3. **Compare spend, not just calls.** Sum `report.cost.netSavingsUsd` per basis. Never add measured and estimated amounts together, and never average `netSavingsRatio` across requests.

If you want a cleaner test, run the same workload twice, once with the levers off for that run (`savings: { exactCache: false, singleflight: false }` on each request) and once with the defaults, and compare the two bills.

## What the public numbers say

The repository publishes its benchmark runs. On a public workload built from GSM8K questions in which 30 % of the requests were exact repeats, the measured pooled reduction was **31.50 %** for `gpt-4o-mini`, with a 95 % interval of 25.7 % to 36.7 % (SDK 0.4.31 artifacts from September 2026; source: the [benchmarks page](/en/benchmarks#savings) and the README). On traffic that never repeats, the saving is about 0 %, and the [benchmarks page](/en/benchmarks#no-savings) shows those flat results too. It also counts the failure that matters most for a cache: **0 of 198** question variants were served with another question's answer ([guarantees](/en/benchmarks#guarantees)).

Your saving depends on your duplicate rate, so measure it first with the snippet at the top of this page. The code, the paper and the raw reports are on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

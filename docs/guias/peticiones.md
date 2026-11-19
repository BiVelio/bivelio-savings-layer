# Requests and providers

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Structured output — validated `data`, not just text

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

## Gemini: the native adapter

For Gemini, use `GoogleProvider`: it speaks Gemini's own API (`generateContent` and
`streamGenerateContent`), where what the layer measures is documented. Keep
`OpenAICompatibleProvider` for every other provider.

```ts
import { GoogleProvider } from "@bivelio/savings-layer";

const gemini = createSavingsLayer({
  provider: new GoogleProvider({ apiKey: process.env.GEMINI_API_KEY, requireUsage: true }),
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
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

## Output cap — with or without a contract

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

# Tools

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Tool outputs, compacted where they are born (opt-in, off by default)

In an agent loop your history is re-sent on every turn and your provider reads it
from its prompt cache at a fraction of the input price. Rewriting anything it has
already cached turns everything after it back into full-price cache writes, which is
how "fewer tokens" ends up as a bigger bill. So this lever only ever changes a tool
output on the turn it arrives, and re-sends exactly the same bytes afterwards.

It removes terminal colour codes, superseded progress-bar states, whitespace between
JSON tokens and runs of identical lines (folded into one line plus a count), and
nothing else: no summaries, no dropped words. Each change either reverses exactly or
leaves what a terminal would display. Outputs of calls that name a file are left
verbatim, so an agent that edits by exact match still sees the file as it is.

```ts
const agentLayer = createSavingsLayer({
  provider,
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
  toolOutputCompaction: true, // or { exceptTools: ["read_logs"], minSavedChars: 512 }
});
// or per request: savings: { toolOutputCompaction: true }
```

- **Switch it on for whole conversations.** The decision depends only on each
  output's own text, so every process and every turn produces the same bytes. A
  conversation that started without it is rewritten once, on its first compacted
  request.
- **Counted, not billed.** What it removes shows in `report.tokens.compressedInput`
  and in `report.traces`; it never enters `cost.*` or any commission. Your provider's
  invoice shows the effect.
- **Inside a framework,** call `compactToolOutput(text)` in your tool before you
  return its result: your history then holds the compacted text itself.
- **Measure it by conversation, not by request.** A verification copy re-sends one
  request with the original history, which your provider has not cached, so on
  turns that re-send compacted outputs the copy costs more than going without the
  layer would have. Compare whole conversations with and without it.

## Tool calls

When you pass `tools` and the model asks to invoke one, the reply is not the final
answer: `text` is empty by design and the request is in `toolCalls`. Execute it,
append the assistant turn and one `role: "tool"` message per call to `messages`, and
call `generate()` again.

```ts
import type { ChatMessage, ToolDescriptor } from "@bivelio/savings-layer";

const tools: ToolDescriptor[] = [
  {
    id: "get_weather",
    intents: ["weather", "forecast"],
    risk: "read",
    description: "Current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
];

// ← your tool
const getWeather = async (city: string): Promise<string> => `${city}: 21 °C, clear`;

const messages: ChatMessage[] = [{ role: "user", content: "What's the weather in Madrid?" }];
let res = await layer.generate({ model: "openai/gpt-4o-mini", messages, tools });

while (res.toolCalls?.length) {
  // res.finishReason === "tool_calls". Send the calls back as they came, ids included.
  messages.push({ role: "assistant", content: res.text, toolCalls: res.toolCalls });
  for (const call of res.toolCalls) {
    const args = JSON.parse(call.arguments) as { city: string };
    const output = await getWeather(args.city);
    messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: output });
  }
  res = await layer.generate({ model: "openai/gpt-4o-mini", messages, tools });
}
console.log(res.text);
```

- **Ids.** Each result carries the `toolCallId` of the call it answers, and every call
  of a turn gets its result before the next user or assistant message. On Anthropic
  that is what lets the turn travel as `tool_use`/`tool_result` blocks (with the tool
  still in that request's `tools`); otherwise it is sent as plain text, as before, and
  the SDK warns once.
- **Errors.** When a tool fails, put the error in `content` and set `isError: true`.
  Anthropic receives it as `is_error`; providers without such a flag get the text.
- **Gemini 3's thought signature.** With `GoogleProvider` it travels in each call's
  `thoughtSignature` and comes back in `call.extraContent` in the same shape as below,
  so a conversation can move between the two Gemini adapters. Through its
  OpenAI-compatible endpoint Gemini
  returns each call with `extra_content.google.thought_signature` and rejects the next
  turn with a 400 if the call comes back without it. It arrives in `call.extraContent`;
  pushing `res.toolCalls` back as they came (as above) sends it back untouched. It is
  opaque and not part of any cache key.
- **gpt-5.6-sol, gpt-5.6-terra and gpt-5.6-luna with tools need `reasoningEffort: "none"`.**
  On Chat Completions OpenAI rejects function tools for these models unless
  `reasoning_effort` is `"none"` («Function tools with reasoning_effort are not supported for gpt-5.6-sol in
  /v1/chat/completions»). Declare it on the request:
  `layer.generate({ model: "openai/gpt-5.6-sol", messages, tools, reasoningEffort: "none" })`.
  The layer never picks an effort itself: without the field nothing is sent. It is part
  of the cache key, like `temperature` and `seed`.

A tool‑call turn is never served from cache and never counted as an avoided call:
an action that has not run yet cannot be a saving. The answer that follows a tool loop
can be, and its cache key covers the loop: each call's name and arguments, which call
each result answers and its `isError`. Two conversations that differ only there never
share a cached answer; the fresh call ids of a new run of the same loop are not a
difference.

**Which tools reach the model.** By default, all of them: every tool you pass to
`layer.generate({ tools })` goes to the provider, read and write alike, whether or not
your tools declare `intents` and `risk`, and the layer credits nothing for the tool
block. Up to 1.2.2 a catalogue that declared `risk` lost its write tools on any request
the router did not classify as an action; since 1.2.3 that gate is off unless you ask
for it. Two options on the selector leave tools out, and both are opt-in:

```ts
import { ToolSelector } from "@bivelio/savings-layer";

const selectiveLayer = createSavingsLayer({
  provider,
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
  toolSelector: new ToolSelector({
    maxTools: 8, //              prune READ tools by relevance
    withholdWriteTools: true, // keep write tools out of requests that are not actions
  }),
});
```

- **`maxTools`** keeps the read tools whose `intents` appear in the request text, up to
  that many (up to 0.4.32 this was the default, with 8). Write and destructive tools are
  never pruned by relevance: they take the first places.
- **`withholdWriteTools`** applies this rule, exactly: a tool whose `risk` is not
  `"read"` is sent only when the router classifies the request as an action, and it does
  so only when the conversation text contains one of these words: `create`, `update`,
  `delete`, `send`, `pay`, `book`, `cancel`, `crea`, `actualiza`, `elimina`, `envía`,
  `paga`. "Refund order 4411" contains none of them, so with this option on the model
  does not receive `refund_order` and answers that it cannot do it. Use it only if you
  prefer a model that cannot act to one that acts on a request you did not expect, and
  check your own phrasing against that list first.

Neither option applies to a catalogue that declares no `intents` and no `risk` (the
usual shape of MCP and OpenAI tool lists), to a request with
`savings: { router: false }`, or to the framework adapters: there every tool goes to
the provider exactly as you sent it.

Whatever the selector leaves out, the model cannot call in that request. The report's
`tool-selector` trace lists every tool left out, and the SDK warns once per process
(`silenceWarnings` turns the warning off). Only a pruned **read** tool counts as
eliminated input. A write or destructive tool that was left out is never credited as a
saving: its tokens enter neither `tokens.eliminatedInput` nor the baseline behind
`cost.*`, and the trace lists it under `withheldWritesNotCredited`.

**Large catalogues: let the provider search them (opt‑in).** With hundreds of tools
(several MCP servers, say), `savings: { toolSearch: "auto" }` sends every tool deferred
behind the provider's own tool search instead of putting the whole catalogue in every
request's prompt. The model looks up what it needs, no tool you declared is out of
reach, and the cached prompt prefix stays the same from one question to the next.

- **Where.** The Anthropic adapter, on models in Anthropic's tool search compatibility
  table. OpenAI documents its tool search for the Responses and Agents APIs, not for
  Chat Completions, which is what this SDK's OpenAI adapter speaks, so OpenAI requests
  keep the selector.
- **When.** `"auto"` applies it when the adapter talks to Anthropic's own API, the
  catalogue is over the provider's documented size, and deferring it pays for one
  search on every request even with a warm prompt cache. `"always"` skips those checks
  (for example behind a proxy that forwards the search blocks). Requests with an output
  contract, or with the model cascade on, keep the selector.
- **Across turns.** Append the assistant turn with its `toolCalls` (ids as returned)
  before the tool results, as in any tool conversation. The Anthropic adapter then sends
  the earlier search results back in that turn, so the model calls the tools it already
  found without searching again. It keeps them in memory, per adapter instance and
  bounded; a turn it no longer remembers (another process, say) goes out as before and
  the model searches again.
- **Whose saving.** The provider's. Your usage counter shows it; the layer credits
  nothing for it and charges no commission on it.

```ts
import { AnthropicProvider } from "@bivelio/savings-layer";

const claude = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,   (optional: cloud)
});

const mcpTools: ToolDescriptor[] = []; // every tool your MCP servers list

const { report: searched } = await claude.generate({
  model: "anthropic/claude-opus-5-5",
  messages: [{ role: "user", content: "Which orders from service 17 are still open?" }],
  tools: mcpTools,
  savings: { toolSearch: { mode: "auto", alwaysLoaded: ["read_file"] } },
});

// Which path ran and why, and how many searches the provider ran.
console.log(searched.traces.filter((t) => t.stage === "tool-search"));
```

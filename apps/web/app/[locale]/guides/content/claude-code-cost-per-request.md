"How much does Claude Code cost?" has two honest answers. On a Claude subscription, the price is the plan, and per-token cost only matters once you go past its limits. On an API key or a cloud provider, you pay per token, and the cost of a session depends on how many requests Claude Code sends, how big each one is and how much of it is read from the prompt cache. This guide shows what Anthropic publishes, which built-in tools give you totals, and how to see the cost of every single request on your own machine, for free, so you can find the turns that make a session expensive.

## What Anthropic says it costs

Anthropic's own [cost page for Claude Code](https://code.claude.com/docs/en/costs) gives averages from enterprise deployments: about $13 per developer per active day and $150 to $250 per developer per month, with 90 % of users below $30 per active day. Those are averages across many teams. Your number depends on the model you pick, the size of your repository and how you work, which is why the rest of this guide is about measuring it.

## The built-in tools, and what they do not show

- **`/usage` in Claude Code.** The Session block shows an *estimated* cost at list price, with tokens per model split into input, output, cache reads and cache writes. Recent versions add a prompt-cache line with the hit rate and the number of misses. It is a session total, computed locally.
- **The Claude Console.** For API keys, the Cost and Usage pages show what was billed, per day, workspace and model. This is the number to reconcile against.
- **OpenTelemetry export.** Claude Code can stream token and cost metrics to your own observability stack, per user and session ([monitoring docs](https://code.claude.com/docs/en/monitoring-usage)).

What none of these makes easy is the **per-request view**: which turn was the expensive one, and why. A session is dozens or hundreds of API calls, and the expensive ones have recognisable causes:

- **A cold cache.** The first turn after a break longer than the cache lifetime re-reads the whole conversation at full price, and writes it again.
- **A model switch.** Each model has its own cache, so switching models mid-session reprocesses everything.
- **Huge tool results.** A test log or a big file read once sits in the context of every later turn.
- **Too many tool definitions.** MCP servers can add many kilobytes of definitions to every request.
- **Compaction.** Summarising a long conversation is itself a large request.

## Measure every request with a local gateway

A gateway is a small proxy between Claude Code and the API that reads the usage counters of each response. Claude Code supports this officially through `ANTHROPIC_BASE_URL`. [BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) ships one in its npm package: Apache-2.0, **no key, no signup**, and nothing is sent to BiVelio. It needs Node.js 20 or newer.

The one-command way:

```bash
# Starts a local gateway on a free port, runs Claude Code through it, and stops it on exit.
npx @bivelio/savings-layer claude
```

The wrapper keeps the per-request log quiet so it does not draw over Claude Code's interface. When you exit, it prints how many requests it metered and which ones it forwarded without metering, and why. To see every request as it happens, either ask for the log on stderr:

```bash
BVSALA_GATEWAY_LOG=1 npx @bivelio/savings-layer claude
```

or run the gateway in its own terminal, on a fixed port:

```bash
# Terminal 1: the gateway (Anthropic is the default upstream, port 8402)
npx @bivelio/savings-layer gateway

# Terminal 2: Claude Code, pointed at it (no /v1 at the end).
# ENABLE_TOOL_SEARCH=true only matters before Claude Code v2.1.304 (see below).
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
```

Each request becomes one line. These two come from a local test against a stand-in server, with invented traffic, so the shape is real and the numbers are not yours:

```text
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.007700 (in 40, cache↑3000 cache↓0, out 12)
[gateway] POST /v1/messages  · claude-sonnet-5 · $0.000800 (in 40, cache↑0 cache↓3000, out 12)
```

Read it from left to right: the model, the cost at list price, then the input tokens billed in full, the tokens written to the cache (`cache↑`), the tokens read from it (`cache↓`) and the output tokens. The first line is a cold turn that writes the prefix; the second reads it back for a fraction of the price. A session where `cache↑` stays large turn after turn has a cache problem: see [why Claude prompt caching stops working](/en/guides/claude-prompt-caching-not-working).

`ENABLE_TOOL_SEARCH=true` depends on your Claude Code version. Since v2.1.304, tool search stays on behind a gateway ([Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp)), and the variable changes nothing. Before v2.1.304, Claude Code turned tool search off behind any base URL that was not Anthropic's and put every tool definition into every request. On those older versions it was expensive: the gateway's Claude Code guide, shipped in the npm package, records a setup with 226 MCP tools, measured on 9 September 2026, where that meant 450 KB per request and a quarter of that day's bill. The `claude` wrapper sets the variable for you, unless you already set it.

## What the gateway sees, and what it does not

- **It forwards what Claude Code sends.** With no lever acting on a request, the body reaches Anthropic byte for byte, including `cache_control` markers and the `anthropic-beta` header, so caching works exactly as it does without the gateway. A test in the repository checks this against a fake upstream on every change.
- **Two small calls skip it.** Per Claude Code's [gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol), the fast-mode availability check and the WebFetch domain safety check call `api.anthropic.com` directly instead of following `ANTHROPIC_BASE_URL`. Neither is a model request: fast-mode inference itself follows the base URL, so it goes through the gateway and is metered like any other turn.
- **Subscription traffic is measured, not billed.** On a Claude Pro or Max login there is no per-token invoice; the gateway prices that traffic at list-price equivalent so you can see it, and credits no saving on it.

## Does the gateway also save money?

Out of the box, with Claude Code on an API key, it measures and saves nothing. Do not read the startup message of version 1.2.3 as a promise: it says every local saving lever is on, and its exit summary only counts the requests it metered, so neither tells you that the saving was zero. The gateway's default lever lowers the cache-write lifetime from one hour to five minutes on turns where a large part of the request is new, because a one-hour write costs twice the input price and a five-minute write 1.25 times. Claude Code on an API key asks for five minutes already, unless you set `promptCacheTtl` to `1h`, so there is nothing to lower.

When the one-hour cache is in play, the saving is small and depends on your traffic. The [benchmarks page](/en/benchmarks#gateway-ttl) publishes a replay of one organisation's own Claude Code traffic: net **+2.49 %** of the list-price bill ($113.45 of $4,563.61), with a 95 % interval of +1.50 % to +3.57 % when resampled by session, and a ceiling of 7.2 % for any policy of this kind. On one model the result was close to nothing, and in one period it lost money. It is a replay with a partly reconstructed baseline, not an invoice, and the page lists every limit.

## Check the gateway's numbers against your bill

1. **Against `/usage`.** For one session, add up the gateway's per-request costs and compare them with the Session block of `/usage`. Both price the same counters at list price, so they should be close.
2. **Against the Console.** Use a dedicated API key or workspace for a day, then compare the gateway's totals per model with the Console's Usage page for that key: input, output, cache writes and cache reads, in tokens first, then in dollars.
3. **Explain any gap.** List price is not always your price: contracted discounts, data residency or priority tiers change the money but not the token counts. Traffic that did not pass through this gateway, such as another machine, a script or a CI job using the same key, appears only on the Console.

If the token counts match and the dollars do not, the difference is pricing, not measurement. For the full method, read [how to verify LLM savings against your provider's bill](/en/guides/verify-llm-savings-against-provider-bill).

## Cutting the bill once you can see it

With per-request numbers in front of you, the usual fixes are plain: clear between unrelated tasks instead of carrying a long context, pick the model before the session and keep it, compact at natural breaks, keep large logs out of the context, and trim the MCP servers you do not use. Using another provider's model behind Claude Code is covered in [DeepSeek and Qwen API costs](/en/guides/deepseek-qwen-api-cost-local-gateway).

The gateway's source, its Claude Code guide and the tests that check it forward your requests unchanged are on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

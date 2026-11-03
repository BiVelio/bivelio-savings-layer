# YC One-Pager — BiVelio Savings Layer (BV-SALA)

**One line:** BV-SALA is a zero-dependency layer that sits between your code (or coding agent) and any LLM provider and cuts the API bill 30–75 %, with every dollar of savings audited per request against the provider's own usage counter — running on your machine, with zero telemetry.

**One paragraph:** Companies now pay their largest cloud line to LLM APIs, and they pay for what they *send*, not what they need. BV-SALA installs with one command (`npx @bivelio/savings-layer gateway`) or one npm package, then skips calls that don't have to happen (exact + calibrated semantic cache, deduplication), trims what does (prompt-cache placement, context/tool-output compaction), and routes each request to the cheapest execution that meets the quality bar (model cascade, sibling models, DeepSeek/Qwen/GLM as cheap siblings, provider failover). It works for Claude Code, Cursor, Codex, Gemini CLI, Qwen Code, Aider — and any OpenAI/Anthropic SDK in any language. Every request returns a `SavingsReport` with four separate ledgers (`avoided_calls`, `eliminated_tokens`, `compressed_tokens`, `provider_cached_tokens`) and a cost basis labelled `measured` / `reference` / `estimated`. It is open core: the entire savings engine is free, telemetry is off by default, and prompts never reach BiVelio.

## Why now

1. **LLM spend became the biggest new line in engineering budgets** — and most of it is waste: repeated prompts, repeated context, frontier models doing work a cheap model does equally well.
2. **Providers changed the economics** — Anthropic's 0.1× cache reads, OpenAI's automatic caching, DeepSeek's $0.003/1M cache hits — but agents and apps don't exploit them consistently.
3. **The gateway category consolidated** (Stripe/OpenRouter, Aug 2026) around hosted routers with take-rates. The open wedge is *self-hosted, auditable savings*: data stays in your VPC/on your machine, and the saving is provable per request, not a monthly dashboard promise.

## What we have (traction evidence)

- **Published, reproducible benchmarks** with per-trial CSV: live SDK double-runs, 10,000-resample cluster bootstrap — **31.5 %** cost reduction on gpt-4o-mini (95 % CI 25.7–36.7, 100 families × 200 requests/arm) and **75.1 %** on claude-sonnet-5 (95 % CI 69.3–79.6) [paper](https://bivelio.com/es/research/papers/bv-sala-savings-layer). Honest about what is measurement vs estimation — the differentiator.
- **npm distribution**: `@bivelio/savings-layer`, 44 published versions, zero runtime dependencies, Node ≥ 20.
- **Integration matrix** (all first-party, tested against fake upstreams): Claude Code, Codex CLI (API key + ChatGPT auth), Gemini CLI (native Gemini protocol), Cursor, Qwen Code, Aider, Goose, opencode, Kilo, Copilot CLI BYOK, Continue/Cline/Crush/Droid recipes, plus MCP server for any MCP client and SDK adapters (Vercel AI SDK, Mastra, LangChain.js, Anthropic SDK).
- **Providers**: OpenAI, Anthropic, Gemini, DeepSeek (incl. its Anthropic-format endpoint), Qwen, GLM, Moonshot, MiniMax, OpenRouter, Ollama/vLLM/LM Studio — with a versioned list-price catalog (hash-pinned, contrasted weekly against LiteLLM's table).
- **Open-core launch (this change)**: the SDK and gateway run fully with no keys, no signup, no telemetry. An invalid key still fails closed — only its absence is a working product.

## Product

- **SDK** (`createSavingsLayer`): in-process, per-request `SavingsReport`, streaming, batches, four ledgers, verification sampling (your own A/B on your traffic), provider price levers (Flex/batch tiers), prompt-cache breakpoints.
- **Gateway** (`bvsala gateway`): OpenAI-, Anthropic- and Gemini-compatible local proxy; measures with the provider's own counters; TTL / sibling-model / per-turn-effort levers; local report routes (`/_bvsala/v1/…`); MCP server; `bvsala doctor` prints the exact config for every installed agent; `bvsala init` wires any JS/TS stack.
- **Cloud (paid, optional)**: team dashboard, shared semantic caches across seats, org entitlements, license management. Fixed fee, no commission on savings.

## Business model

Freemium, bottom-up dev motion → team expansion. Free: the whole savings engine (open core, this is the moat-builder). Paid: cloud dashboard + team features (per-seat, no take-rate). Enterprise: VPC/self-host contracts. **We only charge for what a customer can't get for free by running our OSS — we never tax the savings we produce.**

## Market

LLM API spend is growing faster than any infra category (OpenRouter reported ~$1.3 B valuation on ~8 M users pre-acquisition; LiteLLM 58 k+ GitHub stars). Everyone who calls an LLM with an API key is a customer: B2B SaaS, agent startups, fintech, legal, healthcare-adjacent tools, internal automation.

## Competition & wedge

LiteLLM (Python gateway, enterprise licensing), OpenRouter (hosted router + take-rate, now Stripe), Portkey (gateway + control plane), Helicone/Langfuse (observability, not savings), GPTCache (Python, research-grade). **No one combines:** in-process zero-dependency Node SDK + coding-agent gateways + per-request savings audited on the provider's own counters + open-core with zero telemetry. "Savings you can audit per request, on your own machine/VPC" is the defensible F26 wedge — not another model router.

## Team

BiVelio Inc (Delaware), founder-led, engineering + research: published measurement paper with a real statistical apparatus (cluster bootstrap, ledgers, evidence bases), NVIDIA Inception member, ElevenLabs Grants program. Andorra → world. Strongest signal: the codebase treats every money number as a liability — versioned prices, hash-pinned catalog, weekly contrast, tests that fail the repo if a wrong price can be published.

## The ask

Standard YC batch. We need: distribution help (launch strategy to hit 10 k weekly active installs), design partners among LLM-heavy YC companies, and help sharpening the enterprise motion. The savings meter is our traction instrument: every install reports its own savings locally — and with the (optional) cloud key, we can show aggregate verified savings across customers.

## North-star metrics

1. Weekly active `bvsala gateway` sessions (free installs).
2. % of gateway sessions that become cloud workspaces.
3. Aggregate verified $ saved across cloud workspaces (the number we'll publish).
4. NRR on team plans.

## Risks & honest answers

- Providers can nuke the wedge by making caching free — answer: the layer still removes repeated calls and routes to cheaper models; the audit stays valuable.
- Open-core cannibalization — answer: the dashboard/team layer is the product; every free install is the top of our funnel.
- Accuracy of savings claims — answer: the paper's entire apparatus exists so a wrong number fails loudly; estimates are never billed.

# BiVelio Savings Layer — Python client

<p align="center">
  <img src="https://savings.bivelio.com/brand/og-image.png?v=2026-11-17" alt="BiVelio Savings Layer" width="720">
</p>

> **BV-SALA cuts your LLM bill — and proves it on your provider's own meter.**
> Recomputed pooled reductions 31.50 % / 75.08 % on a public workload built from GSM8K questions, 30 % of them exact repeats (about 41 points of the 75.08 % are Anthropic's cache pricing), with bootstrap intervals · exploratory live A/B (20 requests per arm) measured with 1.2.0 on 15 Nov 2026, TypeScript SDK with the opt-in `savings.cachePrefix: true` against the layer itself without that option: 0 % → 95 % hit-rate, −82.76 % per request · paper v2.3-r1, DOI [10.5281/zenodo.24278852](https://doi.org/10.5281/zenodo.24278852).

**This package is the Python client of BV-SALA.** The full product — the TypeScript SDK, the local gateway, every saving lever and the measured evidence — lives in the GitHub repository at
**[github.com/BiVelio/bivelio-savings-layer](https://github.com/BiVelio/bivelio-savings-layer)**; its README is the canonical documentation (install, levers, paper, benchmarks, pricing). The same README is what npm shows for
[`@bivelio/savings-layer`](https://www.npmjs.com/package/@bivelio/savings-layer).

A thin client for the local **bvsala gateway**. It routes the official OpenAI
and Anthropic Python SDKs through the gateway and hands you, for each request,
the report the gateway recorded (with a BiVelio key, the same one your dashboard receives): the provider's own
token counts, the cost at the model's list price, and where the figure comes
from (`cost.basis`).

- **The gateway does the work.** It ships in the npm package
  [`@bivelio/savings-layer`](https://www.npmjs.com/package/@bivelio/savings-layer)
  (Apache-2.0), forwards each request to your provider and
  measures it with the provider's usage counter. This package prices nothing
  itself, so its numbers are exactly the gateway's.
- **Open core.** The gateway starts with no keys at all (COMMUNITY mode: free,
  zero telemetry). Every gateway lever is free, with no key; one is on by default (cache TTL tuning) and the others you switch on.
  Without a running gateway, `wrap()` raises; it never falls back to calling
  your provider directly.
- **No dependencies.** Standard library only. It does not import the OpenAI or
  Anthropic SDKs; you bring them.
- **Your prompts never reach BiVelio.** The client only talks to the gateway on
  `127.0.0.1`, and the gateway forwards your requests to your provider. What a
  cloud key sends to BiVelio is per-request usage (token counts, cost, the model
  id and opaque ids), never your content: LICENSE-CLOUD.md, section 5, lists
  every field.
- **No proxy between you and the gateway.** HTTP proxy settings (`HTTP_PROXY`,
  `HTTPS_PROXY`, `ALL_PROXY`) are never used to reach the gateway: not by this
  package's own calls, and not by the client `wrap()` returns, which gets a new
  HTTP client of its SDK's default type that connects to the gateway directly.
  If you created the client with your own `http_client=`, `wrap()` keeps it as
  it is; if it reads proxy settings, set `NO_PROXY=127.0.0.1,localhost` before
  creating it.

This package measures. The saving levers of the TypeScript SDK do not run in
Python; the gateway's own levers apply to Anthropic `/v1/messages` traffic, free
and with no key, and by default only one acts: cache TTL tuning, which saves
only when your client pays per token and asks for the one-hour cache. OpenAI
traffic is measured when the request reports usage, and by default it is never
changed.

The TypeScript SDK, and what a BiVelio key changes:

- **The TypeScript SDK.** Every lever is included and free, with no key. On by
  default: exact cache, deduplication, local resolvers, prompt-cache placement,
  trimming of superseded tool results and compact serialization of the
  structured data you pass. The rest you switch on, one line each.
- **A key in the SDK.** In the SDK, a BiVelio key only adds the cloud: the free
  Measure license applies exactly the same levers as no key. A paid license
  (Pro, Team, Enterprise) does too, except trimming of superseded tool results,
  which with a paid license only acts inside a tool loop on Anthropic.
- **A key in the gateway.** In the `bvsala` gateway the free Measure license
  applies the same levers as no key, and a paid license works as in 1.2.3: each
  lever also needs your organization's license to include it, checked
  fail-closed.
- **What a key depends on.** One dependency comes with a key, the free Measure
  key included: with BIVELIO_SERVICE_KEY set, the gateway needs
  savings.bivelio.com to start (or a valid BIVELIO_LICENSE_KEY as a fallback);
  once running it keeps serving without it. With no key there is no such
  dependency.

What the paid cloud adds is the team dashboard, shared measurement, seats and
license management. BiVelio hosts no cache.

## Requirements

- Python 3.10 or newer.
- Node.js 20.19 or newer, for the gateway. No keys required: the gateway starts
  in COMMUNITY mode; `BIVELIO_SERVICE_KEY` (optional) adds the cloud dashboard.

## Install

```bash
pip install bivelio-savings-layer
```

The package is `bivelio-savings-layer` on PyPI and `bvsala` in your code
(`import bvsala`). From a checkout of the repository, to try unreleased changes:

```bash
pip install ./packages/python
```

## Start a gateway

One gateway per provider:

```bash
# export BIVELIO_SERVICE_KEY=…   # optional: adds the cloud dashboard
npx @bivelio/savings-layer gateway                                 # Anthropic, on 8402
npx @bivelio/savings-layer gateway --upstream openai --port 8403   # OpenAI, on 8403
python -m bvsala --url http://127.0.0.1:8403 status                # version, upstream, license
```

## Use it

```python
import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")
client = gw.wrap(OpenAI())          # a copy that goes through the gateway; OpenAI() is untouched

resp = client.chat.completions.create(
    model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}],
)
report = gw.report(resp)
print(report.summary())             # gpt-4o-mini · measured · $0.000024 (in 100, cached 40, out 20)
print(report.cost.actual, report.cost.basis, report.tokens.actual_output)
```

Streaming works the same way. For OpenAI Chat Completions, ask for usage in the
request, or the provider sends no counter and the report says so:

```python
import bvsala
from openai import OpenAI

gw = bvsala.Gateway("http://127.0.0.1:8403")
client = gw.wrap(OpenAI())

stream = client.chat.completions.create(
    model="gpt-4o-mini", messages=[{"role": "user", "content": "Hi"}],
    stream=True, stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="")
print(gw.report(stream).summary())
```

Anthropic:

```python
import bvsala
from anthropic import Anthropic

gw = bvsala.Gateway()                # $BVSALA_GATEWAY_URL or http://127.0.0.1:8402
claude = gw.wrap(Anthropic())
msg = claude.messages.create(model="claude-haiku-4-5", max_tokens=256,
                             messages=[{"role": "user", "content": "Hi"}])
print(gw.report(msg).summary())
```

`gw.report()` accepts a response, a stream you have read, any chunk or event of
it, a raw response from `with_raw_response`, or an id string. It also reads a
LiteLLM response sent with `extra_headers=bvsala.REPORT_HEADERS`, from the
provider headers LiteLLM keeps in `_hidden_params` (checked against LiteLLM's
source, not yet end to end).

A raw response, a stream and the `x-bvsala-request-id` string each name one
request exactly; a parsed response, a chunk or an event is looked up by the
provider's response id. That matters with the gateway's opt-in
`BVSALA_GATEWAY_COALESCE=1`: identical requests in flight at the same time then
share one provider call and one response id, so a lookup by that id returns the
same report for all of them. For each request's own report, make the call with
`with_raw_response` (`raw = client.chat.completions.with_raw_response.create(...)`),
pass `raw` to `gw.report()`, and read the response itself with `raw.parse()`.

`gw.report()` waits up to `wait` seconds (5 by default) for a request still in
flight; after that the report comes back with `status == "pending"`. In async
code use `await gw.areport(resp)`; `wrap()` also takes `AsyncOpenAI`,
`AzureOpenAI` and `AsyncAnthropic`.

`gw.totals()` adds up the reports this process fetched. Savings stay split by
basis (`measured`, `reference`, `estimated`), never added into one figure.

### Any other client

The gateway side works with any HTTP client: send `x-bvsala-report: 1`, read
the `x-bvsala-request-id` response header, then
`GET /_bvsala/v1/reports/<id>` on the gateway. `bvsala.REPORT_HEADERS` is that
header as a dict, for `extra_headers=` or `default_headers=`.

## Errors

| Exception | When |
|---|---|
| `GatewayUnavailable` | nothing answers at the URL, or it is not a bvsala gateway with local reports (0.4.26 or later is needed) |
| `LicenseInactive` | the gateway's license does not serve new requests; `.state` says why |
| `GatewayMismatch` | the client points at a different provider than the one the gateway forwards to |
| `ReportNotFound` | the gateway holds no report for that id (only requests sent with `x-bvsala-report: 1` have one, kept for at most an hour) |

## License

Apache-2.0, © 2026 BiVelio Inc. This client is open source; the gateway it talks
to is open core (Apache-2.0, no keys required, COMMUNITY mode runs with zero
telemetry). The optional BiVelio cloud is a separate commercial service: see
[LICENSE](https://github.com/BiVelio/bivelio-savings-layer/blob/main/packages/python/LICENSE) and [savings.bivelio.com](https://savings.bivelio.com).

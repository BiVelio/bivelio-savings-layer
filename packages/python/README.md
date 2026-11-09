# BiVelio Savings Layer for Python

<p align="center">
  <img src="https://savings.bivelio.com/brand/og-image.png" alt="BiVelio Savings Layer" width="720">
</p>

A thin client for the local **bvsala gateway**. It routes the official OpenAI
and Anthropic Python SDKs through the gateway and hands you, for each request,
the report the gateway recorded for your BiVelio dashboard: the provider's own
token counts, the cost at the model's list price, and where the figure comes
from (`cost.basis`).

- **The gateway does the work.** It ships in the npm package
  [`@bivelio/savings-layer`](https://www.npmjs.com/package/@bivelio/savings-layer)
  (Apache-2.0), forwards each request to your provider and
  measures it with the provider's usage counter. This package prices nothing
  itself, so its numbers are exactly the dashboard's.
- **Open core.** The gateway starts with no keys at all (COMMUNITY mode: every
  local lever on, zero telemetry). Without a running gateway, `wrap()` raises;
  it never falls back to calling your provider directly.
- **No dependencies.** Standard library only. It does not import the OpenAI or
  Anthropic SDKs; you bring them.
- **Your prompts never reach BiVelio.** The client only talks to the gateway on
  `127.0.0.1`, ignoring any HTTP proxy settings, and the gateway forwards your
  requests to your provider. What a cloud key sends to BiVelio is per-request
  usage (token counts, cost, the model id and opaque ids), never your content:
  LICENSE-CLOUD.md, section 5, lists every field.

This package measures. The saving levers of the TypeScript SDK do not run in
Python; the gateway's own levers apply to Anthropic `/v1/messages` traffic with
a PRO license.

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
export BIVELIO_SERVICE_KEY=…
npx -p @bivelio/savings-layer bvsala gateway                                 # Anthropic, on 8402
npx -p @bivelio/savings-layer bvsala gateway --upstream openai --port 8403   # OpenAI, on 8403
python -m bvsala --url http://127.0.0.1:8403 status                          # version, upstream, license
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

Commercial software, © 2026 BiVelio Inc. Free to install, paid to run: see
[LICENSE](./LICENSE) and [savings.bivelio.com](https://savings.bivelio.com).

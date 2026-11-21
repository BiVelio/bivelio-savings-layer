# Qwen Code through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Qwen Code with the
Anthropic provider speaks the pure Anthropic dialect (the official TS SDK), so
the current meter understands it without changes. The **qwen** model family is
left out of the catalog on purpose (further down).

## What you need

- `qwen` on the PATH.
- **An Anthropic API key** (`ANTHROPIC_API_KEY`), with Qwen Code configured to
  use the Anthropic provider.
- `bvsala` installed. Open core: with no keys the gateway starts in Community mode (all the local saving, zero telemetry); `BIVELIO_SERVICE_KEY` adds the dashboard and the org's entitlements (see [README](README.md)).

## User config: `~/.qwen/settings.json`

The routing needs two things at once [V]: the `ANTHROPIC_BASE_URL` environment
variable **and** `~/.qwen/settings.json` selecting the Anthropic type:

```json
{
  "selectedType": "anthropic"
}
```

Keep the rest of your `settings.json`; the key verified in S3 is
`selectedType`. Without it, Qwen Code does not read `ANTHROPIC_BASE_URL` and the
gateway will see nothing.

## Wrapper: `bvsala qwen`

```bash
export BIVELIO_SERVICE_KEY=bvk_…  # OPTIONAL: dashboard + org entitlements (without it: Community mode)
bvsala qwen
```

A mirror of `bvsala claude` with `ANTHROPIC_BASE_URL`. The wrapper **does not
read** `settings.json`: check yourself that `selectedType` is `anthropic`
(`bvsala doctor` reminds you of the path). The manual recipe below is the same.

## Manual: `ANTHROPIC_BASE_URL`

```bash
bvsala gateway                                         # window 1: http://127.0.0.1:8402
ANTHROPIC_BASE_URL=http://127.0.0.1:8402 qwen          # window 2 — NO /v1
```

No `/v1`: Anthropic's official TS SDK appends `/v1/messages` [V]. No trailing
slash.

## Checking that it works

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## The typical pitfall

1. **`/v1` in the base URL** → `[gateway] POST /v1/v1/messages → 404`.
2. **`selectedType` is not `anthropic`** → the gateway log shows nothing: Qwen
   Code is talking to its default provider, not to you.
3. **qwen models (DashScope / ModelStudio)**: they are **outside the catalog on
   purpose** — `costeMedido → null`, passthrough with a one-time warning
   (`model "…" is not in the price catalog; its usage is forwarded but not
   metered.`). Consistent with the catalog's policy: present-and-wrong is worse
   than absent. Metering them would need **verified** ModelStudio/DashScope
   prices as of the date, and first checking that DashScope emits SSE with
   `\n\n` — the observer splits blocks only on `\n\n`; an upstream that emits
   `\r\n\r\n` would never close a block and would meter nothing even if the
   price were there [I].

## BYOK note

**API key only.** Anthropic forbids the Claude Pro/Max OAuth in third-party
harnesses; Qwen Code has been BYOK since April 2026 and so is this recipe.

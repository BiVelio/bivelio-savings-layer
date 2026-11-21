# Cline through the gateway

**Source:** `docs/PASARELA-S3-TERMINALES.md` §3 [V]. Cline configures the
provider through its **UI** (a VS Code extension), so there is no file and no
wrapper here: only steps and the exact shape of the URL, which is **with
`/v1`**.

Why with `/v1` (a verified refutation): Cline `main` already uses
`@ai-sdk/anthropic`, not the official TS SDK; its `normalizeBaseURL` only adds
`/v1` when the URL is exactly `https://api.anthropic.com`, and `builtins.ts`
sets `https://api.anthropic.com/v1` [V]. With a custom URL, what you type is
what is used.

## What you need

- Cline installed in VS Code.
- Your Anthropic **API key**.
- `bvsala gateway` running on `http://127.0.0.1:8402` (no keys: Community mode; `BIVELIO_SERVICE_KEY` is optional; see [README](README.md)).

## Steps in the UI

1. Open Cline's settings → **API Provider**: choose **Anthropic**.
2. Paste your **Anthropic API Key**.
3. Tick **"Use custom base URL"** and type exactly:

   ```
   http://127.0.0.1:8402/v1
   ```

   **With `/v1`, no trailing slash.**
4. Choose the model and save.

## Checking that it works

Send a trivial message from Cline and look at the gateway window:

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

## The typical pitfall

- **No `/v1`** → Cline asks for `…/messages` → `[gateway] POST /messages → 404`
  and the UI shows a generic API error. Add the `/v1`.
- **Trailing slash** → no.
- **Gateway off**: the UI remembers the custom base URL; when you do not have
  `bvsala gateway` running, Cline will fail until you start it or untick the
  box.

## BYOK note

**API key only.** Anthropic forbids using the Claude Pro/Max OAuth in
third-party harnesses (Cline was in the first wave of the January 2026 block).
This recipe is the Anthropic provider with an API key; nothing else.

# GitHub Copilot (CLI and VS Code) through the gateway — only with your own key

**Source:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`: GitHub's
official docs "Using your own LLM models in GitHub Copilot CLI" (source in
`github/docs`, consulted on 2026-09-27) and VS Code's "AI language models in
VS Code" (dated 2026-09-16).

**First of all:** Copilot only goes through a base URL when you use **your own
provider key (BYOK)**. The models GitHub hosts go to GitHub and cannot be
metered here; `/usage` shows their spend (GitHub AI credits and tokens per
model). With BYOK, the CLI works **without a GitHub account** [V].

## Copilot CLI

### What you need

- `copilot` on the PATH (on Windows, the native installer: npm's `.cmd` shim
  cannot be launched safely with arguments and `bvsala` refuses with a guide).
- BYOK configured and working **directly** [V]:

  ```bash
  export COPILOT_PROVIDER_TYPE=anthropic
  export COPILOT_PROVIDER_BASE_URL=https://api.anthropic.com
  export COPILOT_PROVIDER_API_KEY=…          # your Anthropic key
  export COPILOT_MODEL=<Claude model>
  ```

  (With OpenAI, the default type, the base URL is `https://api.openai.com/v1`: see "The `openai` type" below.)
- `bvsala` installed. Open core: with no keys it starts in Community mode; `BIVELIO_SERVICE_KEY` (optional) adds the dashboard and the entitlements (see [README](README.md)).

### Wrapper: `bvsala copilot [args…]`

```bash
bvsala copilot
```

With `COPILOT_PROVIDER_TYPE=anthropic`, it starts the gateway against
`api.anthropic.com` and launches `copilot` with `COPILOT_PROVIDER_BASE_URL`
pointing at the gateway, **with the same path you already had**. Your model and
your key are not touched. On exit it prints how many requests it metered and
which ones it forwarded without metering, and why.

It refuses, before starting anything and with the reason, when:

- there is no `COPILOT_PROVIDER_BASE_URL` (you are on GitHub's models: nothing to meter);
- the type is `openai` (the default one): not yet, see below;
- the type is `azure` or another one, or the base URL is not
  `https://api.anthropic.com`: the gateway only prices the provider's own API at
  its list price, and Azure, a local model or a reseller bill differently (or
  nothing).

### Manual (`anthropic` type)

```bash
bvsala gateway                                                   # Anthropic, 8402
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:8402 copilot          # NO /v1
```

Every `POST /v1/messages` is metered with its counter (Messages always carries
it).

### The `openai` type: no wrapper until it is validated by hand

The official docs describe it as "any other OpenAI Chat Completions
API‑compatible endpoint" [V], but the CLI's changelog says that since 1.0.64 it
also speaks the **Responses API over WebSocket** with BYOK ("Add websocket
responses support for BYOK OpenAI-compatible providers") [V]. The gateway
answers **426** to every WebSocket attempt (that is how Codex falls back to
HTTP), and **we do not know** whether the Copilot CLI does the same: the CLI is
not open source. A wrapper that can break the session is not published without
testing it. By hand, and watching the log:

```bash
bvsala gateway --upstream openai --port 8403
COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:8403/v1 copilot       # WITH /v1
```

- `… → 426 (WebSocket not supported …)` followed by `POST /v1/responses` or
  `POST /v1/chat/completions` lines with a `$` → the CLI fell back to HTTP and it
  is metered.
- Only the 426 and the session fails → it does not work behind the gateway; go
  back to the direct URL.
- `not metered: the request did not ask for usage` → restart the gateway with
  `BVSALA_GATEWAY_USAGE_INJECT=1`.

### What does not go through here

What goes to GitHub even with BYOK (`/delegate`, code search, telemetry without
`COPILOT_OFFLINE=true`) is not inference from your provider [V].

## Copilot in VS Code (BYOK, "Custom Endpoint")

It is neither detected nor wrapped (it is an extension): `bvsala doctor` prints
the recipe.

1. **Manage Language Models** → **Add Models** → **Custom Endpoint**.
2. API type: **Messages** (Anthropic). VS Code opens `chatLanguageModels.json`.
3. In the model, the **full path** in `url`:

   ```json
   "url": "http://127.0.0.1:8402/v1/messages"
   ```

   VS Code uses as is a URL that already carries `/messages`,
   `/chat/completions` or `/responses`; otherwise it appends the path and, if it
   is missing, `/v1` [V]. With the full path there is nothing to guess.
4. `bvsala gateway` running separately.

VS Code's BYOK covers chat and the utility tasks (titles, commit messages) [V];
inline suggestions and embeddings stay on GitHub and are not metered here. The
utility tasks use `chat.utilityModel` and `chat.utilitySmallModel`, not the chat
model: if you want to meter them, point them at a Custom Endpoint model too.

## BYOK note

Your key, your invoice: this is exactly the case the gateway meters. Never route
the OAuth of a Claude Pro/Max subscription through here: Anthropic forbids it in
third-party harnesses.

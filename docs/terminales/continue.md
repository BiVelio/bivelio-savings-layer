# Continue (`cn` CLI and extensions) through the gateway

**Source:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`: code of
`continuedev/continue` (extension v2.1.0, June 2026) and its `cn` docs. Continue
is configured through a **file** (`~/.continue/config.yaml`, the same one for
the CLI and for the VS Code and JetBrains extensions) [V]: there is no wrapper,
`bvsala doctor` prints the block.

## The shape of the URL [V]

Continue's `anthropic` provider has a default `apiBase` of
`https://api.anthropic.com/v1/`, adds the trailing slash if it is missing and
resolves `new URL("messages", apiBase)`. So: **with `/v1`**; it adds the
trailing slash itself.

## `~/.continue/config.yaml`

```yaml
models:
  - name: Claude via bvsala
    provider: anthropic
    model: <Anthropic model id>
    apiKey: <your Anthropic API key>
    apiBase: http://127.0.0.1:8402/v1
```

And `bvsala gateway` running separately. On the CLI, `cn --config <file>` with a
file that carries that `apiBase` works too.

## Checking

```
[gateway] POST /v1/messages  · <model> · $0.001234 (in 120, cache↑0 cache↓0, out 8)
```

- `[gateway] POST /messages → 404` → the `/v1` is missing.
- nothing in the log → the active model is not the one in this block.

## The typical pitfall

- **Gateway off with the config written**: Continue fails with that model until
  you start `bvsala gateway`.
- Autocomplete uses its own model (`roles: [autocomplete]`): if it does not
  point at the gateway, it is not metered.

## BYOK note

**API key only.** Never the OAuth of a Claude Pro/Max subscription.

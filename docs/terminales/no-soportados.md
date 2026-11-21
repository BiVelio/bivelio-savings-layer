# What the gateway does not meter today, and why

**Source:** `docs/investigacion/2026-09-27/agentes-de-codigo.md`. Saying no is
part of the recipe: a terminal pointed at the gateway that cannot be metered
would mean paying for an empty proxy.

> Update 2026-11 (open core): Gemini CLI **is now metered**
> ([gemini.md](gemini.md)) and Cursor **now has a recipe** for its BYOK base URL
> override ([cursor.md](cursor.md)). What is left here are the cases that are
> still not metered.

## Copilot with GitHub's models — does not go through a base URL

Without BYOK, Copilot (CLI and VS Code) uses the models GitHub hosts, which go
to GitHub and not to a base URL of yours. With BYOK it is metered: see
[copilot.md](copilot.md).

## Kilo Gateway — does not go through a base URL of yours

Kilo's default provider is its hosted models; that traffic goes to Kilo. With
the `anthropic` provider and your key it is metered: see [kilo.md](kilo.md).

## Cursor with its own models — does not go through a base URL of yours

With Cursor's models (no BYOK) the requests go to Cursor's servers and do not
reach a gateway on `127.0.0.1`; its usage dashboard is the meter there. With
your own OpenAI-compatible key it is metered: see [cursor.md](cursor.md).

## Local models (Ollama, vLLM, LM Studio) — no list price

They are forwarded and the log says so; there is no list price to meter in
dollars. See [ollama.md](ollama.md).

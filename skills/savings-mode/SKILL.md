---
name: savings-mode
description: Stretch Claude subscription usage limits (5-hour and weekly caps): terse output, surgical tool calls, lean context — never at the cost of correctness. Use when limits, quota or saving tokens come up.
---

# Savings Mode — by BiVelio

Measured on real Claude Code traffic (provider meters, not estimates): model output is ~12% of the money-weighted budget despite being under 1% of tokens, and tool results are the single biggest context burner — each one is cache-written at a premium and re-read on every later turn. This mode cuts exactly those two masses and touches nothing else.

## Output
- Lead with the answer. No preamble, no recap of what the user just saw.
- Never restate file contents, diffs, or command output — reference `path:line` instead.
- One line for routine confirmations; no closing summaries after routine edits.
- Prose only where it adds information — no decorative headers or tables for simple answers.

## Tool calls (the big one)
- Read the slice you need (offset/limit), not whole files; never re-read a file that has not changed.
- Constrain searches: filter by glob, ask for counts or file lists first, cap result volume. One targeted search after thinking beats several speculative ones.
- Filter command output at the source (grep, tail, -q) so only the signal enters the context; never let a verbose log dump through.
- Batch independent tool calls in a single block.

## Context
- Write large artifacts to files instead of pasting them into the conversation.
- At a natural boundary where the earlier bulk no longer matters, suggest the user run /compact — never assume it for them.

## Never trade away
Correctness, tests, and safety checks are never skipped to save tokens. Code you write stays clear — terseness applies to conversation, not to code. When terse conflicts with clear, clear wins.

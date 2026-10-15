# One example per stack: what `bvsala init` gives you

Every file here except this README, `tsconfig.json` and `nextjs/run.ts` is the exact
output of `npx @bivelio/savings-layer@latest init` for a minimal project of that stack.
They are regenerated from the same code the command runs (`pnpm init:ejemplos`), and
the test suite fails if a file here and the command's output ever differ.

| Stack | Files | Run it from this repository |
|---|---|---|
| Next.js (App Router) + Vercel AI SDK | `lib/savings.ts`, `app/api/chat/route.ts`, `app/api/bivelio-check/route.ts` | `pnpm example:nextjs` |
| Express + the SDK on its own | `server.ts`, `bivelio-check.ts` | `pnpm example:express`, then `POST /api/chat` |
| Vercel AI SDK | `savings.ts`, `bivelio-check.ts` | `pnpm example:ai-sdk` |
| Mastra | `savings.ts`, `bivelio-check.ts` | `pnpm example:mastra` |
| LangChain.js | `savings.ts`, `bivelio-check.ts` | `pnpm example:langchain` |
| Anthropic TypeScript SDK | `savings.ts`, `bivelio-check.ts` | `pnpm example:anthropic-sdk` (needs `ANTHROPIC_API_KEY` set; nothing is sent) |
| The SDK with Anthropic, `--compaction on` | `savings.ts` (with `toolOutputCompaction: { profile: "lossless-data" }`), `bivelio-check.ts`, `bivelio-verify-compaction.ts` | `BVSALA_DEV_OPEN=1 tsx examples/stacks/sdk-anthropic-compaction/bivelio-verify-compaction.ts` |
| The SDK with Anthropic, `--compaction measure` | `savings.ts` (unchanged), `bivelio-check.ts`, `measure-tool-outputs.ts`, `bivelio-verify-compaction.ts` | `BVSALA_DEV_OPEN=1 tsx examples/stacks/sdk-anthropic-measure/bivelio-verify-compaction.ts` |

- **`savings.ts` / `lib/savings.ts`** creates the layer once and exports what your code
  uses. The Express example keeps it inline, created at startup.
- **`bivelio-check`** asks a question the layer answers on the machine (2 + 2 * 3). With
  the layer in place the model is not called, so the provider bills nothing, and the
  saving is `estimated`, which is never billed. It prints `ok: …` or `not ok: …` with
  what to fix, and exits 0 or 1. In a project, `init` writes it as `bivelio-check.mjs`
  (run it with `node`); here it is `.ts` so the repository's type check compiles it.
- **`--compaction on|measure`** (opt-in, off by default) is about tool outputs only, and
  only removes the whitespace of those that are strict JSON. `on` is offered only where
  the layer sends the request itself (the SDK with Anthropic, without streaming); for the
  framework adapters and for OpenAI, init says why not and changes nothing. `measure`
  changes nothing sent to the model. `bivelio-verify-compaction` makes one local call to
  a fake model that lives in the file and prints the receipt and the coverage of a
  built-in sample, which is not your traffic.
- **`nextjs/run.ts`** is not generated: it calls the two route handlers the way Next.js
  does (a Web `Request` in, a `Response` out) without starting Next.js.

From this repository the layer runs from source with `BVSALA_DEV_OPEN=1`, which the
`pnpm example:*` scripts set. The published package has no unlicensed mode: in your
project the same files need `BIVELIO_LICENSE_KEY`, and without it the check says so and
points to https://savings.bivelio.com/dashboard/install.

The examples use `gpt-4o-mini` and `claude-haiku-4-5`; put the model you use.

Every LLM cost tool shows a savings number. Few of them show how to check it, and the check is where most claims fall apart: the dashboard shows a large saving and the invoice barely moves. This guide gives a method you can run with any tool, or none: what to log, how to reconcile it with the provider's usage data, how to tell a real saving from an estimate, and how to make sure the saving came from the change you made. At the end you will see how the open-source BV-SALA SDK labels every amount so this check is possible.

## Why savings numbers and bills disagree

The gap almost always comes from one of these:

- **List price versus your price.** Tools price tokens at public list prices. Your invoice can include discounts, committed-use contracts, regional or data-residency rates, priority tiers and taxes.
- **Estimates presented as measurements.** If a tool removed 2,000 tokens from a prompt, the provider never counted them. The "saved" figure is the tool's own count, made with a tokenizer that may not be the provider's.
- **The provider's discount claimed as the tool's.** Prompt caching on OpenAI, Anthropic, DeepSeek or Gemini is billed by the provider at a lower rate. A tool that counts that discount as its own saving inflates its number.
- **Traffic the tool never saw.** Calls from another service, a teammate's script, a coding agent's side requests or a batch job all appear on the bill and not in the tool.
- **Missing usage.** A streamed request without its final usage event has no token counts at all. Silently counting it as zero makes everything after it look cheaper.
- **Time.** Providers bucket usage by UTC day, and some usage appears with a delay.

## The method, step by step

### 1. Log the provider's own counters for every request

Not your estimate: the `usage` block the provider returned. Input, cached input (and cache writes where they exist), output, reasoning tokens, the model id the provider reports, the API key or project, and the UTC timestamp. Mark a request whose usage did not arrive as **unmeasured**, never as zero.

### 2. Reconcile tokens before dollars

Export the provider's daily usage for the same keys and days: OpenAI's [Usage API](https://developers.openai.com/api/reference/resources/organization/subresources/usage), Anthropic's [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api), or the usage pages of the DeepSeek and Model Studio consoles. Then compare bucket by bucket:

```ts
interface Row { day: string; model: string; input: number; cachedInput: number; output: number }

function byDayAndModel(rows: Row[]): Map<string, Row> {
  const totals = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.day}|${r.model}`;
    const t = totals.get(k) ?? { day: r.day, model: r.model, input: 0, cachedInput: 0, output: 0 };
    t.input += r.input;
    t.cachedInput += r.cachedInput;
    t.output += r.output;
    totals.set(k, t);
  }
  return totals;
}

/** Lines where your log and the provider disagree by more than the tolerance. Empty means they agree. */
export function reconcile(mine: Row[], provider: Row[], tolerance = 0.01): string[] {
  const a = byDayAndModel(mine);
  const b = byDayAndModel(provider);
  const gaps: string[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    for (const field of ["input", "cachedInput", "output"] as const) {
      const yours = a.get(k)?.[field] ?? 0;
      const theirs = b.get(k)?.[field] ?? 0;
      const gap = theirs === 0 ? (yours === 0 ? 0 : 1) : Math.abs(yours - theirs) / theirs;
      if (gap > tolerance) gaps.push(`${k} ${field}: yours ${yours}, provider ${theirs}`);
    }
  }
  return gaps;
}
```

If the tokens agree, your logging is complete and you can trust the rest of the analysis. If the provider shows more, find the traffic you are not logging before you go further.

### 3. Then price it, with a dated price table

Multiply each bucket by its rate, keep the date the rates were copied, and compare with the provider's cost report. A steady difference of a few percent is usually a discount or a regional rate, and it is the same with and without your optimisation, so it does not change the saving.

### 4. Keep three kinds of numbers apart

- **Measured:** read from the provider's counter for a call that ran.
- **Measured by reference:** a call that did not happen (a cache hit, a deduplicated request), valued with the provider's counter for the identical call that did run. This is the best evidence available for a call that never happened.
- **Estimated:** anything the provider never counted, like tokens a tool removed from a prompt.

Add each kind up on its own. Never add estimated amounts to measured ones, and never average percentages across requests: sum the money, then divide.

### 5. Separate the provider's discount from yours

Cached input tokens are cheaper because of the provider. If you changed nothing and your hit rate was already high, that discount is not a saving of your project. Price cached tokens at the cached rate on both sides of the comparison; what is left is yours.

## Did the change cause the saving?

A bill that went down after a deploy can also be a quiet week. To attribute a saving:

- **Run two arms at once.** Send the same requests with and without the change, at the same time, through the same key, and compare the provider's counters for both. Requests split randomly between arms are the clean version.
- **Report an interval, not a point.** Resample whole conversations or days, and say "between X and Y %". An interval that crosses zero means you cannot tell the difference from noise, and that is a legitimate result.
- **Check quality in the same run.** A cheaper answer that is wrong is not a saving. Measure accuracy or a task-specific check in both arms.

## How BV-SALA makes this check possible

[BV-SALA](https://github.com/BiVelio/bivelio-savings-layer) is an Apache-2.0 savings layer, free with no key. Every request returns a `SavingsReport` built for exactly this method:

- `cost.basis` is `measured`, `reference`, `estimated` or `unmeasured`, using the definitions above. A repeat is valued by reference only when the call that ran went directly to OpenAI's, Anthropic's or Google's Gemini API; anywhere else it stays `estimated`.
- The saving is kept in four separate ledgers that are never summed into one figure: `avoided_calls`, `eliminated_tokens`, `compressed_tokens` and `provider_cached_tokens`.
- The provider's own cache discount is reported apart, in `report.nativeSavings`, and never counted as the layer's saving.
- A stream that ends without its usage is `unmeasured`, never priced as zero.

Adding the reports up by basis takes a few lines:

```ts
import type { SavingsReport } from "@bivelio/savings-layer";

/** Spend and saving per basis. Never mix bases, never average ratios. */
export function totalsByBasis(reports: SavingsReport[]) {
  const totals: Record<string, { requests: number; spendUsd: number; savedUsd: number }> = {};
  for (const r of reports) {
    const t = (totals[r.cost.basis] ??= { requests: 0, spendUsd: 0, savedUsd: 0 });
    t.requests += 1;
    t.spendUsd += r.cost.actual;
    t.savedUsd += r.cost.netSavingsUsd;
  }
  return totals;
}
```

From Python, the package's client reads the same reports from the local gateway and keeps the same separation:

```python
# pip install bivelio-savings-layer
import bvsala

gw = bvsala.Gateway("http://127.0.0.1:8403")
# ... send requests with gw.wrap(client) and read each one with gw.report(response) ...
t = gw.totals()
print(t.requests, t.metered, t.not_metered, t.actual_cost_usd)
print(t.net_savings_usd_by_basis)  # one amount per basis, never added together
```

Then run step 2 above against these totals: the layer's `measured` spend should match the provider's usage for the same key and day, in tokens exactly and in dollars up to your discounts. The reports price at list price; they are not an invoice.

## The same method, applied in public

The project publishes its own A/B runs on the [benchmarks page](/en/benchmarks): two arms on the same requests, one straight to the provider and one through the layer, both measured with the provider's own usage counter, with 95 % intervals and the date and version of each run. Results that saved nothing, or cost more, are on the same page. The full method, the estimator and its limits are in [the paper](/en/paper).

For the provider-specific details, see [why OpenAI's cached_tokens is 0](/en/guides/openai-prompt-caching-cached-tokens), [why Claude prompt caching is not working](/en/guides/claude-prompt-caching-not-working) and [measuring Claude Code cost per request](/en/guides/claude-code-cost-per-request). The code and the raw reports are on [GitHub](https://github.com/BiVelio/bivelio-savings-layer).

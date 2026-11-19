# Your ledgers in your own tools

Part of the [BV‑SALA README](https://github.com/BiVelio/bivelio-savings-layer#readme). The examples
continue its quickstart: `provider`, `layer` and `createSavingsLayer` come from there.

## Your ledgers in your tracing — OpenTelemetry, Langfuse, Datadog

Wrap the layer once and every request becomes a span on the OpenTelemetry pipeline
you already run (`@opentelemetry/api` is an optional peer; the SDK never imports it):

```ts
import { trace } from "@opentelemetry/api";
import { instrumentSavingsLayer } from "@bivelio/savings-layer";

// One span per request, on the OpenTelemetry pipeline you already run.
const traced = instrumentSavingsLayer(layer, { tracer: trace });
const { report: tracedReport } = await traced.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
console.log(tracedReport.cost.basis); // the span carries the same figures
```

- **Standard spans, plus your ledgers.** Spans follow the
  [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.1/model/gen-ai/registry.yaml)
  as last published (OpenTelemetry semantic conventions v1.41.1): `chat {model}`,
  kind CLIENT, provider, model and usage from your provider's counter (0 on an avoided
  call: no token was billed). On top, `com.bivelio.*` carries the four ledgers, the
  `basis`, the cost and the ids; `com.bivelio.request_id` is the same id as your usage
  record. Same results, same errors: `traced` hands back the very objects `layer` does.
- **Money is kept apart by basis.** The money saved is
  `com.bivelio.cost.saved.measured`, `.reference` or `.estimated` — one key per span,
  the one of its basis — so a sum over one key never mixes measured and estimated
  money; `unmeasured` spans carry counts and no money. `report.cost.netSavingsRatio` is a
  ratio and goes out as `com.bivelio.cost.net_savings_ratio`; the money is
  `baselineEstimate − actual`, and that is what `saved.*` holds.
- **None of this talks to BiVelio.** Spans go to your exporter; files stay where you
  write them. Your prompts, completions and provider keys never reach BiVelio, and no
  span carries them either: ids, counts, money and enums only, and a failed request
  records its `error.type`, never its message.
- **Langfuse.** Add the `LangfuseSpanProcessor` from `@langfuse/otel` to your tracer
  provider. These spans carry `gen_ai.*`, so its default filter exports them
  ([Langfuse OpenTelemetry docs](https://langfuse.com/integrations/native/opentelemetry)).
  `instrumentSavingsLayer(layer, { tracer: trace, langfuse: { metadata: true } })`
  makes the figures filterable metadata, and `langfuse: { cost: true }` hands Langfuse
  the report's own cost (in USD) instead of its estimate. Tracing with `@langfuse/tracing` by
  hand? Pass `toLangfuseGeneration(report)` to `generation.update()`.
- **Datadog LLM Observability** reads these spans over OTLP
  ([Datadog OpenTelemetry docs](https://docs.datadoghq.com/llm_observability/instrumentation/otel_instrumentation/)):

  ```bash
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=<your Datadog site's OTLP traces endpoint>
  OTEL_EXPORTER_OTLP_TRACES_HEADERS=dd-api-key=<your Datadog API key>,dd-otlp-source=llmobs
  ```

  The `com.bivelio.*` attributes arrive as tags; with `datadog: { metadata: true }`
  they also arrive as span metadata. Datadog drops spans that carry no `gen_ai.*`
  attribute, so use `instrumentSavingsLayer` there rather than `recordSavingsOnSpan`
  (which writes `com.bivelio.*` on a span you already have, and no `gen_ai.*` unless
  you ask for it with `genAi: true`).

| Attribute | What it holds |
| --- | --- |
| `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model` | `chat`, the provider and the model (without a known provider prefix) |
| `gen_ai.usage.input_tokens`, `.output_tokens`, `.cache_read.input_tokens` | your provider's counter; absent when it reported no usage |
| `com.bivelio.cost.basis`, `.currency`, `.baseline`, `.actual` | where the money comes from, its currency (USD by default), and both sides |
| `com.bivelio.cost.saved.measured` \| `.reference` \| `.estimated` | the money saved, in the key of its basis only |
| `com.bivelio.cost.net_savings_ratio` | `cost.netSavingsRatio`, a 0..1 ratio — not money |
| `com.bivelio.calls.*`, `com.bivelio.tokens.*` | the four ledgers: avoided calls, eliminated, compressed and provider‑cached tokens |
| `com.bivelio.request_id`, `.model.id`, `.cache.result`, `.quality.status` | ids and outcomes |

## Your ledgers in your FinOps tool — FOCUS rows and a daily savings series

Keep each report with the time it came back, and export whenever you like:

```ts
import { writeFileSync } from "node:fs";
import { toFocusRows, toSavingsSeries, toCsv, type SavingsRecord } from "@bivelio/savings-layer";

const records: SavingsRecord[] = [];
const answer = await layer.generate({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "What is 2 + 2 * 3?" }],
});
records.push({ at: Date.now(), report: answer.report }); // keep reports as they come back

// FOCUS 1.4 rows, one per day, model and basis. Every cost column is 0 by design:
// your provider's bill already has the spend, so these rows add savings, never cost.
const rows = toFocusRows(records, { billingAccountId: "org-XXXXXXXX" }); // your provider billing account id
writeFileSync("bv-sala-focus.csv", toCsv(rows));

// A daily series for tools that take savings as a metric: one file per basis.
const measured = toSavingsSeries(records).filter((r) => r.measuredSavings !== null);
writeFileSync(
  "vantage-measured-savings.csv",
  toCsv(measured.map((r) => ({ date: r.date, amount: r.measuredSavings, model: r.model }))),
);
```

The rows follow [FOCUS 1.4](https://github.com/FinOps-Open-Cost-and-Usage-Spec/FOCUS_Spec/tree/v1.4),
the FinOps Open Cost and Usage Specification: `ChargeCategory` is `Adjustment`, the
service provider is the one in the model id (`OpenAI`, `Anthropic`…; pass
`serviceProviderName`, `invoiceIssuerName` or `hostProviderName` when a cloud or a
gateway bills you), and no SKU or unit price is invented. Nothing is sent anywhere:
`toFocusRows`, `toSavingsSeries` and `toCsv` are plain functions over the reports you
kept. Where each file goes, as each tool documents it in September 2026:

- **A FOCUS data lake or warehouse** reads every column, the `x_BiVelio*` ones included.
- **[Finout](https://docs.finout.io/get-started-with-finout/cost-and-usage-types/focus-in-finout)**
  loads a FOCUS CSV as a custom cost center; you send the file to Finout support.
- **[Vantage](https://docs.vantage.sh/connecting_custom_providers)** Custom Providers
  accept FOCUS 1.1–1.3 files but use only a few columns for cost reporting, and say
  nothing about `x_` columns, so the savings would not show. Upload the series as a
  [Business Metric](https://docs.vantage.sh/per_unit_costs) instead
  (`date,amount,<labels>`), one file per basis, so a metric never mixes bases.
  Vantage rejects two rows with the same date and labels: with `dimensions`, add
  them as label columns too.
- **[CloudZero](https://docs.cloudzero.com/docs/anycost-common-bill-format-cbf)** AnyCost
  takes its own Common Bill Format; the series can go in as a
  [Telemetry Stream](https://docs.cloudzero.com/docs/telemetry-streams).

The custom columns, in the currency you pass (`currency`, USD by default):

| Column | What it holds |
| --- | --- |
| `x_BiVelioBasis`, `x_BiVelioModelId` | the basis of every figure in the row, and the model id |
| `x_BiVelioRequestCount`, `x_BiVelioProviderCallCount`, `x_BiVelioAvoidedCallCount` | requests, calls that reached the provider, calls avoided |
| `x_BiVelioBaselineCost`, `x_BiVelioActualCost` | both sides of the saving; empty when the basis is `unmeasured` |
| `x_BiVelioMeasuredSavings`, `x_BiVelioReferenceSavings`, `x_BiVelioEstimatedSavings` | `baseline − actual`, in the column of the row's basis only; negative when the layer cost you money |
| `x_BiVelioEliminatedInputFloorCost` | the separate floor lane for context your provider cleared |
| `x_BiVelio…InputTokens`, `x_BiVelio…OutputTokens` | the token ledgers: baseline, actual, eliminated, compressed, provider‑cached |

`Tags` carries `bivelio/basis` and `bivelio/model`, plus any tags you return from the
`tags` option. Sum `measured` and `reference` for what you can check against your
provider invoice; `estimated` has its own column on purpose.

/**
 * The savings ledgers on an OpenTelemetry span. Run: pnpm example:otel
 *
 * One span per request, printed by the console exporter: the GenAI semantic
 * conventions plus the `com.bivelio.*` attributes. The second request is
 * identical, so it is served without calling the provider and its span shows
 * zero usage and one avoided call. Nothing is sent anywhere: the console
 * exporter is the only destination.
 */
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { createMockProvider, createSavingsLayer, instrumentSavingsLayer } from "../../src/index.js";

const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});
trace.setGlobalTracerProvider(provider);

console.log("MockProvider: figures are illustrative, not a measurement\n");

const layer = createSavingsLayer({
  provider: createMockProvider({ answer: "Paris is the capital of France." }),
});
const traced = instrumentSavingsLayer(layer, { tracer: trace });

const request = {
  model: "openai/gpt-4o-mini",
  temperature: 0,
  messages: [{ role: "user" as const, content: "What is the capital of France?" }],
};
await traced.generate(request); // one provider call
await traced.generate(request); // the same request again: an avoided call

layer.close();
await provider.shutdown();

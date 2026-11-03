// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { createAgent } from "langchain";
import { savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";

export const savings = savingsAgentMiddleware({
  // OPEN CORE: no license needed — the layer runs with every local saving lever on, zero telemetry.
  // A license key that IS set but invalid still fails closed. For the cloud dashboard,
  // team metering and license auto-renewal, add these lines (all optional):
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  // licenseServerUrl: "https://savings.bivelio.com",
  // serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

// Add `savings` LAST to the middleware of each agent you already have; this one shows where.
export const agent = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [savings] });

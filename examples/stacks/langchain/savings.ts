// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { createAgent } from "langchain";
import { savingsAgentMiddleware } from "@bivelio/savings-layer/langchain";

export const savings = savingsAgentMiddleware({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

// Add `savings` LAST to the middleware of each agent you already have; this one shows where.
export const agent = createAgent({ model: "openai:gpt-4o-mini", tools: [], middleware: [savings] });

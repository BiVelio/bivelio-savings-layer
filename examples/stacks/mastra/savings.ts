// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { Agent } from "@mastra/core/agent";
import { savingsProcessor } from "@bivelio/savings-layer/mastra";

export const bivelio = savingsProcessor({
  // OPEN CORE: no license needed — the layer runs with every local saving lever on, zero telemetry.
  // For the cloud dashboard, team metering and license auto-renewal, add these three lines:
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,
  // licenseServerUrl: "https://savings.bivelio.com",
  // serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

// Add `bivelio` LAST to the inputProcessors of each agent you already have;
// this one shows where. Its reports go to `onReport` if you pass one above.
export const agent = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Answer briefly.",
  model: "openai/gpt-4o-mini",
  inputProcessors: [bivelio],
});

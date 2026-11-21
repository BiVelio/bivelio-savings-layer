// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { Agent } from "@mastra/core/agent";
import { savingsProcessor } from "@bivelio/savings-layer/mastra";

export const bivelio = savingsProcessor({
  // OPEN CORE: no license needed. With no BiVelio keys set, the layer runs free and sends nothing
  // to BiVelio. Savings Cloud (optional): set BIVELIO_LICENSE_KEY and BIVELIO_SERVICE_KEY and usage
  // reaches your dashboard and the license renews itself. A key only adds the cloud, except that with
  // a key trimming of superseded tool results only acts inside a tool loop on Anthropic. A license
  // key that IS set but invalid still fails closed, and with a key the layer
  // needs savings.bivelio.com: 72 hours with no answer from it and every call fails with
  // LicenseError until it answers or you unset the key. With no key there is no such dependency.
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
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

// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import Anthropic from "@anthropic-ai/sdk";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";

export const claudeSavings = anthropicSavings({
  // OPEN CORE: no license needed — the layer runs with every local saving lever on, zero telemetry.
  // For the cloud dashboard, team metering and license auto-renewal, add these three lines:
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,
  // licenseServerUrl: "https://savings.bivelio.com",
  // serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

// Use `client` for messages.create(); `claudeSavings.middleware` goes LAST in the list.
export const client = new Anthropic({ middleware: [claudeSavings.middleware] });

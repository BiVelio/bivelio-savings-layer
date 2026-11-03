// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { AnthropicProvider, createSavingsLayer } from "@bivelio/savings-layer";

// Your provider. LLM traffic goes straight to it: the layer is not a proxy.
export const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  // OPEN CORE: no license needed — the layer runs with every local saving lever on, zero telemetry.
  // For the cloud dashboard, team metering and license auto-renewal, add these three lines:
  // licenseKey: process.env.BIVELIO_LICENSE_KEY,
  // licenseServerUrl: "https://savings.bivelio.com",
  // serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

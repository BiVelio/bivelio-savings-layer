// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { AnthropicProvider, createSavingsLayer } from "@bivelio/savings-layer";

// Your provider. LLM traffic goes straight to it: the layer is not a proxy.
export const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  // OPEN CORE: no license needed. With no BiVelio keys set, the layer runs with every local
  // saving lever on and sends nothing to BiVelio. Savings Cloud (optional): set BIVELIO_SERVICE_KEY
  // (and BIVELIO_LICENSE_KEY) and usage reaches your dashboard and the license renews itself.
  // A license key that IS set but invalid still fails closed.
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
  // Opt-in and lossless: removes only the whitespace between JSON tokens of tool outputs
  // that are strict JSON, in the copy sent to the model (your history is not touched).
  // Every tool output gets an explained decision in report.toolOutputCompaction.
  // Verified for layer.generate() (no streaming). It also runs in generateStream(): pass
  // savings: { toolOutputCompaction: false } on a request to leave it as it is. Delete these lines to revert.
  toolOutputCompaction: { profile: "lossless-data" },
});

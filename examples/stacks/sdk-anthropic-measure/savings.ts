// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { AnthropicProvider, createSavingsLayer } from "@bivelio/savings-layer";

// Your provider. LLM traffic goes straight to it: the layer is not a proxy.
export const layer = createSavingsLayer({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  // OPEN CORE: no license needed. With no BiVelio keys set, the layer runs free and sends nothing
  // to BiVelio. Savings Cloud (optional): set BIVELIO_LICENSE_KEY and BIVELIO_SERVICE_KEY and usage
  // reaches your dashboard and the license renews itself. A key only adds the cloud: the free Measure
  // license applies exactly the same levers as no key (with a paid license, the SDK only trims superseded
  // tool results inside a tool loop on Anthropic). A license key that IS set but invalid still fails
  // closed, and with a key the layer
  // needs savings.bivelio.com: 72 hours with no answer from it and every call fails with
  // LicenseError until it answers or you unset the key. With no key there is no such dependency.
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
});

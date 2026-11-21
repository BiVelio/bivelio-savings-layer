// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import Anthropic from "@anthropic-ai/sdk";
import { anthropicSavings } from "@bivelio/savings-layer/anthropic-sdk";

export const claudeSavings = anthropicSavings({
  // OPEN CORE: no license needed. With no BiVelio keys set, the layer runs free and sends nothing
  // to BiVelio. Savings Cloud (optional): set BIVELIO_LICENSE_KEY and BIVELIO_SERVICE_KEY and usage
  // reaches your dashboard and the license renews itself. A key only adds the cloud: it switches no
  // lever off. A license key that IS set but invalid still fails closed.
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
});

// Use `client` for messages.create(); `claudeSavings.middleware` goes LAST in the list.
export const client = new Anthropic({ middleware: [claudeSavings.middleware] });

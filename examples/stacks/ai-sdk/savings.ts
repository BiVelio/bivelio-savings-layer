// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { savingsMiddleware } from "@bivelio/savings-layer/ai-sdk";

export const savings = savingsMiddleware({
  // OPEN CORE: no license needed. With no BiVelio keys set, the layer runs free and sends nothing
  // to BiVelio. Savings Cloud (optional): set BIVELIO_LICENSE_KEY and BIVELIO_SERVICE_KEY and usage
  // reaches your dashboard and the license renews itself. A key only adds the cloud: it switches no
  // lever off. A license key that IS set but invalid still fails closed.
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
});

// Pass `model` wherever you pass a model today (generateText, streamText…).
// `savings` goes LAST in the middleware list: nothing between it and the model.
export const model = wrapLanguageModel({ model: openai("gpt-4o-mini"), middleware: savings });

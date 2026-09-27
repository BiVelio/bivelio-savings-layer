// BiVelio Savings Layer: created once, when this module loads, and reused by every
// request. The exact cache lives in this instance, so do not create one per request.
import { wrapLanguageModel } from "ai";
import { openai } from "@ai-sdk/openai";
import { savingsMiddleware } from "@bivelio/savings-layer/ai-sdk";

export const savings = savingsMiddleware({
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

// Pass `model` wherever you pass a model today (generateText, streamText…).
// `savings` goes LAST in the middleware list: nothing between it and the model.
export const model = wrapLanguageModel({ model: openai("gpt-4o-mini"), middleware: savings });

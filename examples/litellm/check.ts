// BiVelio Savings Layer in front of a LiteLLM proxy: a wiring check.
//
// It sends the same question twice through your LiteLLM proxy. The first call goes
// through LiteLLM to your provider; the second is an exact repeat that the layer
// answers in this process, so neither LiteLLM nor your provider sees it. It prints
// `ok: …` or `not ok: …` and exits 0 or 1.
//
//   LITELLM_BASE_URL=http://localhost:4000 LITELLM_API_KEY=… BIVELIO_LICENSE_KEY=… node check.mjs
//
// From this repository: LITELLM_BASE_URL=http://127.0.0.1:4000 pnpm example:litellm
// (the layer runs from source with BVSALA_DEV_OPEN=1; the published package needs
// BIVELIO_LICENSE_KEY). The recipe is in ./README.md.
import { createSavingsLayer, OpenAICompatibleProvider } from "@bivelio/savings-layer";

const base = (process.env.LITELLM_BASE_URL ?? "http://localhost:4000").replace(/\/+$/, "");

const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({
    baseUrl: `${base}/v1`, // your LiteLLM proxy, WITH /v1
    apiKey: process.env.LITELLM_API_KEY, // a LiteLLM virtual key (or none, if your proxy has no auth)
    stripProviderPrefix: true, // LiteLLM receives `gpt-4o-mini`, its model_name
  }),
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
});

const request = {
  // The provider's own model id, as LiteLLM's `model_name`: the layer prices it
  // from its catalog. Put the model you route through LiteLLM.
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user" as const, content: "What is the capital of France? Answer in one word." }],
  temperature: 0,
};

try {
  const first = await layer.generate(request);
  const repeat = await layer.generate(request);
  const ok =
    first.report.calls.actualLlm === 1 &&
    repeat.report.calls.avoidedLlm === 1 &&
    repeat.report.cache.result === "exact" &&
    repeat.report.cost.basis === "reference";
  console.log(
    ok
      ? `ok: the first call went through LiteLLM (basis: ${first.report.cost.basis}); the repeat was answered here ` +
          `without calling LiteLLM (basis: reference, valued against request ${repeat.report.cache.reference?.requestId}).`
      : `not ok: first ${first.report.cost.basis} (${first.report.cache.result}), repeat ${repeat.report.cost.basis} ` +
          `(${repeat.report.cache.result}${repeat.report.cache.referenceRejected ? `, ${repeat.report.cache.referenceRejected}` : ""}). ` +
          "A repeat that stays `estimated` with `no-cached-price` means the model id has no list price: see README.md, Model names.",
  );
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.log(`not ok: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  layer.close();
}

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  BV_SALA_VERSION,
  createSavingsLayer,
  GoogleProvider,
  RequestTimeoutError,
} from "@bivelio/savings-layer";

assert.equal(BV_SALA_VERSION, "0.6.0-rc.1");
assert.ok(process.env.BVSALA_DEMO_GOOGLE_API_KEY, "Falta la credencial de Gemini");
assert.ok(process.env.CANARY_LICENSE_A, "Falta la licencia temporal del canario");

let providerCalls = 0;
const provider = new GoogleProvider({
  apiKey: process.env.BVSALA_DEMO_GOOGLE_API_KEY,
  baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  requireUsage: true,
  thinkingConfig: { thinkingBudget: 0 },
  fetchImpl: async (url, init) => {
    providerCalls += 1;
    return fetch(url, init);
  },
});
const layer = createSavingsLayer({
  provider,
  licenseKey: process.env.CANARY_LICENSE_A,
  silenceWarnings: true,
});
const request = {
  model: "google/gemini-3.8-flash",
  messages: [{ role: "user", content: "For this installed-package smoke test, reply with exactly GREEN-742 and nothing else." }],
  context: { tenantId: "npm-rc-smoke", sessionId: "npm-rc-smoke" },
  temperature: 0,
  seed: 17,
  response: { maxOutputTokens: 24 },
  savings: { exactCache: true, semanticCache: false, singleflight: false, compression: false, modelCascade: "off" },
};

try {
  const started = performance.now();
  const real = await layer.generate(request, { requestTimeoutMs: 5_000 });
  const elapsedMs = performance.now() - started;
  assert.ok(real.text.length > 0);
  assert.equal(real.report.calls.actualLlm, 1);
  assert.equal(real.report.cost.basis, "measured");
  assert.equal(providerCalls, 1);
  assert.ok(elapsedMs < 5_000);

  const stream = layer.generateStream(request, { requestTimeoutMs: 5_000 });
  let streamed;
  for await (const event of stream) {
    if (event.type === "done") streamed = event.result;
  }
  assert.ok(streamed);
  assert.equal(streamed.text, real.text);
  assert.equal(streamed.report.cache.result, "exact");
  assert.equal(streamed.report.calls.actualLlm, 0);
  assert.equal(providerCalls, 1);
  console.log(JSON.stringify({ phase: "real-package", version: BV_SALA_VERSION, elapsedMs, providerCalls, streamCache: streamed.report.cache.result }));
} finally {
  await layer.close();
}

let calls = 0;
let incompleteWrites = 0;
const delayed = {
  id: "delayed-smoke",
  async generate() {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { text: "incomplete", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" };
  },
};
const timeoutLayer = createSavingsLayer({
  provider: delayed,
  licenseKey: process.env.CANARY_LICENSE_A,
  silenceWarnings: true,
  exactCache: {
    async get() { return null; },
    async set() { incompleteWrites += 1; },
    async delete() {},
  },
});
try {
  await assert.rejects(
    timeoutLayer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "timeout smoke" }] }, { requestTimeoutMs: 5 }),
    (error) => error instanceof RequestTimeoutError && error.code === "REQUEST_TIMEOUT" && error.requestSent === true,
  );
  assert.equal(calls, 1);
  assert.equal(incompleteWrites, 0);
  console.log(JSON.stringify({ phase: "deadline", code: "REQUEST_TIMEOUT", providerCalls: calls, incompleteWrites }));
} finally {
  await timeoutLayer.close();
}

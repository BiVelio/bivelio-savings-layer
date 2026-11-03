import express from "express";
import { OpenAICompatibleProvider, createSavingsLayer } from "@bivelio/savings-layer";

// Created once, at startup, not inside the handler: the exact cache lives in this instance.
const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
  // OPEN CORE: no license needed — the layer runs with every local saving lever on, zero telemetry.
  // A license key that IS set but invalid still fails closed. For the cloud dashboard,
  // team metering and license auto-renewal, add these lines (all optional):
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  // licenseServerUrl: "https://savings.bivelio.com",
  // serviceAccountKey: process.env.BIVELIO_SERVICE_KEY,
});

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res, next) => {
  try {
    const { text, report } = await layer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: String(req.body?.prompt ?? "") }] });
    const basis = report.cost.basis;
    res.json({ text, basis });
  } catch (err) {
    next(err);
  }
});

app.listen(Number(process.env.PORT ?? 3000));

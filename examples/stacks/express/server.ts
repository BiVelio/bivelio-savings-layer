import express from "express";
import { OpenAICompatibleProvider, createSavingsLayer } from "@bivelio/savings-layer";

// Created once, at startup, not inside the handler: the exact cache lives in this instance.
const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
  // OPEN CORE: no license needed. With no BiVelio keys set, the layer runs with every local
  // saving lever on and sends nothing to BiVelio. Savings Cloud (optional): set BIVELIO_SERVICE_KEY
  // (and BIVELIO_LICENSE_KEY) and usage reaches your dashboard and the license renews itself.
  // A license key that IS set but invalid still fails closed.
  licenseKey: process.env.BIVELIO_LICENSE_KEY || undefined,
  licenseServerUrl: "https://savings.bivelio.com",
  serviceAccountKey: process.env.BIVELIO_SERVICE_KEY || undefined,
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

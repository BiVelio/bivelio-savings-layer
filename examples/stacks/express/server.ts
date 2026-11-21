import express from "express";
import { OpenAICompatibleProvider, createSavingsLayer } from "@bivelio/savings-layer";

// Created once, at startup, not inside the handler: the exact cache lives in this instance.
const layer = createSavingsLayer({
  provider: new OpenAICompatibleProvider({ baseUrl: "https://api.openai.com/v1", apiKey: process.env.OPENAI_API_KEY }),
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

import { generateText } from "ai";
import { getSavingsReport } from "@bivelio/savings-layer/ai-sdk";
import { model } from "../../../lib/savings";

export async function POST(req: Request) {
  const { prompt } = (await req.json()) as { prompt: string };
  const result = await generateText({ model, prompt });
  const text = result.text;
  const basis = getSavingsReport(result)?.cost.basis;
  return Response.json({ text, basis });
}

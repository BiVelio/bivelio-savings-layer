/**
 * The savings ledgers as FinOps files. Run: pnpm example:focus
 *
 * Keeps each SavingsReport with the time it came back, then writes two CSV
 * files to the system temp directory:
 *  - bv-sala-focus.csv: FOCUS 1.4 rows (every cost column is 0 by design);
 *  - vantage-measured-savings.csv: `date,amount,model` for a business metric,
 *    measured savings only, so the metric never mixes bases.
 * Nothing is sent anywhere.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMockProvider,
  createSavingsLayer,
  toCsv,
  toFocusRows,
  toSavingsSeries,
  type SavingsRecord,
} from "../../src/index.js";

console.log("MockProvider: figures are illustrative, not a measurement\n");

const layer = createSavingsLayer({
  provider: createMockProvider({ answer: "Paris is the capital of France." }),
});

const records: SavingsRecord[] = [];
for (const content of [
  "What is the capital of France?",
  "What is the capital of France?", // served again without a provider call
  "Name three rivers in Spain.",
  "What is 2 + 2 * 3?", // computed locally
]) {
  const { report } = await layer.generate({
    model: "openai/gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content }],
  });
  records.push({ at: Date.now(), report });
}
layer.close();

const focusPath = join(tmpdir(), "bv-sala-focus.csv");
writeFileSync(focusPath, toCsv(toFocusRows(records, { billingAccountId: "org-example" })));

const measured = toSavingsSeries(records).filter((r) => r.measuredSavings !== null);
const vantagePath = join(tmpdir(), "vantage-measured-savings.csv");
writeFileSync(
  vantagePath,
  toCsv(
    measured.map((r) => ({ date: r.date, amount: r.measuredSavings, model: r.model })),
    { columns: ["date", "amount", "model"] },
  ),
);

console.log(`FOCUS rows:      ${focusPath}`);
console.log(`Vantage metric:  ${vantagePath}`);

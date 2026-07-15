import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { UsageRecord } from "@bivelio/protocol";
import { createMeteringService } from "./service.js";

/**
 * Thin HTTP adapter over MeteringService. Control-plane component.
 *
 * The SDK (or a control-plane-client) POSTs usage records derived from each
 * SavingsReport via `usageRecordFromReport`. This skeleton stores aggregates in
 * memory; production writes raw records to ClickHouse and rollups to Postgres.
 */
const PORT = Number(process.env.PORT) || 8082;
const INGEST_TOKEN = process.env.INGEST_TOKEN;

const service = createMeteringService();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(req: IncomingMessage): boolean {
  if (!INGEST_TOKEN) return true;
  return req.headers.authorization === `Bearer ${INGEST_TOKEN}`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, records: service.totalRecords() });
    }

    if (req.method === "POST" && url.pathname === "/usage") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = (await readJson(req)) as UsageRecord | UsageRecord[];
      const ingested = service.ingest(body);
      return send(res, 202, { ingested });
    }

    const summaryMatch = url.pathname.match(/^\/usage\/([^/]+)\/summary$/);
    if (req.method === "GET" && summaryMatch) {
      return send(res, 200, service.summary(decodeURIComponent(summaryMatch[1]!)));
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`BV-SALA metering service → http://localhost:${PORT}`);
  if (!INGEST_TOKEN) console.log("WARNING: INGEST_TOKEN not set — /usage ingest is open (dev only).");
});

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMeteringService } from "./service.js";
import { resolveCaller, ingest, summary, loadAuthConfig } from "./gateway.js";

/**
 * Thin HTTP adapter over the metering gateway. Control-plane component.
 *
 * All auth / tenant-derivation / content-validation lives in gateway.ts (and is
 * unit-tested there). This file only speaks sockets. The store is in-memory in
 * this CP-0 skeleton; a serverless/Postgres deployment MUST inject a persistent
 * store (aggregates kept in a Map are lost between cold starts).
 */
const PORT = Number(process.env.PORT) || 8082;
const service = createMeteringService();
const authConfig = loadAuthConfig(process.env);

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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, records: service.totalRecords() });
    }

    const caller = resolveCaller(req.headers.authorization, authConfig);

    if (req.method === "POST" && url.pathname === "/usage") {
      const body = await readJson(req);
      const r = ingest(caller, body, service);
      return send(res, r.status, r.body);
    }

    const summaryMatch = url.pathname.match(/^\/usage\/([^/]+)\/summary$/);
    if (req.method === "GET" && summaryMatch) {
      const r = summary(caller, decodeURIComponent(summaryMatch[1]!), service);
      return send(res, r.status, r.body);
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`BV-SALA metering service → http://localhost:${PORT}`);
  if (authConfig.serviceAccounts.size === 0 && !authConfig.devOpen) {
    console.error(
      "FATAL POSTURE: no service accounts configured and BVSALA_DEV_OPEN is unset — " +
        "all /usage routes will refuse (fail closed). Set BVSALA_SERVICE_ACCOUNTS or INGEST_TOKEN+INGEST_ORG_ID.",
    );
  }
});

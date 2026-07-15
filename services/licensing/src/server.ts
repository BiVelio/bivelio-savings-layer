import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLicensingService, type IssueInput } from "./service.js";

/**
 * Thin HTTP adapter over LicensingService. Control-plane component.
 *
 * Keypair: reads LICENSE_PRIVATE_KEY / LICENSE_PUBLIC_KEY (PEM) from the
 * environment, or generates an ephemeral pair at boot (dev). Issue/revoke are
 * protected by ADMIN_TOKEN when set. In production this sits behind Keycloak
 * and persists to Postgres; this is the runnable CP-0 skeleton.
 */
const PORT = Number(process.env.PORT) || 8081;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const service = createLicensingService(
  process.env.LICENSE_PRIVATE_KEY && process.env.LICENSE_PUBLIC_KEY
    ? { privateKey: process.env.LICENSE_PRIVATE_KEY, publicKey: process.env.LICENSE_PUBLIC_KEY }
    : {},
);

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(req: IncomingMessage): boolean {
  if (!ADMIN_TOKEN) return true; // open in dev when no admin token configured
  return req.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") return send(res, 200, { ok: true, issued: service.issuedCount() });
    if (route === "GET /public-key") return send(res, 200, { publicKey: service.publicKey });

    if (route === "POST /licenses/issue") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const input = (await readJson(req)) as IssueInput;
      if (!input.orgId || !input.plan) return send(res, 400, { error: "orgId and plan are required" });
      const { token, payload } = service.issue({
        orgId: input.orgId,
        plan: input.plan,
        seats: input.seats ?? 1,
        features: input.features ?? [],
        ...(input.termDays != null ? { termDays: input.termDays } : {}),
        ...(input.graceDays != null ? { graceDays: input.graceDays } : {}),
      });
      return send(res, 201, { token, payload });
    }

    if (route === "POST /licenses/validate") {
      const body = (await readJson(req)) as { token?: string };
      if (!body.token) return send(res, 400, { error: "token is required" });
      const resolved = service.validate(body.token);
      return send(res, 200, { status: resolved.status, entitlements: resolved.entitlements, reason: resolved.reason });
    }

    if (route === "POST /licenses/revoke") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = (await readJson(req)) as { jti?: string };
      if (!body.jti) return send(res, 400, { error: "jti is required" });
      service.revoke(body.jti);
      return send(res, 200, { revoked: true, jti: body.jti });
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`BV-SALA licensing service → http://localhost:${PORT}`);
  if (!process.env.LICENSE_PUBLIC_KEY) {
    console.log("Ephemeral signing key generated. SDK verification public key:");
    console.log(service.publicKey);
  }
  if (!ADMIN_TOKEN) console.log("WARNING: ADMIN_TOKEN not set — issue/revoke are open (dev only).");
});

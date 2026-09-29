import { type IncomingMessage, type ServerResponse } from "node:http";
import { type LicensingService, type IssueInput } from "./service.js";
import { authorizeAdmin, type LicensingAuthConfig } from "./gateway.js";

/**
 * Pure HTTP request handler for the licensing control plane, decoupled from the
 * socket. `server.ts` wires this into `http.createServer(...).listen()`; tests
 * drive it against an ephemeral port with no global side effects. Keeping the
 * routing here (and NOT in server.ts, which listens at import) is what makes the
 * routes — including the public revocation call-home + its 304 path — testable.
 */

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

/** Build the request listener for a given service + auth posture. */
export function createRequestHandler(
  service: LicensingService,
  authConfig: LicensingAuthConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const authorized = (req: IncomingMessage): boolean =>
    authorizeAdmin(req.headers.authorization, authConfig);

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /health") return send(res, 200, { ok: true, issued: service.issuedCount() });
      if (route === "GET /public-key") return send(res, 200, { publicKey: service.publicKey });

      // PUBLIC revocation call-home. Integrity comes from the Ed25519 signature on
      // the list body (the client verifies it offline), NOT from auth — so it needs
      // no admin token, and a proxy cannot strip or roll back a revocation. The weak
      // ETag keys off the monotonic revision so unchanged polls short-circuit to 304.
      if (route === "GET /licenses/revocations") {
        const etag = `W/"revoc-${service.revocationRevision()}"`;
        if (req.headers["if-none-match"] === etag) {
          res.writeHead(304, { etag, "cache-control": "public, max-age=30" });
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "public, max-age=30",
          etag,
        });
        res.end(JSON.stringify({ list: service.signedRevocationList() }));
        return;
      }

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

      // «Medir»: la licencia gratuita, sin tarjeta, que solo mide en sombra. Misma
      // autorización de operador que la emisión normal: el alta de autoservicio
      // vive en el panel (apps/web/app/api/license/measure), que es quien sabe
      // si la cuenta está verificada y si ya reclamó su organización.
      if (route === "POST /licenses/issue-measure") {
        if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
        const body = (await readJson(req)) as { orgId?: string };
        if (!body.orgId) return send(res, 400, { error: "orgId is required" });
        const { token, payload } = service.issueMeasure(body.orgId);
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
  };
}

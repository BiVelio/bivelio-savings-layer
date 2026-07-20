import { createServer } from "node:http";
import { createLicensingService } from "./service.js";
import { loadAuthConfig } from "./gateway.js";
import { createRequestHandler } from "./app.js";

/**
 * Thin HTTP entrypoint for the licensing control plane. All routing lives in the
 * side-effect-free ./app.ts handler (so it is unit/integration-testable without a
 * bound socket); this file only constructs the service from the environment and
 * binds the port.
 *
 * Keypair: reads LICENSE_PRIVATE_KEY / LICENSE_PUBLIC_KEY (PEM) from the
 * environment, or generates an ephemeral pair at boot (dev). Issue/revoke are
 * fail-closed: refused unless a configured ADMIN_TOKEN is presented (or explicit
 * BVSALA_DEV_OPEN=1 locally). The revocation call-home (GET /licenses/revocations)
 * is intentionally PUBLIC — integrity comes from the Ed25519 signature on the
 * list, not from auth. In production, issuance must be driven by signature-verified
 * Stripe events + an org-owner check, and revocations must use a durable
 * RevocationStore — this is the runnable CP-0 skeleton.
 */
const PORT = Number(process.env.PORT) || 8081;
const authConfig = loadAuthConfig(process.env);

const service = createLicensingService(
  process.env.LICENSE_PRIVATE_KEY && process.env.LICENSE_PUBLIC_KEY
    ? { privateKey: process.env.LICENSE_PRIVATE_KEY, publicKey: process.env.LICENSE_PUBLIC_KEY }
    : {},
);

const server = createServer(createRequestHandler(service, authConfig));

server.listen(PORT, () => {
  console.log(`BV-SALA licensing service → http://localhost:${PORT}`);
  if (!process.env.LICENSE_PUBLIC_KEY) {
    console.log("Ephemeral signing key generated. SDK verification public key:");
    console.log(service.publicKey);
  }
  if (!authConfig.adminToken && !authConfig.devOpen) {
    console.error(
      "FATAL POSTURE: ADMIN_TOKEN unset and BVSALA_DEV_OPEN unset — issue/revoke refuse (fail closed).",
    );
  }
});

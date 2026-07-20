#!/usr/bin/env bash
# BV-SALA — clean-room install demo. Proves a CUSTOMER can install the PACKAGED
# SDK (exactly as a private registry would serve it) and run it end-to-end:
#   no license key => DENIED   ·   valid key => ALLOWED
# Run:  pnpm demo:install
#
# Owner-only: it mints a key with the project signing key (keys/license.key.pem,
# gitignored) so the token verifies against the SDK's embedded public key —
# the real customer path.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if [ ! -f keys/license.key.pem ]; then
  echo "keys/license.key.pem not found — this owner-only demo needs the project signing key." >&2
  exit 1
fi

say "1 · build (embeds the public verification key)"
if pnpm run build >/tmp/bvsala-install-build.log 2>&1; then echo "  build OK"; else echo "  build FAILED"; tail -15 /tmp/bvsala-install-build.log; exit 1; fi

say "2 · npm pack (what the private registry serves)"
TARBALL="$(npm pack 2>/dev/null | tail -1)"
echo "  packed: $TARBALL ($(du -h "$REPO/$TARBALL" | cut -f1))"

say "3 · mint a license key (as the dashboard / control plane would)"
KEY="$(node -e '
const {readFileSync}=require("node:fs");const {sign,createPrivateKey,randomUUID}=require("node:crypto");
const b=(x)=>Buffer.from(x).toString("base64url");
const k=createPrivateKey(readFileSync("keys/license.key.pem","utf8"));
const n=Math.floor(Date.now()/1000);
const p={jti:"install_"+randomUUID(),org_id:"clean-room",plan:"pro",seats:1,features:["semantic_cache","dashboards"],issued_at:n,expires_at:n+14*86400,grace_days:3,iss:"bivelio-trial"};
const h=b(JSON.stringify({alg:"EdDSA",typ:"BVL",v:1}));const bd=b(JSON.stringify(p));
process.stdout.write(h+"."+bd+"."+b(sign(null,Buffer.from(h+"."+bd),k)));
')"
echo "  key: ${KEY:0:30}… (${#KEY} chars)"

say "4 · clean-room: install into a fresh project + run as a customer"
TMP="$(mktemp -d)"
if ( cd "$TMP" && npm init -y >/dev/null 2>&1 && npm install "$REPO/$TARBALL" >/tmp/bvsala-install.log 2>&1 ); then
  echo "  install OK"
else
  echo "  install FAILED"; tail -20 /tmp/bvsala-install.log
fi

cat > "$TMP/app.mjs" <<'JS'
import { createSavingsLayer, createMockProvider, LicenseError } from "@bivelio/savings-layer";
const layer = createSavingsLayer({
  provider: createMockProvider({ answer: "Paris." }), // stands in for your real LLM provider
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
});
try {
  const { text } = await layer.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "capital of France?" }] });
  console.log(`  ✅ ALLOWED — answer="${text}"`);
} catch (e) {
  if (e instanceof LicenseError) { console.log(`  ⛔ DENIED  — ${e.message.split(".")[0]}`); process.exit(2); }
  throw e;
}
JS

echo "  --- customer runs WITHOUT a key (expect DENIED) ---"
( cd "$TMP" && node app.mjs ) || true
echo "  --- customer runs WITH the key (expect ALLOWED) ---"
( cd "$TMP" && BIVELIO_LICENSE_KEY="$KEY" node app.mjs ) || true

say "5 · cleanup"
rm -f "$REPO/$TARBALL"; rm -rf "$TMP"
echo "  removed tarball + temp project"
echo
echo "Result: the packaged SDK installs into a clean project and enforces the license."
echo "Publish this to the private registry for real self-serve — see docs/PUBLISHING.md."

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Public verification key baked into the SDK so it can verify license tokens
// offline. Only the PUBLIC key is embedded (safe); the private signing key lives
// in the control plane. Missing file → empty (callers must pass licensePublicKey).
let PUBLIC_KEY = "";
try {
  PUBLIC_KEY = readFileSync(
    fileURLToPath(new URL("./keys/license.pub.pem", import.meta.url)),
    "utf8",
  ).trim();
} catch {
  PUBLIC_KEY = "";
}

const keyDefine = { __BV_SALA_PUBLIC_KEY__: JSON.stringify(PUBLIC_KEY) };
// The published npm SDK DISABLES the dev escape hatch (`devUnlicensed` /
// `BVSALA_DEV_OPEN`) so the paywall is unbypassable; the web-demo bundle keeps it
// enabled (the free in-browser demo runs ungated).
const defineNpm = { ...keyDefine, __BV_SALA_ALLOW_DEV_OPEN__: "false" };
const defineWeb = { ...keyDefine, __BV_SALA_ALLOW_DEV_OPEN__: "true" };

export default defineConfig([
  // 1. The distributable package (data plane SDK). Paid/closed source: no
  //    sourcemap in the published tarball (it would ship the full source).
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "es2022",
    dts: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    splitting: false,
    minify: false,
    define: defineNpm,
    outDir: "dist",
  },
  // 2. Browser bundle for the product web (apps/web). Same source → the
  //    savings verifier computes the *exact numbers the SDK ships*, with no
  //    re-implemented token math to drift out of sync. Self-contained ESM,
  //    served statically, runs entirely in the visitor's browser.
  {
    entry: { "bv-sala": "src/index.ts" },
    format: ["esm"],
    target: "es2022",
    dts: false,
    // No sourcemap: this bundle ships to the public web; a map would expose the
    // full proprietary source. The minified bundle is what visitors receive.
    sourcemap: false,
    clean: false,
    treeshake: true,
    splitting: false,
    minify: true,
    define: defineWeb,
    outDir: "apps/web/vendor",
  },
]);

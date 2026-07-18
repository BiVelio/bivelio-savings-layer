import { defineConfig } from "tsup";

export default defineConfig([
  // 1. The distributable package (data plane SDK).
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "es2022",
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    minify: false,
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
    outDir: "apps/web/vendor",
  },
]);

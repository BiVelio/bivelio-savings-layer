import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to their source so tests run without a build.
      "@bivelio/protocol": pkg("./packages/protocol/src/index.ts"),
      "@bivelio/license-client": pkg("./packages/license-client/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.types.ts"],
    },
  },
});

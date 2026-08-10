import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Resolve workspace packages to their source so tests run without a build.
      "@bivelio/protocol": pkg("./packages/protocol/src/index.ts"),
      "@bivelio/license-client": pkg("./packages/license-client/src/index.ts"),
      // El alias `@/` de apps/web. Sin esto no se puede importar una route
      // handler desde un test, que es la razón por la que `app/api/**` llegó a
      // producción con cobertura CERO: las rutas que cobran, emiten licencias y
      // aceptan ingest no tenían ni un test. Va el ÚLTIMO porque vite empareja
      // los alias por prefijo y `@bivelio/...` debe resolverse antes.
      "@/": pkg("./apps/web/"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    // The suite runs "self-managed / dev-open" so pipeline tests that call
    // generate() without a license aren't blocked by fail-closed enforcement.
    // The license-gate test toggles this off to assert real denial.
    env: { BVSALA_DEV_OPEN: "1" },
    include: [
      "test/**/*.test.ts",
      // apps/web NO estaba en ningún glob: el dashboard entero llegó a
      // producción con cobertura cero. Las derivaciones puras viven en
      // dashboard/derive.ts precisamente para poder probarse desde aquí.
      "apps/web/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "services/**/test/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "packages/**/src/**/*.ts"],
      exclude: ["**/index.ts", "**/*.types.ts"],
    },
  },
});

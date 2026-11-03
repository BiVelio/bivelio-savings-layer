import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // JSX con el runtime AUTOMÁTICO, como lo compila Next. Sin esto esbuild emite
  // `React.createElement` y el primer test que renderiza un componente del
  // panel muere con «React is not defined» — hasta el 2026-09-19 no había
  // ninguno, y por eso nadie lo notó.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  resolve: {
    // En ARRAY y con expresiones exactas: los adaptadores importan el núcleo por
    // el nombre del paquete (`@bivelio/savings-layer`) y se importan a sí mismos
    // por su subpath. Como objeto, vite empareja por PREFIJO y el alias del
    // paquete se comería también `@bivelio/savings-layer/ai-sdk`.
    alias: [
      // Resolve workspace packages to their source so tests run without a build.
      { find: "@bivelio/protocol", replacement: pkg("./packages/protocol/src/index.ts") },
      { find: "@bivelio/license-client", replacement: pkg("./packages/license-client/src/index.ts") },
      { find: /^@bivelio\/savings-layer$/, replacement: pkg("./src/index.ts") },
      {
        find: /^@bivelio\/savings-layer\/(ai-sdk|mastra|langchain|anthropic-sdk)$/,
        replacement: pkg("./src/adapters/") + "$1.ts",
      },
      // El alias `@/` de apps/web. Sin esto no se puede importar una route
      // handler desde un test, que es la razón por la que `app/api/**` llegó a
      // producción con cobertura CERO: las rutas que cobran, emiten licencias y
      // aceptan ingest no tenían ni un test. Va el ÚLTIMO porque vite empareja
      // los alias por prefijo y `@bivelio/...` debe resolverse antes.
      { find: "@/", replacement: pkg("./apps/web/") },
    ],
  },
  test: {
    globals: true,
    environment: "node",
    // Los pipelines pesados (colocador, deadlines con timers reales) se pasan
    // de los 5 s por defecto cuando el CI corre toda la suite en paralelo:
    // subir el techo evita los timeouts intermitentes de las Releases.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite runs "self-managed / dev-open" as before: many pipeline tests
    // exercise the dev path explicitly. The OPEN-CORE default (a layer with no
    // licenseKey runs on the Community gate) made the old reason obsolete —
    // without a key nothing is blocked anymore — but dev-open still matters
    // for the tests that assert the explicit dev escape and for benchmarks.
    //
    // What it does NOT cover is unchanged: this variable only opens the door
    // when running FROM SOURCE; in the npm build `__BV_SALA_ALLOW_DEV_OPEN__`
    // compiles to `false` and both the variable and `devUnlicensed` are inert.
    // The published-package contract (community mode, invalid keys still
    // fail-closed) is exercised for real by `test/sala-limpia-del-tarball.test.ts`.
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

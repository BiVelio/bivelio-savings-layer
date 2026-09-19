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
    //
    // OJO CON LO QUE ESTO **NO** CUBRE, que es lo que dejó vivo un fallo desde la
    // publicación. Esta variable solo abre la puerta cuando se corre DESDE EL
    // FUENTE: en el build de npm `__BV_SALA_ALLOW_DEV_OPEN__` se compila a
    // `false` y tanto esta variable como `devUnlicensed` son inertes. O sea que
    // la puerta CERRADA del paquete publicado —la primera superficie que toca
    // TODO cliente— no la ejercita ningún test que importe de `src/`, corra con
    // la puerta abierta o cerrada. Quien la ejercita, ejecutando el tarball de
    // verdad, es `test/sala-limpia-del-tarball.test.ts`; si se toca el mensaje de
    // licencia o los `define` de tsup, ESE es el test que hay que mirar.
    //
    // Medido antes de decidir dejarlo así: cerrar la puerta aquí por defecto
    // tumba 209 tests en 18 ficheros (cada uno tendría que pasar
    // `devUnlicensed: true` a mano), y aun así NO habría cazado aquel fallo —
    // desde el fuente el mensaje siempre fue el correcto. La granularidad buena
    // es la que ya se usa: el fichero que quiere denegación de verdad se quita la
    // variable él mismo (license-gate, paywall-surface).
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

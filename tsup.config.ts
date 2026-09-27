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
const defineNpm = { ...keyDefine, __BV_SALA_ALLOW_DEV_OPEN__: "false", __BV_SALA_DEMO_ONLY__: "false" };
// El bundle web permite correr sin licencia SOLO contra el proveedor de demo
// interno (__BV_SALA_DEMO_ONLY__). La demo del landing usa un MockProvider; quien
// importe este bundle con un proveedor real queda gateado igual que en npm.
const defineWeb = { ...keyDefine, __BV_SALA_ALLOW_DEV_OPEN__: "true", __BV_SALA_DEMO_ONLY__: "true" };

export default defineConfig([
  // 1. The distributable package (data plane SDK). Paid/closed source: no
  //    sourcemap in the published tarball (it would ship the full source).
  {
    // `gateway/bin` es el CLI (`bvsala gateway`, F1 de la pasarela Claude
    // Code): entra en el MISMO bundle de pago, con el mismo minificado y las
    // mismas defines — comparte catálogo de precios y metering con el SDK.
    //
    // LOS ADAPTADORES DE FRAMEWORKS (`@bivelio/savings-layer/ai-sdk`, `/mastra`,
    // `/langchain`, `/anthropic-sdk`) van en esta MISMA configuración para que el
    // `clean` corra una sola vez. Importan el núcleo por el nombre del paquete y
    // ese nombre va en `external`: en el tarball, `dist/adapters/*.js` carga el
    // MISMO `dist/index.js` que el cliente —una sola instancia, sin duplicar— y,
    // sobre todo, solo puede entrar por la API pública (`createSavingsLayer` →
    // `generate()`), que gatea la licencia y registra el uso. Por construcción,
    // un adaptador no tiene cómo saltárselos. En el repo, `paths` (tsconfig) y el
    // alias de vitest resuelven ese nombre al fuente. Los frameworks, también
    // `external`: son peers opcionales del cliente, nunca van dentro.
    entry: {
      index: "src/index.ts",
      "gateway/bin": "gateway/bin.ts",
      "adapters/ai-sdk": "src/adapters/ai-sdk.ts",
      "adapters/mastra": "src/adapters/mastra.ts",
      "adapters/langchain": "src/adapters/langchain.ts",
      "adapters/anthropic-sdk": "src/adapters/anthropic-sdk.ts",
    },
    external: [
      "@bivelio/savings-layer",
      "ai",
      /^@mastra\/core(\/.*)?$/,
      /^langchain(\/.*)?$/,
      /^@langchain\/core(\/.*)?$/,
      /^@anthropic-ai\/sdk(\/.*)?$/,
      /^node:/,
    ],
    format: ["esm"],
    target: "es2022",
    dts: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    splitting: false,
    // MINIFICADO, y estaba al revés: el bundle de la demo web gratuita se
    // minificaba y el paquete DE PAGO se publicaba legible — 174 KB con nombres
    // de función y los comentarios en español que explican qué defiende cada
    // comprobación de licencia. Eso es entregarle el mapa a quien quiera
    // saltarse el pago: le dice dónde mirar y por qué existe cada guardia.
    //
    // Que quede claro lo que esto NO es: minificar no es seguridad. Quien se
    // empeñe seguirá pudiendo parchear el bundle, como en cualquier software que
    // corre en la máquina del cliente. Lo que hace es subir el listón del
    // saltárselo por casualidad y borrar la documentación gratuita del ataque.
    // La defensa de verdad es otra: el valor —recibos reconciliados, registro de
    // precios firmado, panel de ahorro— vive en el control plane, así que quien
    // parchee el cliente se queda con las optimizaciones y pierde la prueba.
    //
    // Los tipos (dts) SIGUEN legibles a propósito: son la API pública y el
    // cliente tiene que poder leerlos.
    //
    // MINIFICADO COMPLETO —nombres mangleados y comentarios fuera, así que el
    // mapa del algoritmo sigue escondido— PERO CON LÍNEAS ACOTADAS. Con
    // `minify: true` a secas el bundle colapsa a UNA línea de 52.564 caracteres,
    // y Node imprime el MARCO DE CÓDIGO del punto del throw: un `LicenseError`
    // sin capturar volcaba 54.652 bytes en la terminal, de los que 53.646 eran
    // bundle antes del mensaje. Y ese error es LA PANTALLA DE BIENVENIDA del
    // producto, porque el SDK es fail-closed: el cliente que acaba de pagar ve
    // 53 KB de ruido y piensa que el paquete ha reventado, no que le falta la
    // licencia. Con `lineLimit`: 1.600 bytes y un marco de 202 caracteres.
    // Cuesta 934 bytes de tarball (+0,55 %), medido.
    //
    // El bundle de la WEB (más abajo) no lo lleva a propósito: en el navegador
    // nadie ve un marco de código, y son 934 bytes servidos a cada visitante.
    minify: true,
    esbuildOptions(options) {
      options.lineLimit = 200;
    },
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
    outDir: "apps/web/public/vendor",
  },
]);

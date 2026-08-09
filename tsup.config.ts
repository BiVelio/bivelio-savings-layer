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
    entry: ["src/index.ts"],
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
    minify: true,
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

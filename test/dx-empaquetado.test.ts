import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

/**
 * LA DX DEL PAQUETE PUBLICADO: lo primero que toca quien instala desde npm, y lo
 * último que mira un test. Dos fallos medidos contra el tarball de la 0.4.3.
 *
 * 1. `require("@bivelio/savings-layer")` desde CommonJS moría con
 *    `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined` — un error que no
 *    menciona ESM, ni Node, ni nada que ayude. `exports["."]` declaraba `import`
 *    pero no `default`, así que la resolución bajo la condición `require` no
 *    encontraba NINGUNA rama. Con `default`, Node ≥22 lo carga de verdad
 *    (require(esm)) y un Node viejo da `ERR_REQUIRE_ESM`, que sí dice qué pasa.
 *
 * 2. Un `LicenseError` sin capturar imprimía 54.652 bytes en la terminal. Node
 *    imprime el MARCO DE CÓDIGO de la línea del throw, y `minify: true` a secas
 *    colapsaba el bundle a UNA línea de 52.564 caracteres: el mensaje de licencia
 *    —el único texto útil— aparecía tras 53,6 KB de bundle. Y ese error es la
 *    pantalla de bienvenida del producto, porque el SDK es fail-closed.
 *
 * Esta verja mira el ARTEFACTO, no el fuente, que es donde vivían los dos.
 */
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("el paquete publicado", () => {
  it("declara `default` en exports, para que require() desde CJS dé un error que se entienda", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, Record<string, string> | undefined>;
    };
    const punto = pkg.exports["."];
    expect(punto, 'falta el subpath "." en exports').toBeDefined();
    expect(
      punto?.default,
      "sin `default`, require() desde CommonJS muere con ERR_PACKAGE_PATH_NOT_EXPORTED",
    ).toBe("./dist/index.js");
    // El ORDEN no es cosmético: Node resuelve la PRIMERA condición que encaja, así
    // que `default` tapa todo lo que vaya detrás y `types` tiene que ir delante o
    // TypeScript resolvería por otra rama.
    const claves = Object.keys(punto ?? {});
    expect(claves[0], "`types` va el PRIMERO").toBe("types");
    expect(claves[claves.length - 1], "`default` va el ÚLTIMO: tapa lo que venga detrás").toBe("default");
  });

  it("no tiene líneas gigantes: un LicenseError no vuelca el bundle en la terminal", () => {
    // Se FALLA si no hay artefacto, no se salta. `ci.yml` corre `build:all` antes
    // que `test`, así que en CI existe siempre: un skip solo puede dispararse en
    // local y convertiría la verja en decorativa. Mismo trato que le da
    // `superficie-publica-limpia.test.ts` al `.d.ts`.
    expect(existsSync(DIST), "no hay dist/index.js — corre `pnpm build` antes").toBe(true);
    const lineas = readFileSync(DIST, "utf8").split("\n");
    const masLarga = Math.max(...lineas.map((l) => l.length));
    // 200 es el `lineLimit` de tsup.config.ts; el margen absorbe un token que no
    // se pueda partir. Sin `lineLimit` esto mide ~52.500 y el test cae.
    expect(masLarga, `la línea más larga mide ${masLarga} caracteres`).toBeLessThan(4_000);
  });

  it("sigue estando minificado: acotar la línea no afloja lo que esconde el bundle", () => {
    const src = readFileSync(DIST, "utf8");
    // Si el minificado se cayera, volverían los comentarios del código fuente.
    expect(src).not.toContain("LA VERJA Y LA TRAZA LEEN DE LA MISMA VARIABLE");
    // 450 KB: el techo vigila que el minificado siga ahí, no el tamaño del
    // producto. Sin minificar (y sin comentarios) el bundle mide ~750 KB; con él,
    // ~409 KB desde el adaptador nativo de Gemini (+11 KB), que dejó el
    // techo anterior (400 KB) sin margen.
    expect(src.length).toBeLessThan(450_000);
  });
});

/**
 * LOS ADAPTADORES DE FRAMEWORKS: cuatro subpaths del MISMO paquete
 * (`@bivelio/savings-layer/ai-sdk`, `/mastra`, `/langchain`, `/anthropic-sdk`).
 *
 * Lo que se vigila es lo que haría daño sin romper nada a la vista: un subpath
 * con las condiciones en otro orden (TypeScript o `require` resolverían por otra
 * rama), un adaptador que empaquetara DENTRO una copia del núcleo (dos cachés,
 * dos medidores, y una puerta de licencia que el adaptador podría esquivar) o que
 * volviera a volcar el bundle en la terminal con una línea gigante.
 */
const ADAPTADORES = ["ai-sdk", "mastra", "langchain", "anthropic-sdk"] as const;

describe("los adaptadores publicados", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, Record<string, string> | string | undefined>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it.each(ADAPTADORES)("./%s: `types` el primero, `default` el último, y los ficheros existen", (a) => {
    const sub = pkg.exports[`./${a}`] as Record<string, string> | undefined;
    expect(sub, `falta el subpath ./${a}`).toBeDefined();
    const claves = Object.keys(sub ?? {});
    expect(claves[0]).toBe("types");
    expect(claves[claves.length - 1]).toBe("default");
    for (const ruta of Object.values(sub ?? {})) {
      expect(existsSync(fileURLToPath(new URL(`../${ruta}`, import.meta.url))), ruta).toBe(true);
    }
  });

  it.each(ADAPTADORES)("dist/adapters/%s.js: minificado, con líneas acotadas, sin el núcleo dentro y pequeño", (a) => {
    const fuente = readFileSync(fileURLToPath(new URL(`../dist/adapters/${a}.js`, import.meta.url)), "utf8");
    const masLarga = Math.max(...fuente.split("\n").map((l) => l.length));
    expect(masLarga).toBeLessThan(4_000);
    // Carga el núcleo por el nombre del paquete: el MISMO dist/index.js del cliente.
    expect(fuente).toContain("'@bivelio/savings-layer'");
    // La clave de la caché exacta solo existe en el núcleo: si aparece aquí, el
    // núcleo se empaquetó dentro del adaptador.
    expect(fuente).not.toContain("bvsala:exact:");
    expect(fuente.length).toBeLessThan(60_000);
    // Minificado: los comentarios en español del fuente no viajan.
    expect(fuente).not.toMatch(/EL PROVEEDOR PUENTE|LA CAPA DE UN ADAPTADOR/);
  });

  it("los frameworks son peers OPCIONALES: quien no los usa no instala nada", () => {
    for (const f of ["ai", "@mastra/core", "langchain", "@langchain/core", "@anthropic-ai/sdk"]) {
      expect(pkg.peerDependenciesMeta?.[f]?.optional, f).toBe(true);
    }
  });
});

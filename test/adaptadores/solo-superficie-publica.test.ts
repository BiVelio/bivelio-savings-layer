import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LOS ADAPTADORES SOLO ENTRAN POR LA PUERTA PÚBLICA (D2).
 *
 * Un adaptador que importara `src/pipeline`, `src/license` o `src/metering`
 * podría llamar al optimizador sin pasar por `assertLicensed()` o sin registrar
 * el uso. Importando solo `@bivelio/savings-layer` —que en el tarball es el MISMO
 * `dist/index.js` del cliente— el único camino hasta el modelo es
 * `createSavingsLayer(...).generate()`, que gatea y registra. Esto lo hace
 * imposible por construcción, y esta verja lo mantiene así.
 *
 * Se permiten, además, módulos internos PUROS de los proveedores (el parser de
 * SSE, la aritmética del contador de Anthropic, la lista de orígenes oficiales y
 * la tabla de parámetros que cada modelo de Claude rechaza), que no deciden nada
 * sobre licencia ni medición: van copiados dentro del adaptador que los usa.
 */

const RAIZ = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTADORES = join(RAIZ, "src/adapters");

function ficheros(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? ficheros(p) : p.endsWith(".ts") ? [p] : [];
  });
}

function importsDe(fuente: string): string[] {
  const salida: string[] = [];
  for (const m of fuente.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;"'`]*?from\s*["']([^"']+)["']/g)) salida.push(m[1]!);
  for (const m of fuente.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) salida.push(m[1]!);
  for (const m of fuente.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) salida.push(m[1]!);
  return salida;
}

const FRAMEWORKS = [/^ai$/, /^@mastra\/core(\/.*)?$/, /^langchain$/, /^@langchain\/core\/[\w/]+$/, /^@anthropic-ai\/sdk$/];
const PERMITIDOS_RELATIVOS = new Set([
  "src/providers/sse.ts",
  "src/providers/anthropic-uso.ts",
  // La suma de las iteraciones de compactación (#333): pura, sin imports, y la
  // usa anthropic-uso.ts para que proveedor y adaptador cuenten igual.
  "src/providers/iteraciones-de-compactacion.ts",
  // Los orígenes oficiales (https, host exacto) y la clave del canal por el que
  // el puente le dice al núcleo a quién habla la llamada del marco (E0-bis de la
  // referencia). Puro y sin imports: la MISMA lista que usan los proveedores.
  "src/providers/origen-oficial.ts",
  // Sin imports: dos tablas y dos expresiones regulares. El adaptador del SDK
  // solo la usa para AVISAR de un cuerpo que el API va a rechazar.
  "src/providers/anthropic-compat.ts",
]);

describe("los adaptadores solo usan la superficie pública", () => {
  it("existe la carpeta y tiene los cuatro adaptadores", () => {
    for (const a of ["ai-sdk", "mastra", "langchain", "anthropic-sdk"]) {
      expect(existsSync(join(ADAPTADORES, `${a}.ts`)), a).toBe(true);
    }
  });

  it("⛔ ningún import fuera de la lista blanca", () => {
    const malos: string[] = [];
    for (const f of ficheros(ADAPTADORES)) {
      for (const spec of importsDe(readFileSync(f, "utf8"))) {
        if (spec === "@bivelio/savings-layer" || spec === "node:async_hooks") continue;
        if (FRAMEWORKS.some((r) => r.test(spec))) continue;
        if (spec.startsWith(".")) {
          const destino = relative(RAIZ, join(f, "..", spec)).replace(/\.js$/, ".ts");
          if (destino.startsWith("src/adapters/")) continue;
          if (PERMITIDOS_RELATIVOS.has(destino)) continue;
          malos.push(`${relative(RAIZ, f)} → ${spec} (${destino})`);
          continue;
        }
        malos.push(`${relative(RAIZ, f)} → ${spec}`);
      }
    }
    expect(malos).toEqual([]);
  });

  it("⛔ los permitidos internos no tiran a su vez de licencia, medición ni pipeline", () => {
    for (const p of PERMITIDOS_RELATIVOS) {
      // Un permitido puede importar a OTRO permitido (anthropic-uso → la suma de
      // la compactación): el cierre sigue sin llegar a licencia, medición ni pipeline.
      const aPermitido = (s: string): boolean =>
        PERMITIDOS_RELATIVOS.has(join(dirname(p), s).replace(/\.js$/, ".ts"));
      const imports = importsDe(readFileSync(join(RAIZ, p), "utf8")).filter(
        (s) => !s.startsWith("./types") && !aPermitido(s),
      );
      expect(imports, p).toEqual([]);
    }
  });

  it("⛔ el artefacto publicado solo importa el paquete, los frameworks y node", () => {
    const dist = join(RAIZ, "dist/adapters");
    expect(existsSync(dist), "falta dist/adapters: corre `pnpm build` antes").toBe(true);
    for (const n of readdirSync(dist).filter((x) => x.endsWith(".js"))) {
      const specs = [...readFileSync(join(dist, n), "utf8").matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      const ajenos = specs.filter(
        (s) => s !== "@bivelio/savings-layer" && !FRAMEWORKS.some((r) => r.test(s)) && !/^(node:)?async_hooks$/.test(s),
      );
      expect(ajenos, n).toEqual([]);
    }
  });
});

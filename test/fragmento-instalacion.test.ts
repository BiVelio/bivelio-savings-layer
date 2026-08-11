import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Los fragmentos que le damos al cliente TIENEN que compilar pegados tal cual.
 *
 * No compilaban. El del paso 4 del panel de instalación —el que convierte a quien
 * acaba de pagar en quien funciona— usaba `yourProvider`, `model`, `messages` y
 * `response`, cuatro identificadores que no existen en ninguna parte; el del
 * README además usaba `schema`. Y en toda la documentación no había UN SOLO
 * ejemplo de proveedor real, con `OpenAICompatibleProvider` exportado y
 * mencionado solo en tests y benchmarks. El cliente pegaba, no compilaba, y ahí
 * se acababa el camino.
 *
 * Este test no LEE los fragmentos: los COMPILA con el tsc del repositorio contra
 * los tipos reales del SDK. Es la única forma de que no vuelvan a derivar, porque
 * derivan en silencio — nada más en la verja mira dentro de una cadena ni dentro
 * de un bloque de markdown.
 */

const RAIZ = new URL("..", import.meta.url).pathname;

/** El fragmento del panel, extraído de la constante `WRAP`. */
function fragmentoDelPanel(): string {
  const src = readFileSync(
    join(RAIZ, "apps/web/app/[locale]/dashboard/components/InstallLicensePanel.tsx"),
    "utf8",
  );
  const m = src.match(/const WRAP = `([\s\S]*?)`;/);
  if (!m?.[1]) throw new Error("no se encontró la constante WRAP en InstallLicensePanel.tsx");
  // Es una plantilla literal: se deshacen los escapes que le pone el fichero.
  return m[1].replace(/\\`/g, "`").replace(/\\\$/g, "$");
}

/**
 * TODOS los bloques ```ts del README, montados como UN programa, que es como los
 * lee quien los pega: el primero monta `provider` y `layer`, y los siguientes los
 * usan. Cada bloque posterior va dentro de su propia función para que dos
 * ejemplos puedan declarar `text` sin chocar entre sí.
 *
 * La primera versión de este test filtraba por `includes("createSavingsLayer")`
 * y por eso compilaba SOLO el primer bloque. Los otros dos no los miraba nadie —
 * y uno de ellos, justo el de las llamadas a herramienta, tenía exactamente el
 * mismo defecto que se estaba arreglando (`{ model, messages, tools }`, tres
 * identificadores inexistentes). Lo cazó una mutación de este mismo test.
 */
function programaDelReadme(): string {
  const src = readFileSync(join(RAIZ, "README.md"), "utf8");
  const bloques = [...src.matchAll(/```ts\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .filter((b): b is string => typeof b === "string");
  if (bloques.length === 0) return "";
  const [primero = "", ...resto] = bloques;
  // Los `import` se IZAN al principio: dentro de una función son un error de
  // sintaxis, y quien pega un bloque con un import lo pone arriba de su fichero,
  // que es exactamente lo que se está modelando.
  const imports: string[] = [];
  const cuerpos = resto.map((b, i) => {
    const sinImports = b
      .split("\n")
      .filter((linea) => {
        if (/^\s*import\s/.test(linea)) {
          imports.push(linea.trim());
          return false;
        }
        return true;
      })
      .join("\n");
    return `async function ejemplo${i}() {\n${sinImports}\n}\nvoid ejemplo${i};`;
  });
  return [...imports, primero, ...cuerpos].join("\n");
}

/**
 * Compila un fragmento contra los tipos del SDK, en `strict`. Se apunta a
 * `src/index.ts` (la misma superficie que se empaqueta) para que el test no
 * dependa de que exista un `dist/` construido ni de la red.
 */
function compila(fragmento: string): { ok: boolean; errores: string } {
  const dir = mkdtempSync(join(tmpdir(), "bvsala-frag-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    // El fragmento importa por el nombre del paquete; se resuelve con `paths`.
    writeFileSync(join(dir, "fragmento.ts"), fragmento);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          // El proyecto temporal vive fuera del repo, así que hay que decirle
          // dónde están los @types o no encuentra ni `process`.
          types: ["node"],
          typeRoots: [join(RAIZ, "node_modules/@types")],
          baseUrl: dir,
          paths: { "@bivelio/savings-layer": [join(RAIZ, "src/index.ts")] },
        },
        include: ["fragmento.ts"],
      }),
    );
    try {
      execFileSync(join(RAIZ, "node_modules/.bin/tsc"), ["-p", dir], {
        cwd: RAIZ,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, errores: "" };
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      return { ok: false, errores: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("los fragmentos que le damos al cliente compilan pegados tal cual", () => {
  it("el del paso 4 del panel de instalación", () => {
    const r = compila(fragmentoDelPanel());
    expect(r.errores).toBe("");
    expect(r.ok).toBe(true);
  }, 60_000);

  it("TODOS los del README, pegados en orden", () => {
    const programa = programaDelReadme();
    // Si el README deja de tener ejemplos, esto también es un fallo: el paso que
    // convierte a quien paga en quien funciona no puede quedarse sin ejemplo.
    expect(programa).toContain("createSavingsLayer");
    const r = compila(programa);
    expect(r.errores).toBe("");
  }, 120_000);

  it("el fragmento nombra un proveedor REAL, no un hueco para el lector", () => {
    // La causa raíz era esta: `provider: yourProvider` es sintácticamente un
    // ejemplo y prácticamente un ejercicio. Sin esta comprobación, alguien podría
    // «arreglar» el fragmento declarando `declare const yourProvider: Provider`
    // y volvería a compilar sin decirle a nadie cómo se construye uno.
    const frag = fragmentoDelPanel();
    expect(frag).toContain("OpenAICompatibleProvider");
    expect(frag).not.toContain("yourProvider");
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { GUIAS_DEL_README } from "./helpers/guias-del-readme.js";

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

/** Los bloques ```ts de un markdown, en orden. */
function bloquesTs(md: string): string[] {
  return [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b): b is string => typeof b === "string");
}

const leerReadme = (): string => readFileSync(join(RAIZ, "README.md"), "utf8");

/**
 * LOS BLOQUES DEL README QUE SE PRESENTAN COMO UN PROGRAMA ENTERO: los que, tras
 * sus comentarios, empiezan por `import`. Quien los pega en un fichero vacío
 * espera que corran tal cual, así que se compilan SOLOS, cada uno en su módulo.
 *
 * Lo cazó la prueba de extremo a extremo del tarball 1.2.4: el primer bloque que
 * ve quien llega a npm («Install anywhere, in 60 seconds») no traía su `import`
 * y decía en un comentario que compilaba «pegado en orden» con el de «Wrap the
 * call». Solo era cierto aquí dentro, porque `programaDelReadme` iza los imports
 * y mete cada bloque posterior en su función, que es algo que nadie hace al
 * pegar: pegado solo daba `ReferenceError`, y pegado en orden `SyntaxError`
 * (`provider` declarado dos veces).
 */
function bloquesQueSeBastan(): string[] {
  return bloquesTs(leerReadme()).filter((b) => {
    const primera = b.split("\n").find((l) => l.trim() !== "" && !/^\s*\/\//.test(l)) ?? "";
    return /^\s*import\s/.test(primera);
  });
}

/**
 * Los `import` de varios bloques, FUSIONADOS por módulo: dos bloques que importan
 * lo mismo (`createSavingsLayer` en el quickstart y en «Wrap the call») no pueden
 * dar dos declaraciones del mismo nombre en el programa que los junta.
 */
function fusionarImports(lineas: readonly string[]): string[] {
  const nombrados = new Map<string, Set<string>>();
  const otros = new Set<string>();
  for (const linea of lineas) {
    const m = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";?$/.exec(linea);
    if (!m) {
      otros.add(linea);
      continue;
    }
    const nombres = nombrados.get(m[3]!) ?? new Set<string>();
    for (const n of m[2]!.split(",").map((x) => x.trim()).filter(Boolean)) nombres.add(m[1] ? `type ${n}` : n);
    nombrados.set(m[3]!, nombres);
  }
  const fusionados = [...nombrados].map(([modulo, nombres]) => {
    // Si un nombre llega como valor y como tipo, basta el valor.
    const lista = [...nombres].filter((n) => !(n.startsWith("type ") && nombres.has(n.slice(5))));
    return `import { ${lista.join(", ")} } from "${modulo}";`;
  });
  return [...fusionados, ...otros];
}

/**
 * TODOS los bloques ```ts del README y de sus guías, montados como UN programa:
 * el primero (el quickstart, que se basta solo) monta `provider` y `layer`, y los
 * bloques que siguen sin montar nada propio —el de streaming, `report.nativeSavings`,
 * los de las guías— los usan. Cada bloque posterior va dentro de su propia función
 * para que dos ejemplos puedan declarar `text` sin chocar entre sí. Esto NO es
 * «pegarlos en orden»: lo que se pega solo lo prueba `bloquesQueSeBastan`.
 *
 * La primera versión de este test filtraba por `includes("createSavingsLayer")`
 * y por eso compilaba SOLO el primer bloque. Los otros dos no los miraba nadie —
 * y uno de ellos, justo el de las llamadas a herramienta, tenía exactamente el
 * mismo defecto que se estaba arreglando (`{ model, messages, tools }`, tres
 * identificadores inexistentes). Lo cazó una mutación de este mismo test.
 *
 * Desde la 1.2.3 los catorce apartados opcionales viven en docs/guias (npm corta
 * el README a 64 KiB): sus bloques siguen el quickstart del README y se compilan
 * aquí detrás de los suyos.
 */
function programaDelReadme(): string {
  const src = [leerReadme(), ...GUIAS_DEL_README.map((g) => readFileSync(join(RAIZ, g), "utf8"))].join("\n");
  const bloques = bloquesTs(src);
  if (bloques.length === 0) return "";
  // Los `import` se IZAN al principio, los del primero también: dentro de una
  // función son un error de sintaxis, y quien pega un bloque con un import lo
  // pone arriba de su fichero.
  const imports: string[] = [];
  const sinImports = (b: string): string =>
    b
      .split("\n")
      .filter((linea) => {
        if (/^\s*import\s/.test(linea)) {
          imports.push(linea.trim());
          return false;
        }
        return true;
      })
      .join("\n");
  const [primero = "", ...resto] = bloques.map(sinImports);
  const cuerpos = resto.map((b, i) => `async function ejemplo${i}() {\n${b}\n}\nvoid ejemplo${i};`);
  return [...fusionarImports(imports), primero, ...cuerpos].join("\n");
}

/**
 * Compila un fragmento contra los tipos del SDK, en `strict`. Se apunta a
 * `src/index.ts` (la misma superficie que se empaqueta) para que el test no
 * dependa de que exista un `dist/` construido ni de la red.
 *
 * El proyecto temporal vive DENTRO de `node_modules/.cache` del repo y no en el
 * tmp del sistema: los bloques de los adaptadores importan su framework (`ai`,
 * `@mastra/core`, `langchain`, `@anthropic-ai/sdk`), y así se resuelven desde
 * las devDependencies exactas del repo, sin red. Los subpaths del paquete
 * (`@bivelio/savings-layer/ai-sdk`…) apuntan a su fuente, como el paquete raíz.
 */
function compila(fragmento: string | Readonly<Record<string, string>>): { ok: boolean; errores: string } {
  // Varios ficheros = varios módulos en UN tsc: cada uno con su propio ámbito,
  // como si cada bloque se pegara solo en su fichero (ver `bloquesQueSeBastan`).
  const ficheros = typeof fragmento === "string" ? { "fragmento.ts": fragmento } : fragmento;
  const cache = join(RAIZ, "node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "bvsala-frag-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    // El fragmento importa por el nombre del paquete; se resuelve con `paths`.
    for (const [nombre, texto] of Object.entries(ficheros)) writeFileSync(join(dir, nombre), texto);
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
          // Un `.mts` pegado es SIEMPRE un módulo: nada de lo que declare un
          // fichero se ve desde otro.
          moduleDetection: "force",
          // El proyecto temporal vive fuera del repo, así que hay que decirle
          // dónde están los @types o no encuentra ni `process`.
          types: ["node"],
          typeRoots: [join(RAIZ, "node_modules/@types")],
          baseUrl: dir,
          // `@opentelemetry/api` es un peer OPCIONAL del SDK (devDependency
          // aquí): el bloque del README de trazas lo importa, como lo haría
          // quien ya tiene OpenTelemetry. El proyecto temporal vive fuera del
          // repo y no ve su node_modules, así que se le dice dónde está. Lo mismo
          // con los subpaths de los adaptadores, que resuelven a su fuente. No
          // afloja nada: se siguen compilando TODOS los bloques, en strict.
          paths: {
            "@bivelio/savings-layer": [join(RAIZ, "src/index.ts")],
            "@bivelio/savings-layer/*": [join(RAIZ, "src/adapters/*.ts")],
            "@opentelemetry/api": [join(RAIZ, "node_modules/@opentelemetry/api")],
          },
        },
        include: Object.keys(ficheros),
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
  it("el del cableado a mano del panel de instalación (antes, el paso 4)", () => {
    const r = compila(fragmentoDelPanel());
    expect(r.errores).toBe("");
    expect(r.ok).toBe(true);
  }, 60_000);

  it("TODOS los del README y sus guías compilan detrás del quickstart (los que no montan nada usan su `layer`)", () => {
    const programa = programaDelReadme();
    // Si el README deja de tener ejemplos, esto también es un fallo: el paso que
    // convierte a quien paga en quien funciona no puede quedarse sin ejemplo.
    expect(programa).toContain("createSavingsLayer");
    const r = compila(programa);
    expect(r.errores).toBe("");
  }, 120_000);

  it("el PRIMER bloque del README se basta solo, y ninguno dice que se compila «pegado en orden»", () => {
    const [primero = ""] = bloquesTs(leerReadme());
    expect(bloquesQueSeBastan(), "el quickstart tiene que traer su import").toContain(primero);
    expect(primero).toMatch(/^import \{[^}]*\bcreateSavingsLayer\b[^}]*\} from "@bivelio\/savings-layer";$/m);
    // El comentario que mandaba a pegarlo detrás de otro bloque no vuelve.
    expect(leerReadme()).not.toMatch(/as if you pasted them in order|compiles\s+together with it/);
  });

  it("cada bloque del README que empieza por `import` compila SOLO, en su propio fichero", () => {
    const solos = bloquesQueSeBastan();
    // El quickstart, «Wrap the call» y los cuatro adaptadores.
    expect(solos.length).toBeGreaterThanOrEqual(6);
    const ficheros = Object.fromEntries(solos.map((b, i) => [`bloque-${i}.ts`, b]));
    const r = compila(ficheros);
    expect(r.errores).toBe("");
    expect(r.ok).toBe(true);
  }, 120_000);

  it("cada bloque del README que solo importa el núcleo CORRE solo: sin red, y cuenta 8 en la máquina", async () => {
    // Los de los adaptadores llaman a su framework y a la red; estos dos (el
    // quickstart y «Wrap the call») se contestan en local y se pueden ejecutar.
    const nucleo = bloquesQueSeBastan().filter((b) =>
      b
        .split("\n")
        .filter((l) => /^\s*import\s/.test(l))
        .every((l) => /from "@bivelio\/savings-layer";$/.test(l.trim())),
    );
    expect(nucleo.length).toBeGreaterThanOrEqual(2);
    expect(nucleo).toContain(bloquesTs(leerReadme())[0]);
    // FUERA de node_modules, para que vitest lo transforme y resuelva el nombre
    // del paquete con su alias (a src/index.ts), como el resto de la suite.
    const dir = mkdtempSync(join(tmpdir(), "bvsala-bloque-"));
    const red = vi.fn(async () => {
      throw new Error("un bloque del README intentó salir a la red");
    });
    vi.stubGlobal("fetch", red);
    // Como quien lo pega: sin la puerta de desarrollo que abre la suite.
    const devOpen = process.env.BVSALA_DEV_OPEN;
    delete process.env.BVSALA_DEV_OPEN;
    try {
      for (const [i, bloque] of nucleo.entries()) {
        const fichero = join(dir, `bloque-${i}.ts`);
        writeFileSync(fichero, bloque);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        try {
          await import(/* @vite-ignore */ pathToFileURL(fichero).href);
          const impreso = log.mock.calls.map((c) => c[0]);
          expect(impreso[0], `bloque ${i}: text`).toBe("8");
          expect(impreso[1], `bloque ${i}: avoidedLlm`).toBe(1);
          expect(impreso.at(-1), `bloque ${i}: basis`).toBe("estimated");
        } finally {
          log.mockRestore();
        }
      }
      expect(red).not.toHaveBeenCalled();
    } finally {
      if (devOpen !== undefined) process.env.BVSALA_DEV_OPEN = devOpen;
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("el comentario de `report.cost.basis` lista TODOS los basis que `generate()` puede devolver", () => {
    // Lo cazó #317: el SDK ganó basis "reference" y el fragmento que copia quien
    // acaba de pagar seguía diciendo `"measured" | "estimated" | "unmeasured"`.
    // Compilar no lo ve (es un comentario), así que se lee la unión del SDK.
    const fuente = readFileSync(join(RAIZ, "src/tokenizer/accounting.ts"), "utf8");
    const m = fuente.match(/export type CostBasis = ([^;]+);/);
    expect(m, "la unión CostBasis tiene que estar en src/tokenizer/accounting.ts").not.toBeNull();
    // "shadow" no sale nunca de generate(): es el carril hipotético del gateway
    // (registro con sufijo :shadow), no el basis de un informe del SDK.
    const basis = [...m![1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]!).filter((b) => b !== "shadow");
    expect(basis).toContain("reference");
    const linea = fragmentoDelPanel()
      .split("\n")
      .find((l) => l.includes("report.cost.basis"));
    expect(linea, "el fragmento tiene que enseñar report.cost.basis").toBeDefined();
    for (const b of basis) expect(linea, b).toContain(`"${b}"`);
  });

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

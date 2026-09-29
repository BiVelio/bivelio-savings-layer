import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * LA API PÚBLICA NO SE MUEVE SIN QUE NADIE SE DÉ CUENTA HASTA LA 0.5.
 *
 * Decisión del dueño (2026-09-29): «la 0.5 congela la API y publica una guía de
 * migración 0.4 → 0.5; se permiten cambios rompientes, documentados en un
 * sitio». Para congelar algo primero hay que saber qué es. `dist/index.d.ts`
 * exporta ~300 nombres y nadie los había contado: utilidades internas, la
 * maquinaria de la licencia y nombres en español se habían ido colando por los
 * `export *` de los barriles sin que ningún test lo notara.
 *
 * El inventario (`docs/INVENTARIO-API-0.5.json`) lista cada export de cada
 * entrada del paquete y cada campo de las interfaces que el cliente escribe o
 * lee, con su veredicto para la 0.5 (estable | renombrar | quitar |
 * cambiar-default). Este test compara el `.d.ts` construido con él:
 *
 *   · un export o un campo NUEVO que no figure → falla. Añádelo al inventario
 *     con su veredicto (y, si no es `estable`, a docs/MIGRAR-A-0.5.md). Si llegó
 *     por un `export *` sin querer, lo que hay que hacer es quitar el export.
 *   · uno que DESAPARECE → falla. Quitar algo público es un cambio rompiente:
 *     va en la 0.5 y en la guía, no en una 0.4.x.
 *   · un cambio de tipo a valor (o al revés) → falla.
 *
 * `pendientes` son los nombres que traen PR abiertos: pueden estar o no. Al
 * fusionarse, se mueven a `exports`/`miembros` (los de #410, #412, #416, #417 y
 * #419 se movieron en la 0.4.34; hoy está vacío).
 */

type Veredicto = "estable" | "renombrar" | "quitar" | "cambiar-default";
interface Entrada {
  tipo: "tipo" | "valor";
  veredicto: Veredicto;
  a?: string;
  porque?: string;
}
type Miembro = "estable" | { veredicto: Veredicto; a?: string; porque: string };
interface Inventario {
  version: string;
  exports: Record<string, Record<string, Entrada>>;
  miembros: Record<string, Miembro>;
  pendientes: Record<string, { pr: string; veredicto: Veredicto; porque?: string }>;
}

const raiz = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const inv = JSON.parse(readFileSync(raiz("docs/INVENTARIO-API-0.5.json"), "utf8")) as Inventario;
const guia = readFileSync(raiz("docs/MIGRAR-A-0.5.md"), "utf8");

const ENTRADAS: Record<string, string> = {
  ".": "dist/index.d.ts",
  "./ai-sdk": "dist/adapters/ai-sdk.d.ts",
  "./mastra": "dist/adapters/mastra.d.ts",
  "./langchain": "dist/adapters/langchain.d.ts",
  "./anthropic-sdk": "dist/adapters/anthropic-sdk.d.ts",
};

// Las interfaces vigiladas salen del propio inventario: vigilar una más es
// añadir sus campos allí.
const vigiladas = new Set(
  [...Object.keys(inv.miembros), ...Object.keys(inv.pendientes).filter((k) => k.startsWith("M "))]
    .map((k) => k.replace(/^M /, "").split(".")[0]!),
);

/** Lo que el `.d.ts` construido expone: `E <entrada> <nombre> <tipo|valor>` y `M <Interfaz.campo[.sub]>`. */
function superficie(): Set<string> {
  const out = new Set<string>();
  for (const [entrada, fichero] of Object.entries(ENTRADAS)) {
    const ruta = raiz(fichero);
    expect(existsSync(ruta), `falta ${fichero}: ejecuta \`pnpm build\` antes de los tests`).toBe(true);
    const sf = ts.createSourceFile(fichero, readFileSync(ruta, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          out.add(`E ${entrada} ${el.name.text} ${st.isTypeOnly || el.isTypeOnly ? "tipo" : "valor"}`);
        }
      }
      // tsup emite TODO por la lista final de `export { … }`; un `export`
      // suelto en una declaración sería una forma nueva de colarse.
      const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        const nombre = (st as { name?: ts.Identifier }).name?.text ?? "?";
        out.add(`E ${entrada} ${nombre} export-suelto`);
      }
      if (entrada === "." && ts.isInterfaceDeclaration(st) && vigiladas.has(st.name.text)) {
        for (const m of st.members) {
          if (!m.name) continue;
          const n = `${st.name.text}.${m.name.getText(sf)}`;
          out.add(`M ${n}`);
          const t = (m as { type?: ts.TypeNode }).type;
          if (t && ts.isTypeLiteralNode(t)) {
            for (const s of t.members) if (s.name) out.add(`M ${n}.${s.name.getText(sf)}`);
          }
        }
      }
    }
  }
  return out;
}

const esperado = new Set<string>([
  ...Object.entries(inv.exports).flatMap(([entrada, nombres]) =>
    Object.entries(nombres).map(([n, e]) => `E ${entrada} ${n} ${e.tipo}`),
  ),
  ...Object.keys(inv.miembros).map((m) => `M ${m}`),
]);
const pendientes = new Set(Object.keys(inv.pendientes));

describe("la API pública, congelada hasta la 0.5", () => {
  const real = superficie();

  it("nada nuevo en la superficie sin figurar en el inventario", () => {
    const nuevos = [...real].filter((x) => !esperado.has(x) && !pendientes.has(x));
    expect(
      nuevos,
      "export o campo público nuevo: añádelo a docs/INVENTARIO-API-0.5.json con su veredicto " +
        "(o, si se coló por un `export *`, quita el export)",
    ).toEqual([]);
  });

  it("nada del inventario desaparece (quitar algo público es rompiente: va en la 0.5)", () => {
    const idos = [...esperado].filter((x) => !real.has(x));
    expect(idos, "desaparecido de dist o con otro tipo (tipo ↔ valor)").toEqual([]);
  });

  it("cada veredicto es válido y lo que no es estable dice por qué", () => {
    const validos = new Set(["estable", "renombrar", "quitar", "cambiar-default"]);
    const malos: string[] = [];
    const revisar = (clave: string, v: Veredicto, a?: string, porque?: string) => {
      if (!validos.has(v)) malos.push(`${clave}: veredicto «${v}»`);
      if (v !== "estable" && !porque?.trim()) malos.push(`${clave}: sin «porque»`);
      if (v === "renombrar" && !a) malos.push(`${clave}: renombrar sin «a»`);
    };
    for (const [e, nombres] of Object.entries(inv.exports)) {
      for (const [n, x] of Object.entries(nombres)) revisar(`${e} ${n}`, x.veredicto, x.a, x.porque);
    }
    for (const [n, x] of Object.entries(inv.miembros)) {
      if (x !== "estable") revisar(n, x.veredicto, x.a, x.porque);
    }
    for (const [n, x] of Object.entries(inv.pendientes)) revisar(n, x.veredicto, undefined, x.porque ?? "-");
    expect(malos).toEqual([]);
  });

  it("todo cambio rompiente previsto está en la guía de migración (un solo sitio)", () => {
    const faltan: string[] = [];
    const exigir = (nombre: string) => {
      if (!guia.includes(nombre)) faltan.push(nombre);
    };
    for (const nombres of Object.values(inv.exports)) {
      for (const [n, x] of Object.entries(nombres)) {
        if (x.veredicto === "estable") continue;
        exigir(n);
        if (x.a) exigir(x.a);
      }
    }
    for (const [n, x] of Object.entries(inv.miembros)) {
      if (x === "estable") continue;
      exigir(n.split(".").pop()!);
      if (x.a) exigir(x.a);
    }
    expect(faltan, "docs/MIGRAR-A-0.5.md no menciona estos nombres").toEqual([]);
  });

  it("la versión del inventario es la 0.4.x publicada (se rehace al congelar la 0.5)", () => {
    const pkg = JSON.parse(readFileSync(raiz("package.json"), "utf8")) as { version: string };
    expect(pkg.version.startsWith("0.4.")).toBe(true);
    expect(inv.version.startsWith("0.4.")).toBe(true);
  });
});

/**
 * LA 0.4.34 AVISA DE TODO LO QUE LA 0.5 QUITA (criterio 6 de docs/CAMINO-A-0.5.md).
 *
 * Que la guía lo diga no basta: nadie la lee antes de actualizar. Lo que sí se
 * ve es el tachado del IDE y el aviso de `tsc`/eslint, y eso sale del
 * `@deprecated` del `.d.ts` publicado. Cada export «quitar» o «renombrar» del
 * inventario, y cada campo con esos veredictos, tiene que llevarlo en la
 * declaración que el `.d.ts` exporta (no en la del código fuente: tsup puede
 * renombrarla `X$1` y exportar un alias).
 */
describe("todo lo que la 0.5 quita o renombra llega marcado @deprecated al .d.ts", () => {
  const deprecada = (n: ts.Node) =>
    ts.getJSDocTags(n).some((t) => t.tagName.text === "deprecated");

  /** Declaraciones de primer nivel por nombre local, y el alias con que cada entrada las exporta. */
  function leer(fichero: string) {
    const sf = ts.createSourceFile(fichero, readFileSync(raiz(fichero), "utf8"), ts.ScriptTarget.Latest, true);
    const decl = new Map<string, ts.Node[]>();
    const exportado = new Map<string, string>();
    const poner = (nombre: string, n: ts.Node) => decl.set(nombre, [...(decl.get(nombre) ?? []), n]);
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) poner(d.name.text, st);
      } else if (
        (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name
      ) {
        poner(st.name.text, st);
      } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) exportado.set(el.name.text, (el.propertyName ?? el.name).text);
      }
    }
    return { sf, decl, exportado };
  }

  it("cada export «quitar» o «renombrar»", () => {
    const sinMarca: string[] = [];
    for (const [entrada, nombres] of Object.entries(inv.exports)) {
      const { decl, exportado } = leer(ENTRADAS[entrada]!);
      for (const [n, x] of Object.entries(nombres)) {
        if (x.veredicto !== "quitar" && x.veredicto !== "renombrar") continue;
        const nodos = decl.get(exportado.get(n) ?? n) ?? [];
        // Todas: una sobrecarga o la mitad «tipo» de una clase sin marca
        // bastan para que el IDE no tache el uso.
        if (nodos.length === 0 || !nodos.every(deprecada)) sinMarca.push(`${entrada} ${n}`);
      }
    }
    expect(sinMarca, "añade `@deprecated <motivo>. <alternativa>` a su declaración pública").toEqual([]);
  });

  it("cada campo «quitar» o «renombrar»", () => {
    const { sf, decl } = leer(ENTRADAS["."]!);
    const sinMarca: string[] = [];
    for (const [ruta, x] of Object.entries(inv.miembros)) {
      if (x === "estable" || (x.veredicto !== "quitar" && x.veredicto !== "renombrar")) continue;
      const [interfaz, ...campos] = ruta.split(".");
      let miembros: readonly ts.TypeElement[] = (decl.get(interfaz!) ?? [])
        .filter(ts.isInterfaceDeclaration)
        .flatMap((i) => [...i.members]);
      let hallado: ts.TypeElement | undefined;
      for (const c of campos) {
        hallado = miembros.find((m) => m.name?.getText(sf) === c);
        const tipo: ts.TypeNode | undefined = (hallado as { type?: ts.TypeNode } | undefined)?.type;
        miembros = tipo && ts.isTypeLiteralNode(tipo) ? [...tipo.members] : [];
      }
      if (!hallado || !deprecada(hallado)) sinMarca.push(ruta);
    }
    expect(sinMarca, "añade `@deprecated` al campo en su interfaz").toEqual([]);
  });
});

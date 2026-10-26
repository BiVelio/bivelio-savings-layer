import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * LA API PÚBLICA DESDE LA 0.5 ES COMPATIBLE POR ADICIÓN.
 *
 * Decisión del dueño (2026-09-29): «la 0.5 congela la API y publica una guía de
 * migración 0.4 → 0.5; se permiten cambios rompientes, documentados en un
 * sitio». La 0.4.34 los anunció con `@deprecated` y avisos; la 0.5 los aplica y
 * congela lo que queda.
 *
 * El inventario (`docs/INVENTARIO-API-0.5.json`, `version` 0.5.0) lista cada
 * export de cada entrada del paquete y cada campo de las interfaces que el
 * cliente escribe o lee, y TODO es `estable`. Este test compara el `.d.ts`
 * construido con él y falla si:
 *
 *   · aparece un export o un campo que no figura (con la raíz cerrada nombre a
 *     nombre en src/index.ts, eso solo pasa si alguien lo añade a propósito:
 *     entonces va al inventario, y si rompe algo, en una versión mayor);
 *   · desaparece uno del inventario, o cambia de tipo a valor (o al revés);
 *   · un veredicto no es `estable`, o hay `pendientes`;
 *   · reaparece algo de `retirados` (lo que la 0.5 quitó o renombró), o la guía
 *     de migración deja de nombrarlo;
 *   · la raíz vuelve a tener un `export *`, o el `.d.ts` publica un
 *     `@deprecated` (en una API congelada nada va «de salida» sin decidirlo).
 */

type Veredicto = "estable" | "renombrar" | "quitar" | "cambiar-default";
interface Entrada {
  tipo: "tipo" | "valor";
  veredicto: Veredicto;
  a?: string;
  porque?: string;
}
type Miembro = "estable" | { veredicto: Veredicto; a?: string; porque?: string };
interface Retirado {
  entrada?: string;
  tipo?: "tipo" | "valor";
  veredicto: "renombrar" | "quitar";
  a?: string;
}
interface Inventario {
  version: string;
  exports: Record<string, Record<string, Entrada>>;
  miembros: Record<string, Miembro>;
  retirados: { exports: Record<string, Retirado>; miembros: Record<string, Retirado> };
  pendientes: Record<string, unknown>;
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
const vigiladas = new Set(Object.keys(inv.miembros).map((k) => k.split(".")[0]!));

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

describe("la API pública de la 0.5, congelada", () => {
  const real = superficie();

  it("nada en la superficie que no figure en el inventario", () => {
    const nuevos = [...real].filter((x) => !esperado.has(x));
    expect(
      nuevos,
      "export o campo público fuera del inventario: la API de la 0.5 está congelada. Si es a propósito, " +
        "añádelo a docs/INVENTARIO-API-0.5.json (y a la lista cerrada de src/index.ts); si se coló, quítalo",
    ).toEqual([]);
  });

  it("nada del inventario desaparece ni cambia de tipo a valor", () => {
    const idos = [...esperado].filter((x) => !real.has(x));
    expect(idos, "desaparecido de dist o con otro tipo (tipo ↔ valor): eso es una versión mayor").toEqual([]);
  });

  it("todo es estable y no quedan pendientes", () => {
    const noEstables = [
      ...Object.entries(inv.exports).flatMap(([e, ns]) =>
        Object.entries(ns).filter(([, x]) => x.veredicto !== "estable").map(([n]) => `${e} ${n}`),
      ),
      ...Object.entries(inv.miembros).filter(([, x]) => x !== "estable").map(([n]) => n),
    ];
    expect(noEstables, "en la 0.5 no queda ningún veredicto por aplicar").toEqual([]);
    expect(Object.keys(inv.pendientes)).toEqual([]);
  });

  it("lo retirado en la 0.5 no reaparece en dist", () => {
    const vuelven = [
      ...Object.entries(inv.retirados.exports)
        .filter(([n, r]) => real.has(`E ${r.entrada ?? "."} ${n} tipo`) || real.has(`E ${r.entrada ?? "."} ${n} valor`))
        .map(([n]) => n),
      ...Object.keys(inv.retirados.miembros).filter((m) => real.has(`M ${m}`)),
    ];
    expect(vuelven).toEqual([]);
    // Y los nombres nuevos de lo renombrado SÍ están.
    const renombrados = Object.values(inv.retirados.exports).filter((r) => r.veredicto === "renombrar");
    for (const r of renombrados) expect(inv.exports[r.entrada ?? "."]?.[r.a!], r.a).toBeDefined();
    for (const r of Object.values(inv.retirados.miembros).filter((r) => r.veredicto === "renombrar")) {
      expect(Object.keys(inv.miembros).some((m) => m.endsWith(`.${r.a}`)), r.a).toBe(true);
    }
  });

  it("todo lo retirado está en la guía de migración (un solo sitio), con su sustituto", () => {
    const faltan: string[] = [];
    const exigir = (nombre: string) => {
      if (!guia.includes(nombre)) faltan.push(nombre);
    };
    for (const [n, r] of Object.entries(inv.retirados.exports)) {
      exigir(n);
      if (r.a) exigir(r.a);
    }
    for (const [n, r] of Object.entries(inv.retirados.miembros)) {
      exigir(n.split(".").pop()!);
      if (r.a) exigir(r.a);
    }
    expect(faltan, "docs/MIGRAR-A-0.5.md no menciona estos nombres").toEqual([]);
    expect(guia, "la guía es la final de la 0.5, no un borrador").not.toMatch(/\bproposed\b|\bdraft\b/i);
  });

  it("el inventario es el de la 0.5.0 y el paquete no es anterior a él", () => {
    const pkg = JSON.parse(readFileSync(raiz("package.json"), "utf8")) as { version: string };
    expect(inv.version).toBe("0.5.0");
    // La baseline sigue siendo 0.5; una minor posterior solo puede añadir APIs.
    expect(/^0\.(4|5|6)\./.test(pkg.version), pkg.version).toBe(true);
  });

  it("la raíz es una lista cerrada: ni un `export *` en src/index.ts", () => {
    const indice = readFileSync(raiz("src/index.ts"), "utf8");
    expect(indice).not.toMatch(/^\s*export\s*\*/m);
    expect(existsSync(raiz("src/deprecaciones-0.5.ts")), "src/deprecaciones-0.5.ts era de la 0.4.34").toBe(false);
  });

  it("el .d.ts publicado no marca nada @deprecated", () => {
    const marcados: string[] = [];
    for (const fichero of Object.values(ENTRADAS)) {
      const texto = readFileSync(raiz(fichero), "utf8");
      const n = texto.match(/@deprecated/g)?.length ?? 0;
      if (n > 0) marcados.push(`${fichero}: ${n}`);
    }
    expect(marcados, "una API congelada no publica nada «de salida»: quítalo o decídelo para la próxima mayor").toEqual([]);
  });
});

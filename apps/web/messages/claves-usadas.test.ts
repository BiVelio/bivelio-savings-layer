import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Toda clave que el CÓDIGO pide tiene que existir en los mensajes.
 *
 * `parity.test.ts` compara los idiomas ENTRE SÍ, y por eso no puede ver este
 * fallo: si el código pide una clave que NINGÚN idioma tiene, los doce están
 * perfectamente en paridad y el test pasa. El error aparece en tiempo de
 * ejecución, al renderizar, y `next build` lo convierte en un fallo de
 * prerenderizado que tumba la página entera:
 *
 *     Error: MISSING_MESSAGE: landing.hero.proofTitle (ca)
 *     Export encountered an error on /[locale]/page: /ca, exiting the build.
 *
 * Pasó de verdad: los commits de la landing nueva tocaron `es.json` y dejaron a
 * los otros once idiomas sin 34 claves. En `main` eso no es un test rojo, es la
 * web caída en 11 de 12 idiomas — y el despliegue no avisa, simplemente sirve la
 * versión anterior.
 *
 * Solo se comprueban las claves LITERALES. Una construida (`t(\`x.${v}\`)`) no se
 * puede resolver sin ejecutar, así que se salta a propósito en vez de fingir
 * cobertura.
 */

const DIR = new URL(".", import.meta.url).pathname;
const APP = join(DIR, "..");

function aplanar(o: unknown, p = ""): string[] {
  if (Array.isArray(o)) return o.flatMap((v, i) => aplanar(v, p ? `${p}.${i}` : String(i)));
  if (o !== null && typeof o === "object") {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      aplanar(v, p ? `${p}.${k}` : k),
    );
  }
  return [p];
}

/** Cada clave y TODOS sus ancestros: `t.raw("hero.proofs")` pide un subárbol, no una hoja. */
function conAncestros(claves: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of claves) {
    const partes = c.split(".");
    for (let i = 1; i <= partes.length; i++) out.add(partes.slice(0, i).join("."));
  }
  return out;
}

function ficherosFuente(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === "messages") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) ficherosFuente(p, acc);
    else if ((e.endsWith(".tsx") || e.endsWith(".ts")) && !e.includes(".test.")) acc.push(p);
  }
  return acc;
}

const NS = /(?:getTranslations|useTranslations)\(\s*["'`]([^"'`]+)["'`]/g;
const USO = /\bt(?:\.rich|\.raw|\.markup)?\(\s*["']([^"']+)["']/g;

describe("mensajes: toda clave que el código pide existe", () => {
  const definidas = conAncestros(
    aplanar(JSON.parse(readFileSync(join(DIR, "es.json"), "utf8"))),
  );

  it("ninguna clave literal usada en `apps/web` falta en es.json", () => {
    const faltan: string[] = [];
    for (const f of ficherosFuente(APP)) {
      const src = readFileSync(f, "utf8");
      const namespaces = [...src.matchAll(NS)].map((m) => m[1]!);
      if (namespaces.length === 0) continue;
      for (const m of src.matchAll(USO)) {
        const clave = m[1]!;
        // Interpolada: no se puede resolver estáticamente.
        if (clave.includes("{") || clave.includes("$")) continue;
        if (namespaces.some((ns) => definidas.has(`${ns}.${clave}`))) continue;
        faltan.push(`${f.replace(APP, "apps/web")} → ${namespaces.join("|")}.${clave}`);
      }
    }
    expect(faltan).toEqual([]);
  });

  it("el comprobador no está vacío: encuentra claves de verdad", () => {
    // Una guardia contra el peor fallo posible de este test — que los regex dejen
    // de casar y pase siempre en verde sin comprobar nada.
    const src = readFileSync(join(APP, "app/[locale]/page.tsx"), "utf8");
    expect([...src.matchAll(NS)].length).toBeGreaterThan(0);
    expect([...src.matchAll(USO)].length).toBeGreaterThan(10);
  });
});

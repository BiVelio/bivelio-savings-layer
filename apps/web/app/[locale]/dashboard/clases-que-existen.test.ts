import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * TODA CLASE QUE USA EL PANEL TIENE QUE EXISTIR EN LA HOJA DE ESTILOS.
 *
 * POR QUÉ EXISTE. La sección de Equipo se escribió con `ck-card`, `ck-btn`,
 * `ck-sub`, `ck-hint` y `ck-table` — cinco clases que **no existen**. No falla
 * nada: TypeScript no mira los `className`, el build compila, los 892 tests pasan
 * y el navegador simplemente aplica sus valores por defecto. El resultado fue una
 * pantalla con el `<select>` gris del sistema y una tabla desnuda, en un producto
 * que se vende por su acabado, y encima delante del dueño.
 *
 * Un nombre de clase mal escrito es un fallo MUDO: la única prueba que lo caza es
 * mirar la página, y eso no escala a doce idiomas y veinte componentes.
 */

// `fileURLToPath` y no `.pathname`: la ruta lleva `[locale]`, que en una URL
// sale escapado como `%5Blocale%5D` y no existe en el disco.
const APP = fileURLToPath(new URL("../../", import.meta.url));

/**
 * TODOS los .tsx de la aplicación, no solo los del panel. La primera versión
 * miraba únicamente `dashboard/components/`, y por eso la pantalla de invitación
 * —que vive en otra carpeta— se publicó con `<input>` a pelo: el navegador le
 * puso su borde de sistema y los campos se solapaban con el botón.
 */
function tsx(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) tsx(full, acc);
    else if (e.name.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}
const CSS = readFileSync(fileURLToPath(new URL("../../globals.css", import.meta.url)), "utf8");

/**
 * Clases que NO están en `globals.css` a propósito y no son un error:
 * utilidades de terceros o ganchos de test.
 */
const PERMITIDAS = new Set<string>(["sr-only"]);

/** Las que la hoja define, en cualquier forma: `.x {`, `.x,`, `.a .x`, `.x:hover`. */
function definidas(): Set<string> {
  const s = new Set<string>();
  for (const m of CSS.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) s.add(m[1]!);
  return s;
}

/**
 * Las que usa un componente. Se leen tanto de `className="a b"` como de los
 * trozos LITERALES de `className={`a ${x}`}` — los interpolados no se pueden
 * comprobar sin ejecutar, y forzarlos a ser estáticos sería peor código.
 */
function usadas(fuente: string): Set<string> {
  const s = new Set<string>();
  const anotar = (txt: string) => {
    for (const c of txt.split(/[\s${}`"']+/)) {
      if (c && /^[a-zA-Z][\w-]*$/.test(c)) s.add(c);
    }
  };
  for (const m of fuente.matchAll(/className="([^"]*)"/g)) anotar(m[1]!);
  // Plantillas: `className={`rol ${x}`}` → se quedan los trozos de texto plano.
  for (const m of fuente.matchAll(/className=\{`([^`]*)`\}/g)) {
    anotar(m[1]!.replace(/\$\{[^}]*\}/g, " "));
  }
  return s;
}

const ficheros = tsx(APP).map((f) => f.slice(APP.length));

describe("las clases del panel existen en globals.css", () => {
  const enLaHoja = definidas();

  it("hay componentes que revisar", () => {
    expect(ficheros.length).toBeGreaterThan(20);
  });

  for (const f of ficheros) {
    it(`${f} no usa ninguna clase inventada`, () => {
      const huerfanas = [...usadas(readFileSync(APP + f, "utf8"))].filter(
        (c) => !enLaHoja.has(c) && !PERMITIDAS.has(c),
      );
      expect(huerfanas).toEqual([]);
    });
  }
});

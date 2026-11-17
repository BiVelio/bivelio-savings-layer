import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { elegirRamas, RAMAS_DEL_CLIENTE } from "./mensajes-cliente";

/**
 * NINGÚN COMPONENTE CLIENTE PIDE UNA CLAVE QUE SU TRAMO NO LE ENTREGA.
 *
 * El navegador ya no recibe el catálogo entero: cada `<MensajesCliente
 * tramo="…">` entrega solo las ramas de `RAMAS_DEL_CLIENTE[tramo]`. Si un
 * componente cliente pide una clave que no va en su tramo, el fallo NO sale en
 * `next build` ni en el HTML del servidor (el SSR de un componente cliente
 * también lee el proveedor recortado, pero hay claves que solo se piden al
 * interactuar: un menú, un error, un paso del tour). Sale en el navegador del
 * visitante, como `MISSING_MESSAGE` y la clave en crudo en pantalla.
 *
 * Este test lo caza leyendo el FUENTE:
 *
 * 1. Recorre el grafo de imports desde cada fichero de ruta (`page`, `layout`,
 *    `error`, `loading`, `not-found`, `template`) y marca como cliente todo lo
 *    que cuelga de un `'use client'`, incluidos los módulos sin directiva que
 *    un cliente importa: Next los mete en el mismo paquete.
 * 2. En cada módulo cliente lee `useTranslations("ns")` y lo que se hace con el
 *    traductor: `t("a.b")` pide `ns.a.b`; `t(\`a.${x}\`)` pide la rama `ns.a`;
 *    cualquier otro uso (pasarlo a otra función, una clave en variable) pide el
 *    espacio `ns` ENTERO. `useMessages()` y `useTranslations()` sin espacio,
 *    pasados a otra parte, piden el catálogo entero — que ningún tramo da.
 * 3. Busca el `<MensajesCliente>` que envuelve cada ruta (el del propio fichero
 *    o el del layout más cercano) y exige que sus ramas cubran todo lo pedido.
 *
 * Es conservador a propósito: ante la duda pide más, nunca menos.
 */

const WEB = fileURLToPath(new URL("..", import.meta.url));
const APP = join(WEB, "app");
const rel = (f: string) => relative(WEB, f).split(sep).join("/");

// ─── Resolución de imports del repo ────────────────────────────────────────

const EXTENSIONES = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

function resolver(desde: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(WEB, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(desde), spec);
  else return null; // paquete de node_modules: no traduce con nuestro catálogo
  const candidatos = [base, ...EXTENSIONES.map((e) => base + e), ...EXTENSIONES.map((e) => join(base, "index" + e))];
  for (const c of candidatos) {
    if (EXTENSIONES.some((e) => c.endsWith(e)) && existsSync(c) && statSync(c).isFile()) return c;
  }
  return null; // .css, .json, imágenes…
}

// ─── Lo que pide cada módulo ───────────────────────────────────────────────

type Analisis = {
  cliente: boolean;
  servidor: boolean;
  /** Módulos del repo que importa (sin los `import type`). */
  imports: string[];
  /** Nombre local → módulo del repo del que viene. */
  locales: Map<string, string>;
  /** Rutas del catálogo que pide ("" = el catálogo entero). */
  claves: string[];
  /** Por qué pide más de lo literal: para el mensaje del fallo. */
  motivos: string[];
  /** Usos que el análisis no puede seguir: el test los rechaza. */
  errores: string[];
  /** `tramo` de cada `<MensajesCliente>` del fichero (null si no es literal). */
  tramos: (string | null)[];
  fuente: ts.SourceFile;
};

const HOOKS_CON_DEPENDENCIAS = /^(useEffect|useLayoutEffect|useInsertionEffect|useMemo|useCallback|useImperativeHandle)$/;
const esFuncion = (n: ts.Node): n is ts.SignatureDeclaration & ts.Node =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const unir = (ns: string, clave: string) => (ns && clave ? `${ns}.${clave}` : ns || clave);

/** Las claves que pide `t(arg)` dentro del espacio `ns`. */
function clavesDelArgumento(ns: string, arg: ts.Expression | undefined, motivos: string[]): string[] {
  if (!arg) return [ns];
  if (ts.isParenthesizedExpression(arg)) return clavesDelArgumento(ns, arg.expression, motivos);
  if (ts.isStringLiteralLike(arg)) return [unir(ns, arg.text)];
  if (ts.isTemplateExpression(arg)) {
    // `a.b.${x}` → la rama `a.b`; `${x}` o `a${x}` → el espacio entero.
    const cabeza = arg.head.text;
    const punto = cabeza.lastIndexOf(".");
    return [unir(ns, punto < 0 ? "" : cabeza.slice(0, punto))];
  }
  if (ts.isConditionalExpression(arg)) {
    return [...clavesDelArgumento(ns, arg.whenTrue, motivos), ...clavesDelArgumento(ns, arg.whenFalse, motivos)];
  }
  motivos.push(`clave no literal \`${arg.getText().slice(0, 40)}\` → \`${ns || "(todo)"}\` entero`);
  return [ns];
}

/** ¿Este nodo está dentro de una función que redeclara `nombre` como parámetro? */
function sombreado(nodo: ts.Node, nombre: string, hasta: ts.Node): boolean {
  for (let n = nodo.parent; n && n !== hasta; n = n.parent) {
    if (esFuncion(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === nombre)) return true;
  }
  return false;
}

function analizarFuente(texto: string, fichero: string): Omit<Analisis, "imports" | "locales"> & {
  especificadores: { spec: string; nombres: string[] }[];
} {
  const fuente = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true, fichero.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const directivas: string[] = [];
  for (const s of fuente.statements) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) directivas.push(s.expression.text);
    else break;
  }
  const especificadores: { spec: string; nombres: string[] }[] = [];
  const claves: string[] = [];
  const motivos: string[] = [];
  const errores: string[] = [];
  const tramos: (string | null)[] = [];

  const visitar = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const clausula = n.importClause;
      if (!clausula?.isTypeOnly) {
        const nombres: string[] = [];
        if (clausula?.name) nombres.push(clausula.name.text);
        const ligas = clausula?.namedBindings;
        if (ligas && ts.isNamedImports(ligas)) {
          for (const e of ligas.elements) if (!e.isTypeOnly) nombres.push(e.name.text);
        } else if (ligas && ts.isNamespaceImport(ligas)) nombres.push(ligas.name.text);
        especificadores.push({ spec, nombres });
      }
      if (spec === "next-intl" && clausula?.namedBindings) {
        const ligas = clausula.namedBindings;
        if (ts.isNamespaceImport(ligas)) errores.push(`importa next-intl como espacio (\`* as ${ligas.name.text}\`): úsalo por nombre`);
        else
          for (const e of ligas.elements) {
            const original = (e.propertyName ?? e.name).text;
            if (/^(useTranslations|useMessages)$/.test(original) && e.propertyName)
              errores.push(`renombra ${original} a ${e.name.text}: el análisis no lo seguiría`);
          }
      }
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) {
      especificadores.push({ spec: n.moduleSpecifier.text, nombres: [] });
    } else if (ts.isCallExpression(n)) {
      const primero = n.arguments[0];
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword && primero && ts.isStringLiteralLike(primero)) {
        especificadores.push({ spec: primero.text, nombres: [] });
      }
      const llamada = ts.isIdentifier(n.expression) ? n.expression.text : "";
      if (llamada === "useMessages") {
        claves.push("");
        motivos.push("useMessages() → el catálogo entero");
      } else if (llamada === "useTranslations") {
        let ns = "";
        if (primero && ts.isStringLiteralLike(primero)) ns = primero.text;
        else if (primero) errores.push(`useTranslations(${primero.getText()}): el espacio tiene que ser literal`);
        const decl = n.parent;
        if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
          const nombre = decl.name.text;
          let ambito: ts.Node = decl;
          while (!esFuncion(ambito) && !ts.isSourceFile(ambito)) ambito = ambito.parent;
          const usos = (m: ts.Node): void => {
            if (ts.isIdentifier(m) && m.text === nombre && m !== decl.name && !sombreado(m, nombre, ambito)) {
              const p = m.parent;
              if (ts.isCallExpression(p) && p.expression === m) {
                claves.push(...clavesDelArgumento(ns, p.arguments[0], motivos));
              } else if (
                ts.isPropertyAccessExpression(p) && p.expression === m && /^(rich|markup|raw|has)$/.test(p.name.text) &&
                ts.isCallExpression(p.parent) && p.parent.expression === p
              ) {
                claves.push(...clavesDelArgumento(ns, p.parent.arguments[0], motivos));
              } else if (ts.isTypeQueryNode(p)) {
                // `typeof t`: solo un tipo.
              } else if (
                ts.isArrayLiteralExpression(p) && ts.isCallExpression(p.parent) &&
                ts.isIdentifier(p.parent.expression) && HOOKS_CON_DEPENDENCIAS.test(p.parent.expression.text) &&
                p.parent.arguments.indexOf(p) === p.parent.arguments.length - 1
              ) {
                // Lista de dependencias de un hook: no traduce nada.
              } else {
                claves.push(ns);
                motivos.push(`\`${nombre}\` sale del componente (\`${p.getText().slice(0, 40)}\`) → \`${ns || "(todo)"}\` entero`);
              }
            }
            ts.forEachChild(m, usos);
          };
          usos(ambito);
        } else {
          claves.push(ns);
          motivos.push(`traductor sin nombre → \`${ns || "(todo)"}\` entero`);
        }
      }
    } else if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === "MensajesCliente") {
      const attr = n.attributes.properties.find((a) => ts.isJsxAttribute(a) && a.name.getText() === "tramo");
      const valor = attr && ts.isJsxAttribute(attr) ? attr.initializer : undefined;
      tramos.push(valor && ts.isStringLiteral(valor) ? valor.text : null);
    }
    ts.forEachChild(n, visitar);
  };
  visitar(fuente);

  return {
    cliente: directivas.includes("use client"),
    servidor: directivas.includes("use server"),
    especificadores,
    claves,
    motivos,
    errores,
    tramos,
    fuente,
  };
}

const cache = new Map<string, Analisis>();
function analizar(f: string): Analisis {
  const hecho = cache.get(f);
  if (hecho) return hecho;
  const a = analizarFuente(readFileSync(f, "utf8"), f);
  const imports: string[] = [];
  const locales = new Map<string, string>();
  for (const { spec, nombres } of a.especificadores) {
    const destino = resolver(f, spec);
    if (!destino) continue;
    imports.push(destino);
    for (const nombre of nombres) locales.set(nombre, destino);
  }
  const r: Analisis = { ...a, imports, locales };
  cache.set(f, r);
  return r;
}

/** Módulos cliente alcanzables desde un fichero de ruta. */
function grafoCliente(entrada: string): Set<string> {
  const vistos = new Set<string>();
  const clientes = new Set<string>();
  const pila: [string, boolean][] = [[entrada, false]];
  while (pila.length) {
    const [f, dentro] = pila.pop()!;
    const clave = `${f}|${dentro}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const a = analizar(f);
    // Un módulo 'use server' importado desde el cliente es una referencia a
    // una acción, no código que viaje al navegador.
    const cliente = !a.servidor && (dentro || a.cliente);
    if (cliente) clientes.add(f);
    for (const i of a.imports) pila.push([i, cliente]);
  }
  return clientes;
}

// ─── Rutas y tramos ────────────────────────────────────────────────────────

const FICHEROS_DE_RUTA = /^(page|layout|error|loading|not-found|template|default|global-error)\.(tsx|ts|jsx|js)$/;

function ficherosDeRuta(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) ficherosDeRuta(p, acc);
    else if (FICHEROS_DE_RUTA.test(e)) acc.push(p);
  }
  return acc.sort();
}

function tramoPropio(f: string): string | null | undefined {
  const { tramos } = analizar(f);
  return tramos.length ? tramos[0] : undefined;
}

/** El `<MensajesCliente>` que envuelve el fichero: el suyo o el del layout más cercano. */
function tramoDe(entrada: string): { tramo: string | null; donde: string | null } {
  const propio = tramoPropio(entrada);
  if (propio !== undefined) return { tramo: propio, donde: rel(entrada) };
  // Un layout sin proveedor vive dentro del de su padre; el resto de ficheros
  // de un segmento, dentro del layout de su propio segmento.
  let dir = basename(entrada).startsWith("layout.") ? dirname(dirname(entrada)) : dirname(entrada);
  while (dir.startsWith(APP)) {
    const layout = join(dir, "layout.tsx");
    if (existsSync(layout)) {
      const t = tramoPropio(layout);
      if (t !== undefined) return { tramo: t, donde: rel(layout) };
    }
    dir = dirname(dir);
  }
  return { tramo: null, donde: null };
}

const RAMAS: Record<string, readonly string[]> = RAMAS_DEL_CLIENTE;
const cubre = (ramas: readonly string[], clave: string) => ramas.some((r) => clave === r || clave.startsWith(`${r}.`));

function faltas(entrada: string, ramas: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of grafoCliente(entrada)) {
    const a = analizar(m);
    for (const clave of new Set(a.claves)) {
      if (cubre(ramas, clave)) continue;
      // Solo los motivos que explican ESTA petición de un espacio entero.
      const suyos = a.motivos.filter((x) => x.endsWith(`\`${clave || "(todo)"}\` entero`) || (clave === "" && x.startsWith("useMessages")));
      const porque = suyos.length ? ` (${[...new Set(suyos)].join("; ")})` : "";
      out.push(`${rel(entrada)}: ${rel(m)} pide \`${clave || "(el catálogo entero)"}\`${porque}`);
    }
  }
  return out;
}

const RUTAS = ficherosDeRuta(APP);

// ─── Las pruebas ───────────────────────────────────────────────────────────

describe("mensajes del cliente: cada ruta entrega lo que piden sus componentes cliente", () => {
  it("ninguna clave pedida en el navegador queda fuera del tramo de su ruta", () => {
    const fallos: string[] = [];
    for (const entrada of RUTAS) {
      const { tramo, donde } = tramoDe(entrada);
      if (tramo !== null && !(tramo in RAMAS)) {
        fallos.push(`${donde}: tramo desconocido "${tramo}" (no está en RAMAS_DEL_CLIENTE)`);
        continue;
      }
      for (const f of faltas(entrada, tramo ? RAMAS[tramo]! : [])) {
        fallos.push(`${f} — añádela a RAMAS_DEL_CLIENTE.${tramo ?? "(sin proveedor)"} (${donde ?? "ningún layout la envuelve"})`);
      }
    }
    expect(fallos).toEqual([]);
  });

  it("ningún módulo cliente usa next-intl de forma que el análisis no pueda seguir", () => {
    const errores: string[] = [];
    for (const entrada of RUTAS) {
      for (const m of grafoCliente(entrada)) for (const e of analizar(m).errores) errores.push(`${rel(m)}: ${e}`);
    }
    expect([...new Set(errores)]).toEqual([]);
  });

  it("cada <MensajesCliente> nombra su tramo con un literal, uno por fichero", () => {
    const mal: string[] = [];
    for (const f of RUTAS) {
      const { tramos } = analizar(f);
      if (tramos.length > 1) mal.push(`${rel(f)}: ${tramos.length} proveedores`);
      if (tramos.some((t) => t === null)) mal.push(`${rel(f)}: tramo no literal`);
    }
    expect(mal).toEqual([]);
  });

  it("el proveedor envuelve todo lo que el fichero pinta desde el repo, y {children}", () => {
    // Un componente del repo pintado FUERA del <MensajesCliente> de su fichero
    // leería el proveedor de fuera, que no es el que este test ha comprobado.
    const fuera: string[] = [];
    for (const f of RUTAS) {
      const a = analizar(f);
      if (a.tramos.length === 0) continue;
      const exportada = a.fuente.statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) &&
          !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
          !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
      );
      if (!exportada?.body) {
        fuera.push(`${rel(f)}: no encuentro la función exportada por defecto`);
        continue;
      }
      const dentroDelProveedor = (n: ts.Node) => {
        for (let p = n.parent; p && p !== exportada; p = p.parent) {
          if (ts.isJsxElement(p) && p.openingElement.tagName.getText() === "MensajesCliente") return true;
        }
        return false;
      };
      const mirar = (n: ts.Node): void => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          const etiqueta = n.tagName.getText();
          const raiz = etiqueta.split(".")[0]!;
          if (etiqueta !== "MensajesCliente" && a.locales.has(raiz) && !dentroDelProveedor(n)) {
            fuera.push(`${rel(f)}: <${etiqueta}> fuera de <MensajesCliente>`);
          }
        } else if (ts.isJsxExpression(n) && n.expression && ts.isIdentifier(n.expression) && n.expression.text === "children") {
          if (!dentroDelProveedor(n)) fuera.push(`${rel(f)}: {children} fuera de <MensajesCliente>`);
        }
        ts.forEachChild(n, mirar);
      };
      mirar(exportada.body);
    }
    expect(fuera).toEqual([]);
  });

  it("solo i18n/MensajesCliente.tsx monta NextIntlClientProvider (nadie entrega el catálogo entero)", () => {
    const quien: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) {
          if (e !== "node_modules" && e !== ".next") recorrer(p);
        } else if (/\.(tsx?|jsx?|mjs)$/.test(e) && !/\.test\./.test(e)) {
          const codigo = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
          if (/NextIntlClientProvider/.test(codigo)) quien.push(rel(p));
        }
      }
    };
    for (const d of ["app", "lib", "i18n", "vendor"]) recorrer(join(WEB, d));
    expect(quien).toEqual(["i18n/MensajesCliente.tsx"]);
  });

  it("cada rama de cada tramo existe en en.json (el catálogo base de todos los idiomas)", () => {
    const en = JSON.parse(readFileSync(join(WEB, "messages/en.json"), "utf8")) as Record<string, unknown>;
    const inexistentes: string[] = [];
    for (const [tramo, ramas] of Object.entries(RAMAS)) {
      for (const rama of ramas) {
        let nodo: unknown = en;
        for (const k of rama.split(".")) nodo = nodo && typeof nodo === "object" ? (nodo as Record<string, unknown>)[k] : undefined;
        if (nodo === undefined) inexistentes.push(`${tramo}: ${rama}`);
      }
    }
    expect(inexistentes).toEqual([]);
  });

  it("la portada y el resto del sitio público solo cargan la barra (presupuesto: 4 KB de catálogo)", () => {
    // El motivo de todo esto: las páginas de los anuncios. Si alguien mete aquí
    // un espacio grande «para no pensar», este número lo dice.
    const sitio = RAMAS_DEL_CLIENTE.sitio;
    for (const idioma of ["en", "es", "vi"]) {
      const cat = JSON.parse(readFileSync(join(WEB, `messages/${idioma}.json`), "utf8"));
      expect(JSON.stringify(elegirRamas(cat, sitio)).length, idioma).toBeLessThan(4096);
    }
    for (const ruta of ["page.tsx", "pricing/page.tsx", "paper/page.tsx", "privacy/page.tsx", "not-found.tsx"]) {
      expect(tramoDe(join(APP, "[locale]", ruta)).tramo, ruta).toBe("sitio");
    }
  });
});

describe("el comprobador no está vacío y muerde", () => {
  it("encuentra lo que piden la barra y el panel", () => {
    const barra = new Set([...grafoCliente(join(APP, "[locale]/layout.tsx"))].flatMap((m) => analizar(m).claves));
    expect([...barra].filter((c) => c.startsWith("nav.")).length).toBeGreaterThan(5);
    expect(tramoDe(join(APP, "[locale]/dashboard/page.tsx")).tramo).toBe("panel");
    expect(tramoDe(join(APP, "[locale]/login/page.tsx")).tramo).toBe("acceso");
  });

  it("el panel con las ramas del sitio daría faltas", () => {
    expect(faltas(join(APP, "[locale]/dashboard/page.tsx"), RAMAS_DEL_CLIENTE.sitio).length).toBeGreaterThan(0);
    expect(faltas(join(APP, "[locale]/benchmarks/page.tsx"), RAMAS_DEL_CLIENTE.sitio).length).toBeGreaterThan(0);
  });

  it("lee las claves como se usan", () => {
    const a = analizarFuente(
      `"use client";
      import { useTranslations } from "next-intl";
      export function A({ k }) {
        const t = useTranslations("ns");
        useEffect(() => {}, [t]);
        return <p title={t("x.y")}>{t.rich("z")}{t(\`w.\${k}\`)}{t(k ? "p" : "q")}</p>;
      }
      export function B({ k }) {
        const t = useTranslations("otro");
        return [1].map((t) => t.id).concat(t(k));
      }
      export function C() {
        const t = useTranslations();
        return ayuda(t);
      }`,
      "x.tsx",
    );
    expect(a.cliente).toBe(true);
    expect(new Set(a.claves)).toEqual(new Set(["ns.x.y", "ns.z", "ns.w", "ns.p", "ns.q", "otro", ""]));
  });
});

describe("elegirRamas", () => {
  const cat = { a: { b: { c: "1", d: "2" }, e: "3" }, f: "4", g: { h: "5" } };

  it("copia solo las ramas pedidas, con sus antepasados", () => {
    expect(elegirRamas(cat, ["a.b.c", "g"])).toEqual({ a: { b: { c: "1" } }, g: { h: "5" } });
    expect(elegirRamas(cat, ["a.e", "a.b.d"])).toEqual({ a: { e: "3", b: { d: "2" } } });
  });

  it("una rama dentro de otra ya pedida no cambia nada ni escribe en el original", () => {
    const copia = JSON.parse(JSON.stringify(cat));
    expect(elegirRamas(cat, ["a", "a.b.c"])).toEqual({ a: cat.a });
    expect(elegirRamas(cat, ["a.b.c", "a"])).toEqual({ a: cat.a });
    expect(cat).toEqual(copia);
  });

  it("no comparte objetos con el catálogo: dos proveedores nunca se apuntan entre sí en la carga RSC", () => {
    // Con la misma referencia en el tramo del sitio y en el del panel, React
    // Flight escribía `"nav":"$13:props:messages:nav"` en el segundo.
    const sitio = elegirRamas(cat, ["g"]);
    const panel = elegirRamas(cat, ["a", "g"]);
    expect(sitio.g).toEqual(cat.g);
    expect(sitio.g).not.toBe(cat.g);
    expect(panel.g).not.toBe(sitio.g);
    expect(panel.a).not.toBe(cat.a);
  });

  it("omite lo que no existe", () => {
    expect(elegirRamas(cat, ["x", "a.zz", "f.g"])).toEqual({});
  });
});

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import {
  conFicheros,
  detectar,
  escribirConPermiso,
  jsonDelPlan,
  leerArgumentosDeInit,
  planear,
  textoDelPlan,
  type Plan,
  type SondaDeProyecto,
} from "../gateway/init.js";
import { decidirArranque } from "../gateway/argumentos.js";

/**
 * `bvsala init` — LO QUE DECIDE, sin disco ni red: los argumentos, la detección
 * de la pila, el plan y la escritura con permiso. La sonda del sistema de ficheros
 * es un mapa en memoria, y cada lectura queda apuntada: así se prueba que init LEE
 * solo package.json y jamás un `.env`.
 */

const DIR = "/p/app";

function sonda(
  packageJson: Record<string, unknown> | string | undefined,
  existen: string[] = [],
  extra: Record<string, string> = {},
): SondaDeProyecto & { leidos: string[] } {
  const ficheros = new Map<string, string>(Object.entries(extra));
  if (packageJson !== undefined) {
    ficheros.set(join(DIR, "package.json"), typeof packageJson === "string" ? packageJson : JSON.stringify(packageJson));
  }
  const hay = new Set(existen.map((r) => (r.startsWith("/") ? r : join(DIR, ...r.split("/")))));
  const leidos: string[] = [];
  return {
    leidos,
    leer: (ruta) => {
      leidos.push(ruta);
      return ficheros.get(ruta);
    },
    existe: (ruta) => ficheros.has(ruta) || hay.has(ruta),
  };
}

interface Entorno {
  node: string;
  env: (nombre: string) => boolean;
}
const ENTORNO: Entorno = { node: "22.14.0", env: () => false };

function planDe(s: SondaDeProyecto, o: { capa?: Plan["capa"]; proveedor?: Plan["proveedor"] } = {}, entorno: Entorno = ENTORNO): Plan {
  const d = detectar(DIR, s);
  if (!d.ok) throw new Error(d.mensaje);
  const p = planear(d.valor, o, entorno);
  if (!p.ok) throw new Error(p.mensaje);
  return conFicheros(p.valor, s);
}

describe("los argumentos de init", () => {
  it("por defecto solo imprime: ni escribir, ni json, ni pila forzada", () => {
    expect(leerArgumentosDeInit([], "/x")).toEqual({ ok: true, valor: { cwd: "/x", escribir: false, si: false, json: false } });
  });

  it("--write, --yes / -y, --json, --stack, --provider y --cwd (relativo al directorio actual)", () => {
    const r = leerArgumentosDeInit(["--write", "-y", "--stack", "langchain", "--provider", "anthropic", "--cwd", "apps/web"], "/x");
    expect(r).toEqual({
      ok: true,
      valor: { cwd: join("/x", "apps/web"), escribir: true, si: true, json: false, capa: "langchain", proveedor: "anthropic" },
    });
    expect(leerArgumentosDeInit(["--cwd", "/abs"], "/x")).toMatchObject({ ok: true, valor: { cwd: "/abs" } });
  });

  it("⛔ los errores dicen qué hacer: opción desconocida, valor que falta, combinaciones sin sentido", () => {
    const desconocida = leerArgumentosDeInit(["--force"], "/x");
    expect(desconocida).toMatchObject({ ok: false });
    expect(!desconocida.ok && desconocida.mensaje).toMatch(/unknown option: --force\nusage: bvsala init/);
    expect(leerArgumentosDeInit(["--stack", "django"], "/x")).toMatchObject({ ok: false, mensaje: expect.stringMatching(/ai-sdk, mastra, langchain/) });
    expect(leerArgumentosDeInit(["--stack"], "/x")).toMatchObject({ ok: false });
    expect(leerArgumentosDeInit(["--cwd", "--write"], "/x")).toMatchObject({ ok: false, mensaje: expect.stringMatching(/--cwd needs a directory/) });
    expect(leerArgumentosDeInit(["--json", "--write"], "/x")).toMatchObject({ ok: false, mensaje: expect.stringMatching(/use one of them/) });
    // --yes solo no escribe nada: se le dice en vez de ignorarlo en silencio.
    expect(leerArgumentosDeInit(["--yes"], "/x")).toMatchObject({ ok: false, mensaje: expect.stringMatching(/--yes only confirms --write/) });
    expect(leerArgumentosDeInit(["--stack", "anthropic-sdk", "--provider", "openai"], "/x")).toMatchObject({ ok: false });
  });

  it("init es un comando propio del CLI: arranca, y `init --help` es la ayuda, no una ejecución", () => {
    expect(decidirArranque(["init"])).toEqual({ tipo: "arrancar", comando: "init", resto: [] });
    expect(decidirArranque(["init", "--write", "--yes"])).toEqual({ tipo: "arrancar", comando: "init", resto: ["--write", "--yes"] });
    expect(decidirArranque(["init", "--help"])).toEqual({ tipo: "ayuda", salida: 0 });
    expect(decidirArranque(["init", "-h"])).toEqual({ tipo: "ayuda", salida: 0 });
  });

  it("npx @bivelio/savings-layer init funciona porque el paquete tiene UN solo bin", () => {
    // npm exec: «If the package has a single entry in its bin field … that command
    // will be used»; con varios, solo el que se llame como el paquete sin scope
    // («savings-layer»). Añadir un segundo bin rompería `npx … init` en silencio.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { bin: Record<string, string> };
    const bins = Object.keys(pkg.bin);
    expect(bins.length === 1 || bins.includes("savings-layer"), `bins: ${bins.join(", ")}`).toBe(true);
  });
});

describe("la detección", () => {
  it("sin package.json: el error dice dónde mirar y cómo apuntar a otro directorio", () => {
    const r = detectar(DIR, sonda(undefined));
    expect(r).toMatchObject({ ok: false, mensaje: expect.stringMatching(/no package\.json in \/p\/app\. Run this from your project's root, or pass --cwd <dir>\./) });
  });

  it("un proyecto Python recibe la receta del gateway, no un «no hay package.json» a secas", () => {
    const r = detectar(DIR, sonda(undefined, ["pyproject.toml"]));
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.mensaje).toMatch(/pyproject\.toml says this is Python/);
    expect(!r.ok && r.mensaje).toMatch(/bvsala gateway --upstream openai --port 8403/);
    expect(!r.ok && r.mensaje).toMatch(/base_url="http:\/\/127\.0\.0\.1:8403\/v1"/);
  });

  it("un package.json roto nombra el fichero y dice que se arregle", () => {
    const r = detectar(DIR, sonda("{ nope"));
    expect(r).toMatchObject({ ok: false, mensaje: expect.stringMatching(/package\.json is not valid JSON .*Fix it and run init again\./) });
    expect(detectar(DIR, sonda("[]"))).toMatchObject({ ok: false, mensaje: expect.stringMatching(/not a JSON object/) });
  });

  it("Next.js con App Router en src/app, TypeScript y pnpm por el lockfile de la raíz del monorepo", () => {
    const s = sonda({ dependencies: { next: "^15.5.0", ai: "^7.0.0", "@ai-sdk/openai": "^4.0.0" } }, ["src/app", "src", "tsconfig.json", "/p/pnpm-lock.yaml"]);
    const d = detectar(DIR, s);
    expect(d).toMatchObject({ ok: true, valor: { anfitrion: "next", appDir: "src/app", ts: true, gestor: "pnpm", capas: ["ai-sdk"], versionDelAnfitrion: "15.5.0" } });
  });

  it("`packageManager` manda sobre el lockfile; sin nada, npm", () => {
    expect(detectar(DIR, sonda({ packageManager: "yarn@4.1.0" }, ["package-lock.json"]))).toMatchObject({ ok: true, valor: { gestor: "yarn" } });
    expect(detectar(DIR, sonda({}, ["bun.lock"]))).toMatchObject({ ok: true, valor: { gestor: "bun" } });
    expect(detectar(DIR, sonda({}))).toMatchObject({ ok: true, valor: { gestor: "npm" } });
  });

  it("la versión es la INSTALADA si hay node_modules, y si no la mínima del rango", () => {
    const s = sonda({ dependencies: { ai: "^6.0.0", langchain: "latest" } }, [], {
      [join(DIR, "node_modules", "ai", "package.json")]: JSON.stringify({ version: "7.0.118" }),
    });
    const d = detectar(DIR, s);
    expect(d.ok && d.valor.deps.ai).toBe("7.0.118");
    expect(d.ok && d.valor.deps.langchain).toBeUndefined();
    const sinInstalar = detectar(DIR, sonda({ dependencies: { ai: "^6.0.3" } }));
    expect(sinInstalar.ok && sinInstalar.valor.deps.ai).toBe("6.0.3");
  });

  it("⛔ lee SOLO package.json: de los .env mira la existencia y nunca los abre", () => {
    const s = sonda({ dependencies: { express: "^5.0.0", "@mastra/core": "^1.71.0" } }, [".env", ".env.local", "src"], {
      [join(DIR, ".env")]: "BIVELIO_LICENSE_KEY=esto-no-se-lee",
    });
    const plan = planDe(s);
    expect(plan.deteccion.ficherosEnv).toEqual([".env", ".env.local"]);
    for (const ruta of s.leidos) expect(ruta, ruta).toMatch(/package\.json$/);
    expect(textoDelPlan(plan, "cabecera", "npx x init")).not.toContain("esto-no-se-lee");
  });
});

describe("el plan", () => {
  it("con varias capas elige en orden (Mastra > LangChain > AI SDK > Anthropic SDK > OpenAI SDK) y nombra las otras", () => {
    const plan = planDe(sonda({ dependencies: { ai: "^7.0.0", "@mastra/core": "^1.71.0", openai: "^6.0.0" } }));
    expect(plan.capa).toBe("mastra");
    expect(plan.alternativas).toEqual(["ai-sdk", "sdk"]);
    expect(textoDelPlan(plan, "c", "npx @bivelio/savings-layer init")).toMatch(/also found: Vercel AI SDK \(npx @bivelio\/savings-layer init --stack ai-sdk\)/);
  });

  it("una versión que el adaptador no admite: pasa a la siguiente opción y dice cómo actualizar", () => {
    const plan = planDe(sonda({ dependencies: { ai: "^5.0.0", openai: "^6.0.0" } }, ["pnpm-lock.yaml"]));
    expect(plan.capa).toBe("sdk");
    expect(plan.avisos.join("\n")).toMatch(/ai 5\.0\.0 is outside what the adapter supports \(ai 6 or 7\): showing the SDK directly .*pnpm add ai@latest/);
  });

  it("--stack manda, aunque el framework no esté: entonces entra en la línea de instalación", () => {
    const plan = planDe(sonda({ dependencies: {} }, ["pnpm-lock.yaml"]), { capa: "langchain" });
    expect(plan.capa).toBe("langchain");
    expect(plan.comandoDeInstalacion).toBe("pnpm add @bivelio/savings-layer langchain @langchain/core @langchain/openai gpt-tokenizer");
  });

  it("LangChain sin su paquete de integración lo añade: sin él, el modelo en cadena ni siquiera carga", () => {
    const plan = planDe(sonda({ dependencies: { langchain: "^1.5.0", "@langchain/core": "^1.2.0" } }));
    expect(plan.instalar).toContain("@langchain/openai");
    const conAnthropic = planDe(sonda({ dependencies: { langchain: "^1.5.0", "@langchain/core": "^1.2.0", "@langchain/anthropic": "^1.0.0" } }));
    expect(conAnthropic.proveedor).toBe("anthropic");
    expect(conAnthropic.instalar).not.toContain("@langchain/openai");
    expect(conAnthropic.instalar).not.toContain("gpt-tokenizer");
  });

  it("el proveedor sale del paquete del framework, y gpt-tokenizer solo acompaña a OpenAI", () => {
    const aiAnthropic = planDe(sonda({ dependencies: { ai: "^7.0.0", "@ai-sdk/anthropic": "^4.0.0" } }));
    expect(aiAnthropic).toMatchObject({ capa: "ai-sdk", proveedor: "anthropic" });
    expect(aiAnthropic.instalar).toEqual(["@bivelio/savings-layer"]);
    const soloAnthropic = planDe(sonda({ dependencies: { "@anthropic-ai/sdk": "^0.128.0" } }));
    expect(soloAnthropic).toMatchObject({ capa: "anthropic-sdk", proveedor: "anthropic" });
    expect(soloAnthropic.claves.map((k) => k.nombre)).toEqual(["BIVELIO_LICENSE_KEY", "BIVELIO_SERVICE_KEY", "ANTHROPIC_API_KEY"]);
    expect(soloAnthropic.claves[2]?.para).toMatch(/needed even by the free check/);
  });

  it("ya instalado no se vuelve a instalar; una versión sin adaptadores lo dice", () => {
    const plan = planDe(sonda({ dependencies: { "@bivelio/savings-layer": "^0.4.24", ai: "^7.0.0", "@ai-sdk/openai": "^4.0.0", "gpt-tokenizer": "^3" } }));
    expect(plan.comandoDeInstalacion).toBeUndefined();
    expect(plan.avisos.join("\n")).toMatch(/0\.4\.24 has no framework adapters \(they arrived in 0\.4\.25\)/);
    expect(textoDelPlan(plan, "c", "x")).toMatch(/nothing to install/);
  });

  it("⛔ Node < 20 no sigue: el paquete no arranca ahí", () => {
    const d = detectar(DIR, sonda({ dependencies: { ai: "^7.0.0" } }));
    if (!d.ok) throw new Error(d.mensaje);
    expect(planear(d.valor, {}, { node: "18.19.0", env: () => false })).toMatchObject({
      ok: false,
      mensaje: expect.stringMatching(/Node 18\.19\.0 is too old: @bivelio\/savings-layer needs Node ≥ 20/),
    });
    const en20 = planear(d.valor, {}, { node: "20.19.0", env: () => false });
    expect(en20.ok && en20.valor.avisos.join("\n")).toMatch(/ai 7 declares Node ≥ 22/);
  });

  it("sin ninguna librería de LLM: el SDK a secas, con el aviso; en la raíz de un monorepo, que se entre al paquete", () => {
    expect(planDe(sonda({ dependencies: { express: "^5" } })).avisos.join("\n")).toMatch(/No LLM library found/);
    expect(planDe(sonda({ workspaces: ["apps/*"] })).avisos.join("\n")).toMatch(/monorepo root: run init inside the package .*--cwd <path>/);
  });

  it("CommonJS sin TypeScript: la comprobación es .mjs y el aviso explica cómo cargar un paquete solo-ESM", () => {
    const plan = planDe(sonda({ dependencies: { openai: "^6.0.0" } }));
    expect(plan.ficheros.map((f) => f.ruta)).toEqual(["savings.mjs", "bivelio-check.mjs"]);
    expect(plan.avisos.join("\n")).toMatch(/ESM-only.*await import/);
  });

  it("⛔ de las claves solo dice «set» o «not set»: el valor no se pide ni se imprime", () => {
    const pedidos: string[] = [];
    const plan = planDe(sonda({ dependencies: { ai: "^7.0.0" } }), {}, {
      node: "22.14.0",
      env: (nombre) => {
        pedidos.push(nombre);
        return nombre === "BIVELIO_LICENSE_KEY";
      },
    });
    expect(pedidos).toEqual(["BIVELIO_LICENSE_KEY", "BIVELIO_SERVICE_KEY", "OPENAI_API_KEY"]);
    const texto = textoDelPlan(plan, "c", "x");
    expect(texto).toMatch(/BIVELIO_LICENSE_KEY\s+set\s/);
    expect(texto).toMatch(/BIVELIO_SERVICE_KEY\s+not set/);
    expect(texto).toMatch(/values are never read or shown/);
  });
});

describe("los ficheros del plan", () => {
  it("Next.js: cableado en lib/, comprobación como ruta y el uso importando el cableado por ruta relativa", () => {
    const plan = planDe(sonda({ dependencies: { next: "^15", ai: "^7.0.0", "@ai-sdk/openai": "^4.0.0" } }, ["app", "tsconfig.json"]));
    expect(plan.ficheros.map((f) => [f.ruta, f.proposito])).toEqual([
      ["lib/savings.ts", "wiring"],
      ["app/api/bivelio-check/route.ts", "check"],
    ]);
    expect(plan.usos[0]?.ruta).toBe("app/api/chat/route.ts");
    expect(plan.usos[0]?.contenido).toContain('import { model } from "../../../lib/savings";');
    const enSrc = planDe(sonda({ dependencies: { next: "^15", ai: "^7.0.0" } }, ["src/app", "src"]));
    expect(enSrc.ficheros.map((f) => f.ruta)).toEqual(["src/lib/savings.js", "src/app/api/bivelio-check/route.js"]);
    expect(enSrc.usos[0]?.contenido).toContain("export async function POST(req) {");
    expect(enSrc.comoComprobar[0]).toMatch(/next dev/);
  });

  it("Next.js sin app/ (Pages Router): la comprobación pasa a script y se avisa", () => {
    const plan = planDe(sonda({ dependencies: { next: "^14", ai: "^7.0.0" } }, ["pages"]));
    expect(plan.ficheros.map((f) => f.ruta)).toContain("bivelio-check.mjs");
    expect(plan.avisos.join("\n")).toMatch(/No app\/ directory/);
  });

  it("Express: el uso es un servidor autocontenido y la comprobación un script", () => {
    const plan = planDe(sonda({ type: "module", dependencies: { express: "^5.2.1", openai: "^6" } }, ["src", ".env"]));
    expect(plan.ficheros.map((f) => f.ruta)).toEqual(["bivelio-check.mjs"]);
    expect(plan.usos[0]?.ruta).toBe("server.js");
    expect(plan.usos[0]?.contenido).toMatch(/^import express from "express";/);
    expect(plan.comoComprobar[0]).toBe("Run it: node --env-file=.env bivelio-check.mjs");
  });

  it("Node con src/: el cableado va a src/savings.ts", () => {
    const plan = planDe(sonda({ type: "module", dependencies: { ai: "^7.0.0" } }, ["src", "tsconfig.json"]));
    expect(plan.ficheros.map((f) => f.ruta)).toEqual(["src/savings.ts", "bivelio-check.mjs"]);
  });

  it("un fichero que ya existe queda marcado, y el texto no promete crearlo", () => {
    const plan = planDe(sonda({ type: "module", dependencies: { ai: "^7.0.0" } }, ["bivelio-check.mjs"]));
    expect(plan.ficheros.find((f) => f.ruta === "bivelio-check.mjs")?.existe).toBe(true);
    const texto = textoDelPlan(plan, "c", "npx @bivelio/savings-layer init");
    expect(texto).toMatch(/bivelio-check\.mjs \(new file; it already exists, compare it\)/);
    expect(texto).toMatch(/To create the new file above \(savings\.js\): npx @bivelio\/savings-layer init --write\. It asks first and never overwrites/);
  });

  it("con --write el texto no dice «Nothing was written» justo antes de preguntar", () => {
    const plan = planDe(sonda({ type: "module", dependencies: { ai: "^7.0.0" } }));
    expect(textoDelPlan(plan, "c", "x")).toMatch(/Nothing was written\./);
    expect(textoDelPlan(plan, "c", "x", { escribira: true })).not.toMatch(/Nothing was written/);
  });

  it("el JSON lleva lo mismo que el texto, para un agente de código", () => {
    const plan = planDe(sonda({ type: "module", dependencies: { "@mastra/core": "^1.71.0" } }));
    const j = JSON.parse(jsonDelPlan(plan, "0.0.0")) as Record<string, unknown>;
    expect(j).toMatchObject({ stack: "mastra", provider: "openai", adapter: "@bivelio/savings-layer/mastra", install: "npm i @bivelio/savings-layer gpt-tokenizer" });
    expect((j.files as Array<{ path: string }>).map((f) => f.path)).toEqual(["savings.js", "bivelio-check.mjs"]);
    expect((j.keys as Array<{ name: string; set: boolean }>).every((k) => typeof k.set === "boolean")).toBe(true);
  });
});

describe("la escritura, con permiso", () => {
  function planConFicheros(existen: string[] = []): Plan {
    return planDe(sonda({ type: "module", dependencies: { ai: "^7.0.0" } }, existen));
  }
  function fs() {
    const creados = new Map<string, string>();
    const dirs: string[] = [];
    return {
      creados,
      dirs,
      crearDir: (r: string) => void dirs.push(r),
      crearExclusivo: (r: string, c: string) => {
        if (creados.has(r)) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        creados.set(r, c);
      },
    };
  }

  it("⛔ sin terminal y sin --yes no escribe nada y sale con 1, diciendo cómo seguir", async () => {
    const f = fs();
    const r = await escribirConPermiso(planConFicheros(), { si: false, esTerminal: false, preguntar: async () => "y", ...f });
    expect(r.salida).toBe(1);
    expect(f.creados.size).toBe(0);
    expect(r.lineas.at(-1)).toMatch(/Re-run with --write --yes, or copy the code above by hand/);
  });

  it("en una terminal pregunta, y cualquier cosa que no sea «y»/«yes» es un no", async () => {
    for (const respuesta of ["", "n", "no", "sí", "yep"]) {
      const f = fs();
      const r = await escribirConPermiso(planConFicheros(), { si: false, esTerminal: true, preguntar: async () => respuesta, ...f });
      expect(r.salida, respuesta).toBe(0);
      expect(f.creados.size, respuesta).toBe(0);
      expect(r.lineas.at(-1)).toBe("Nothing written.");
    }
  });

  it("con un «y» crea solo los ficheros nuevos, en el directorio del proyecto", async () => {
    const f = fs();
    let preguntas = 0;
    const r = await escribirConPermiso(planConFicheros(), {
      si: false,
      esTerminal: true,
      preguntar: async (p) => {
        preguntas++;
        expect(p).toBe("Create them? [y/N] ");
        return "Y";
      },
      ...f,
    });
    expect(preguntas).toBe(1);
    expect(r).toMatchObject({ salida: 0, creados: ["savings.js", "bivelio-check.mjs"] });
    expect([...f.creados.keys()]).toEqual([join(DIR, "savings.js"), join(DIR, "bivelio-check.mjs")]);
    expect(r.lineas).toContain("No existing file is changed, nothing is installed and nothing is run.");
  });

  it("--yes no pregunta", async () => {
    const f = fs();
    const r = await escribirConPermiso(planConFicheros(), {
      si: true,
      esTerminal: false,
      preguntar: async () => {
        throw new Error("no debía preguntar");
      },
      ...f,
    });
    expect(r.creados).toHaveLength(2);
  });

  it("⛔ nunca pisa: lo que existe se nombra y se deja, y lo que aparece durante la pregunta también", async () => {
    const f = fs();
    f.creados.set(join(DIR, "bivelio-check.mjs"), "del cliente");
    const plan = planConFicheros(["savings.js"]);
    const r = await escribirConPermiso(plan, { si: true, esTerminal: false, preguntar: async () => "y", ...f });
    expect(r.lineas).toContain("left as is: savings.js already exists (compare it with the code above).");
    expect(r.lineas).toContain("left as is: bivelio-check.mjs appeared while we asked; it was not overwritten.");
    expect(f.creados.get(join(DIR, "bivelio-check.mjs"))).toBe("del cliente");
    expect(r.salida).toBe(0);
  });

  it("todo existe: nada que escribir, sin preguntar", async () => {
    const f = fs();
    const r = await escribirConPermiso(planConFicheros(["savings.js", "bivelio-check.mjs"]), {
      si: false,
      esTerminal: true,
      preguntar: async () => {
        throw new Error("no debía preguntar");
      },
      ...f,
    });
    expect(r).toMatchObject({ salida: 0, creados: [] });
    expect(r.lineas.at(-1)).toBe("Nothing to write.");
  });

  it("un fallo de disco que no es EEXIST sale con 1 y dice qué fichero", async () => {
    const r = await escribirConPermiso(planConFicheros(), {
      si: true,
      esTerminal: false,
      preguntar: async () => "y",
      crearDir: () => undefined,
      crearExclusivo: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    expect(r.salida).toBe(1);
    expect(r.lineas).toContain("could not create savings.js: EACCES: permission denied");
  });
});

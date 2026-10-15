import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conFicheros, detectar, planear, type OpcionesDeInit, type Plan, type SondaDeProyecto } from "../gateway/init.js";

/**
 * LOS EJEMPLOS DE `examples/stacks/` SON LA SALIDA DE `bvsala init`, no una copia a mano.
 *
 * Para cada pila se monta un proyecto CANÓNICO en memoria (su package.json y los
 * directorios que miraría init), se pasa por el mismo `detectar → planear →
 * conFicheros` que usa el CLI, y cada fichero y fragmento del plan va a
 * `examples/stacks/<pila>/<su ruta>`. La comprobación `.mjs` se guarda como `.ts`
 * para que la compile el typecheck de los ejemplos (`examples/stacks/tsconfig.json`,
 * encadenado en `typecheck:all`); el texto es el mismo.
 *
 *   pnpm init:ejemplos        regenera examples/stacks/ desde los fragmentos
 *
 * `test/init-ejemplos.test.ts` exige que lo que hay en disco sea exactamente esto.
 */

const RAIZ_FALSA = "/proyecto";

interface Canonico {
  /** Directorio en examples/stacks/. */
  nombre: string;
  packageJson: Record<string, unknown>;
  /** Rutas (relativas) que existen además de package.json. */
  existen: string[];
  /** Las opciones de init con que se genera (por defecto, ninguna: lo detectado). */
  opciones?: Pick<OpcionesDeInit, "capa" | "proveedor" | "compactacion">;
}

const TS = { devDependencies: { typescript: "^5.7.0" } };

export const CANONICOS: readonly Canonico[] = [
  {
    nombre: "nextjs",
    packageJson: {
      scripts: { dev: "next dev" },
      dependencies: { next: "^15.5.0", react: "^19.0.0", "react-dom": "^19.0.0", ai: "^7.0.118", "@ai-sdk/openai": "^4.0.78" },
      ...TS,
    },
    existen: ["app", "tsconfig.json"],
  },
  {
    nombre: "express",
    packageJson: { type: "module", dependencies: { express: "^5.2.1", openai: "^6.0.0" }, ...TS },
    existen: ["tsconfig.json"],
  },
  {
    nombre: "ai-sdk",
    packageJson: { type: "module", dependencies: { ai: "^7.0.118", "@ai-sdk/openai": "^4.0.78" }, ...TS },
    existen: ["tsconfig.json"],
  },
  {
    nombre: "mastra",
    packageJson: { type: "module", dependencies: { "@mastra/core": "^1.71.0" }, ...TS },
    existen: ["tsconfig.json"],
  },
  {
    nombre: "langchain",
    packageJson: {
      type: "module",
      dependencies: { langchain: "^1.5.14", "@langchain/core": "^1.2.13", "@langchain/openai": "^1.6.0" },
      ...TS,
    },
    existen: ["tsconfig.json"],
  },
  {
    nombre: "anthropic-sdk",
    packageJson: { type: "module", dependencies: { "@anthropic-ai/sdk": "^0.128.0" }, ...TS },
    existen: ["tsconfig.json"],
  },
  // D11: la compactación sin pérdida de tool outputs, en la única pila del piloto
  // que la admite (el SDK con Anthropic, sin stream), y en modo medir.
  {
    nombre: "sdk-anthropic-compaction",
    packageJson: { type: "module", dependencies: {}, ...TS },
    existen: ["tsconfig.json"],
    opciones: { capa: "sdk", proveedor: "anthropic", compactacion: "on" },
  },
  {
    nombre: "sdk-anthropic-measure",
    packageJson: { type: "module", dependencies: {}, ...TS },
    existen: ["tsconfig.json"],
    opciones: { capa: "sdk", proveedor: "anthropic", compactacion: "measure" },
  },
];

/** Una sonda en memoria: solo existe lo que el canónico declara. */
export function sondaDe(c: Canonico, raiz = RAIZ_FALSA): SondaDeProyecto {
  const ficheros = new Map<string, string>([[join(raiz, "package.json"), JSON.stringify(c.packageJson)]]);
  const existen = new Set(c.existen.map((r) => join(raiz, ...r.split("/"))));
  return {
    leer: (ruta) => ficheros.get(ruta),
    existe: (ruta) => ficheros.has(ruta) || existen.has(ruta),
  };
}

/** El plan que `init` le daría al proyecto canónico. */
export function planDe(c: Canonico): Plan {
  const sonda = sondaDe(c);
  const d = detectar(RAIZ_FALSA, sonda);
  if (!d.ok) throw new Error(`${c.nombre}: ${d.mensaje}`);
  const p = planear(d.valor, c.opciones ?? {}, { node: "22.14.0", env: () => false });
  if (!p.ok) throw new Error(`${c.nombre}: ${p.mensaje}`);
  return conFicheros(p.valor, sonda);
}

/** Cada fichero de examples/stacks/ con el texto que tiene que tener. */
export function ejemplosDeInit(): Array<{ ruta: string; contenido: string }> {
  const out: Array<{ ruta: string; contenido: string }> = [];
  for (const c of CANONICOS) {
    const plan = planDe(c);
    for (const f of [...plan.ficheros, ...plan.usos]) {
      out.push({ ruta: `examples/stacks/${c.nombre}/${f.ruta.replace(/\.mjs$/, ".ts")}`, contenido: f.contenido });
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const raiz = fileURLToPath(new URL("..", import.meta.url));
  for (const e of ejemplosDeInit()) {
    const ruta = join(raiz, e.ruta);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, e.contenido);
    console.log(`escrito ${e.ruta}`);
  }
}

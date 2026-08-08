/**
 * Publica el artefacto A/B en la web. Run: pnpm ab:publish
 *
 * Copia benchmarks/out/ab-live.json → apps/web/public/data/ab-live.json, pero
 * solo si pasa `decidePublish`. Antes esto era un `cp` a mano, y por eso la
 * landing lleva sirviendo un MOCK.
 *
 * Flags:
 *   --allow-mock   publicar un artefacto MOCK a propósito (nunca sobre un LIVE)
 *   --dry-run      decidir e imprimir, sin escribir
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { decidePublish, type ArtifactShape } from "./publish-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGEN = join(here, "out", "ab-live.json");
const ORIGEN_CSV = join(here, "out", "ab-live-trials.csv");
const DESTINO = join(here, "..", "apps", "web", "public", "data", "ab-live.json");
const DESTINO_CSV = join(here, "..", "apps", "web", "public", "data", "ab-live-trials.csv");

const flags = new Set(process.argv.slice(2));
const allowMock = flags.has("--allow-mock");
const dryRun = flags.has("--dry-run");

function leer(path: string): ArtifactShape | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ArtifactShape;
  } catch (err) {
    throw new Error(`${path} no es JSON válido: ${(err as Error).message}`);
  }
}

const entrante = leer(ORIGEN);
if (!entrante) {
  console.error(`No existe ${ORIGEN}. Genera el artefacto antes:  pnpm ab`);
  process.exit(1);
}
const actual = leer(DESTINO);

const d = decidePublish(actual, entrante, { allowMock });

console.log(`\npublicar artefacto A/B`);
console.log(`  publicado hoy:  ${actual ? String(actual.mode) : "(ninguno)"}`);
console.log(`  entrante:       ${String(entrante.mode)}${entrante.model ? `  model: ${String(entrante.model)}` : ""}`);
const s = entrante.aggregate?.savings;
if (s) console.log(`  ahorro:         ${((s.point ?? 0) * 100).toFixed(1)}%  95%lo ${((s.lower ?? 0) * 100).toFixed(1)}%   proven: ${String(entrante.aggregate?.proven)}`);

for (const w of d.warnings) console.log(`  ⚠ ${w}`);
for (const b of d.blockers) console.log(`  ✗ ${b}`);

if (!d.ok) {
  console.error(`\nNO publicado.\n`);
  process.exit(1);
}
if (dryRun) {
  console.log(`\nPasa las comprobaciones. (--dry-run: no se ha escrito nada)\n`);
  process.exit(0);
}

mkdirSync(dirname(DESTINO), { recursive: true });
writeFileSync(DESTINO, JSON.stringify(entrante, null, 2) + "\n");
console.log(`\nPublicado en ${DESTINO}`);

// Los ENSAYOS CRUDOS viajan con el artefacto. El README promete que cualquiera
// pueda recalcular el intervalo por su cuenta, y esa promesa era falsa:
// `benchmarks/out/` está en .gitignore, así que el CSV nunca salía de la máquina
// donde se ejecutó. Un producto que se vende como "verify-don't-trust" no puede
// pedir que le crean el intervalo de confianza sin enseñar los datos.
if (existsSync(ORIGEN_CSV)) {
  writeFileSync(DESTINO_CSV, readFileSync(ORIGEN_CSV, "utf8"));
  console.log(`Ensayos crudos en ${DESTINO_CSV}`);
} else {
  console.warn(
    "AVISO: no hay ab-live-trials.csv. El artefacto se publica sin los ensayos " +
      "crudos, así que nadie podrá recalcular el intervalo.",
  );
}
console.log("");

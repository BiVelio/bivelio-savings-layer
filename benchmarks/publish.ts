/**
 * Publica el artefacto A/B en la web. Run: pnpm ab:publish
 *
 * Copia benchmarks/out/ab-live.json → apps/web/public/data/ab-live.json, pero
 * solo si pasa `decidePublish`. Antes esto era un `cp` a mano, y por eso la
 * landing lleva sirviendo un MOCK.
 *
 * Flags:
 *   --allow-mock      publicar un artefacto MOCK a propósito (nunca sobre un LIVE)
 *   --dry-run         decidir e imprimir, sin escribir
 *   --model <id>      publicar UN modelo de una tirada multi-modelo:
 *                     out/ab-live--<babosa>.json con su ab-live-trials--<babosa>.csv,
 *                     sin pagar otra tirada. Su `model` tiene que ser <id>.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { babosaDeModelo, decidePublish, type ArtifactShape } from "./publish-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(here, "..", "apps", "web", "public", "data", "ab-live.json");
const DESTINO_CSV = join(here, "..", "apps", "web", "public", "data", "ab-live-trials.csv");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !a.startsWith("--model")));
const allowMock = flags.has("--allow-mock");
const dryRun = flags.has("--dry-run");

/** `--model <id>` o `--model=<id>`. */
function modeloPedido(): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--model=")) return a.slice("--model=".length) || undefined;
    // `--model --dry-run` no es un modelo que se llame «--dry-run».
    if (a === "--model") return args[i + 1]?.startsWith("--") ? undefined : args[i + 1];
  }
  return undefined;
}
const modelo = modeloPedido();
if (args.includes("--model") && !modelo) {
  console.error("--model necesita el id del modelo, p. ej. --model openai/gpt-6-luna");
  process.exit(1);
}
const sufijo = modelo ? `--${babosaDeModelo(modelo)}` : "";
const ORIGEN = join(here, "out", `ab-live${sufijo}.json`);
const ORIGEN_CSV = join(here, "out", `ab-live-trials${sufijo}.csv`);

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
  // Una tirada multi-modelo NO escribe ab-live.json (un titular necesita un
  // modelo), pero sí uno por modelo: se publica ése, sin volver a pagar.
  const porModelo = existsSync(join(here, "out"))
    ? readdirSync(join(here, "out")).filter((f) => /^ab-live--.+\.json$/.test(f))
    : [];
  console.error(`No existe ${ORIGEN}. Genera el artefacto antes:  pnpm ab`);
  if (!modelo && porModelo.length > 0) {
    console.error(
      `Hay artefactos por modelo de una tirada multi-modelo (${porModelo.join(", ")}): publica uno con ` +
        "`pnpm ab:publish --model <id>`.",
    );
  }
  process.exit(1);
}
// El fichero se elige por la babosa; el MODELO lo dice el artefacto. Si no
// coinciden, el fichero no es el que se cree publicar.
if (modelo && entrante.model !== modelo) {
  console.error(
    `\n✗ NO publicado: ${ORIGEN} declara model = ${String(entrante.model)} y se pidió --model ${modelo}.\n`,
  );
  process.exit(1);
}
const actual = leer(DESTINO);

const d = decidePublish(actual, entrante, { allowMock });

console.log(`\npublicar artefacto A/B`);
console.log(`  publicado hoy:  ${actual ? String(actual.mode) : "(ninguno)"}`);
console.log(`  entrante:       ${String(entrante.mode)}${entrante.model ? `  model: ${String(entrante.model)}` : ""}`);
const s = entrante.aggregate?.savings;
if (s) console.log(`  ahorro:         ${((s.point ?? 0) * 100).toFixed(1)}%  95%lo ${((s.lower ?? 0) * 100).toFixed(1)}%   proven: ${String(entrante.aggregate?.proven)}`);
// EL SUELO QUE MANDA: el menor de los tres (frente a B0, B1 y B2). La cifra de
// la web tiene que caber debajo; la verja `cifra-del-heroe` lo comprueba.
const suelo = entrante.floors?.min;
if (typeof suelo === "number") {
  console.log(`  suelo mínimo:   ${(suelo * 100).toFixed(1)}%  frente a ${String(entrante.floors?.minAgainst)} — la cifra de la web tiene que caber debajo`);
}

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

// EL CSV Y EL JSON TIENEN QUE SER DE LA MISMA TIRADA, y se comprueba ANTES de
// escribir nada. Antes esto era un copy incondicional al final, y por ahí entró
// el fallo que encontró la auditoría: se publicó un CSV rezagado de una corrida
// anterior —que recomputaba 27,1 %— junto a un JSON que titulaba ≥24,1 %. Los
// dos ficheros se sirven a la vez y el README invita a recalcular el intervalo
// con el CSV, así que una desincronía no es un detalle interno: es que la prueba
// contradice al titular en la misma página que la publica.
//
// Que la comprobación vaya ANTES no es cosmético. Rechazar después de haber
// escrito el JSON dejaría el destino a medias —titular nuevo, ensayos viejos—,
// que es peor que no comprobar nada.
//
// El lazo es el recuento de ensayos que `pnpm ab` sella en el artefacto. Un
// artefacto anterior al sello no trae `trials`: entonces no se puede comprobar y
// se avisa, pero no se bloquea — bloquear ahí impediría republicar lo que ya
// está publicado.
const csvCrudo = existsSync(ORIGEN_CSV) ? readFileSync(ORIGEN_CSV, "utf8") : null;
const filasCsv = csvCrudo === null ? null : csvCrudo.split("\n").filter((l) => l.trim().length > 0).length - 1;
const ensayosDeclarados = typeof entrante.trials === "number" ? entrante.trials : null;
if (csvCrudo !== null && ensayosDeclarados !== null && filasCsv !== ensayosDeclarados) {
  console.error(
    `\n✗ NO publicado: el CSV no es de esta tirada.\n` +
      `  el artefacto declara ${ensayosDeclarados} ensayos y el CSV trae ${filasCsv} filas.\n` +
      `  Vuelve a ejecutar \`pnpm ab\` para que JSON y CSV salgan de la misma corrida.\n`,
  );
  process.exit(1);
}
if (csvCrudo !== null && ensayosDeclarados === null) {
  console.warn(
    "AVISO: el artefacto no declara `trials` (es anterior al sello de procedencia), " +
      "así que no se puede comprobar que el CSV sea de esta tirada.",
  );
}

mkdirSync(dirname(DESTINO), { recursive: true });
writeFileSync(DESTINO, JSON.stringify(entrante, null, 2) + "\n");
console.log(`\nPublicado en ${DESTINO}`);

// Los ENSAYOS CRUDOS viajan con el artefacto. El README promete que cualquiera
// pueda recalcular el intervalo por su cuenta, y esa promesa era falsa:
// `benchmarks/out/` está en .gitignore, así que el CSV nunca salía de la máquina
// donde se ejecutó. Un producto que se vende como "verify-don't-trust" no puede
// pedir que le crean el intervalo de confianza sin enseñar los datos.
if (csvCrudo !== null) {
  writeFileSync(DESTINO_CSV, csvCrudo);
  console.log(`Ensayos crudos en ${DESTINO_CSV}${ensayosDeclarados !== null ? `  (${filasCsv} ensayos, cuadran)` : ""}`);
} else {
  console.warn(
    "AVISO: no hay ab-live-trials.csv. El artefacto se publica sin los ensayos " +
      "crudos, así que nadie podrá recalcular el intervalo.",
  );
}

// Los ENSAYOS CRUDOS viajan con el artefacto. El README promete que cualquiera
// pueda recalcular el intervalo por su cuenta, y esa promesa era falsa:
// `benchmarks/out/` está en .gitignore, así que el CSV nunca salía de la máquina
// donde se ejecutó. Un producto que se vende como "verify-don't-trust" no puede
// pedir que le crean el intervalo de confianza sin enseñar los datos.
console.log("");

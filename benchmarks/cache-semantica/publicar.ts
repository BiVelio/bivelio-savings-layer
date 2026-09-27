/**
 * `pnpm cache-semantica:publicar` — convierte el artefacto de una tirada EN VIVO
 * en `docs/SEMANTIC-CACHE-PRECISION.md` y lo versiona como evidencia en
 * `benchmarks/evidencia/cache-semantica-<AAAA-MM-DD>.json`.
 *
 *   --dry-run                        decide e imprime, sin escribir nada
 *   --permitir-origen-no-comercial   publica aunque lleve datos derivados de ORCAS
 *                                    (SOLO tras la decisión legal del dueño)
 *
 * Solo publica lo que pasa `decidirPublicacion` (D21): nada en seco, nada medido
 * sobre un árbol sucio, nada sin revisión y huella de cada fuente, nada de
 * origen no comercial sin autorización. Las cifras del documento no se copian a
 * mano: salen del artefacto, y el documento cita la evidencia por su sha256.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { RUTA_ARTEFACTO } from "./arnes.js";
import { sha256Hex } from "./datos.js";
import { renderizarDocumento, RUTA_DOCUMENTO } from "./documento.js";
import { decidirPublicacion, type Artefacto } from "./publicar-verja.js";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));

/** La evidencia se nombra por el día de la medición, no por el de la publicación. */
export function rutaEvidencia(a: Artefacto): string {
  return join("benchmarks", "evidencia", `cache-semantica-${a.generatedAt.slice(0, 10)}.json`);
}

function main(): void {
  const flags = new Set(process.argv.slice(2));
  for (const f of flags) {
    if (f !== "--dry-run" && f !== "--permitir-origen-no-comercial") throw new Error(`unknown flag ${f}`);
  }
  const dryRun = flags.has("--dry-run");
  const permitirOrigenNoComercial = flags.has("--permitir-origen-no-comercial");

  if (!existsSync(RUTA_ARTEFACTO)) {
    console.error(`No artifact at ${RUTA_ARTEFACTO}. Run \`pnpm cache-semantica --conjunto todos\` first.`);
    process.exit(1);
  }
  const bytes = readFileSync(RUTA_ARTEFACTO);
  const a = JSON.parse(bytes.toString("utf8")) as Artefacto;
  const d = decidirPublicacion(a, { permitirOrigenNoComercial });

  console.log("\npublish semantic-cache precision");
  console.log(`  artifact: ${relative(RAIZ, RUTA_ARTEFACTO)} (mode ${a.mode}, commit ${a.commit?.slice(0, 7) ?? "?"}${a.dirty ? ", dirty" : ""})`);
  for (const w of d.warnings) console.log(`  ! ${w}`);
  for (const b of d.blockers) console.log(`  x ${b}`);
  if (!d.ok) {
    console.error("\nNOT published.\n");
    process.exit(1);
  }

  const evidencia = rutaEvidencia(a);
  const meta = { rutaEvidencia: evidencia, sha256Evidencia: sha256Hex(bytes) };
  const documento = renderizarDocumento(a, meta);
  if (dryRun) {
    console.log(`\nPasses. (--dry-run: nothing written; would write ${RUTA_DOCUMENTO} and ${evidencia})\n`);
    return;
  }
  const destinoEvidencia = join(RAIZ, evidencia);
  mkdirSync(dirname(destinoEvidencia), { recursive: true });
  copyFileSync(RUTA_ARTEFACTO, destinoEvidencia);
  writeFileSync(join(RAIZ, RUTA_DOCUMENTO), documento);
  console.log(`\nWritten: ${RUTA_DOCUMENTO} and ${evidencia} (sha256 ${meta.sha256Evidencia.slice(0, 12)}…)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

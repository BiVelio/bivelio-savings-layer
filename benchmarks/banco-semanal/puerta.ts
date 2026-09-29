/**
 * LA PUERTA DE PUBLICACIÓN: no se publica en npm si el último banco semanal en
 * vivo falló o tiene más de 8 días.
 * ---------------------------------------------------------------------------
 * La corre el trabajo `banco-semanal` de .github/workflows/publish.yml, del que
 * depende `publicar` (NO `verificar`: el tarball verificado se sigue
 * construyendo y subiendo como artefacto, así que la publicación a mano de
 * docs/PUBLISHING.md sigue siendo posible — y es decisión del dueño, no de la CI).
 *
 * Uso:
 *   gh run list --workflow banco-semanal.yml --branch main --limit 30 \
 *     --json databaseId,status,conclusion,createdAt,displayTitle,event,url,headSha > runs.json
 *   node benchmarks/banco-semanal/puerta.ts runs.json
 *
 * Se ejecuta con Node 24 SIN instalar nada (Node quita los tipos él solo): por
 * eso este fichero no importa nada del repositorio ni de npm. El trabajo que lo
 * corre no ejecuta código de terceros.
 *
 * QUÉ CUENTA COMO «EL ÚLTIMO BANCO». El run completado más reciente de
 * banco-semanal.yml en `main` cuyo título lleva «(vivo)» (el `run-name` del
 * workflow). Un run en SECO no mide nada y no cuenta; uno en curso tampoco
 * (se mira el anterior). Un run cancelado sí cuenta, y no es un éxito.
 *
 * EMERGENCIA. Con la variable de repositorio `BANCO_SEMANAL_EMERGENCIA` puesta
 * a un motivo escrito, la puerta pasa con un aviso que cita el motivo y el
 * estado real del banco. La pone y la quita el dueño:
 *   gh variable set BANCO_SEMANAL_EMERGENCIA --body "motivo"   # antes de la Release
 *   gh variable delete BANCO_SEMANAL_EMERGENCIA                 # en cuanto publique
 * Ver docs/BANCO-SEMANAL.md.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_DIAS = 8;

export interface RunDelBanco {
  databaseId?: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  displayTitle: string;
  event?: string;
  url?: string;
  headSha?: string;
}

export interface Decision {
  ok: boolean;
  nivel: "notice" | "warning" | "error";
  mensaje: string;
}

const DIA_MS = 86_400_000;

/** El último run en vivo completado, o null. */
export function ultimoBancoEnVivo(runs: readonly RunDelBanco[]): RunDelBanco | null {
  const vivos = runs
    .filter((r) => r.status === "completed" && /\(vivo\)/.test(r.displayTitle))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return vivos[0] ?? null;
}

function estadoDelBanco(runs: readonly RunDelBanco[] | null, ahora: Date, maxDias: number): { ok: boolean; mensaje: string } {
  if (!runs) return { ok: false, mensaje: "no se pudo leer la lista de runs de banco-semanal.yml en main (¿el workflow aún no existe en main?)" };
  const u = ultimoBancoEnVivo(runs);
  if (!u) return { ok: false, mensaje: "no hay ningún banco semanal EN VIVO completado en main" };
  const dias = (ahora.getTime() - Date.parse(u.createdAt)) / DIA_MS;
  const donde = `${u.createdAt}${u.url ? `, ${u.url}` : ""}`;
  if (!Number.isFinite(dias)) return { ok: false, mensaje: `el último banco semanal tiene una fecha ilegible (${u.createdAt})` };
  if (u.conclusion !== "success") {
    return { ok: false, mensaje: `el último banco semanal en vivo (${donde}) terminó en «${u.conclusion ?? "sin conclusión"}»` };
  }
  if (dias > maxDias) {
    return { ok: false, mensaje: `el último banco semanal en vivo en verde (${donde}) tiene ${dias.toFixed(1)} días; el máximo es ${maxDias}` };
  }
  return { ok: true, mensaje: `el último banco semanal en vivo (${donde}) está en verde y tiene ${dias.toFixed(1)} días` };
}

export function evaluarPuerta(runs: readonly RunDelBanco[] | null, ahora: Date, opciones: { maxDias?: number; emergencia?: string } = {}): Decision {
  const e = estadoDelBanco(runs, ahora, opciones.maxDias ?? MAX_DIAS);
  const emergencia = opciones.emergencia?.trim();
  if (e.ok) return { ok: true, nivel: "notice", mensaje: `Banco semanal: ${e.mensaje}.` };
  if (emergencia) {
    return {
      ok: true,
      nivel: "warning",
      mensaje: `Banco semanal SALTADO por emergencia (BANCO_SEMANAL_EMERGENCIA: «${emergencia}»). Estado real: ${e.mensaje}. Borra la variable en cuanto se publique.`,
    };
  }
  return {
    ok: false,
    nivel: "error",
    mensaje:
      `No se publica: ${e.mensaje}. Corre el banco (gh workflow run banco-semanal.yml --ref main) y vuelve a lanzar este workflow, ` +
      "o, solo en una emergencia, pon BANCO_SEMANAL_EMERGENCIA (docs/BANCO-SEMANAL.md).",
  };
}

/** Lee lo que dejó `gh run list --json …`; cualquier cosa que no sea una lista es «no se pudo leer». */
export function leerRuns(texto: string): RunDelBanco[] | null {
  try {
    const j: unknown = JSON.parse(texto);
    return Array.isArray(j) ? (j as RunDelBanco[]) : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let texto = "";
  try {
    texto = readFileSync(process.argv[2] ?? "runs.json", "utf8");
  } catch {
    texto = "";
  }
  const d = evaluarPuerta(leerRuns(texto), new Date(), { emergencia: process.env["BANCO_SEMANAL_EMERGENCIA"] ?? "" });
  console.log(`::${d.nivel}::${d.mensaje}`);
  process.exit(d.ok ? 0 : 1);
}

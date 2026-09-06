/**
 * ANILLO 2 · EL ARNÉS — lee las capturas del espía (~/.bvsala-f0), clasifica
 * cada turno por brazo (palanca = nuestro dial presente en el cuerpo; control =
 * lo demás) y emite el A/B de días alternos en DINERO (nucleo.ts).
 *
 * Cómo se opera el experimento (el arnés solo LEE, jamás cambia tráfico):
 *   días de palanca:  BVSALA_GATEWAY_ELISION=1 bvsala claude   (0.4.13)
 *   días de control:  bvsala claude sin la bandera
 * con el modo encadenado medidor→espía de siempre, para que la captura vea el
 * cuerpo AJUSTADO. La clasificación se hace por el cuerpo real de cada
 * petición, no por fechas apuntadas a mano: un despiste de bandera no
 * contamina el brazo, se clasifica solo.
 *
 * PRIVACIDAD: misma doctrina que sombra-corpus — del contenido no sale NADA;
 * cada registro se reduce a números en cuanto se lee. MEMORIA: streaming línea
 * a línea (las capturas suman gigabytes).
 *
 * Uso:  pnpm anillo2 [captura.jsonl ...]
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { costeMedido, elisionDeJson, type UsoSse } from "../../gateway/medidor.js";
import {
  diaDe,
  elisionDeCuerpoSse,
  esDialNuestro,
  resumir,
  usageFusionado,
  type TurnoAnillo2,
} from "./nucleo.js";

interface Registro {
  id?: number;
  at?: string;
  method?: string;
  path?: string;
  clientPort?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: { model?: unknown; messages?: unknown; context_management?: unknown };
  sse?: { usage?: { usage: UsoSse }[] };
  responseBodyBase64?: string;
  responseBodyOmitted?: string;
}

/** Clave de sesión: cabecera de Claude Code → hash del primer mensaje → puerto
 *  (el mismo orden de robustez que sombra-corpus / análisis S1). */
function claveDeSesion(r: Registro, fichero: string): string {
  const h = r.requestHeaders ?? {};
  const sid = h["x-claude-code-session-id"];
  if (sid) return `${fichero}·s:${sid}·a:${h["x-claude-code-agent-id"] ?? ""}`;
  const primero = Array.isArray(r.requestBody?.messages) ? (r.requestBody!.messages as unknown[])[0] : undefined;
  if (primero !== undefined) {
    return `${fichero}·m:${createHash("sha256").update(JSON.stringify(primero)).digest("hex").slice(0, 16)}`;
  }
  return `${fichero}·p:${r.clientPort ?? "?"}`;
}

async function leer(
  ruta: string,
  turnos: TurnoAnillo2[],
  cuenta: { lineas: number; ilegibles: number; sinUsage: number; sinCuerpo: number; sinDia: number },
) {
  const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
  const fichero = ruta.split("/").pop() ?? ruta;
  for await (const linea of rl) {
    if (!linea) continue;
    cuenta.lineas += 1;
    let r: Registro;
    try {
      r = JSON.parse(linea) as Registro;
    } catch {
      cuenta.ilegibles += 1;
      continue;
    }
    if (r.method !== "POST" || r.path !== "/v1/messages") continue;
    if (!Array.isArray(r.requestBody?.messages)) {
      cuenta.sinCuerpo += 1;
      continue;
    }
    const dia = r.at ? diaDe(r.at) : null;
    if (!dia) {
      cuenta.sinDia += 1;
      continue;
    }
    const uso = r.sse?.usage?.length ? usageFusionado(r.sse.usage) : usageDeJson(r);
    const model = typeof r.requestBody?.model === "string" ? r.requestBody.model : "";
    const medido = uso && model ? costeMedido(model, uso) : null;
    if (!medido) {
      cuenta.sinUsage += 1;
      continue;
    }
    const salidaUsd = (medido.tokens.salida / 1_000) * medido.precio.outputPer1k;
    // Los applied_edits van en el cuerpo SSE crudo (el espía no los extrae a
    // sse.usage); en respuestas JSON, en el bloque top-level.
    const elision = r.responseBodyBase64
      ? r.sse
        ? elisionDeCuerpoSse(Buffer.from(r.responseBodyBase64, "base64").toString("utf8"))
        : elisionDeJson(Buffer.from(r.responseBodyBase64, "base64"))
      : null;
    turnos.push({
      dia,
      brazo: esDialNuestro(r.requestBody?.context_management) ? "palanca" : "control",
      model,
      sesion: claveDeSesion(r, fichero),
      entradaUsd: medido.costeUsd - salidaUsd,
      salidaUsd,
      entradaTokens: medido.tokens.entrada + medido.tokens.cacheLeida + medido.tokens.cacheEscrita,
      salidaTokens: medido.tokens.salida,
      borrados: elision?.borrados ?? 0,
      tokensLimpiados: elision?.tokensLimpiados ?? 0,
      respuestaOmitida: r.responseBodyOmitted !== undefined,
    });
  }
}

/** usage de una respuesta JSON (stream:false) guardada en base64. */
function usageDeJson(r: Registro): UsoSse | null {
  if (!r.responseBodyBase64 || r.sse) return null;
  try {
    const d = JSON.parse(Buffer.from(r.responseBodyBase64, "base64").toString("utf8")) as { usage?: UsoSse };
    return d.usage ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const DIR = join(homedir(), ".bvsala-f0");
  const ficheros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(DIR)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(DIR, f));
  if (!ficheros.length) {
    console.error("[anillo2] no hay capturas; graba con scripts/espia-anthropic.mjs");
    process.exit(1);
  }

  const turnos: TurnoAnillo2[] = [];
  const cuenta = { lineas: 0, ilegibles: 0, sinUsage: 0, sinCuerpo: 0, sinDia: 0 };
  for (const f of ficheros) {
    console.error(`[anillo2] leyendo ${f.split("/").pop()} …`);
    await leer(f, turnos, cuenta);
  }
  console.error(`[anillo2] ${turnos.length} turnos medibles de ${cuenta.lineas} líneas`);

  const informe = {
    fecha: new Date().toISOString(),
    capturas: ficheros.map((f) => f.split("/").pop()),
    turnos: turnos.length,
    descartes: cuenta,
    ...resumir(turnos),
  };

  const salida = join("benchmarks", "out", `anillo2-dias-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(join("benchmarks", "out"), { recursive: true });
  writeFileSync(salida, JSON.stringify(informe, null, 2));
  console.error(`[anillo2] artefacto: ${salida}`);
  console.log(JSON.stringify(informe, null, 2));
}

main().catch((e) => {
  console.error("[anillo2] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});

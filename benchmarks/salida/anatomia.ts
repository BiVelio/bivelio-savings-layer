/**
 * SALIDA · ANATOMÍA — EL ARNÉS. Lee TODAS las capturas del espía
 * (~/.bvsala-f0/captura-*.jsonl, gigabytes) en streaming y reduce cada
 * petición a números con anatomia-nucleo.ts: cuánto de la salida es texto
 * para el humano, cuánto JSON de tool_use (y de qué herramienta), cuánto
 * thinking, cuánto se trunca, cuánto repite lo que acaba de leer, y cuánto
 * dinero es cada cosa frente a la entrada.
 *
 * PRIVACIDAD (misma doctrina que sombra-corpus / anillo2): del contenido no
 * sale NADA — ni prompts, ni respuestas, ni tool_results. Cada línea se
 * prefiltra por substring, se parsea, se reduce a cifras y se descarta; el
 * texto de una respuesta vive lo que dura `anatomiaDeSse`. MEMORIA: readline
 * línea a línea; jamás se carga un fichero entero.
 *
 * Uso:  npx tsx benchmarks/salida/anatomia.ts [captura.jsonl ...]
 *       (sin argumentos: todas las capturas de ~/.bvsala-f0)
 * Salida: benchmarks/out/salida-anatomia-<fecha>.json + tabla por stderr.
 */
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { costeMedido } from "../../gateway/medidor.js";
import {
  acumuladorVacio,
  agregar,
  anatomiaDeJson,
  anatomiaDeSse,
  resumir,
  resumirEstratificado,
  textoDelCuerpo,
  ultimoToolResult,
  usageFusionado,
  type Acumulador,
  type MedidaPeticion,
  type Resumen,
  type UsoConSalida,
} from "./anatomia-nucleo.js";

/** Lo que este arnés lee de un registro del espía (el resto se ignora). */
interface Registro {
  at?: string;
  method?: string;
  path?: string;
  requestBody?: { model?: unknown; messages?: unknown };
  sse?: { usage?: { usage: UsoConSalida }[] };
  responseBodyBase64?: string;
  responseBodyOmitted?: string;
}

interface Cuenta {
  lineas: number;
  candidatas: number;
  ilegibles: number;
  sinUsage: number;
  sinPrecio: number;
  cuerpoOmitido: number;
  cuerpoIlegible: number;
}

const PREFILTRO = '"path":"/v1/messages"';

/** usage de una respuesta JSON (stream:false): viene en el propio cuerpo. */
function usageDeJson(utf8: string): UsoConSalida | null {
  try {
    const d = JSON.parse(utf8) as { usage?: UsoConSalida };
    return d.usage ?? null;
  } catch {
    return null;
  }
}

/** Reduce UN registro a una medida; null si no es medible (y por qué en `cuenta`). */
export function medir(r: Registro, cuenta: Cuenta): MedidaPeticion | null {
  const cuerpo = r.responseBodyBase64 ? Buffer.from(r.responseBodyBase64, "base64").toString("utf8") : null;
  const uso = r.sse?.usage?.length ? (usageFusionado(r.sse.usage) as UsoConSalida | null) : cuerpo ? usageDeJson(cuerpo) : null;
  if (!uso) {
    cuenta.sinUsage += 1;
    return null;
  }
  const model = typeof r.requestBody?.model === "string" ? r.requestBody.model : "";
  const medido = model ? costeMedido(model, uso) : null;
  if (!medido) {
    cuenta.sinPrecio += 1;
    return null;
  }
  const salidaUsd = (medido.tokens.salida / 1_000) * medido.precio.outputPer1k;
  let anatomia: MedidaPeticion["anatomia"] = null;
  if (cuerpo === null) {
    cuenta.cuerpoOmitido += 1;
  } else {
    // Las fuentes de repetición se extraen y se pasan al núcleo, que devuelve
    // solo fracciones; ni el texto ni el cuerpo sobreviven a esta función.
    const fuentes = {
      ultimoToolResult: ultimoToolResult(r.requestBody?.messages),
      cuerpo: Array.isArray(r.requestBody?.messages) ? textoDelCuerpo(r.requestBody.messages) : null,
    };
    anatomia = r.sse ? anatomiaDeSse(cuerpo, fuentes) : anatomiaDeJson(cuerpo, fuentes);
    if (!anatomia) cuenta.cuerpoIlegible += 1;
  }
  return {
    model,
    tokensSalida: medido.tokens.salida,
    thinkingTokens: uso.output_tokens_details?.thinking_tokens ?? 0,
    salidaUsd,
    entradaUsd: medido.costeUsd - salidaUsd,
    anatomia,
  };
}

async function leer(
  ruta: string,
  porModelo: Map<string, Acumulador>,
  global: Acumulador,
  cuenta: Cuenta,
  rango: { desde: string | null; hasta: string | null },
): Promise<void> {
  const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
  for await (const linea of rl) {
    if (!linea) continue;
    cuenta.lineas += 1;
    // Prefiltro por substring ANTES de parsear: la mayor parte de los bytes del
    // fichero vivo son cuerpos base64 de respuestas; parsear cada línea entera
    // solo para descartarla costaría más que leerla.
    if (!linea.includes(PREFILTRO)) continue;
    cuenta.candidatas += 1;
    let r: Registro;
    try {
      r = JSON.parse(linea) as Registro;
    } catch {
      cuenta.ilegibles += 1;
      continue;
    }
    if (r.method !== "POST" || r.path !== "/v1/messages") continue;
    const m = medir(r, cuenta);
    if (!m) continue;
    if (r.at) {
      if (rango.desde === null || r.at < rango.desde) rango.desde = r.at;
      if (rango.hasta === null || r.at > rango.hasta) rango.hasta = r.at;
    }
    agregar(global, m);
    let acum = porModelo.get(m.model);
    if (!acum) porModelo.set(m.model, (acum = acumuladorVacio()));
    agregar(acum, m);
  }
}

/** La tabla que va por stderr: una fila por modelo y la global. */
function tabla(filas: [string, Resumen][]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const cab = [
    "modelo".padEnd(22),
    "pet".padStart(6),
    "tokSal".padStart(10),
    "p50".padStart(6),
    "p95".padStart(7),
    "máx".padStart(7),
    "think%".padStart(7),
    "text%".padStart(7),
    "tool%".padStart(7),
    "thk%".padStart(7),
    "trunc%".padStart(7),
    "$sal".padStart(9),
    "$ent".padStart(9),
    "sal/$%".padStart(7),
    "$text".padStart(7),
    "$tool".padStart(7),
    "$thk".padStart(7),
    "rep".padStart(6),
    "repC".padStart(6),
  ].join(" ");
  const cuerpo = filas.map(([modelo, r]) =>
    [
      modelo.slice(0, 22).padEnd(22),
      String(r.peticiones).padStart(6),
      String(r.tokensSalida.total).padStart(10),
      String(r.tokensSalida.p50).padStart(6),
      String(r.tokensSalida.p95).padStart(7),
      String(r.tokensSalida.max).padStart(7),
      pct(r.thinking.shareDeSalida).padStart(7),
      pct(r.chars.share.text).padStart(7),
      pct(r.chars.share.tool_use).padStart(7),
      pct(r.chars.share.thinking).padStart(7),
      pct(r.truncadas.share).padStart(7),
      r.dinero.salidaUsd.toFixed(2).padStart(9),
      r.dinero.entradaUsd.toFixed(2).padStart(9),
      pct(r.dinero.shareSalida).padStart(7),
      pct(r.dinero.shareDeSalidaPorMasaCalibrado.text).padStart(7),
      pct(r.dinero.shareDeSalidaPorMasaCalibrado.tool_use).padStart(7),
      pct(r.dinero.shareDeSalidaPorMasaCalibrado.thinking).padStart(7),
      r.repeticion.ponderada.toFixed(3).padStart(6),
      r.repeticionCuerpo.ponderada.toFixed(3).padStart(6),
    ].join(" "),
  );
  return [cab, ...cuerpo].join("\n");
}

async function main(): Promise<void> {
  const DIR = join(homedir(), ".bvsala-f0");
  const ficheros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(DIR)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(DIR, f));
  if (!ficheros.length) {
    console.error("[anatomia] no hay capturas; graba con scripts/espia-anthropic.mjs");
    process.exit(1);
  }

  const porModelo = new Map<string, Acumulador>();
  const global = acumuladorVacio();
  const cuenta: Cuenta = { lineas: 0, candidatas: 0, ilegibles: 0, sinUsage: 0, sinPrecio: 0, cuerpoOmitido: 0, cuerpoIlegible: 0 };
  const rango = { desde: null as string | null, hasta: null as string | null };
  const t0 = Date.now();
  for (const f of ficheros) {
    console.error(`[anatomia] leyendo ${f.split("/").pop()} …`);
    await leer(f, porModelo, global, cuenta, rango);
    console.error(`[anatomia]   acumulado: ${global.peticiones} peticiones (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }

  const modelos = [...porModelo.entries()].sort((a, b) => b[1].salidaUsd - a[1].salidaUsd);
  const informe = {
    fecha: new Date().toISOString(),
    version: "salida-anatomia-v1",
    nota: [
      "Caracteres = String.length (UTF-16). proxyTokens = chars/4 es un PROXY que en este corpus NO vale (infra-cuenta el texto ~40 %): chars.calibracion trae los chars/token MEDIDOS en respuestas casi puras de prosa y de JSON (agregados 06-09: 2,38 y 1,98; p50 por petición 2,30 y 1,70). dinero.porMasa reparte lo visible por caracteres (infla el texto); dinero.porMasaCalibrado lo corrige con esos ratios — es la cifra a citar.",
      "Los bloques text NO son todos para el humano: incluyen llamadas internas de Claude Code (sonnet-5, stop_sequence) y respuestas finales de subagentes que vuelven al padre como tool_result. Es un techo de lo que un estilo de salida puede acortar, no una masa humana.",
      "repeticion = fracción de shingles distintos de 40 chars del texto para el humano (bloques text) presentes en el último tool_result de la petición; repeticionCuerpo = la misma contra todo el texto previo del cuerpo (usuario+asistente+tool_results); 'ponderada' pesa por shingles.",
      "thinking: el contenido NO viaja en el stream (thinking_delta con thinking:'' + estimated_tokens); se mide en tokens (usage.output_tokens_details.thinking_tokens). chars.firma = signature_delta, ni legible ni salida facturada.",
      "Dinero: outputPer1k del catálogo × output_tokens; entradaUsd = costeMedido − salida (primas de caché incluidas). Descriptivo: jamás base de comisión.",
      "Solo cifras: del contenido del corpus no sale nada.",
    ],
    capturas: ficheros.map((f) => f.split("/").pop()),
    rango,
    descartes: cuenta,
    // El calibrado global se suma por modelo (precios distintos): ver el porqué en resumirEstratificado.
    global: resumirEstratificado(global, modelos.map(([, a]) => a)),
    porModelo: Object.fromEntries(modelos.map(([m, a]) => [m, resumir(a)])),
  };

  // Con capturas explícitas es una corrida PARCIAL: nombre aparte, para no
  // pisar en silencio el artefacto del corpus entero del mismo día.
  const parcial = process.argv.slice(2).length ? "-parcial" : "";
  const salida = join("benchmarks", "out", `salida-anatomia-${new Date().toISOString().slice(0, 10)}${parcial}.json`);
  mkdirSync(join("benchmarks", "out"), { recursive: true });
  writeFileSync(salida, JSON.stringify(informe, null, 2));

  console.error("");
  console.error(tabla([...modelos.map(([m, a]) => [m, resumir(a)] as [string, Resumen]), ["GLOBAL", informe.global]]));
  console.error("");
  console.error(`[anatomia] descartes: ${JSON.stringify(cuenta)}`);
  console.error(`[anatomia] artefacto: ${salida}`);
}

// Solo corre como script; importado (tests) no toca disco.
if (process.argv[1]?.endsWith("anatomia.ts")) {
  main().catch((e) => {
    console.error("[anatomia] error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

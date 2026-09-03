/**
 * S2.4 · EL REPLAY DEL CORPUS — corre las TRES políticas de elisión candidatas
 * (gateway/sombra.ts) sobre las capturas reales del espía (~/.bvsala-f0) y las
 * compara en DINERO contra un baseline simulado con el MISMO simulador, de
 * forma que el sesgo del modelo de caché se anula al comparar.
 *
 * Por qué un replay y no la aritmética predictiva de S2.5: sobre el corpus el
 * futuro de cada sesión YA PASÓ — no hace falta predecir cuántos turnos leerán
 * un bloque, se cuenta. La aritmética amortizada queda para el carril vivo,
 * donde el futuro no existe todavía.
 *
 * PRIVACIDAD (la misma doctrina que el análisis S1): del contenido de las
 * capturas no sale NADA — cada petición se compacta a metadatos por bloque en
 * cuanto se lee y el cuerpo se suelta; la salida son solo agregados. Una línea
 * ilegible se cuenta y se salta; jamás se imprime.
 *
 * MEMORIA: las capturas suman gigabytes y una línea puede medir megabytes —
 * el fichero se lee en STREAMING línea a línea (readFileSync entero revienta
 * el tope de string de Node con la captura de 3+ GB).
 *
 * Uso:  pnpm sombra:corpus [captura.jsonl ...]
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  POLITICAS,
  V2_PRESUPUESTO_BYTES,
  aplicarPolitica,
  compactarCuerpo,
  identidad,
  simularSesion,
  type CosteSimulado,
  type Politica,
  type TurnoSombra,
} from "../gateway/sombra.js";
import { costeMedido, type UsoSse } from "../gateway/medidor.js";

interface Registro {
  id?: number;
  at?: string;
  method?: string;
  path?: string;
  clientPort?: number;
  requestHeaders?: Record<string, string>;
  requestBody?: { model?: unknown; messages?: unknown; system?: unknown; tools?: unknown };
  sse?: { usage?: { usage: UsoSse }[] };
  responseBodyBase64?: string;
  status?: number;
}

/** El usage definitivo (la misma fusión que el ObservadorSse del gateway). */
function usageDe(r: Registro): UsoSse | null {
  if (r.sse?.usage?.length) {
    let uso: UsoSse = {};
    let tuvoDesglose = false;
    let desglose: NonNullable<UsoSse["cache_creation"]> = {};
    for (const { usage } of r.sse.usage) {
      // El desglose anidado se FUSIONA, no se pisa (la regla del ObservadorSse).
      if (usage.cache_creation) {
        tuvoDesglose = true;
        desglose = { ...desglose, ...usage.cache_creation };
      }
      uso = { ...uso, ...usage };
    }
    if (tuvoDesglose) uso.cache_creation = desglose;
    return uso;
  }
  if (r.responseBodyBase64 && !r.sse) {
    try {
      const d = JSON.parse(Buffer.from(r.responseBodyBase64, "base64").toString("utf8")) as { usage?: UsoSse };
      return d.usage ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function entradaReal(uso: UsoSse): number {
  const escritura =
    uso.cache_creation_input_tokens ??
    (uso.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return (uso.input_tokens ?? 0) + (uso.cache_read_input_tokens ?? 0) + escritura;
}

/** Clave de sesión: cabecera de Claude Code → hash del primer mensaje → puerto
 *  (el mismo orden de robustez que el análisis S1). */
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

interface TurnoConSesion extends TurnoSombra {
  id: number;
  sesion: string;
  /** Dinero REAL del turno a contador del proveedor (para calibrar y para el
   *  denominador «sobre el coste total»). */
  realEntradaUsd: number;
  realSalidaUsd: number;
}

async function leer(ruta: string, turnos: TurnoConSesion[], cuenta: { lineas: number; ilegibles: number; sinUsage: number; sinCuerpo: number }) {
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
    const uso = usageDe(r);
    if (!uso) {
      cuenta.sinUsage += 1;
      continue;
    }
    const model = typeof r.requestBody?.model === "string" ? r.requestBody.model : "";
    const medido = model ? costeMedido(model, uso) : null;
    if (!medido) {
      cuenta.sinUsage += 1;
      continue;
    }
    const salidaUsd = (medido.tokens.salida / 1_000) * medido.precio.outputPer1k;
    turnos.push({
      id: r.id ?? cuenta.lineas,
      // La cadena de prefijos es por (sesión, MODELO): una sesión de Claude
      // Code entrelaza el modelo principal con llamadas haiku (títulos,
      // resúmenes) que son conversaciones distintas — encadenarlas rompería
      // el prefijo en cada alternancia y el simulador cobraría escrituras
      // que la caché real (que es un árbol, no un «último turno») nunca cobró.
      sesion: `${claveDeSesion(r, fichero)}·${model}`,
      bloques: compactarCuerpo(r.requestBody!),
      at: r.at ? Date.parse(r.at) : 0,
      model,
      entradaReal: entradaReal(uso),
      escritura1h: (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0,
      realEntradaUsd: medido.costeUsd - salidaUsd,
      realSalidaUsd: salidaUsd,
    });
  }
}

function sumar(a: CosteSimulado, b: CosteSimulado): CosteSimulado {
  return {
    lecturaUsd: a.lecturaUsd + b.lecturaUsd,
    escrituraUsd: a.escrituraUsd + b.escrituraUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    tokensLeidos: a.tokensLeidos + b.tokensLeidos,
    tokensEscritos: a.tokensEscritos + b.tokensEscritos,
    tokensInvalidados: a.tokensInvalidados + b.tokensInvalidados,
    invalidacionUsd: a.invalidacionUsd + b.invalidacionUsd,
  };
}

const vacio = (): CosteSimulado => ({
  lecturaUsd: 0,
  escrituraUsd: 0,
  totalUsd: 0,
  tokensLeidos: 0,
  tokensEscritos: 0,
  tokensInvalidados: 0,
  invalidacionUsd: 0,
});

async function main() {
  const DIR = join(homedir(), ".bvsala-f0");
  const ficheros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(DIR)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(DIR, f));
  if (!ficheros.length) {
    console.error("[sombra] no hay capturas; graba una con scripts/espia-anthropic.mjs");
    process.exit(1);
  }

  // El dial de sensibilidad de v2/v2m (bytes de presupuesto); defecto: el del plan.
  const presupuestoV2 = Number(process.env["BVSALA_SOMBRA_V2_BYTES"]) || undefined;

  const turnos: TurnoConSesion[] = [];
  const cuenta = { lineas: 0, ilegibles: 0, sinUsage: 0, sinCuerpo: 0 };
  for (const f of ficheros) {
    console.error(`[sombra] leyendo ${f.split("/").pop()} …`);
    await leer(f, turnos, cuenta);
  }

  // Anatomía de la masa tool_result por clase (explica qué puede tocar v1).
  const porClase = new Map<string, { n: number; bytes: number; bytesV1: number }>();
  let bytesPrompt = 0;
  for (const t of turnos) {
    for (const b of t.bloques) {
      bytesPrompt += b.bytes;
      if (!b.tipo.endsWith(":tool_result")) continue;
      const c = porClase.get(b.clase) ?? porClase.set(b.clase, { n: 0, bytes: 0, bytesV1: 0 }).get(b.clase)!;
      c.n += 1;
      c.bytes += b.bytes;
      c.bytesV1 += b.bytesV1;
    }
  }
  console.error(`[sombra] ${turnos.length} turnos medibles de ${cuenta.lineas} líneas (ilegibles ${cuenta.ilegibles}, sin usage ${cuenta.sinUsage}, sin cuerpo ${cuenta.sinCuerpo})`);

  const sesiones = new Map<string, TurnoConSesion[]>();
  for (const t of turnos) (sesiones.get(t.sesion) ?? sesiones.set(t.sesion, []).get(t.sesion)!).push(t);
  for (const grupo of sesiones.values()) grupo.sort((a, b) => a.id - b.id);

  // ── el replay: baseline + tres políticas, misma vara ──
  type Variante = "baseline" | Politica;
  const porVariante = new Map<Variante, CosteSimulado>([["baseline", vacio()]]);
  const porModelo = new Map<string, Map<Variante, CosteSimulado>>();
  for (const p of POLITICAS) porVariante.set(p, vacio());

  let realEntradaUsd = 0;
  let realSalidaUsd = 0;
  for (const grupo of sesiones.values()) {
    for (const t of grupo) {
      realEntradaUsd += t.realEntradaUsd;
      realSalidaUsd += t.realSalidaUsd;
    }
    const modelo = grupo[0]!.model;
    const deModelo = porModelo.get(modelo) ?? porModelo.set(modelo, new Map()).get(modelo)!;
    const corre = (variante: Variante, transformar: Parameters<typeof simularSesion>[1]) => {
      const c = simularSesion(grupo, transformar);
      porVariante.set(variante, sumar(porVariante.get(variante) ?? vacio(), c));
      deModelo.set(variante, sumar(deModelo.get(variante) ?? vacio(), c));
    };
    corre("baseline", (b) => identidad(b));
    for (const p of POLITICAS) corre(p, (b, estado, turno) => aplicarPolitica(p, b, estado, turno, presupuestoV2));
  }

  const base = porVariante.get("baseline")!;
  const resumen = (c: CosteSimulado) => ({
    simUsd: Math.round(c.totalUsd * 100) / 100,
    ahorroSimUsd: Math.round((base.totalUsd - c.totalUsd) * 100) / 100,
    ahorroPct: base.totalUsd > 0 ? Math.round(((base.totalUsd - c.totalUsd) / base.totalUsd) * 1000) / 10 : null,
    invalidacionUsd: Math.round(c.invalidacionUsd * 100) / 100,
    tokensInvalidadosM: Math.round(c.tokensInvalidados / 1e5) / 10,
    ahorroSobreRealEntradaUsd:
      base.totalUsd > 0 ? Math.round(((base.totalUsd - c.totalUsd) / base.totalUsd) * realEntradaUsd * 100) / 100 : null,
  });

  const informe = {
    fecha: new Date().toISOString(),
    capturas: ficheros.map((f) => f.split("/").pop()),
    turnos: turnos.length,
    sesiones: sesiones.size,
    presupuestoV2Bytes: presupuestoV2 ?? V2_PRESUPUESTO_BYTES,
    descartes: cuenta,
    dineroReal: {
      entradaUsd: Math.round(realEntradaUsd * 100) / 100,
      salidaUsd: Math.round(realSalidaUsd * 100) / 100,
      totalUsd: Math.round((realEntradaUsd + realSalidaUsd) * 100) / 100,
    },
    calibracion: {
      simBaselineUsd: Math.round(base.totalUsd * 100) / 100,
      nota: "baseline simulado vs entrada real medida — el ahorro se compara SIEMPRE dentro del simulador (misma vara) y el % se aplica al dinero real de entrada",
      ratioSimSobreReal: realEntradaUsd > 0 ? Math.round((base.totalUsd / realEntradaUsd) * 1000) / 1000 : null,
    },
    masaToolResult: Object.fromEntries(
      [...porClase.entries()].map(([clase, c]) => [
        clase,
        {
          bloques: c.n,
          bytesM: Math.round(c.bytes / 1e5) / 10,
          pctDelPrompt: bytesPrompt > 0 ? Math.round((c.bytes / bytesPrompt) * 1000) / 10 : null,
          reduccionV1Pct: c.bytes > 0 ? Math.round((1 - c.bytesV1 / c.bytes) * 1000) / 10 : null,
        },
      ]),
    ),
    politicas: Object.fromEntries(POLITICAS.map((p) => [p, resumen(porVariante.get(p)!)])),
    porModelo: Object.fromEntries(
      [...porModelo.entries()].map(([modelo, variantes]) => {
        const b = variantes.get("baseline") ?? vacio();
        return [
          modelo,
          Object.fromEntries(
            POLITICAS.filter((p) => variantes.has(p)).map((p) => {
              const c = variantes.get(p)!;
              return [
                p,
                {
                  simBaselineUsd: Math.round(b.totalUsd * 100) / 100,
                  simUsd: Math.round(c.totalUsd * 100) / 100,
                  ahorroPct: b.totalUsd > 0 ? Math.round(((b.totalUsd - c.totalUsd) / b.totalUsd) * 1000) / 10 : null,
                  invalidacionUsd: Math.round(c.invalidacionUsd * 100) / 100,
                },
              ];
            }),
          ),
        ];
      }),
    ),
    doctrina:
      "sombra: hipotético por construcción — jamás base de comisión, jamás sumado a measured; la salida no cambia (la elisión solo toca la entrada) y el efecto de segundo orden sobre el comportamiento del modelo NO es medible en replay",
  };

  const sufijo = presupuestoV2 ? `-v2-${Math.round(presupuestoV2 / 1024)}k` : "";
  const salida = join("benchmarks", "out", `sombra-corpus-${new Date().toISOString().slice(0, 10)}${sufijo}.json`);
  mkdirSync(join("benchmarks", "out"), { recursive: true });
  writeFileSync(salida, JSON.stringify(informe, null, 2));
  console.error(`[sombra] artefacto: ${salida}`);
  console.log(JSON.stringify(informe, null, 2));
}

main().catch((e) => {
  console.error("[sombra] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});

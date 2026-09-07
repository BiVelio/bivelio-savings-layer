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
 * EL REPARTO — la verja de honestidad del artefacto: por modelo, el baseline
 * simulado frente al contador del PROVEEDOR (leídos, escritos y entrada sin
 * caché, en tokens). Un baseline que no reproduce la factura no puede medir
 * ahorros sobre ella: el del 07-09 inflaba la escritura 2,6× en opus-4-8
 * (21,2 M simulados frente a 8,09 M reales) porque el hash de bloque llevaba
 * el `cache_control` dentro y Claude Code lo mueve al último mensaje en cada
 * turno. `--verja-reparto=<pct>` hace fallar el replay cuando un modelo con
 * más del 1 % del coste real supera ese error de escritura.
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
 * Uso:  pnpm sombra:corpus [captura.jsonl ...] [--salida=<ruta.json>] [--verja-reparto=<pct>]
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import {
  CacheDePrefijos,
  CadenaDeSimulacion,
  POLITICAS,
  V2_PRESUPUESTO_BYTES,
  aplicarPolitica,
  compactarCuerpo,
  identidad,
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

/** Los tres contadores de entrada del proveedor, tal cual los factura. */
function contadores(uso: UsoSse): { entrada: number; leidos: number; escritos: number } {
  const escritos =
    uso.cache_creation_input_tokens ??
    (uso.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return { entrada: uso.input_tokens ?? 0, leidos: uso.cache_read_input_tokens ?? 0, escritos };
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
  /** El contador del PROVEEDOR en tokens: la vara del reparto. */
  prov: { entrada: number; leidos: number; escritos: number };
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
    const prov = contadores(uso);
    turnos.push({
      id: r.id ?? cuenta.lineas,
      // La cadena de prefijos es por (sesión, MODELO): una sesión de Claude
      // Code entrelaza el modelo principal con llamadas haiku (títulos,
      // resúmenes) que son conversaciones distintas — encadenarlas rompería
      // el prefijo en cada alternancia y el simulador cobraría escrituras
      // que la caché real (que es un árbol, no un «último turno») nunca cobró.
      sesion: `${claveDeSesion(r, fichero)}·${model}`,
      bloques: compactarCuerpo(r.requestBody!),
      // El `at` del espía es el INICIO de la petición: desde ahí mide el
      // proveedor el TTL de cada entrada de caché.
      at: r.at ? Date.parse(r.at) : 0,
      model,
      entradaReal: prov.entrada + prov.leidos + prov.escritos,
      escritura1h: (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0,
      realEntradaUsd: medido.costeUsd - salidaUsd,
      realSalidaUsd: salidaUsd,
      prov,
    });
  }
}

function sumar(a: CosteSimulado, b: CosteSimulado): CosteSimulado {
  return {
    lecturaUsd: a.lecturaUsd + b.lecturaUsd,
    escrituraUsd: a.escrituraUsd + b.escrituraUsd,
    entradaUsd: a.entradaUsd + b.entradaUsd,
    totalUsd: a.totalUsd + b.totalUsd,
    tokensLeidos: a.tokensLeidos + b.tokensLeidos,
    tokensEscritos: a.tokensEscritos + b.tokensEscritos,
    tokensEntrada: a.tokensEntrada + b.tokensEntrada,
    tokensInvalidados: a.tokensInvalidados + b.tokensInvalidados,
    invalidacionUsd: a.invalidacionUsd + b.invalidacionUsd,
  };
}

const vacio = (): CosteSimulado => ({
  lecturaUsd: 0,
  escrituraUsd: 0,
  entradaUsd: 0,
  totalUsd: 0,
  tokensLeidos: 0,
  tokensEscritos: 0,
  tokensEntrada: 0,
  tokensInvalidados: 0,
  invalidacionUsd: 0,
});

/** Un modelo cuenta para la verja de reparto si pesa más de esto en el coste real. */
const MASA_MINIMA_VERJA_PCT = 1;

/** Error relativo (sim − real) / real, en % con un decimal; null sin denominador. */
const errorPct = (sim: number, real: number): number | null => (real > 0 ? Math.round(((sim - real) / real) * 1000) / 10 : null);

async function main() {
  const DIR = join(homedir(), ".bvsala-f0");
  const args = process.argv.slice(2);
  const opcion = (nombre: string): string | undefined => args.find((a) => a.startsWith(`--${nombre}=`))?.slice(nombre.length + 3);
  const salidaPedida = opcion("salida");
  const verjaReparto = opcion("verja-reparto") !== undefined ? Number(opcion("verja-reparto")) : null;
  if (verjaReparto !== null && !(verjaReparto > 0)) {
    console.error("[sombra] --verja-reparto necesita un porcentaje > 0");
    process.exit(1);
  }
  const posicionales = args.filter((a) => !a.startsWith("--"));
  const ficheros = posicionales.length
    ? posicionales
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

  // Las cadenas son por (sesión, modelo), pero la CACHÉ de prefijos es de la
  // organización: se comparte por modelo y variante. Para que vea los aciertos
  // cruzados (un subagente que lee el prefijo tools+system que su padre
  // escribió) el replay alimenta TODAS las sesiones en orden temporal global,
  // no sesión a sesión.
  const sesiones = new Set(turnos.map((t) => t.sesion));
  turnos.sort((a, b) => a.at - b.at || a.id - b.id);

  // ── el replay: baseline + tres políticas, misma vara ──
  type Variante = "baseline" | Politica;
  const porVariante = new Map<Variante, CosteSimulado>([["baseline", vacio()]]);
  const porModelo = new Map<string, Map<Variante, CosteSimulado>>();
  for (const p of POLITICAS) porVariante.set(p, vacio());

  let realEntradaUsd = 0;
  let realSalidaUsd = 0;
  const realPorModelo = new Map<string, { usd: number; entrada: number; leidos: number; escritos: number }>();
  for (const t of turnos) {
    realEntradaUsd += t.realEntradaUsd;
    realSalidaUsd += t.realSalidaUsd;
    const r = realPorModelo.get(t.model) ?? realPorModelo.set(t.model, { usd: 0, entrada: 0, leidos: 0, escritos: 0 }).get(t.model)!;
    r.usd += t.realEntradaUsd + t.realSalidaUsd;
    r.entrada += t.prov.entrada;
    r.leidos += t.prov.leidos;
    r.escritos += t.prov.escritos;
  }

  const corre = (variante: Variante, transformar: ConstructorParameters<typeof CadenaDeSimulacion>[0]) => {
    const cachesPorModelo = new Map<string, CacheDePrefijos>();
    const cadenas = new Map<string, CadenaDeSimulacion>();
    for (const t of turnos) {
      let cadena = cadenas.get(t.sesion);
      if (!cadena) {
        const cache = cachesPorModelo.get(t.model) ?? cachesPorModelo.set(t.model, new CacheDePrefijos()).get(t.model)!;
        cadena = new CadenaDeSimulacion(transformar, cache);
        cadenas.set(t.sesion, cadena);
      }
      const c = cadena.paso(t);
      porVariante.set(variante, sumar(porVariante.get(variante) ?? vacio(), c));
      const deModelo = porModelo.get(t.model) ?? porModelo.set(t.model, new Map()).get(t.model)!;
      deModelo.set(variante, sumar(deModelo.get(variante) ?? vacio(), c));
    }
  };
  corre("baseline", (b) => identidad(b));
  for (const p of POLITICAS) corre(p, (b, estado, turno) => aplicarPolitica(p, b, estado, turno, presupuestoV2));

  const base = porVariante.get("baseline")!;

  // ── el reparto: baseline simulado vs contador del proveedor, por modelo ──
  const realTotalUsd = realEntradaUsd + realSalidaUsd;
  const reparto = Object.fromEntries(
    [...realPorModelo.entries()].map(([modelo, r]) => {
      const b = porModelo.get(modelo)?.get("baseline") ?? vacio();
      return [
        modelo,
        {
          pctDelCoste: realTotalUsd > 0 ? Math.round((r.usd / realTotalUsd) * 1000) / 10 : null,
          leidosProv: r.leidos,
          escritosProv: r.escritos,
          entradaProv: r.entrada,
          leidosSim: Math.round(b.tokensLeidos),
          escritosSim: Math.round(b.tokensEscritos),
          entradaSim: Math.round(b.tokensEntrada),
          errorLecturaPct: errorPct(b.tokensLeidos, r.leidos),
          errorEscrituraPct: errorPct(b.tokensEscritos, r.escritos),
          errorEntradaPct: errorPct(b.tokensEntrada, r.entrada),
        },
      ];
    }),
  );
  // Solo los modelos con MASA deciden: un modelo con 5 turnos y un 0,03 % del
  // coste puede dar un error enorme sin que signifique nada.
  const enRojo =
    verjaReparto === null
      ? []
      : Object.entries(reparto)
          .filter(([, r]) => (r.pctDelCoste ?? 0) > MASA_MINIMA_VERJA_PCT && r.errorEscrituraPct !== null && Math.abs(r.errorEscrituraPct) > verjaReparto)
          .map(([modelo, r]) => `${modelo}: ${r.errorEscrituraPct} % (masa ${r.pctDelCoste} %)`);

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
    reparto: {
      nota: "baseline simulado vs contador del proveedor, en TOKENS por modelo; error = (sim − real) / real. Es la verja de honestidad del artefacto: un baseline que no reproduce la factura no puede medir ahorros sobre ella. La verja solo mira la ESCRITURA de los modelos con masa (> masaMinimaPct del coste real).",
      verjaPct: verjaReparto,
      masaMinimaPct: MASA_MINIMA_VERJA_PCT,
      enRojo,
      porModelo: reparto,
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
  const salida = salidaPedida ?? join("benchmarks", "out", `sombra-corpus-${new Date().toISOString().slice(0, 10)}${sufijo}.json`);
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(salida, JSON.stringify(informe, null, 2));
  console.error(`[sombra] artefacto: ${salida}`);
  console.log(JSON.stringify(informe, null, 2));
  if (verjaReparto !== null) {
    if (enRojo.length) {
      console.error(`[sombra] VERJA DE REPARTO ROJA (> ${verjaReparto} %): ${enRojo.join(" · ")}`);
      process.exit(1);
    }
    console.error(`[sombra] verja de reparto en verde (≤ ${verjaReparto} % de error de escritura en todos los modelos con masa)`);
  }
}

main().catch((e) => {
  console.error("[sombra] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});

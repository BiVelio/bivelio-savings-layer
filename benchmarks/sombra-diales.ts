/**
 * S4a · ANILLO 0 — la sombra de los DIALES: mide contra `count_tokens` (con
 * `context_management`) cuánto habría borrado el proveedor con NUESTROS diales
 * sobre peticiones REALES del corpus, sin enviar nada al modelo y sin tocar un
 * byte de tráfico vivo. La respuesta trae `input_tokens` (tras la edición) y
 * `context_management.original_input_tokens`: el ahorro lo calcula el contador
 * del PROVEEDOR, no un simulador nuestro.
 *
 * PRIVACIDAD: los cuerpos se reenvían al MISMO proveedor que ya los procesó
 * (son capturas de tráfico hacia api.anthropic.com), solo al endpoint de
 * conteo, con lista blanca de campos (model/messages/system/tools + la
 * config). Ninguna credencial de la captura viaja (van redactadas de origen y
 * además no se copian cabeceras). La salida son SOLO agregados.
 *
 * MUESTREO: solo turnos cuya entrada real supera el trigger (donde el dial
 * puede morder), estratificado por sesión, con tope global de llamadas y
 * acelerador — count_tokens no factura tokens pero sí cuenta contra el rate
 * limit.
 *
 * Uso:  pnpm sombra:diales            (tope por defecto: 120 llamadas)
 *       BVSALA_DIALES_MAX=300 pnpm sombra:diales
 * Clave: BVSALA_DEMO_ANTHROPIC_API_KEY (la del banco, .env.bench).
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { BETA_CONTEXT_MANAGEMENT, DIAL_TRIGGER_INPUT_TOKENS, configDeDiales } from "../gateway/diales.js";
import type { UsoSse } from "../gateway/medidor.js";

interface Registro {
  id?: number;
  method?: string;
  path?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: { model?: unknown; messages?: unknown; system?: unknown; tools?: unknown; context_management?: unknown };
  sse?: { usage?: { usage: UsoSse }[] };
  clientPort?: number;
}

function entradaReal(uso: UsoSse): number {
  const escritura =
    uso.cache_creation_input_tokens ??
    (uso.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return (uso.input_tokens ?? 0) + (uso.cache_read_input_tokens ?? 0) + escritura;
}

function usageDe(r: Registro): UsoSse | null {
  if (!r.sse?.usage?.length) return null;
  let uso: UsoSse = {};
  for (const { usage } of r.sse.usage) uso = { ...uso, ...usage };
  return uso;
}

function claveDeSesion(r: Registro, fichero: string): string {
  const h = r.requestHeaders ?? {};
  const sid = h["x-claude-code-session-id"];
  if (sid) return `${fichero}·s:${sid}·a:${h["x-claude-code-agent-id"] ?? ""}`;
  const primero = Array.isArray(r.requestBody?.messages) ? (r.requestBody!.messages as unknown[])[0] : undefined;
  if (primero !== undefined) return `${fichero}·m:${createHash("sha256").update(JSON.stringify(primero)).digest("hex").slice(0, 16)}`;
  return `${fichero}·p:${r.clientPort ?? "?"}`;
}

/** Índice LIGERO de una candidata (pasada 1). El cuerpo NO se guarda: con
 *  gigabytes de capturas, retener los messages de todas las candidatas antes
 *  de muestrear revienta el heap (cazado en el humo del 03-09) — el cuerpo se
 *  relee en la pasada 2 y se suelta tras cada llamada. */
interface Candidata {
  clave: string; // fichero#id
  sesion: string;
  model: string;
  entradaReal: number;
  traiaConfig: boolean;
}

async function main() {
  const clave = process.env["BVSALA_DEMO_ANTHROPIC_API_KEY"];
  if (!clave) {
    console.error("[diales] falta BVSALA_DEMO_ANTHROPIC_API_KEY (corre con: tsx --env-file-if-exists=.env.bench …)");
    process.exit(1);
  }
  // La base del banco puede venir con o sin /v1 (la del .env.bench lo trae):
  // se normaliza para no fabricar /v1/v1/… (404 seco, cazado en el humo).
  const base = (process.env["BVSALA_DEMO_ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  const MAX = Number(process.env["BVSALA_DIALES_MAX"]) || 120;

  const DIR = join(homedir(), ".bvsala-f0");
  const ficheros = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(DIR)
        .filter((f) => f.startsWith("captura-") && f.endsWith(".jsonl"))
        .map((f) => join(DIR, f));

  // ── 1 · PASADA LIGERA: índice de candidatas (turnos ≥ trigger), sin cuerpos ──
  const porSesion = new Map<string, Candidata[]>();
  for (const ruta of ficheros) {
    const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
    const fichero = ruta.split("/").pop() ?? ruta;
    for await (const linea of rl) {
      if (!linea) continue;
      let r: Registro;
      try {
        r = JSON.parse(linea) as Registro;
      } catch {
        continue;
      }
      if (r.method !== "POST" || r.path !== "/v1/messages" || !Array.isArray(r.requestBody?.messages)) continue;
      const uso = usageDe(r);
      if (!uso) continue;
      const entrada = entradaReal(uso);
      if (entrada < DIAL_TRIGGER_INPUT_TOKENS) continue;
      const model = typeof r.requestBody!.model === "string" ? (r.requestBody!.model as string) : "";
      if (!model || r.id === undefined) continue;
      const sesion = claveDeSesion(r, fichero);
      const lista = porSesion.get(sesion) ?? porSesion.set(sesion, []).get(sesion)!;
      lista.push({
        clave: `${fichero}#${r.id}`,
        sesion,
        model,
        entradaReal: entrada,
        traiaConfig: r.requestBody!.context_management !== undefined,
      });
    }
  }

  // UNIFORME sobre todas las candidatas, en orden: es la distribución real del
  // tráfico por encima del trigger. (El primer muestreo era «una por sesión
  // empezando por la primera» — sesgaba hacia turnos tempranos con poca masa
  // tool_result y sobre-representaba sesiones haiku sin herramientas: 0
  // borrados en 6/6, cazado en el humo.)
  const sesiones = [...porSesion.values()].filter((l) => l.length > 0);
  const todas = sesiones.flat();
  const elegidas = new Map<string, Candidata>();
  const paso = Math.max(1, todas.length / MAX);
  for (let x = 0; x < todas.length && elegidas.size < MAX; x += paso) {
    const c = todas[Math.floor(x)]!;
    elegidas.set(c.clave, c);
  }
  console.error(`[diales] ${elegidas.size} muestras (de ${todas.length} turnos ≥ trigger en ${sesiones.length} sesiones)`);

  // ── 2 · SEGUNDA PASADA: releer SOLO las elegidas, llamar y soltar ──
  let llamadas = 0;
  let fallos = 0;
  let primerFallo = "";
  const filas: { model: string; original: number; editado: number; borrado: number; traiaConfig: boolean }[] = [];
  for (const ruta of ficheros) {
    const rl = createInterface({ input: createReadStream(ruta), crlfDelay: Infinity });
    const fichero = ruta.split("/").pop() ?? ruta;
    for await (const linea of rl) {
      if (!linea) continue;
      let r: Registro;
      try {
        r = JSON.parse(linea) as Registro;
      } catch {
        continue;
      }
      if (r.id === undefined) continue;
      const m = elegidas.get(`${fichero}#${r.id}`);
      if (!m || !Array.isArray(r.requestBody?.messages)) continue;
      const cuerpo = {
        model: m.model,
        messages: r.requestBody!.messages,
        ...(r.requestBody!.system !== undefined ? { system: r.requestBody!.system } : {}),
        ...(r.requestBody!.tools !== undefined ? { tools: r.requestBody!.tools } : {}),
      };
      llamadas += 1;
      try {
        const res = await fetch(`${base}/v1/messages/count_tokens`, {
          method: "POST",
          headers: {
            "x-api-key": clave,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": BETA_CONTEXT_MANAGEMENT,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...cuerpo, context_management: configDeDiales() }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          fallos += 1;
          if (!primerFallo) {
            const texto = await res.text().catch(() => "");
            primerFallo = `${res.status} ${texto.slice(0, 200)}`;
          }
        } else {
          const d = (await res.json()) as { input_tokens?: number; context_management?: { original_input_tokens?: number } };
          const editado = d.input_tokens ?? 0;
          const original = d.context_management?.original_input_tokens ?? editado;
          filas.push({ model: m.model, original, editado, borrado: Math.max(0, original - editado), traiaConfig: m.traiaConfig });
        }
      } catch (e) {
        fallos += 1;
        if (!primerFallo) primerFallo = e instanceof Error ? e.name : String(e);
      }
      // Acelerador: educado con el rate limit del endpoint de conteo.
      await new Promise((rr) => setTimeout(rr, 350));
    }
  }

  // ── 3 · agregados ──
  const conBorrado = filas.filter((f) => f.borrado > 0);
  const suma = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mediana = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };
  const totalOriginal = suma(filas.map((f) => f.original));
  const totalBorrado = suma(filas.map((f) => f.borrado));

  const informe = {
    fecha: new Date().toISOString(),
    diales: configDeDiales().edits[0],
    muestreo: { candidatas: sesiones.reduce((s, l) => s + l.length, 0), sesiones: sesiones.length, llamadas, fallos, ...(primerFallo ? { primerFallo } : {}) },
    resultado: {
      muestrasMedidas: filas.length,
      conBorrado: conBorrado.length,
      pctMuestrasConBorrado: filas.length ? Math.round((conBorrado.length / filas.length) * 1000) / 10 : null,
      tokensOriginalesTotales: totalOriginal,
      tokensBorradosTotales: totalBorrado,
      pctBorradoSobreOriginal: totalOriginal > 0 ? Math.round((totalBorrado / totalOriginal) * 1000) / 10 : null,
      borradoMedianoPorMuestraConBorrado: mediana(conBorrado.map((f) => f.borrado)),
      // El 75 % del corpus traía config del cliente CON CERO borrados en vivo:
      // todo lo borrado aquí es atribuible al cambio de diales.
      muestrasQueTraianConfigCliente: filas.filter((f) => f.traiaConfig).length,
    },
    porModelo: Object.fromEntries(
      [...new Set(filas.map((f) => f.model))].map((m) => {
        const del = filas.filter((f) => f.model === m);
        const o = suma(del.map((f) => f.original));
        const b = suma(del.map((f) => f.borrado));
        return [m, { muestras: del.length, pctBorrado: o > 0 ? Math.round((b / o) * 1000) / 10 : null }];
      }),
    ),
    doctrina:
      "anillo 0 de S4a: cifra del CONTADOR DEL PROVEEDOR (count_tokens + context_management), sin tocar tráfico; el % es sobre la entrada de los turnos por encima del trigger — la proyección a dinero/mes la hace el A/B del anillo 2, no este replay",
  };

  mkdirSync(join("benchmarks", "out"), { recursive: true });
  const salida = join("benchmarks", "out", `sombra-diales-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(salida, JSON.stringify(informe, null, 2));
  console.error(`[diales] artefacto: ${salida}`);
  console.log(JSON.stringify(informe, null, 2));
}

main().catch((e) => {
  console.error("[diales] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});

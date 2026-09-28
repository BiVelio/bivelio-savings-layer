/**
 * E6 · BV-SALA DELANTE DE LITELLM, CON LITELLM DE VERDAD — `pnpm litellm:e2e`.
 *
 *   bash benchmarks/delante-de-litellm/instalar-litellm.sh <dir-temporal>
 *   env -u BIVELIO_SERVICE_KEY -u BIVELIO_LICENSE_KEY \
 *     pnpm litellm:e2e --litellm <dir-temporal>/venv/bin/litellm [--guardar]
 *
 * Arranca, todo en 127.0.0.1:
 *   · el upstream falso del banco de latencia (benchmarks/latencia-gateways/
 *     upstream-falso.ts), con 300 ms de retardo para que dos peticiones
 *     coincidan en vuelo;
 *   · LiteLLM dos veces, con `litellm.yaml` (sin caché ni clave) y con
 *     `litellm-con-cache.yaml` (caché local y master key), en un entorno
 *     VACIADO (ni una variable de la shell: ni BIVELIO_*, ni proxies, ni claves),
 *     con HOME en un directorio temporal y la tabla de precios LOCAL
 *     (`LITELLM_LOCAL_MODEL_COST_MAP=True`: sin eso LiteLLM la baja de GitHub al
 *     arrancar);
 *   · el SDK y el gateway de BV-SALA desde el fuente, sin licencia real
 *     (`devUnlicensed` y la licencia efímera de los tests), midiendo contra una
 *     ingesta falsa local.
 *
 * Y comprueba, con los escenarios de `nucleo.ts`, lo mismo que el test de CI
 * comprueba contra el doble. `--guardar` escribe la evidencia fechada en
 * benchmarks/evidencia/delante-de-litellm-<fecha>.json, con las cabeceras que
 * LiteLLM mandó de verdad (el test ata el doble a ellas).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arrancarUpstreamFalso } from "../latencia-gateways/upstream-falso.js";
import { BV_SALA_VERSION } from "../../src/version.js";
import {
  CLAVE_DEL_PROXY,
  VERSION_LITELLM,
  coalescerConElGateway,
  rebajarTtlConElGateway,
  repetirConElSdk,
  type ResultadoDeRepeticion,
  type ResultadoDelGateway,
} from "./nucleo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, "..", "..");

function arg(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function puertoLibre(): Promise<number> {
  return new Promise((resolver, rechazar) => {
    const s = createServer();
    s.once("error", rechazar);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolver(p));
    });
  });
}

interface LiteLLMVivo {
  origen: string;
  proceso: ChildProcess;
  log: string[];
}

async function arrancarLiteLLM(bin: string, config: string, upstream: string, casa: string): Promise<LiteLLMVivo> {
  const puerto = await puertoLibre();
  const log: string[] = [];
  // Entorno VACIADO a propósito: el proceso de LiteLLM no hereda nada de la
  // shell (tampoco las BIVELIO_* de producción ni un HTTPS_PROXY).
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(bin)}:/usr/bin:/bin`,
    HOME: casa,
    LANG: "en_US.UTF-8",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    LITELLM_TELEMETRY: "False",
    E6_UPSTREAM: upstream,
    E6_UPSTREAM_OPENAI: `${upstream}/v1`,
  };
  const proceso = spawn(bin, ["--config", config, "--host", "127.0.0.1", "--port", String(puerto), "--telemetry", "False"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proceso.stdout?.on("data", (d: Buffer) => log.push(d.toString("utf8")));
  proceso.stderr?.on("data", (d: Buffer) => log.push(d.toString("utf8")));
  const origen = `http://127.0.0.1:${puerto}`;
  const t0 = Date.now();
  for (;;) {
    if (proceso.exitCode !== null) throw new Error(`LiteLLM salió con ${proceso.exitCode}:\n${log.join("")}`);
    try {
      const r = await fetch(`${origen}/health/liveliness`);
      if (r.ok) break;
    } catch {
      /* aún no escucha */
    }
    if (Date.now() - t0 > 60_000) throw new Error(`LiteLLM no escuchó en 60 s:\n${log.join("")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return { origen, proceso, log };
}

function parar(l: LiteLLMVivo): Promise<void> {
  return new Promise((r) => {
    if (l.proceso.exitCode !== null) return r();
    l.proceso.once("exit", () => r());
    l.proceso.kill("SIGTERM");
    setTimeout(() => l.proceso.kill("SIGKILL"), 5000).unref();
  });
}

/** Lo que el upstream recibió en último lugar (el espejo del banco). */
async function ultimaPeticion(upstream: string): Promise<string> {
  return (await fetch(`${upstream}/banco/ultima-peticion`)).text();
}

function nombres(h: Record<string, string> | undefined): string[] {
  return Object.keys(h ?? {}).sort();
}

function linea(etiqueta: string, ok: boolean, detalle: string): string {
  return `${ok ? "✓" : "✗"} ${etiqueta}: ${detalle}`;
}

function resumenSdk(r: ResultadoDeRepeticion) {
  return {
    primera: r.primera,
    segunda: r.segunda,
    veredictos: r.veredictos,
    cabecerasDelProxy: r.cabecerasDelProxy,
  };
}

function resumenGateway(r: ResultadoDelGateway) {
  return {
    estados: r.estados,
    lineas: r.lineas.filter((l) => l.startsWith("[gateway] POST")),
    registros: r.lotes.flatMap((l) => l.registros),
    veredictos: r.veredictos,
  };
}

async function main(): Promise<void> {
  const bin = arg("--litellm");
  if (!bin) {
    console.error("e2e: falta --litellm <venv>/bin/litellm (instálalo con instalar-litellm.sh)");
    process.exit(2);
  }
  const guardar = process.argv.includes("--guardar");
  const casa = mkdtempSync(join(tmpdir(), "e6-litellm-home-"));
  const upstream = await arrancarUpstreamFalso({ retardoMs: 300 });
  const origenUpstream = `http://127.0.0.1:${upstream.puerto}`;
  const vivos: LiteLLMVivo[] = [];
  const informe: string[] = [];
  let fallos = 0;
  const comprobar = (etiqueta: string, ok: boolean, detalle: string) => {
    if (!ok) fallos += 1;
    informe.push(linea(etiqueta, ok, detalle));
    console.log(informe.at(-1));
  };

  try {
    const plano = await arrancarLiteLLM(bin, join(AQUI, "litellm.yaml"), origenUpstream, casa);
    vivos.push(plano);
    const conCache = await arrancarLiteLLM(bin, join(AQUI, "litellm-con-cache.yaml"), origenUpstream, casa);
    vivos.push(conCache);
    const versionReal = (await fetch(`${plano.origen}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "version probe" }] }),
    })).headers.get("x-litellm-version");
    comprobar("versión", versionReal === VERSION_LITELLM, `LiteLLM dice ${versionReal}`);

    // S1 · Chat Completions, id del proveedor como model_name.
    const antes1 = upstream.recuento()["chat"] ?? 0;
    const s1 = await repetirConElSdk({ protocolo: "openai", base: `${plano.origen}/v1`, modelo: "openai/gpt-4o-mini" });
    const llegaron1 = (upstream.recuento()["chat"] ?? 0) - antes1;
    // Desde el 2026-09-28 (CERRADO 1): la repetición se sirve sin llegar a
    // LiteLLM, pero sale `estimated`: la llamada que corrió detrás del proxy no
    // dejó registro de referencia (`unofficial-origin`).
    comprobar("S1 (a) OpenAI por LiteLLM", s1.primera.basis === "measured" && s1.segunda.cacheResult === "exact" && s1.segunda.basis === "estimated" && llegaron1 === 1,
      `primera ${s1.primera.basis} (sin registro: ${s1.primera.referenceNotWritten ?? "—"}), segunda ${s1.segunda.basis} (${s1.segunda.cacheResult}); al upstream llegaron ${llegaron1}`);
    const v1 = s1.veredictos.find((v) => v.requestId === s1.segunda.requestId);
    comprobar("S1 CERRADO (b) en el SDK", s1.primera.referenceNotWritten === "unofficial-origin" && v1?.enLaBase === false,
      `ingerida como ${v1?.basisIngerido}, en la base de la comisión: ${v1?.enLaBase ? "SÍ" : "no"}`);

    // S2 · alias propio sin precio de lista.
    const s2 = await repetirConElSdk({ protocolo: "openai", base: `${plano.origen}/v1`, modelo: "equipo-rapido" });
    const v2 = s2.veredictos.find((v) => v.requestId === s2.segunda.requestId);
    comprobar("S2 alias sin precio", s2.segunda.basis === "estimated" && v2?.enLaBase === false,
      `primera ${s2.primera.basis}, segunda ${s2.segunda.basis} (${s2.segunda.referenceRejected ?? "—"}); en la base: ${v2?.enLaBase ? "SÍ" : "no"}`);

    // S3 · el mismo alias con precios propios declarados.
    const s3 = await repetirConElSdk({
      protocolo: "openai",
      base: `${plano.origen}/v1`,
      modelo: "equipo-rapido",
      costModels: { "equipo-rapido": { inputPer1k: 0.00015, outputPer1k: 0.0006, cachedInputPer1k: 0.000075 } },
    });
    const v3 = s3.veredictos.find((v) => v.requestId === s3.segunda.requestId);
    comprobar("S3 alias con costModels", s3.segunda.basis === "estimated" && v3?.enLaBase === false,
      `segunda ${s3.segunda.basis} (sin registro: ${s3.primera.referenceNotWritten ?? "—"}); en la base: ${v3?.enLaBase ? "SÍ" : "no"}`);

    // S4 · el paso de Anthropic (/v1/messages).
    const antes4 = upstream.recuento()["messages"] ?? 0;
    const s4 = await repetirConElSdk({ protocolo: "anthropic", base: `${plano.origen}/v1`, modelo: "anthropic/claude-haiku-4-5" });
    const llegaron4 = (upstream.recuento()["messages"] ?? 0) - antes4;
    comprobar("S4 (a) Anthropic por LiteLLM", s4.primera.basis === "measured" && s4.segunda.cacheResult === "exact" && s4.segunda.basis === "estimated" && llegaron4 === 1,
      `primera ${s4.primera.basis} (sin registro: ${s4.primera.referenceNotWritten ?? "—"}), segunda ${s4.segunda.basis}; al upstream llegaron ${llegaron4}`);

    // S5 · dos instancias de la app detrás de un LiteLLM con caché.
    const antes5 = upstream.recuento()["chat"] ?? 0;
    const s5 = await repetirConElSdk({ protocolo: "openai", base: `${conCache.origen}/v1`, modelo: "openai/gpt-4o-mini", capas: 2 });
    const llegaron5 = (upstream.recuento()["chat"] ?? 0) - antes5;
    const aciertoLiteLLM = s5.cabecerasDelProxy[1]?.["x-litellm-cache-key"] !== undefined;
    // HUECO 3: el acierto de la caché de LiteLLM llega al SDK como una llamada
    // normal, con el `usage` original, y el SDK la da por `measured`.
    comprobar("S5 HUECO caché de LiteLLM", llegaron5 === 1 && aciertoLiteLLM && s5.segunda.basis === "measured",
      `al upstream llegaron ${llegaron5}; la segunda instancia recibió un acierto de LiteLLM (${aciertoLiteLLM}) y el SDK lo reporta ${s5.segunda.basis} con actual ${s5.segunda.actualUsd.toExponential(3)} USD; cabecera de coste 1ª ${s5.cabecerasDelProxy[0]?.["x-litellm-response-cost"]} · 2ª ${s5.cabecerasDelProxy[1]?.["x-litellm-response-cost"]}`);

    // S6 · el gateway con LiteLLM como upstream: la gemela coalescida.
    const antes6 = upstream.recuento()["chat"] ?? 0;
    const s6 = await coalescerConElGateway({ upstream: plano.origen });
    const llegaron6 = (upstream.recuento()["chat"] ?? 0) - antes6;
    const gemela = s6.veredictos.find((v) => v.cacheResult === "singleflight");
    comprobar("S6 (b) gateway delante de LiteLLM", llegaron6 === 1 && gemela?.basisEmitido === "estimated" && gemela.enLaBase === false &&
      s6.lineas.some((l) => l.includes("estimated, not by reference: unofficial-upstream")),
      `al upstream llegaron ${llegaron6}; la gemela sale ${gemela?.basisEmitido}, en la base: ${gemela?.enLaBase ? "SÍ" : "no"}`);

    // S7 · ¿llega el cache_control con su TTL a través de LiteLLM?
    await fetch(`${plano.origen}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": CLAVE_DEL_PROXY },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 64,
        system: [{ type: "text", text: "You are terse.", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: "ttl probe" }],
      }),
    }).then((r) => r.text());
    const recibida7 = JSON.parse(await ultimaPeticion(origenUpstream)) as { system?: { cache_control?: { ttl?: string } }[] };
    const ttl7 = recibida7.system?.[0]?.cache_control?.ttl;
    comprobar("S7 cache_control por LiteLLM", ttl7 === "1h", `el upstream recibió ttl=${ttl7 ?? "(ninguno)"}`);

    // S8 · la palanca de TTL del gateway con LiteLLM como upstream.
    const s8 = await rebajarTtlConElGateway({ upstream: plano.origen });
    const recibida8 = JSON.parse(await ultimaPeticion(origenUpstream)) as { system?: { cache_control?: { ttl?: string } }[] };
    const ttl8 = recibida8.system?.[0]?.cache_control?.ttl;
    // HUECO 2 (lo ata el test de CI con un upstream que declara escrituras): la
    // rebaja llega al proveedor a través de LiteLLM y se acredita a precio de
    // lista aunque el upstream no sea oficial.
    comprobar("S8 palanca de TTL por LiteLLM", s8.estados[0] === 200 && ttl8 === "5m", `el upstream recibió ttl=${ttl8 ?? "(ninguno)"}; registro ${s8.veredictos[0]?.basisEmitido} con ahorro ${s8.veredictos[0]?.ahorroUsd} USD (el upstream falso no declara escrituras de caché)`);

    const evidencia = {
      experimento: "E6 · BV-SALA delante de LiteLLM (informe de competencia 2026-09-27, §10)",
      fecha: new Date().toISOString(),
      maquina: { plataforma: `${platform()} ${release()}`, arquitectura: arch(), cpu: cpus()[0]?.model, nucleos: cpus().length, node: process.version },
      bvsala: { version: BV_SALA_VERSION, desde: "fuente (devUnlicensed / licencia efímera de los tests)" },
      litellm: {
        version: versionReal,
        instalacion: "benchmarks/delante-de-litellm/instalar-litellm.sh (rueda comprobada con sha256; dependencias con --exclude-newer 2026-09-24T00:00:00Z)",
        paquetesInstalados: (() => {
          try {
            return readFileSync(join(dirname(dirname(dirname(bin))), "freeze.txt"), "utf8").trim().split("\n").length;
          } catch {
            return null;
          }
        })(),
        entorno: "vaciado; HOME temporal; LITELLM_LOCAL_MODEL_COST_MAP=True; LITELLM_TELEMETRY=False; --host 127.0.0.1",
        configs: ["benchmarks/delante-de-litellm/litellm.yaml", "benchmarks/delante-de-litellm/litellm-con-cache.yaml"],
      },
      upstream: "benchmarks/latencia-gateways/upstream-falso.ts (retardo 300 ms)",
      comprobaciones: informe,
      fallos,
      cabecerasObservadas: {
        chat: nombres(s1.cabecerasDelProxy[0]),
        messages: nombres(s4.cabecerasDelProxy[0]),
        chatAciertoDeCache: nombres(s5.cabecerasDelProxy[1]),
      },
      escenarios: {
        s1_openai_id_del_proveedor: resumenSdk(s1),
        s2_alias_sin_precio: resumenSdk(s2),
        s3_alias_con_costModels: resumenSdk(s3),
        s4_anthropic_messages: resumenSdk(s4),
        s5_dos_instancias_tras_la_cache_de_litellm: { ...resumenSdk(s5), llegaronAlUpstream: llegaron5 },
        s6_gateway_gemela_coalescida: { ...resumenGateway(s6), llegaronAlUpstream: llegaron6 },
        s7_cache_control_por_litellm: { ttlEnviado: "1h", ttlRecibidoPorElUpstream: ttl7 ?? null, cuerpoRecibido: recibida7 },
        s8_gateway_palanca_ttl: { ...resumenGateway(s8), ttlRecibidoPorElUpstream: ttl8 ?? null },
      },
    };
    if (guardar) {
      const dia = evidencia.fecha.slice(0, 10);
      const ruta = join(RAIZ, "benchmarks", "evidencia", `delante-de-litellm-${dia}.json`);
      writeFileSync(ruta, `${JSON.stringify(evidencia, null, 2)}\n`);
      console.log(`\nEvidencia: ${ruta}`);
    }
  } finally {
    for (const v of vivos) await parar(v);
    await upstream.cerrar();
    rmSync(casa, { recursive: true, force: true });
  }
  // «Como se esperaba» = como dice el código de hoy. Las líneas HUECO son
  // comportamiento actual que contradice la hipótesis (b) y decide el dueño.
  console.log(`\n${fallos === 0 ? "Todo como dice el código de hoy (las líneas HUECO las decide el dueño)." : `${fallos} comprobación(es) no salieron como dice el código de hoy.`}`);
  process.exitCode = fallos === 0 ? 0 : 1;
}

await main();

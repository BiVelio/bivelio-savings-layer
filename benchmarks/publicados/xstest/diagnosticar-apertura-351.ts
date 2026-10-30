import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { negativaEnTexto } from "../../../src/providers/negativa-en-texto.js";
import { configDesdeEntorno } from "../../modelos.js";
import { endpointDeModelo } from "../../transporte.js";
import {
  cargarDataset,
  crearCapa,
  exigirLicenciaEnVivo,
  MODELOS,
  TOPE_DE_SALIDA,
  vigilarHosts,
  type Endpoints,
  type Red,
} from "./banco.js";
import { clasificar, contieneSecreto, limpiarSecretos, sha256Hex } from "./nucleo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "../../..");
const HOSTS = new Set(["raw.githubusercontent.com", "api.openai.com"]);

async function principal(): Promise<void> {
  const cfg = MODELOS.find((m) => m.id === "gpt-5.4-mini");
  if (!cfg) throw new Error("falta gpt-5.4-mini en MODELOS");
  const tope = cfg.topeDeSalida ?? TOPE_DE_SALIDA;
  if (tope !== 160) throw new Error("el diagnóstico exige tope de salida 160");

  const env = process.env;
  const transporte = configDesdeEntorno(env);
  const endpoint = endpointDeModelo("openai/gpt-5.4-mini", transporte);
  const licencia = env["BIVELIO_LICENSE_KEY"]?.trim() || undefined;
  const devOpen = env["BVSALA_DEV_OPEN"] === "1";
  const secretos = Object.entries(env)
    .filter(([k, v]) => /KEY|TOKEN|SECRET/i.test(k) && typeof v === "string")
    .map(([, v]) => v!);
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET/i.test(k)) delete env[k];

  exigirLicenciaEnVivo(true, licencia, devOpen);
  if (!endpoint?.baseUrl || !endpoint.apiKey || endpoint.transporte !== "openai-compatible") {
    throw new Error("falta el endpoint o la credencial de OpenAI");
  }
  const base = new URL(endpoint.baseUrl);
  if (base.protocol !== "https:" || base.host !== "api.openai.com") {
    throw new Error("el diagnóstico solo admite https://api.openai.com");
  }
  const endpoints: Endpoints = {
    anthropicBaseUrl: "https://api.anthropic.com/v1",
    openaiBaseUrl: endpoint.baseUrl,
    openaiApiKey: endpoint.apiKey,
  };
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: RAIZ, encoding: "utf8" }).trim();

  const fetchOriginal = globalThis.fetch;
  const relojOriginal = Date.now;
  const vigia = vigilarHosts(fetchOriginal.bind(globalThis), HOSTS);
  globalThis.fetch = vigia.fetch;
  let capa: ReturnType<typeof crearCapa> | undefined;
  try {
    const prompts = await cargarDataset(true);
    const prompt = prompts?.find((p) => p.id === 351);
    if (!prompt || prompt.type !== "contrast_historical_events" || prompt.label !== "unsafe") {
      throw new Error("XSTest 351 no tiene el tipo o la etiqueta esperados");
    }

    let llamadas = 0;
    const red: Red = {
      reintentos: 0,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        llamadas++;
        if (llamadas !== 1) throw new Error("el diagnóstico admite una sola llamada B");
        const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
        if (u.protocol !== "https:" || u.host !== "api.openai.com") {
          throw new Error("la llamada B solo puede ir a https://api.openai.com");
        }
        if (typeof init?.body !== "string") throw new Error("la llamada B no tiene un cuerpo JSON");
        let cuerpo: Record<string, unknown>;
        try {
          cuerpo = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          throw new Error("la llamada B no tiene un cuerpo JSON válido");
        }
        for (const [k, v] of Object.entries(cfg.extraOpenAI ?? {})) {
          if (cuerpo[k] === undefined) cuerpo[k] = v;
        }
        if (cuerpo["max_completion_tokens"] !== tope && cuerpo["max_tokens"] !== tope) {
          throw new Error("la llamada B no lleva el tope de salida 160");
        }
        return await vigia.fetch(url, {
          ...init,
          body: JSON.stringify(cuerpo),
          signal: AbortSignal.timeout(120_000),
        });
      }) as typeof fetch,
    };

    capa = crearCapa(red, endpoints, cfg, licencia);
    const resultado = await capa.generate({
      model: "openai/gpt-5.4-mini",
      messages: [{ role: "user", content: prompt.prompt }],
      maxOutputTokens: tope,
      ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
    });
    if (llamadas !== 1) throw new Error("la llamada B no llegó exactamente una vez al proveedor");

    const texto = resultado.text ?? "";
    const negativaCapa = resultado.finishReason === "content_filter" || (typeof resultado.refusal === "string" && resultado.refusal !== "");
    const clasificacion = clasificar(texto, negativaCapa);
    const detector = negativaEnTexto(texto);
    const reproduce =
      clasificacion.clase === "full_refusal" &&
      clasificacion.fuente === "strmatch-paper" &&
      clasificacion.paper === "1_full_compliance" &&
      detector === null;
    if (!reproduce) throw new Error("XSTest 351 no reprodujo la negativa buscada");

    const salida = {
      id: 351,
      modelo: "openai/gpt-5.4-mini",
      commit,
      nuevaMuestra: true,
      bytesOriginales: false,
      longitud: texto.length,
      sha256: sha256Hex(texto),
      clasificacion,
      detector,
      llamadas,
      apertura: texto.slice(0, 240),
    };
    const json = limpiarSecretos(JSON.stringify(salida, null, 2), secretos);
    if (contieneSecreto(json, secretos)) throw new Error("un secreto llegó al diagnóstico");
    const directorio = join(RAIZ, "diagnostico-xstest-351");
    const ruta = join(directorio, "apertura.json");
    mkdirSync(directorio, { recursive: true, mode: 0o700 });
    writeFileSync(ruta, json + "\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(ruta, 0o600);
    console.log("[xstest-351] diagnóstico escrito con una llamada B");
  } finally {
    try {
      if (capa) await capa.close();
    } finally {
      globalThis.fetch = fetchOriginal;
      Date.now = relojOriginal;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch((error: unknown) => {
    const mensaje = error instanceof Error ? error.message : String(error);
    const codigo = /no reprodujo la negativa buscada/.test(mensaje) ? "no-reproduced"
      : /401|403|api key|credential|authentication/i.test(mensaje) ? "credentials"
        : /429|quota/i.test(mensaje) ? "quota"
          : /timeout|timed out/i.test(mensaje) ? "timeout"
            : /fetch failed|ECONN|network/i.test(mensaje) ? "network"
              : /404|endpoint|tope|cuerpo|tipo|etiqueta/i.test(mensaje) ? "configuration"
                : "other";
    console.error(`[xstest-351] ${codigo}; no se escribió texto en consola`);
    process.exitCode = 1;
  });
}

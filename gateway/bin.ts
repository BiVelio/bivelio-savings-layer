#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describirEstadoDeElision } from "./palanca.js";
import { describirEstadoDeEsfuerzo } from "./esfuerzo.js";
import { describirEstadoDeHermano } from "./hermano.js";
import { arrancarGateway, type GatewayArrancado } from "./servidor.js";
import { resumenDeDegradaciones } from "./degradacion.js";
import {
  decidirArranque,
  isChildInfoRequest,
  mensajeDeFalloDeArranque,
  traducirEntorno,
  traducirFlags,
} from "./argumentos.js";
import { LICENSE_SERVER_URL, resolveStartupLicense } from "./license.js";
import {
  envoltorioDe,
  esTerminalConEnvoltorio,
  impedimentoDeEnvoltorio,
  modoAuthCodex,
  resolverBinarioWindows,
  TERMINALES_CON_ENVOLTORIO,
} from "./envoltorios.js";
import { resumenDeMedicion } from "./recuento.js";
import { leerEnrolamiento, planDeAnillo2 } from "./anillo2.js";
import { flagDeUpstream, resolverUpstream } from "./upstream.js";
import { connect } from "node:net";

/**
 * ¿Hay alguien escuchando en ese puerto de loopback? Se pregunta ANTES de
 * encadenar: mandar el tráfico a un espía muerto son 502 en cada turno y el
 * dueño se queda sin terminal por un fichero que olvidó borrar.
 */
function puertoEscucha(puerto: number, msTope = 300): Promise<boolean> {
  return new Promise((resolver) => {
    const socket = connect({ port: puerto, host: "127.0.0.1" });
    const cerrar = (vivo: boolean) => {
      socket.destroy();
      resolver(vivo);
    };
    socket.setTimeout(msTope, () => cerrar(false));
    socket.once("connect", () => cerrar(true));
    socket.once("error", () => cerrar(false));
  });
}
import { doctor } from "./doctor.js";
import { conFicheros, detectar, escribirConPermiso, jsonDelPlan, leerArgumentosDeInit, planear, textoDelPlan } from "./init.js";
import { instalarAgentsMd, instalarSkill } from "./skill.js";
import { soportaZstd } from "./medidor.js";
import { BV_SALA_VERSION } from "../src/index.js";
import { EMBEDDED_PUBLIC_KEY } from "../src/license/index.js";

/**
 * El CLI de la pasarela:
 *
 *   `bvsala gateway [--port N] [--upstream U]` — el medidor local para
 *   herramientas que respetan un base URL (Claude Code, el anillo de terminales
 *   compatibles y los SDK oficiales de OpenAI y Anthropic en cualquier lenguaje).
 *   `--upstream` elige el proveedor (gateway/upstream.ts): uno por gateway.
 *
 *   `bvsala claude|codex|goose|qwen|opencode|kilo|copilot|aider [args…]` — cero
 *   configuración: arranca el gateway en un puerto efímero, lanza el terminal
 *   apuntándole y lo apaga al salir, con un resumen de lo medido y lo que no
 *   (tabla en gateway/envoltorios.ts; resumen en gateway/recuento.ts).
 *
 *   `bvsala doctor [--port N]` — detecta terminales instalados e imprime el
 *   bloque de configuración exacto de cada uno (gateway/doctor.ts).
 *
 *   `bvsala init` (y `npx @bivelio/savings-layer init`, porque el paquete tiene un
 *   solo `bin`) — el doctor del SDK: detecta la pila del proyecto e imprime el
 *   código exacto de su adaptador y una comprobación gratuita (gateway/init.ts).
 *
 * El gateway y los envoltorios EXIGEN LICENCIA al arrancar (LICENSE §2), como el
 * SDK: la recogen con BIVELIO_SERVICE_KEY y la verifican contra la clave pública
 * embebida (gateway/license.ts); sin ella, exit 1 con el arreglo exacto. La
 * ayuda, la versión, el doctor, el skill, init y `bvsala <terminal> --help|-h|--version`
 * no usan el servicio ni la red, y siguen funcionando sin licencia.
 *
 * La decisión «ayuda / versión / arrancar» es una función pura
 * (gateway/argumentos.ts) porque este fichero arranca cosas al importarse y
 * no se puede probar; lo que aquí se hace es ejecutar lo decidido.
 */
const decision = decidirArranque(process.argv.slice(2));

function ayuda(): void {
  console.log(`bvsala ${BV_SALA_VERSION} — BiVelio Savings Layer

Commands:
  gateway [--port N] [--upstream U]
                         Local metering proxy (default port 8402) for anything that honours a
                         base URL: Claude Code, opencode, Goose, Crush… and the official OpenAI
                         and Anthropic SDKs in any language, Python included.
                         Needs BIVELIO_SERVICE_KEY and an active BiVelio license.
                         --upstream openai | anthropic | an origin URL (default: anthropic).
                         One gateway talks to ONE upstream: run a second one on another port
                         for the other provider. Behind an origin that is not the provider's
                         own API (a proxy such as LiteLLM), requests are metered but no
                         saving is credited: list prices only hold at the provider's API.
  claude [args…]         Run Claude Code through the gateway. No configuration needed.
  codex [args…]          Run Codex CLI through the gateway (API key: api.openai.com;
                         ChatGPT auth: chatgpt.com/backend-api/codex, metered with no commission).
  goose [args…]          Run Goose (ANTHROPIC_HOST) through the gateway.
  qwen [args…]           Run Qwen Code (ANTHROPIC_BASE_URL) through the gateway.
  opencode [args…]       Run opencode with its anthropic provider through the gateway
                         (OPENCODE_CONFIG_CONTENT; nothing written to disk).
  kilo [args…]           Run the Kilo CLI with its anthropic provider through the gateway
                         (KILO_CONFIG_CONTENT; nothing written to disk).
  copilot [args…]        Run GitHub Copilot CLI through the gateway with your own Anthropic key
                         (BYOK, COPILOT_PROVIDER_TYPE=anthropic). GitHub-hosted models do not
                         use a base URL and are not metered.
  aider [args…]          Run Aider through the gateway: Anthropic models by default
                         (ANTHROPIC_API_BASE); OpenAI with BVSALA_GATEWAY_UPSTREAM=openai.
                         Every wrapper prints, on exit, how many requests it metered and
                         which ones it forwarded without metering, and why.
  doctor [--port N]      Detect installed terminals and print the exact configuration for each.
  skill [--codex] [--project] [--force]
                         Install the "savings-mode" skill for Claude Code (~/.claude/skills;
                         with --project, .claude/skills in the current directory): terse
                         output plus surgical tool use to stretch subscription limits.
                         With --codex, the same discipline as a marked block in AGENTS.md
                         (~/.codex; with --project, ./AGENTS.md) — Codex has no skills and
                         AGENTS.md is always active. Its effect is measured by the gateway,
                         not promised.
  init [--write [--yes]] [--stack S] [--provider P] [--cwd DIR] [--json]
                         Set up the SDK in a JavaScript/TypeScript project (also:
                         npx @bivelio/savings-layer@latest init). Detects Next.js, Express, the
                         Vercel AI SDK, Mastra, LangChain.js, the Anthropic SDK and the OpenAI SDK,
                         and prints the install line, the keys that are missing, the exact code
                         for your adapter and a free check. Reads package.json files only, never
                         a .env file or a secret's value, and uses no network. It writes nothing
                         unless you pass --write, and then it creates new files only, after
                         asking (--yes without a terminal); an existing file is never overwritten.
                         --stack ai-sdk | mastra | langchain | anthropic-sdk | sdk   (default: detected)
                         --provider openai | anthropic                              (default: detected)
                         --json prints the plan for a script or a coding agent.
  --version | -v         Print the version only.
  --help | -h            This help; also accepted after gateway, doctor, skill or init
                         (\`bvsala gateway --help\` starts nothing; \`bvsala claude --help\` or
                         \`--version\` go straight to the terminal, with no gateway).

  The Spanish spellings --puerto, --proyecto and --forzar still work until 0.5, with a
  deprecation notice (BVSALA_SILENCE_DEPRECATIONS=1 silences it).
Environment:
  BIVELIO_SERVICE_KEY    Service key (bvk_…): REQUIRED. Identifies your organization, collects its
                         license (renewed by itself) and enables metering and seat identity.
  BIVELIO_LICENSE_KEY    License key (optional fallback): used only if savings.bivelio.com cannot be
                         reached at start; verified on this machine. Replace it every billing period.
  BVSALA_SEAT_ID         Stable seat identity per replica (optional).
  BVSALA_GATEWAY_UPSTREAM  Alternative upstream: openai | anthropic | an origin URL (default: the
                         terminal's own). --upstream wins over it.
  BVSALA_GATEWAY_COALESCE  =1 enables duplicate-request coalescing (experimental).
  BVSALA_GATEWAY_USAGE_INJECT
                         =1 adds stream_options.include_usage to streamed /v1/chat/completions
                         requests that lack it, so they can be metered. Off by default: the last
                         chunk of those streams then has an empty choices list, which code that
                         reads choices[0] without checking does not expect.
  BVSALA_GATEWAY_SHADOW  =1 enables the shadow lane for context elision (experimental):
                         computes what the elision policy would have saved WITHOUT touching
                         traffic and reports it separately (never counts toward the fee).
  BVSALA_GATEWAY_ELISION =0 turns OFF the provider-side levers, which are armed by default.
                         (The license check is not affected: the licence channel stays open.)
                         Each one only takes effect if your organization's license carries
                         its feature (checked fail-closed):
                           · context_elision  — adjusts ONLY the context_management block
                             of each /v1/messages; the provider does the trimming.
                           · cache_ttl_tuning — lowers the cache-write TTL from 1h (2x the
                             input price) to 5m (1.25x) while the session stays warm. It does
                             NOT touch a single token the model reads: it changes the rate,
                             not the content. In measured traffic, 99.1% of turns chain within
                             5 minutes, and that surcharge was 8.0% of the bill.
                         When in doubt, the request travels untouched. (Up to 0.4.13 the flag
                         was inverted: "=1 arms". In an A/B always pass it explicitly, =1 or
                         =0, so you do not depend on the installed version.)
  BVSALA_GATEWAY_SIBLING_MODEL
                         =1 serves claude-fable-5 with claude-fable-5-1 (sibling model routing):
                         same input, output and cache-write rates; cache READS drop from
                         0.001 to 0.00025 per 1K tokens (catalog). The saving is the difference
                         of two prices over the same usage: measured without an A/B, and it
                         counts toward the measured headline in the dashboard.
                         Only if the license carries sibling_model_routing (fail-closed).
                         It CHANGES the model you see in the response (/cost, /status), and
                         turning it on mid-thread pays ONE cold write of the prefix (each
                         model has its own cache): start it together with the terminal.
                         Off = unset the variable or =0.
  BVSALA_GATEWAY_EFFORT  =low|medium sets a per-turn effort ceiling (experimental):
                         appends a message with output_config.effort to each /v1/messages
                         without touching the root (does not reset the prefix cache). Only if
                         the license carries per_turn_effort (fail-closed), only with
                         claude-fable-5-1, claude-mythos-5-1, claude-opus-5-5 and claude-opus-5,
                         and only when the level is below the model's default (high; medium on
                         claude-opus-5-5): it never raises effort. Any other request travels
                         untouched. It is the only lever that can affect response quality: OFF
                         by default and not yet measured against the quality gate.
  BVSALA_SILENCE_DEPRECATIONS
                         =1 silences the notice printed when a deprecated Spanish name is used:
                         BVSALA_GATEWAY_MODELO_HERMANO (now BVSALA_GATEWAY_SIBLING_MODEL),
                         BVSALA_GATEWAY_ESFUERZO (now BVSALA_GATEWAY_EFFORT), --puerto, --proyecto,
                         --forzar. The old names keep working until 0.5; the English one wins
                         when both are set.
  BVSALA_CODEX_AUTH      api-key | chatgpt — forces the Codex auth mode.
  BVSALA_GATEWAY_LOG     =1 shows the per-request log inside the wrappers too (silenced by
                         default so it does not overwrite the TUI; use the dashboard instead).
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1  (Claude Code, API key only) your models in /model.

The gateway is fail-closed, like the SDK: it starts only with BIVELIO_SERVICE_KEY and an active
BiVelio license. It never interrupts a request in flight: if the license lapses, only NEW requests
are refused (HTTP 402) until it is renewed. Metering is best-effort: with ingestion down, it
forwards and warns. On a Claude or ChatGPT subscription there is no per-token invoice: that
traffic is metered at list-price equivalent and never carries commission.
Your prompts, completions and provider keys never reach BiVelio: what it receives is per-request
usage (token counts, cost, the model id and opaque ids); LICENSE §5 lists every field.
More: savings.bivelio.com`);
}

if (decision.tipo === "ayuda") {
  ayuda();
  process.exit(decision.salida);
}
if (decision.tipo === "version") {
  // Solo la versión, para que un script (o un probador) la lea sin recortar
  // nada: `bvsala --version` → «0.4.21».
  console.log(BV_SALA_VERSION);
  process.exit(0);
}
const { comando } = decision;
const esEnvoltorio = esTerminalConEnvoltorio(comando);
// Los nombres españoles (--puerto, BVSALA_GATEWAY_ESFUERZO…) son alias de los
// ingleses desde 0.4.33: se traducen AQUÍ, antes de leerse, con un aviso por
// nombre (silenciable). Lo que va detrás de un terminal envuelto es suyo.
const flags = esEnvoltorio ? { resto: decision.resto, avisos: [] } : traducirFlags(decision.resto, process.env);
const resto = flags.resto;
const entorno = traducirEntorno(process.env);
for (const aviso of [...flags.avisos, ...entorno.avisos]) console.error(aviso);
const effortEnv = entorno.env.BVSALA_GATEWAY_EFFORT;
const siblingModelEnv = entorno.env.BVSALA_GATEWAY_SIBLING_MODEL;

if (comando === "init") {
  // Antes del puerto, del upstream y de la verja de licencia: init es onboarding,
  // no usa la red ni el servicio, y tiene que funcionar ANTES de tener la clave.
  const leido = leerArgumentosDeInit(resto, process.cwd());
  if (!leido.ok) {
    console.error(`[bvsala init] ${leido.mensaje}`);
    process.exit(1);
  }
  const opciones = leido.valor;
  const sonda = {
    leer: (ruta: string) => {
      try {
        return readFileSync(ruta, "utf8");
      } catch {
        return undefined;
      }
    },
    existe: existsSync,
  };
  const detectado = detectar(opciones.cwd, sonda);
  if (!detectado.ok) {
    console.error(`[bvsala init] ${detectado.mensaje}`);
    process.exit(1);
  }
  const planeado = planear(detectado.valor, opciones, {
    node: process.versions.node,
    // Solo EXISTENCIA: el valor no se lee más allá de saber si está vacío.
    env: (nombre) => Boolean(process.env[nombre]?.trim()),
  });
  if (!planeado.ok) {
    console.error(`[bvsala init] ${planeado.mensaje}`);
    process.exit(1);
  }
  const plan = conFicheros(planeado.valor, sonda);
  if (opciones.json) {
    console.log(jsonDelPlan(plan, BV_SALA_VERSION));
    process.exit(0);
  }
  // `@latest`: con una versión anterior ya instalada en el proyecto, `npx` a secas
  // ejecutaría la local, que puede no tener `init`.
  console.log(
    textoDelPlan(plan, `bvsala init · BiVelio Savings Layer ${BV_SALA_VERSION}`, "npx @bivelio/savings-layer@latest init", {
      escribira: opciones.escribir,
    }),
  );
  if (!opciones.escribir) process.exit(0);
  console.log("");
  const { createInterface } = await import("node:readline/promises");
  const r = await escribirConPermiso(plan, {
    si: opciones.si,
    esTerminal: Boolean(process.stdin.isTTY),
    preguntar: async (pregunta) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(pregunta);
      } finally {
        rl.close();
      }
    },
    crearDir: (ruta) => mkdirSync(ruta, { recursive: true }),
    crearExclusivo: (ruta, contenido) => writeFileSync(ruta, contenido, { flag: "wx" }),
  });
  for (const l of r.lineas) (r.salida === 0 ? console.log : console.error)(l);
  process.exit(r.salida);
}

if (comando === "skill") {
  // El SKILL.md empaquetado vive en <raíz>/skills/; desde dist/gateway/bin.js
  // la raíz es ../../, y ejecutado con tsx desde gateway/ es ../ — se prueban
  // ambas por existencia en vez de adivinar el layout.
  const aqui = dirname(fileURLToPath(import.meta.url));
  const opciones = {
    origenes: [join(aqui, "..", ".."), join(aqui, "..")],
    home: homedir(),
    cwd: process.cwd(),
    proyecto: resto.includes("--project"),
    forzar: resto.includes("--force"),
    fs: {
      existe: existsSync,
      leer: (ruta: string) => readFileSync(ruta, "utf8"),
      escribir: (ruta: string, contenido: string) => writeFileSync(ruta, contenido),
      crearDir: (ruta: string) => mkdirSync(ruta, { recursive: true }),
    },
  };
  // --codex: la misma disciplina como bloque marcado de AGENTS.md (Codex no
  // tiene skills); sin él, el skill de Claude Code de siempre.
  const r = resto.includes("--codex") ? instalarAgentsMd(opciones) : instalarSkill(opciones);
  console.log(r.mensaje);
  process.exit(r.ok ? 0 : 1);
}

// Envoltorios: puerto efímero; `gateway`: 8402 o --port (0 = efímero, lo usa
// el arnés F2); `doctor`: 1–65535 (imprime URLs — un puerto 0 no señala nada).
const idx = resto.indexOf("--port");
const puerto = esEnvoltorio ? 0 : idx >= 0 ? Number(resto[idx + 1]) : 8402;
if (!Number.isInteger(puerto) || (comando === "doctor" ? puerto < 1 : puerto < 0) || puerto > 65535) {
  console.error(`[bvsala ${comando}] invalid port: ${resto[idx + 1]}`);
  process.exit(1);
}

if (comando === "doctor") {
  if (resto.includes("--write")) {
    console.error("[bvsala doctor] --write does not exist yet: the doctor only prints; copy the block by hand.");
    process.exit(1);
  }
  const informe = await doctor(puerto);
  console.log(informe.texto);
  process.exit(0);
}

/**
 * `bvsala claude --help`, `-h` o `--version`: una PREGUNTA al terminal hijo, no
 * una sesión. Va directa al binario, sin gateway ni licencia: no pasa tráfico
 * que medir, y exigir la clave para leer la ayuda de Claude Code sería un muro
 * absurdo. Hereda el entorno sin tocarlo y sale con el código del hijo.
 */
function lanzarSinGateway(terminal: typeof comando, args: string[]): Promise<never> {
  if (!esTerminalConEnvoltorio(terminal)) process.exit(1);
  let bin = envoltorioDe(terminal, 0, [], {}).bin;
  if (process.platform === "win32") {
    const resuelto = resolverBinarioWindows(bin);
    if (resuelto.tipo === "exe") {
      bin = resuelto.ruta;
    } else if (resuelto.tipo === "solo-shim") {
      console.error(
        `[bvsala ${terminal}] \`${bin}\` is installed as an npm shim (${resuelto.ruta}) and Windows cannot ` +
          "launch it safely with arguments (CVE-2024-27980). Install it with its native installer " +
          `(which leaves a ${bin}.exe on the PATH) or use the manual recipe in docs/terminales/.`,
      );
      process.exit(127);
    }
  }
  const hijo = spawn(bin, args, { stdio: "inherit" });
  hijo.on("error", (err) => {
    console.error(`[bvsala ${terminal}] could not launch \`${bin}\`: ${String(err)}. Is it installed and on the PATH?`);
    process.exit(127);
  });
  hijo.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  return new Promise<never>(() => {});
}
if (esEnvoltorio && isChildInfoRequest(resto)) await lanzarSinGateway(comando, resto);

// Lo que impide un envoltorio (Copilot sin BYOK, una config inline ilegible de
// opencode o Kilo) se dice AQUÍ: antes de la licencia, de la red y del gateway.
// Arrancar para no medir nada sería cobrar un asiento por un proxy vacío.
if (esEnvoltorio) {
  const impedimento = impedimentoDeEnvoltorio(comando);
  if (impedimento) {
    console.error(`[bvsala ${comando}] ${impedimento}`);
    process.exit(1);
  }
}

// `--upstream` solo es de `gateway`: en los envoltorios todo lo que va detrás
// del terminal es del terminal (gateway/argumentos.ts). La variable de entorno
// vale para los dos, y el flag manda sobre ella. Se resuelve DESPUÉS del
// doctor: una variable mal puesta no puede impedir que el doctor imprima.
const flagUpstream = comando === "gateway" ? flagDeUpstream(resto) : undefined;
const up = resolverUpstream({ flag: flagUpstream, env: process.env.BVSALA_GATEWAY_UPSTREAM });
if (!up.ok) {
  console.error(up.error);
  process.exit(1);
}

// ── LA VERJA DE LICENCIA (LICENSE §2) ─────────────────────────────────────
// Antes del envoltorio, del anillo 2 y de cualquier lectura de fichero: sin
// licencia verificada, el gateway no arranca. Se recoge SIEMPRE online con la
// clave de servicio (la ata a su org); BIVELIO_LICENSE_KEY solo es el respaldo
// cuando savings.bivelio.com no responde. La URL es SIEMPRE la de producción:
// BVSALA_METERING_URL ya no redirige ni la licencia ni el canal.
const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY?.trim() || undefined;
const licencia = await resolveStartupLicense({
  serviceAccountKey,
  licenseKey: process.env.BIVELIO_LICENSE_KEY,
  licenseServerUrl: LICENSE_SERVER_URL,
  publicKey: EMBEDDED_PUBLIC_KEY,
});
if (!licencia.ok) {
  console.error(`[bvsala ${comando}] ${licencia.message}`);
  process.exit(1);
}

// La tabla decide destino y variables; bin.ts solo ejecuta. El modo de auth de
// Codex se lee por EXISTENCIA/enum de ~/.codex/auth.json — jamás se registra.
const envoltorio = esEnvoltorio
  ? envoltorioDe(comando, 0, resto, {
      modoCodex:
        comando === "codex"
          ? modoAuthCodex({ leerAuth: () => readFileSync(join(homedir(), ".codex", "auth.json"), "utf8") })
          : undefined,
      ...(up.upstream ? { upstreamElegido: up.upstream } : {}),
    })
  : null;

// En modo envoltorio el hijo ES un TUI dueño de la terminal: el log por
// petición del gateway se imprimía encima y se pisaban las palabras (visto en
// vivo con el diálogo de confianza de Claude Code). Silencio por defecto —
// el sitio para mirar es el panel — y BVSALA_GATEWAY_LOG=1 lo recupera para
// depurar. `bvsala gateway` a secas sigue logueando: ahí el log es el producto.
const silencioso = esEnvoltorio && process.env.BVSALA_GATEWAY_LOG !== "1";
// Anillo 2 · el encadenado al espía NO puede depender de cómo se lanzó la
// sesión: vivía en una función del .zshrc y toda sesión nacida por otro camino
// se medía pero no entraba en el corpus (2026-09-06: las dos sesiones vivas,
// sin encadenar). El fichero lo hereda cualquier arranque. Solo la casa lo
// tiene. Codex queda fuera: su upstream no habla el protocolo del espía.
const enrolamientoAnillo2 = envoltorio?.upstream
  ? null
  : leerEnrolamiento(() =>
      readFileSync(process.env.BVSALA_ANILLO2_FICHERO ?? join(homedir(), ".bvsala", "anillo2.json"), "utf8"),
    );
const planAnillo2 = planDeAnillo2({
  enrolamiento: enrolamientoAnillo2,
  espiaVivo: enrolamientoAnillo2 !== null && (await puertoEscucha(enrolamientoAnillo2.espia)),
  upstreamEnv: up.upstream,
  ...(up.origen !== "none" ? { upstreamOrigen: up.origen } : {}),
  elisionEnv: process.env.BVSALA_GATEWAY_ELISION,
  hoyUtcIso: new Date().toISOString().slice(0, 10),
});
const upstreamPedido = up.upstream ?? planAnillo2.upstream;
const elisionPedida = process.env.BVSALA_GATEWAY_ELISION ?? planAnillo2.elision;

let arranque: GatewayArrancado;
try {
  arranque = await arrancarGateway({
    puerto,
    // Callado también en los avisos de «no medido»: un console.warn se pinta
    // encima del TUI igual que el log.
    ...(silencioso ? { log: () => {}, avisosDeNoMedido: false } : {}),
    // La licencia ya verificada, y la base del control plane para el canal, las
    // revocaciones y el renovador. Un arranque OFFLINE pide recogida inmediata.
    license: {
      token: licencia.license.token,
      publicKey: EMBEDDED_PUBLIC_KEY,
      licenseServerUrl: LICENSE_SERVER_URL,
      checkOnStart: licencia.source === "offline",
    },
    // Las transiciones de licencia NO se silencian en los envoltorios: un 402 a
    // mitad de sesión tiene que decir por qué y dónde se arregla.
    warn: (l: string) => console.error(l),
    // Garantizada por la verja de arriba.
    serviceAccountKey: serviceAccountKey!,
    ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
    ...(upstreamPedido
      ? { upstream: upstreamPedido }
      : envoltorio?.upstream
        ? { upstream: envoltorio.upstream }
        : {}),
    ...(process.env.BVSALA_GATEWAY_COALESCE === "1" ? { coalescer: true } : {}),
    // Opt-in: pedir el usage por los clientes de Chat Completions que no lo
    // piden. Cambia la forma del último chunk (choices: []), así que nunca por
    // defecto.
    ...(process.env.BVSALA_GATEWAY_USAGE_INJECT === "1" ? { usageInject: true } : {}),
    ...(process.env.BVSALA_GATEWAY_SHADOW === "1" ? { sombra: true } : {}),
    // S4a · el CANAL de entitlements, del que cuelgan las dos palancas. ARMADO
    // POR DEFECTO: el ahorro en el terminal tiene que funcionar SOLO. El gate
    // REAL son los features `context_elision` y `cache_ttl_tuning` en la licencia
    // de la org (fail-closed). `BVSALA_GATEWAY_ELISION=0` sigue siendo el freno
    // de emergencia que apaga las dos de golpe. `serviceAccountKey` es
    // estructuralmente necesaria (identidad de org para el entitlement).
    elision: elisionPedida !== "0",
    // S4a-B · los DIALES, APAGADOS desde el 2026-09-09. Hasta hoy iban en la
    // misma bandera que la rebaja de TTL, así que no se podía apagar la palanca
    // que pierde sin apagar la que gana. Medida en pérdida por tres vías
    // independientes (simulador honesto +49 % de coste, carril sombra en
    // producción los días 08 y 09, y R = 4,05 frente a R* = 0,0127 en
    // fable-5-1). El brazo del anillo 2 ya NO las arma: mientras el A/B calcule
    // el brazo una sola vez al arrancar el proceso, una sesión que cruza la
    // medianoche corre con la bandera de ayer y no hay observación de control
    // limpia. Se encienden a mano y a sabiendas.
    ...(process.env.BVSALA_GATEWAY_DIALES_ELISION === "1" ? { dialesElision: true } : {}),
    // Palanca C · el MODELO HERMANO (decisión del dueño, 2026-09-09: «haz el C»).
    // Opt-in explícito del cliente porque cambia el `model` de la respuesta; el
    // feature `sibling_model_routing` de la licencia sigue verjando (fail-closed)
    // y `BVSALA_GATEWAY_ELISION=0` la apaga con las demás. NO la arma el anillo 2:
    // el ahorro se mide sin contrafactual, no hay A/B que hacer.
    ...(siblingModelEnv === "1" ? { modeloHermano: true } : {}),
    // Palanca D · el techo de esfuerzo por turno. Es del OPERADOR: la palanca no
    // adivina qué turno merece pensar menos. Solo cambia la VÍA por la que se
    // aplica —un mensaje añadido, que NO reinicia la caché de prefijo, en vez del
    // campo de la raíz, que sí— y verja por modelo, porque fuera de fable-5-1,
    // mythos-5-1, opus-5-5 y opus-5 es un 400. Y solo REBAJA: un nivel igual o
    // superior al defecto del modelo deja la petición intacta.
    ...(effortEnv ? { esfuerzo: effortEnv } : {}),
    // Solo para desarrollo y pruebas: redirigir la INGESTA de metering (y solo
    // ella: la licencia y el canal van siempre a savings.bivelio.com). En
    // producción no se toca.
    ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
  });
} catch (err) {
  // El escenario más probable para un probador es lanzarlo dos veces (el 8402
  // por defecto). Hasta 0.4.20 esto era un rechazo sin manejar: la traza cruda
  // de Node («node:net … listen EADDRINUSE …») y exit 1 sin una palabra del
  // producto. Una sola línea, sin traza, con la salida (--port M o apagar el
  // otro proceso), y exit 1.
  console.error(`[bvsala ${comando}] ${mensajeDeFalloDeArranque(err, comando, puerto)}`);
  process.exit(1);
}

const upstreamEfectivo = upstreamPedido ?? envoltorio?.upstream ?? "https://api.anthropic.com";
console.log(`[bvsala gateway] v${BV_SALA_VERSION} listening on http://127.0.0.1:${arranque.puerto} → ${upstreamEfectivo}`);
(licencia.lineIsWarning ? console.error : console.log)(`[bvsala gateway] ${licencia.line}`);
for (const w of licencia.warnings) console.error(`[bvsala gateway] ${w}`);
console.log("[bvsala gateway] metering: ON (service key present)");
if (process.env.BVSALA_METERING_URL) {
  console.error(
    `[bvsala gateway] WARNING: BVSALA_METERING_URL=${process.env.BVSALA_METERING_URL} redirects usage reporting away ` +
      "from savings.bivelio.com (development only): your dashboard will not see this usage. The license and the " +
      "entitlements channel still use savings.bivelio.com.",
  );
}
if (up.aviso) console.error(up.aviso);
if (process.env.BVSALA_GATEWAY_USAGE_INJECT === "1") {
  // La clave de servicio la garantiza la verja de licencia, así que aquí la
  // medición siempre está encendida y la inyección también.
  console.log(
    "[bvsala gateway] usage injection: ON (BVSALA_GATEWAY_USAGE_INJECT=1) — streamed chat completions without " +
      "stream_options get include_usage; their last chunk has an empty choices list.",
  );
}
{
  // El brazo del A/B (anillo 2) dicho en voz alta al arrancar: un día entero de
  // «palanca» corrió sin clave en un terminal viejo y fue control en silencio.
  // Con la verja de licencia, la clave está garantizada: `hayClave` es true.
  const estado = describirEstadoDeElision(elisionPedida, true, process.env.BVSALA_GATEWAY_DIALES_ELISION === "1");
  (estado.aviso ? console.error : console.log)(`[bvsala gateway] ${estado.linea}`);
  // Palanca C dicha en voz alta, por la misma razón: una bandera puesta en un
  // terminal sin clave (o con el canal cerrado) es control en silencio.
  const estadoHermano = describirEstadoDeHermano(siblingModelEnv, true, elisionPedida !== "0");
  (estadoHermano.aviso ? console.error : console.log)(`[bvsala gateway] ${estadoHermano.linea}`);
  // Palanca D dicha en voz alta por la misma razón que las otras: una palanca
  // que se cree encendida y no lo está es la trampa muda que ya costó un A/B.
  const estadoEsfuerzo = describirEstadoDeEsfuerzo(effortEnv, true, elisionPedida !== "0");
  (estadoEsfuerzo.aviso ? console.error : console.log)(`[bvsala gateway] ${estadoEsfuerzo.linea}`);
  if (planAnillo2.linea) {
    (planAnillo2.aviso ? console.error : console.log)(`[bvsala gateway] ${planAnillo2.linea}`);
  }
}
if (up.upstream && envoltorio?.upstream && up.upstream !== envoltorio.upstream) {
  // Un BVSALA_GATEWAY_UPSTREAM heredado del .zshrc (p.ej. el de Claude Code)
  // mandaría el tráfico de Codex a un host que no habla su protocolo. Se
  // compara el origen ya resuelto: `openai` y https://api.openai.com son el mismo.
  console.error(
    `[bvsala ${comando}] WARNING: BVSALA_GATEWAY_UPSTREAM=${up.upstream} overrides this terminal's upstream ` +
      `(${envoltorio.upstream}). If that is not what you want, unset the variable.`,
  );
}
if (comando === "codex" && !soportaZstd()) {
  console.error(
    `[bvsala codex] WARNING: this Node (${process.version}) cannot decompress zstd and Codex sends its body in zstd: ` +
      "traffic passes through but is NOT metered. Use Node >= 22.15.",
  );
}

/**
 * Lo que el log callado no pudo decir, una sola vez por proceso (el hijo que
 * sale y un Ctrl-C pueden llegar los dos): el tráfico degradado y lo medido. Una
 * sesión entera sin medir (terminal mal apuntado, stream sin usage, modelo sin
 * precio) solo se ve aquí. Por stderr: el stdout del hijo puede ir a un fichero.
 */
let resumido = false;
function imprimirResumenes(): void {
  if (resumido) return;
  resumido = true;
  const degradado = resumenDeDegradaciones(arranque.degradaciones());
  if (degradado) console.error(degradado);
  console.error(resumenDeMedicion(arranque.medicion(), comando));
}

if (envoltorio && esEnvoltorio) {
  // La tabla se calculó con puerto 0 (aún no había gateway): se recalcula con
  // el puerto REAL. Hereda la terminal entera (stdio inherit: el TUI funciona
  // tal cual) y muere con el hijo.
  const final = envoltorioDe(comando, arranque.puerto, resto, {
    ...(envoltorio.upstream ? { modoCodex: envoltorio.upstream.includes("chatgpt.com") ? "chatgpt" : "api-key" } : {}),
    ...(up.upstream ? { upstreamElegido: up.upstream } : {}),
  });
  if (final.nota) console.log(`[bvsala ${comando}] ${final.nota}`);
  // Windows: spawn no resuelve shims .cmd/.bat y lanzarlos con args no es
  // seguro (ver resolverBinarioWindows). El .exe se ejecuta por ruta directa;
  // con solo-shim nos negamos con guía en vez de fallar con un ENOENT mudo.
  let binAEjecutar = final.bin;
  if (process.platform === "win32") {
    const resuelto = resolverBinarioWindows(final.bin);
    if (resuelto.tipo === "exe") {
      binAEjecutar = resuelto.ruta;
    } else if (resuelto.tipo === "solo-shim") {
      console.error(
        `[bvsala ${comando}] \`${final.bin}\` is installed as an npm shim (${resuelto.ruta}) and Windows cannot ` +
          "launch it safely with arguments (CVE-2024-27980). Install it with its native installer " +
          `(which leaves a ${final.bin}.exe on the PATH) or use the manual recipe in docs/terminales/.`,
      );
      await arranque.cerrar();
      process.exit(127);
    }
  }
  const hijo = spawn(binAEjecutar, final.args, { stdio: "inherit", env: { ...process.env, ...final.env } });
  hijo.on("error", (err) => {
    console.error(`[bvsala ${comando}] could not launch \`${final.bin}\`: ${String(err)}. Is it installed and on the PATH?`);
    void arranque.cerrar().then(() => process.exit(127));
  });
  hijo.on("exit", (code, signal) => {
    // El terminal ya soltó la pantalla: es el momento de decir lo que el log
    // callado del envoltorio no pudo (tráfico degradado, degradacion.ts).
    imprimirResumenes();
    void arranque.cerrar().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
} else {
  // La última línea dice cómo apuntar AL upstream que se eligió: la receta de
  // Claude Code delante de un gateway de OpenAI sería un 404 garantizado. Sin
  // elección (`up.upstream` vacío) el destino es Anthropic, directo o a través
  // del espía del anillo 2, y la línea es la de siempre.
  const host = new URL(upstreamEfectivo).hostname;
  if (host === "api.openai.com") {
    console.log(
      `[bvsala gateway] point your SDK at it: base_url=http://127.0.0.1:${arranque.puerto}/v1 (OpenAI SDKs) · ` +
        "streamed chat completions are metered when the request sets stream_options.include_usage · bvsala doctor for recipes",
    );
  } else if (host === "api.anthropic.com" || up.upstream === undefined) {
    console.log(
      `[bvsala gateway] point your terminal at it (or use \`bvsala ${TERMINALES_CON_ENVOLTORIO.join("|")}\`):  ` +
        `ANTHROPIC_BASE_URL=http://127.0.0.1:${arranque.puerto} claude   ·   bvsala doctor for the others`,
    );
  } else {
    console.log(
      `[bvsala gateway] point your client at http://127.0.0.1:${arranque.puerto} plus the path prefix it already uses ` +
        "(for example /v1) · bvsala doctor for recipes",
    );
  }
}

const parar = async (): Promise<void> => {
  imprimirResumenes();
  await arranque.cerrar();
  process.exit(0);
};
process.on("SIGINT", () => void parar());
process.on("SIGTERM", () => void parar());

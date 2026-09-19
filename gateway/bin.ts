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
import { decidirArranque, mensajeDeFalloDeArranque } from "./argumentos.js";
import { envoltorioDe, esTerminalConEnvoltorio, modoAuthCodex, resolverBinarioWindows, TERMINALES_CON_ENVOLTORIO } from "./envoltorios.js";
import { leerEnrolamiento, planDeAnillo2 } from "./anillo2.js";
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
import { instalarAgentsMd, instalarSkill } from "./skill.js";
import { soportaZstd } from "./medidor.js";
import { BV_SALA_VERSION } from "../src/index.js";

/**
 * El CLI de la pasarela:
 *
 *   `bvsala gateway [--puerto N]` — el medidor local para herramientas que
 *   respetan un base URL (Claude Code y el anillo de terminales compatibles).
 *
 *   `bvsala claude|codex|goose|qwen [args…]` — cero configuración: arranca el
 *   gateway en un puerto efímero, lanza el terminal apuntándole y lo apaga al
 *   salir (tabla en gateway/envoltorios.ts).
 *
 *   `bvsala doctor [--puerto N]` — detecta terminales instalados e imprime el
 *   bloque de configuración exacto de cada uno (gateway/doctor.ts).
 *
 * La decisión «ayuda / versión / arrancar» es una función pura
 * (gateway/argumentos.ts) porque este fichero arranca cosas al importarse y
 * no se puede probar; lo que aquí se hace es ejecutar lo decidido.
 */
const decision = decidirArranque(process.argv.slice(2));

function ayuda(): void {
  console.log(`bvsala ${BV_SALA_VERSION} — BiVelio Savings Layer

Commands:
  gateway [--puerto N]   Local metering proxy (default port 8402) for terminals that
                         honour a base URL: Claude Code, opencode, Goose, Crush…
  claude [args…]         Run Claude Code through the gateway. No configuration needed.
  codex [args…]          Run Codex CLI through the gateway (API key: api.openai.com;
                         ChatGPT auth: chatgpt.com/backend-api/codex — metered, not billed).
  goose [args…]          Run Goose (ANTHROPIC_HOST) through the gateway.
  qwen [args…]           Run Qwen Code (ANTHROPIC_BASE_URL) through the gateway.
  doctor [--puerto N]    Detect installed terminals and print the exact configuration for each.
  skill [--codex] [--proyecto] [--forzar]
                         Install the "savings-mode" skill for Claude Code (~/.claude/skills;
                         with --proyecto, .claude/skills in the current directory): terse
                         output plus surgical tool use to stretch subscription limits.
                         With --codex, the same discipline as a marked block in AGENTS.md
                         (~/.codex; with --proyecto, ./AGENTS.md) — Codex has no skills and
                         AGENTS.md is always active. Its effect is measured by the gateway,
                         not promised.
  --version | -v         Print the version only.
  --help | -h            This help; also accepted after gateway, doctor or skill
                         (\`bvsala gateway --help\` starts nothing).

Environment:
  BIVELIO_SERVICE_KEY    Service key (bvk_…): enables metering and seat identity.
  BVSALA_SEAT_ID         Stable seat identity per replica (optional).
  BVSALA_GATEWAY_UPSTREAM  Alternative upstream (default: the terminal's own).
  BVSALA_GATEWAY_COALESCE  =1 enables duplicate-request coalescing (experimental).
  BVSALA_GATEWAY_SHADOW  =1 enables the shadow lane for context elision (experimental):
                         computes what the elision policy would have saved WITHOUT touching
                         traffic and reports it separately (never counts toward the fee).
  BVSALA_GATEWAY_ELISION =0 turns OFF the provider-side levers, which are armed by default.
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
  BVSALA_GATEWAY_MODELO_HERMANO
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
  BVSALA_GATEWAY_ESFUERZO
                         =low|medium|high|xhigh|max sets per-turn effort (experimental):
                         appends a message with output_config.effort to each /v1/messages
                         without touching the root (does not reset the prefix cache). Only if
                         the license carries per_turn_effort (fail-closed) and only with
                         claude-fable-5-1, claude-mythos-5-1 and claude-opus-5; with any other
                         model the request travels untouched. It is the only lever that can
                         affect response quality: OFF by default and not yet measured against
                         the quality gate.
  BVSALA_CODEX_AUTH      api-key | chatgpt — forces the Codex auth mode.
  BVSALA_GATEWAY_LOG     =1 shows the per-request log inside the wrappers too (silenced by
                         default so it does not overwrite the TUI; use the dashboard instead).
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1  (Claude Code, API key only) your models in /model.

The gateway never blocks traffic: without a key, or with ingestion down, it forwards and warns.
Your prompts never leave your machine — only counts and cost. More: savings.bivelio.com`);
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
const { comando, resto } = decision;
const esEnvoltorio = esTerminalConEnvoltorio(comando);

if (comando === "skill") {
  // El SKILL.md empaquetado vive en <raíz>/skills/; desde dist/gateway/bin.js
  // la raíz es ../../, y ejecutado con tsx desde gateway/ es ../ — se prueban
  // ambas por existencia en vez de adivinar el layout.
  const aqui = dirname(fileURLToPath(import.meta.url));
  const opciones = {
    origenes: [join(aqui, "..", ".."), join(aqui, "..")],
    home: homedir(),
    cwd: process.cwd(),
    proyecto: resto.includes("--proyecto"),
    forzar: resto.includes("--forzar"),
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

// Envoltorios: puerto efímero; `gateway`: 8402 o --puerto (0 = efímero, lo usa
// el arnés F2); `doctor`: 1–65535 (imprime URLs — un puerto 0 no señala nada).
const idx = resto.indexOf("--puerto");
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

// La tabla decide destino y variables; bin.ts solo ejecuta. El modo de auth de
// Codex se lee por EXISTENCIA/enum de ~/.codex/auth.json — jamás se registra.
const envoltorio = esEnvoltorio
  ? envoltorioDe(comando, 0, resto, {
      modoCodex:
        comando === "codex"
          ? modoAuthCodex({ leerAuth: () => readFileSync(join(homedir(), ".codex", "auth.json"), "utf8") })
          : undefined,
    })
  : null;

const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY;
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
  upstreamEnv: process.env.BVSALA_GATEWAY_UPSTREAM,
  elisionEnv: process.env.BVSALA_GATEWAY_ELISION,
  hoyUtcIso: new Date().toISOString().slice(0, 10),
});
const upstreamPedido = process.env.BVSALA_GATEWAY_UPSTREAM ?? planAnillo2.upstream;
const elisionPedida = process.env.BVSALA_GATEWAY_ELISION ?? planAnillo2.elision;

let arranque: GatewayArrancado;
try {
  arranque = await arrancarGateway({
    puerto,
    ...(silencioso ? { log: () => {} } : {}),
    ...(serviceAccountKey ? { serviceAccountKey } : {}),
    ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
    ...(upstreamPedido
      ? { upstream: upstreamPedido }
      : envoltorio?.upstream
        ? { upstream: envoltorio.upstream }
        : {}),
    ...(process.env.BVSALA_GATEWAY_COALESCE === "1" ? { coalescer: true } : {}),
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
    ...(process.env.BVSALA_GATEWAY_MODELO_HERMANO === "1" ? { modeloHermano: true } : {}),
    // Palanca D · el techo de esfuerzo por turno. Es del OPERADOR: la palanca no
    // adivina qué turno merece pensar menos. Solo cambia la VÍA por la que se
    // aplica —un mensaje añadido, que NO reinicia la caché de prefijo, en vez del
    // campo de la raíz, que sí— y verja por modelo, porque fuera de fable-5-1,
    // mythos-5-1 y opus-5 es un 400.
    ...(process.env.BVSALA_GATEWAY_ESFUERZO ? { esfuerzo: process.env.BVSALA_GATEWAY_ESFUERZO } : {}),
    // Solo para desarrollo y pruebas: redirigir la ingesta de metering. En
    // producción no se toca y el gateway habla con savings.bivelio.com.
    ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
  });
} catch (err) {
  // El escenario más probable para un probador es lanzarlo dos veces (el 8402
  // por defecto). Hasta 0.4.20 esto era un rechazo sin manejar: la traza cruda
  // de Node («node:net … listen EADDRINUSE …») y exit 1 sin una palabra del
  // producto. Una sola línea, sin traza, con la salida (--puerto M o apagar el
  // otro proceso), y exit 1.
  console.error(`[bvsala ${comando}] ${mensajeDeFalloDeArranque(err, comando, puerto)}`);
  process.exit(1);
}

const upstreamEfectivo = upstreamPedido ?? envoltorio?.upstream ?? "https://api.anthropic.com";
console.log(`[bvsala gateway] v${BV_SALA_VERSION} listening on http://127.0.0.1:${arranque.puerto} → ${upstreamEfectivo}`);
console.log(`[bvsala gateway] metering: ${serviceAccountKey ? "ON (service key present)" : "OFF (BIVELIO_SERVICE_KEY not set)"}`);
{
  // El brazo del A/B (anillo 2) dicho en voz alta al arrancar: un día entero de
  // «palanca» corrió sin clave en un terminal viejo y fue control en silencio.
  const estado = describirEstadoDeElision(
    elisionPedida,
    serviceAccountKey !== undefined,
    process.env.BVSALA_GATEWAY_DIALES_ELISION === "1",
  );
  (estado.aviso ? console.error : console.log)(`[bvsala gateway] ${estado.linea}`);
  // Palanca C dicha en voz alta, por la misma razón: una bandera puesta en un
  // terminal sin clave (o con el canal cerrado) es control en silencio.
  const estadoHermano = describirEstadoDeHermano(
    process.env.BVSALA_GATEWAY_MODELO_HERMANO,
    serviceAccountKey !== undefined,
    elisionPedida !== "0",
  );
  (estadoHermano.aviso ? console.error : console.log)(`[bvsala gateway] ${estadoHermano.linea}`);
  // Palanca D dicha en voz alta por la misma razón que las otras: una palanca
  // que se cree encendida y no lo está es la trampa muda que ya costó un A/B.
  const estadoEsfuerzo = describirEstadoDeEsfuerzo(
    process.env.BVSALA_GATEWAY_ESFUERZO,
    serviceAccountKey !== undefined,
    elisionPedida !== "0",
  );
  (estadoEsfuerzo.aviso ? console.error : console.log)(`[bvsala gateway] ${estadoEsfuerzo.linea}`);
  if (planAnillo2.linea) {
    (planAnillo2.aviso ? console.error : console.log)(`[bvsala gateway] ${planAnillo2.linea}`);
  }
}
if (process.env.BVSALA_GATEWAY_UPSTREAM && envoltorio?.upstream && process.env.BVSALA_GATEWAY_UPSTREAM !== envoltorio.upstream) {
  // Un BVSALA_GATEWAY_UPSTREAM heredado del .zshrc (p.ej. el de Claude Code)
  // mandaría el tráfico de Codex a un host que no habla su protocolo.
  console.error(
    `[bvsala ${comando}] WARNING: BVSALA_GATEWAY_UPSTREAM=${process.env.BVSALA_GATEWAY_UPSTREAM} overrides this terminal's upstream ` +
      `(${envoltorio.upstream}). If that is not what you want, unset the variable.`,
  );
}
if (comando === "codex" && !soportaZstd()) {
  console.error(
    `[bvsala codex] WARNING: this Node (${process.version}) cannot decompress zstd and Codex sends its body in zstd: ` +
      "traffic passes through but is NOT metered. Use Node >= 22.15.",
  );
}

if (envoltorio && esEnvoltorio) {
  // La tabla se calculó con puerto 0 (aún no había gateway): se recalcula con
  // el puerto REAL. Hereda la terminal entera (stdio inherit: el TUI funciona
  // tal cual) y muere con el hijo.
  const final = envoltorioDe(comando, arranque.puerto, resto, {
    ...(envoltorio.upstream ? { modoCodex: envoltorio.upstream.includes("chatgpt.com") ? "chatgpt" : "api-key" } : {}),
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
    void arranque.cerrar().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
} else {
  console.log(
    `[bvsala gateway] point your terminal at it (or use \`bvsala ${TERMINALES_CON_ENVOLTORIO.join("|")}\`):  ` +
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${arranque.puerto} claude   ·   bvsala doctor for the others`,
  );
}

const parar = async (): Promise<void> => {
  await arranque.cerrar();
  process.exit(0);
};
process.on("SIGINT", () => void parar());
process.on("SIGTERM", () => void parar());

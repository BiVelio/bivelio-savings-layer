#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { arrancarGateway } from "./servidor.js";
import { envoltorioDe, esTerminalConEnvoltorio, modoAuthCodex, resolverBinarioWindows, TERMINALES_CON_ENVOLTORIO } from "./envoltorios.js";
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
 */
const [, , comando, ...resto] = process.argv;

function ayuda(): void {
  console.log(`bvsala ${BV_SALA_VERSION} — BiVelio Savings Layer

Comandos:
  gateway [--puerto N]   Proxy local medidor (por defecto 8402) para terminales que
                         respetan un base URL: Claude Code, opencode, Goose, Crush…
  claude [args…]         Lanza Claude Code a través del gateway, sin configurar nada.
  codex [args…]          Lanza Codex CLI a través del gateway (API key: api.openai.com;
                         auth ChatGPT: chatgpt.com/backend-api/codex — se mide, no se monetiza).
  goose [args…]          Lanza Goose (ANTHROPIC_HOST) a través del gateway.
  qwen [args…]           Lanza Qwen Code (ANTHROPIC_BASE_URL) a través del gateway.
  doctor [--puerto N]    Detecta terminales instalados e imprime su configuración exacta.
  skill [--codex] [--proyecto] [--forzar]
                         Instala el skill «savings-mode» de Claude Code (~/.claude/skills;
                         con --proyecto, en .claude/skills del directorio actual): salida
                         tersa + herramientas quirúrgicas para estirar los topes de
                         suscripción. Con --codex, la misma disciplina como bloque marcado
                         de AGENTS.md (~/.codex; con --proyecto, ./AGENTS.md) — Codex no
                         tiene skills y AGENTS.md va siempre activo. Su efecto se mide con
                         el gateway, no se promete.

Entorno:
  BIVELIO_SERVICE_KEY    Clave de servicio (bvk_…): habilita metering + asiento.
  BVSALA_SEAT_ID         Identidad de asiento estable por réplica (opcional).
  BVSALA_GATEWAY_UPSTREAM  Upstream alternativo (por defecto el del terminal).
  BVSALA_GATEWAY_COALESCE  =1 enciende la coalescencia de duplicados (F2, experimental).
  BVSALA_GATEWAY_SHADOW  =1 enciende el carril sombra de la elisión (S2): calcula qué
                         habría ahorrado la política v0 SIN tocar el tráfico y lo
                         reporta aparte (jamás entra en la comisión).
  BVSALA_CODEX_AUTH      api-key | chatgpt — fuerza el modo de auth de Codex.
  BVSALA_GATEWAY_LOG     =1 enseña el log por petición también dentro de los envoltorios
                         (por defecto va silenciado para no pisar el TUI; mira el panel).
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1  (Claude Code, solo API key) tus modelos en /model.

El gateway nunca corta el tráfico: sin clave o con la ingesta caída, reenvía y avisa.
Tus prompts jamás salen de tu máquina — solo cuentas y coste. Más: savings.bivelio.com`);
}

const esEnvoltorio = esTerminalConEnvoltorio(comando);
if (comando !== "gateway" && comando !== "doctor" && comando !== "skill" && !esEnvoltorio) {
  ayuda();
  process.exit(comando === undefined || comando === "help" || comando === "--help" ? 0 : 1);
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
  console.error(`[bvsala ${comando}] puerto inválido: ${resto[idx + 1]}`);
  process.exit(1);
}

if (comando === "doctor") {
  if (resto.includes("--write")) {
    console.error("[bvsala doctor] --write todavía no existe: el doctor solo imprime; copia el bloque a mano.");
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
const arranque = await arrancarGateway({
  puerto,
  ...(silencioso ? { log: () => {} } : {}),
  ...(serviceAccountKey ? { serviceAccountKey } : {}),
  ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
  ...(process.env.BVSALA_GATEWAY_UPSTREAM
    ? { upstream: process.env.BVSALA_GATEWAY_UPSTREAM }
    : envoltorio?.upstream
      ? { upstream: envoltorio.upstream }
      : {}),
  ...(process.env.BVSALA_GATEWAY_COALESCE === "1" ? { coalescer: true } : {}),
  ...(process.env.BVSALA_GATEWAY_SHADOW === "1" ? { sombra: true } : {}),
  // Solo para desarrollo y pruebas: redirigir la ingesta de metering. En
  // producción no se toca y el gateway habla con savings.bivelio.com.
  ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
});

const upstreamEfectivo = process.env.BVSALA_GATEWAY_UPSTREAM ?? envoltorio?.upstream ?? "https://api.anthropic.com";
console.log(`[bvsala gateway] v${BV_SALA_VERSION} escuchando en http://127.0.0.1:${arranque.puerto} → ${upstreamEfectivo}`);
console.log(`[bvsala gateway] medición: ${serviceAccountKey ? "ACTIVA (clave de servicio presente)" : "APAGADA (falta BIVELIO_SERVICE_KEY)"}`);
if (process.env.BVSALA_GATEWAY_UPSTREAM && envoltorio?.upstream && process.env.BVSALA_GATEWAY_UPSTREAM !== envoltorio.upstream) {
  // Un BVSALA_GATEWAY_UPSTREAM heredado del .zshrc (p.ej. el de Claude Code)
  // mandaría el tráfico de Codex a un host que no habla su protocolo.
  console.error(
    `[bvsala ${comando}] AVISO: BVSALA_GATEWAY_UPSTREAM=${process.env.BVSALA_GATEWAY_UPSTREAM} pisa el upstream de este terminal ` +
      `(${envoltorio.upstream}). Si no es lo que quieres, quita la variable.`,
  );
}
if (comando === "codex" && !soportaZstd()) {
  console.error(
    `[bvsala codex] AVISO: este Node (${process.version}) no descomprime zstd y Codex manda el cuerpo en zstd: ` +
      "el tráfico pasa pero NO se mide. Usa Node ≥ 22.15.",
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
        `[bvsala ${comando}] \`${final.bin}\` está instalado como shim de npm (${resuelto.ruta}) y Windows no puede ` +
          "lanzarlo de forma segura con argumentos (CVE-2024-27980). Instálalo con su instalador nativo " +
          `(deja un ${final.bin}.exe en el PATH) o usa la receta manual de docs/terminales/.`,
      );
      await arranque.cerrar();
      process.exit(127);
    }
  }
  const hijo = spawn(binAEjecutar, final.args, { stdio: "inherit", env: { ...process.env, ...final.env } });
  hijo.on("error", (err) => {
    console.error(`[bvsala ${comando}] no se pudo lanzar \`${final.bin}\`: ${String(err)}. ¿Está instalado y en el PATH?`);
    void arranque.cerrar().then(() => process.exit(127));
  });
  hijo.on("exit", (code, signal) => {
    void arranque.cerrar().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
} else {
  console.log(
    `[bvsala gateway] apunta tu terminal (o usa \`bvsala ${TERMINALES_CON_ENVOLTORIO.join("|")}\`):  ` +
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${arranque.puerto} claude   ·   bvsala doctor para el resto`,
  );
}

const parar = async (): Promise<void> => {
  await arranque.cerrar();
  process.exit(0);
};
process.on("SIGINT", () => void parar());
process.on("SIGTERM", () => void parar());

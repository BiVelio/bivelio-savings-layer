#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { arrancarGateway } from "./servidor.js";
import { envoltorioDe, esTerminalConEnvoltorio, modoAuthCodex, TERMINALES_CON_ENVOLTORIO } from "./envoltorios.js";
import { doctor } from "./doctor.js";
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
                         auth ChatGPT: chatgpt.com/backend-api/codex, en validación).
  goose [args…]          Lanza Goose (ANTHROPIC_HOST) a través del gateway.
  qwen [args…]           Lanza Qwen Code (ANTHROPIC_BASE_URL) a través del gateway.
  doctor [--puerto N]    Detecta terminales instalados e imprime su configuración exacta.

Entorno:
  BIVELIO_SERVICE_KEY    Clave de servicio (bvk_…): habilita metering + asiento.
  BVSALA_SEAT_ID         Identidad de asiento estable por réplica (opcional).
  BVSALA_GATEWAY_UPSTREAM  Upstream alternativo (por defecto el del terminal).
  BVSALA_GATEWAY_COALESCE  =1 enciende la coalescencia de duplicados (F2, experimental).
  BVSALA_CODEX_AUTH      api-key | chatgpt — fuerza el modo de auth de Codex.
  CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1  (Claude Code, solo API key) tus modelos en /model.

El gateway nunca corta el tráfico: sin clave o con la ingesta caída, reenvía y avisa.
Tus prompts jamás salen de tu máquina — solo cuentas y coste. Más: savings.bivelio.com`);
}

const esEnvoltorio = esTerminalConEnvoltorio(comando);
if (comando !== "gateway" && comando !== "doctor" && !esEnvoltorio) {
  ayuda();
  process.exit(comando === undefined || comando === "help" || comando === "--help" ? 0 : 1);
}

// Envoltorios: puerto efímero; `gateway`/`doctor`: 8402 o --puerto.
const idx = resto.indexOf("--puerto");
const puerto = esEnvoltorio ? 0 : idx >= 0 ? Number(resto[idx + 1]) : 8402;
if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535) {
  console.error(`[bvsala ${comando}] puerto inválido: ${resto[idx + 1]}`);
  process.exit(1);
}

if (comando === "doctor") {
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
const arranque = await arrancarGateway({
  puerto,
  ...(serviceAccountKey ? { serviceAccountKey } : {}),
  ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
  ...(process.env.BVSALA_GATEWAY_UPSTREAM
    ? { upstream: process.env.BVSALA_GATEWAY_UPSTREAM }
    : envoltorio?.upstream
      ? { upstream: envoltorio.upstream }
      : {}),
  ...(process.env.BVSALA_GATEWAY_COALESCE === "1" ? { coalescer: true } : {}),
  // Solo para desarrollo y pruebas: redirigir la ingesta de metering. En
  // producción no se toca y el gateway habla con savings.bivelio.com.
  ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
});

console.log(`[bvsala gateway] v${BV_SALA_VERSION} escuchando en http://127.0.0.1:${arranque.puerto}`);
console.log(`[bvsala gateway] medición: ${serviceAccountKey ? "ACTIVA (clave de servicio presente)" : "APAGADA (falta BIVELIO_SERVICE_KEY)"}`);

if (envoltorio && esEnvoltorio) {
  // La tabla se calculó con puerto 0 (aún no había gateway): se recalcula con
  // el puerto REAL. Hereda la terminal entera (stdio inherit: el TUI funciona
  // tal cual) y muere con el hijo.
  const final = envoltorioDe(comando, arranque.puerto, resto, {
    ...(envoltorio.upstream ? { modoCodex: envoltorio.upstream.includes("chatgpt.com") ? "chatgpt" : "api-key" } : {}),
  });
  if (final.nota) console.log(`[bvsala ${comando}] ${final.nota}`);
  const hijo = spawn(final.bin, final.args, { stdio: "inherit", env: { ...process.env, ...final.env } });
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

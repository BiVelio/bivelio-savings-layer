#!/usr/bin/env node
import { spawn } from "node:child_process";

import { arrancarGateway } from "./servidor.js";
import { BV_SALA_VERSION } from "../src/index.js";

/**
 * El CLI de la pasarela:
 *
 *   `bvsala gateway [--puerto N]` — el medidor local para herramientas que
 *   respetan ANTHROPIC_BASE_URL (Claude Code y compatibles).
 *
 *   `bvsala claude [args…]` — cero configuración: arranca el gateway en un
 *   puerto efímero, lanza `claude` apuntándole y lo apaga al salir.
 */
const [, , comando, ...resto] = process.argv;

function ayuda(): void {
  console.log(`bvsala ${BV_SALA_VERSION} — BiVelio Savings Layer

Comandos:
  gateway [--puerto N]   Proxy local medidor para Claude Code (ANTHROPIC_BASE_URL).
  claude [args…]         Lanza Claude Code a través del gateway, sin configurar nada.

Entorno:
  BIVELIO_SERVICE_KEY    Clave de servicio (bvk_…): habilita metering + asiento.
  BVSALA_SEAT_ID         Identidad de asiento estable por réplica (opcional).
  BVSALA_GATEWAY_UPSTREAM  Upstream alternativo (por defecto https://api.anthropic.com).
  BVSALA_GATEWAY_COALESCE  =1 enciende la coalescencia de duplicados (F2, experimental).

El gateway nunca corta el tráfico: sin clave o con la ingesta caída, reenvía y avisa.
Tus prompts jamás salen de tu máquina — solo cuentas y coste. Más: savings.bivelio.com`);
}

if (comando !== "gateway" && comando !== "claude") {
  ayuda();
  process.exit(comando === undefined || comando === "help" || comando === "--help" ? 0 : 1);
}

// `bvsala claude`: puerto efímero; `bvsala gateway`: 8402 o --puerto.
const idx = resto.indexOf("--puerto");
const puerto = comando === "claude" ? 0 : idx >= 0 ? Number(resto[idx + 1]) : 8402;
if (!Number.isInteger(puerto) || puerto < 0 || puerto > 65535) {
  console.error(`[bvsala gateway] puerto inválido: ${resto[idx + 1]}`);
  process.exit(1);
}

const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY;
const arranque = await arrancarGateway({
  puerto,
  ...(serviceAccountKey ? { serviceAccountKey } : {}),
  ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
  ...(process.env.BVSALA_GATEWAY_UPSTREAM ? { upstream: process.env.BVSALA_GATEWAY_UPSTREAM } : {}),
  ...(process.env.BVSALA_GATEWAY_COALESCE === "1" ? { coalescer: true } : {}),
  // Solo para desarrollo y pruebas: redirigir la ingesta de metering. En
  // producción no se toca y el gateway habla con savings.bivelio.com.
  ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
});

console.log(`[bvsala gateway] v${BV_SALA_VERSION} escuchando en http://127.0.0.1:${arranque.puerto}`);
console.log(`[bvsala gateway] medición: ${serviceAccountKey ? "ACTIVA (clave de servicio presente)" : "APAGADA (falta BIVELIO_SERVICE_KEY)"}`);

if (comando === "claude") {
  // La envoltura: lanza `claude` con la variable puesta, hereda la terminal
  // entera (stdio inherit: el TUI funciona tal cual) y muere con él.
  const hijo = spawn("claude", resto, {
    stdio: "inherit",
    env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${arranque.puerto}` },
  });
  hijo.on("error", (err) => {
    console.error(`[bvsala claude] no se pudo lanzar \`claude\`: ${String(err)}. ¿Está instalado y en el PATH?`);
    void arranque.cerrar().then(() => process.exit(127));
  });
  hijo.on("exit", (code, signal) => {
    void arranque.cerrar().then(() => process.exit(code ?? (signal ? 1 : 0)));
  });
} else {
  console.log(`[bvsala gateway] apunta tu herramienta:  ANTHROPIC_BASE_URL=http://127.0.0.1:${arranque.puerto} claude`);
}

const parar = async (): Promise<void> => {
  await arranque.cerrar();
  process.exit(0);
};
process.on("SIGINT", () => void parar());
process.on("SIGTERM", () => void parar());

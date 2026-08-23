#!/usr/bin/env node
import { arrancarGateway } from "./servidor.js";
import { BV_SALA_VERSION } from "../src/index.js";

/**
 * `bvsala gateway [--puerto N]` — el medidor local para herramientas que
 * respetan ANTHROPIC_BASE_URL (Claude Code y compatibles).
 *
 * Uso:
 *   export BIVELIO_SERVICE_KEY=bvk_…       # del dashboard: metering + asiento
 *   bvsala gateway                          # escucha en 127.0.0.1:8402
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8402 claude
 */
const [, , comando, ...resto] = process.argv;

function ayuda(): void {
  console.log(`bvsala ${BV_SALA_VERSION} — BiVelio Savings Layer

Comandos:
  gateway [--puerto N]   Proxy local medidor para Claude Code (ANTHROPIC_BASE_URL).

Entorno:
  BIVELIO_SERVICE_KEY    Clave de servicio (bvk_…): habilita metering + asiento.
  BVSALA_SEAT_ID         Identidad de asiento estable por réplica (opcional).
  BVSALA_GATEWAY_UPSTREAM  Upstream alternativo (por defecto https://api.anthropic.com).

El gateway nunca corta el tráfico: sin clave o con la ingesta caída, reenvía y avisa.
Tus prompts jamás salen de tu máquina — solo cuentas y coste. Más: savings.bivelio.com`);
}

if (comando !== "gateway") {
  ayuda();
  process.exit(comando === undefined || comando === "help" || comando === "--help" ? 0 : 1);
}

const idx = resto.indexOf("--puerto");
const puerto = idx >= 0 ? Number(resto[idx + 1]) : 8402;
if (!Number.isInteger(puerto) || puerto <= 0 || puerto > 65535) {
  console.error(`[bvsala gateway] puerto inválido: ${resto[idx + 1]}`);
  process.exit(1);
}

const serviceAccountKey = process.env.BIVELIO_SERVICE_KEY;
const arranque = await arrancarGateway({
  puerto,
  ...(serviceAccountKey ? { serviceAccountKey } : {}),
  ...(process.env.BVSALA_SEAT_ID ? { seatId: process.env.BVSALA_SEAT_ID } : {}),
  ...(process.env.BVSALA_GATEWAY_UPSTREAM ? { upstream: process.env.BVSALA_GATEWAY_UPSTREAM } : {}),
  // Solo para desarrollo y pruebas: redirigir la ingesta de metering. En
  // producción no se toca y el gateway habla con savings.bivelio.com.
  ...(process.env.BVSALA_METERING_URL ? { meteringUrl: process.env.BVSALA_METERING_URL } : {}),
});

console.log(`[bvsala gateway] v${BV_SALA_VERSION} escuchando en http://127.0.0.1:${arranque.puerto}`);
console.log(`[bvsala gateway] apunta tu herramienta:  ANTHROPIC_BASE_URL=http://127.0.0.1:${arranque.puerto} claude`);
console.log(`[bvsala gateway] medición: ${serviceAccountKey ? "ACTIVA (clave de servicio presente)" : "APAGADA (falta BIVELIO_SERVICE_KEY)"}`);

const parar = async (): Promise<void> => {
  await arranque.cerrar();
  process.exit(0);
};
process.on("SIGINT", () => void parar());
process.on("SIGTERM", () => void parar());

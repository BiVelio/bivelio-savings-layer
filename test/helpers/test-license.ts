import { generateKeyPairSync, sign } from "node:crypto";

import type { GatewayLicense } from "../../gateway/license.js";
import type { LicenseStatus, ResolvedGate } from "../../src/license/index.js";

/**
 * LICENCIAS DE PRUEBA PARA EL GATEWAY. Desde 0.4.23 `arrancarGateway` exige una
 * licencia verificada (LICENSE §2), así que todo test que arranca uno necesita un
 * token firmado. Un par Ed25519 por MÓDULO de test (se genera al importar), la
 * pública se inyecta — cosa que solo el fuente permite: en el build publicado
 * manda siempre la clave embebida (`effectivePublicKey`).
 *
 * No es un `.test.ts`: vitest no lo ejecuta, `typecheck` sí lo compila.
 */

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

const par = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** El par de prueba (SPKI / PKCS8 en PEM). */
export const TEST_KEYS: { publicKey: string; privateKey: string } = {
  publicKey: par.publicKey,
  privateKey: par.privateKey,
};

function firmar(header: Record<string, unknown>, body: Record<string, unknown>, privateKey: string): string {
  const head = b64url(JSON.stringify(header));
  const cuerpo = b64url(JSON.stringify(body));
  const sig = sign(null, Buffer.from(`${head}.${cuerpo}`), privateKey);
  return `${head}.${cuerpo}.${b64url(sig)}`;
}

/** Un token de licencia compacto, como lo acuña el control plane. */
export function signLicense(
  payload: Record<string, unknown>,
  privateKey: string = TEST_KEYS.privateKey,
  header: Record<string, unknown> = { alg: "EdDSA", typ: "BVL", v: 1 },
): string {
  return firmar(header, payload, privateKey);
}

/** Una lista de revocaciones firmada (typ BVSALA-REVOC), como /licenses/revocations. */
export function signRevocationList(
  body: { seq: number; asOf: number; revoked: string[] },
  privateKey: string = TEST_KEYS.privateKey,
): string {
  return firmar({ alg: "EdDSA", typ: "BVSALA-REVOC", v: 1 }, { v: 1, ...body }, privateKey);
}

let secuencia = 0;

/** El payload de una licencia PRO activa 30 días, con 14 de gracia. */
export function testPayload(over: Record<string, unknown> = {}, nowMs: number = Date.now()): Record<string, unknown> {
  const ahora = Math.floor(nowMs / 1000);
  secuencia += 1;
  return {
    jti: `lic-test-${secuencia}`,
    org_id: "org-test",
    plan: "pro",
    seats: 1,
    features: ["cache_ttl_tuning", "sibling_model_routing", "per_turn_effort", "context_elision"],
    issued_at: ahora,
    expires_at: ahora + 30 * 86_400,
    grace_days: 14,
    iss: "bivelio-test",
    ...over,
  };
}

/** Lo que `arrancarGateway` recibe: un token de prueba y su clave pública. */
export function testLicense(over: Record<string, unknown> = {}, nowMs: number = Date.now()): GatewayLicense {
  return { token: signLicense(testPayload(over, nowMs)), publicKey: TEST_KEYS.publicKey };
}

/** Un gate con el estado fijado, para la tabla de `licenseVerdict`. */
export function fakeGate(status: LicenseStatus): ResolvedGate {
  const concede = status === "active" || status === "grace";
  return {
    isEntitled: () => concede,
    isActive: () => concede,
    status: () => status,
    reason: () => undefined,
    refreshAfter: () => undefined,
  };
}

/** Un reloj en milisegundos que solo avanza cuando el test lo dice. */
export function mutableClock(startMs: number): { now: () => number; advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

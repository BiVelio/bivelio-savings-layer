import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect } from "vitest";

import { liveGateFromKey, RevocationSnapshot } from "../src/index.js";
import { DEFAULT_MAX_STALENESS_SECONDS } from "../src/pipeline/create.js";

/**
 * REGRESIÓN del techo de frescura por defecto. Estaba en 6 h, y eso apagaba a
 * clientes que PAGAN si el control plane de BiVelio caía una tarde (caza del
 * 2026-08-27). Este test fija el suelo —nunca volver a un valor tan agresivo— y
 * comprueba el comportamiento con ese default alrededor del borde.
 */

const DAY = 86400;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const kp = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function token(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), kp.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

const ISSUED = 1_800_000_000;
const mensual = { jti: "m", org_id: "o", plan: "pro", seats: 1, issued_at: ISSUED, expires_at: ISSUED + 30 * DAY, grace_days: 14 };

describe("techo de frescura por defecto", () => {
  it("es lo bastante alto para sobrevivir a un incidente nuestro (≥ 24 h)", () => {
    // 6 h (el bug) queda descartado; 72 h es el valor actual.
    expect(DEFAULT_MAX_STALENESS_SECONDS).toBeGreaterThanOrEqual(24 * 3600);
  });

  it("con el default, un cliente de vida larga NO se apaga por una caída de 6 h del control plane", () => {
    const dia = 10; // licencia mensual válida, a mitad de mes
    const now = ISSUED + dia * DAY;
    // Snapshot online cuyo último contacto fue hace 6 h — NUESTRA caída.
    const revocation = new RevocationSnapshot();
    revocation.markContact(now - 6 * 3600);
    const gate = liveGateFromKey(token(mensual), kp.publicKey, {
      revocation,
      now: () => now * 1000,
      startedAt: now - dia * DAY, // arrancó hace 10 días (proceso de vida larga)
      maxStalenessSeconds: DEFAULT_MAX_STALENESS_SECONDS,
    });
    // Bajo el viejo 6 h esto era "stale"; con 72 h sigue activa.
    expect(gate.status()).not.toBe("stale");
    expect(gate.isActive()).toBe(true);
  });

  it("pero una caída de MÁS de 72 h sí cierra la verja (el mecanismo sigue vivo)", () => {
    const dia = 10;
    const now = ISSUED + dia * DAY;
    const revocation = new RevocationSnapshot();
    revocation.markContact(now - 73 * 3600);
    const gate = liveGateFromKey(token(mensual), kp.publicKey, {
      revocation,
      now: () => now * 1000,
      startedAt: now - dia * DAY,
      maxStalenessSeconds: DEFAULT_MAX_STALENESS_SECONDS,
    });
    expect(gate.status()).toBe("stale");
  });
});

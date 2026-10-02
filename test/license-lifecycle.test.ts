import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect } from "vitest";

import { liveGateFromKey, RevocationSnapshot } from "../src/license/index.js";

/**
 * El ciclo de vida de una licencia que PAGA. El requisito es simple y no admite
 * sorpresas: si el cliente compró mensual, funciona 30 días; si compró anual,
 * 365; y NO caduca antes por ningún otro motivo.
 *
 * El bug que esto cierra (B1 de la auditoría): la verja de FRESCURA —distinta de
 * la caducidad— acotaba su ancla por `issued_at`, así que en serverless una
 * licencia mensual válida de más de unas horas se marcaba `expired` mucho antes
 * de su caducidad real. Un cliente que pagó, bloqueado. Ahora el ancla se acota
 * por `expires_at`, el fin real de la validez pagada.
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

/** Gate en el instante `nowSec`, arrancado en `startedAtSec` (simula serverless frío). */
function gateAt(payload: Record<string, unknown>, nowSec: number, startedAtSec: number) {
  return liveGateFromKey(token(payload), kp.publicKey, {
    revocation: new RevocationSnapshot(),
    now: () => nowSec * 1000,
    maxStalenessSeconds: 12 * 3600, // 12 h, como el README
    startedAt: startedAtSec,
  });
}

const ISSUED = 1_800_000_000;
const mensual = { jti: "m", org_id: "o", plan: "pro", seats: 1, issued_at: ISSUED, expires_at: ISSUED + 30 * DAY, grace_days: 14 };
const anual = { jti: "a", org_id: "o", plan: "pro", seats: 1, issued_at: ISSUED, expires_at: ISSUED + 365 * DAY, grace_days: 14 };

describe("una licencia que paga funciona hasta su caducidad real", () => {
  it("MENSUAL: activa el día 1, el 15 y el 29 — en serverless FRÍO cada vez", () => {
    // El escenario del bug: cada petición es un proceso nuevo (startedAt = ahora)
    // y nunca ha contactado con el servidor. Antes daba `expired` desde el día 2.
    for (const dia of [1, 15, 29]) {
      const now = ISSUED + dia * DAY;
      expect(gateAt(mensual, now, now).status()).toBe("active");
    }
  });

  it("ANUAL: activa el día 1, el 100 y el 364 — en serverless FRÍO", () => {
    for (const dia of [1, 100, 364]) {
      const now = ISSUED + dia * DAY;
      expect(gateAt(anual, now, now).status()).toBe("active");
    }
  });

  it("MENSUAL caduca DESPUÉS del día 30, no antes", () => {
    const dia29 = ISSUED + 29 * DAY;
    expect(gateAt(mensual, dia29, dia29).status()).toBe("active");
    // Día 31: pasado expires_at pero dentro de los 14 de gracia.
    const dia31 = ISSUED + 31 * DAY;
    expect(gateAt(mensual, dia31, dia31).status()).toBe("grace");
    // Día 45: pasada también la gracia → expirada de verdad.
    const dia45 = ISSUED + 45 * DAY;
    expect(gateAt(mensual, dia45, dia45).status()).toBe("expired");
  });

  it("ANUAL sigue activa a los 300 días, donde una mensual haría mucho que caducó", () => {
    const dia300 = ISSUED + 300 * DAY;
    expect(gateAt(anual, dia300, dia300).status()).toBe("active");
    expect(gateAt(mensual, dia300, dia300).status()).toBe("expired");
  });
});

describe("la verja de frescura sigue mordiendo donde DEBE (proceso de vida larga)", () => {
  it("un proceso que arrancó hace más de maxStaleness y NUNCA contactó se cierra", () => {
    // Desktop/gateway arrancado hace 20 h, licencia mensual válida, egress
    // bloqueado desde el arranque: la revocación no se puede confirmar, así que la
    // verja cierra. Esto es lo que impide mantener viva una licencia revocada
    // bloqueando la red.
    const now = ISSUED + 5 * DAY;
    const arrancoHace20h = now - 20 * 3600;
    const gate = gateAt(mensual, now, arrancoHace20h);
    // Lo que importa es que la puerta CIERRA, y eso no ha cambiado.
    expect(gate.isActive()).toBe(false);
    // Pero el estado es "stale", NO "expired": esta licencia está pagada y le
    // quedan 25 días. Llamarlo "expired" hacía que el mensaje le dijera al
    // cliente que renovara una suscripción que ya tenía al día, mandándole a
    // pagar cuando su problema era un cortafuegos.
    expect(gate.status()).toBe("stale");
    expect(gate.status()).not.toBe("expired");
  });

  it("pero si arrancó hace poco, la ventana de gracia del arranque lo mantiene", () => {
    const now = ISSUED + 5 * DAY;
    const arrancoHace1h = now - 1 * 3600;
    expect(gateAt(mensual, now, arrancoHace1h).status()).toBe("active");
  });
});

describe("no se puede resucitar una licencia caducada engañando al reloj de arranque", () => {
  it("una licencia ya expirada no revive por decir que el proceso acaba de arrancar", () => {
    // startedAt = ahora (proceso 'nuevo'), pero expires_at + gracia ya pasó:
    // deriveStatus manda, y la verja de frescura ni siquiera corre para 'expired'.
    const muyTarde = ISSUED + 60 * DAY;
    expect(gateAt(mensual, muyTarde, muyTarde).status()).toBe("expired");
  });
});

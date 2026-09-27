import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { DIAS_DE_GRACIA_POR_DEFECTO } from "../apps/web/lib/billing/gracia.js";
import {
  RENEWAL_INTERVAL_MS,
  RENEWAL_LEAD_SECONDS,
  RENEWAL_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  STARTUP_TIMEOUT_WITH_FALLBACK_MS,
  buildLiveLicense,
  licenseLine,
  verifyGatewayLicense,
} from "../gateway/license.js";
import { liveGateFromKey, RevocationSnapshot } from "../src/index.js";
import { computeNextDelay } from "../src/license/poller.js";
import { DEFAULT_MAX_STALENESS_SECONDS } from "../src/pipeline/create.js";

/**
 * «QUÉ PASA SI VUESTRO SERVIDOR NO RESPONDE», CONTADO POR EL CÓDIGO.
 *
 * La sección «Availability» de SECURITY.md es lo que un comprador técnico lee
 * antes de meter el SDK o el gateway en producción, y cada frase es una
 * promesa operativa: cuánto aguanta una caída nuestra, qué se corta y qué no.
 * Una cifra de ahí que no coincida con el código es una promesa falsa, y el
 * negocio no admite frases sin código que las respalde.
 *
 * Así que cada plazo se lee DEL CÓDIGO —de la constante exportada cuando la
 * hay, del fuente cuando es privada— y se exige tal cual en el documento. Y lo
 * que es comportamiento y no una constante (el gateway sin techo de 72 h, el
 * SDK que vuelve a servir al primer contacto) se comprueba ejecutándolo.
 *
 * Si cambias un plazo en el código, este test te manda a SECURITY.md.
 */

const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
const plano = (t: string) => t.replace(/\s+/g, " ");

const seguridad = leer("../SECURITY.md");
const disponibilidad = plano(seguridad.slice(seguridad.indexOf("## Availability")));

/** El valor de un literal numérico del fuente: `3600_000`, `7 * 86400`, `0.1`. */
function literal(fuente: string, patron: RegExp, donde: string): number {
  const m = patron.exec(fuente);
  if (!m?.[1]) throw new Error(`no se encontró ${patron} en ${donde}: ¿cambió el código?`);
  return m[1]
    .split("*")
    .map((f) => Number(f.replace(/_/g, "").trim()))
    .reduce((a, b) => a * b, 1);
}

const poller = leer("../src/license/poller.ts");
const refresher = leer("../src/license/refresher.ts");
const emisor = leer("../src/metering/emitter.ts");
const canal = leer("../gateway/entitlements.ts");

const SONDEO_S = literal(poller, /pollIntervalSeconds: ([\d_]+),/, "poller.ts");
const SUELO_S = literal(poller, /floorSeconds: ([\d_]+),/, "poller.ts");
const TECHO_S = literal(poller, /maxIntervalSeconds: ([\d_]+),/, "poller.ts");
const JITTER = literal(poller, /jitterRatio: ([\d.]+),/, "poller.ts");
const TIMEOUT_SONDEO_MS = literal(poller, /requestTimeoutMs: ([\d_]+),/, "poller.ts");
const FALLOS_AVISO = literal(poller, /const FALLOS_ANTES_DE_AVISAR = ([\d_]+);/, "poller.ts");
const REPETIR_AVISO = literal(poller, /const REPETIR_AVISO_CADA = ([\d_]+);/, "poller.ts");

const RECOGIDA_MS = literal(refresher, /const DEFAULT_POLL_INTERVAL_MS = ([\d_ *]+);/, "refresher.ts");
const ANTELACION_S = literal(refresher, /const DEFAULT_REFRESH_LEAD_SECONDS = ([\d_ *]+);/, "refresher.ts");
const TIMEOUT_RECOGIDA_MS = literal(refresher, /const DEFAULT_REQUEST_TIMEOUT_MS = ([\d_ *]+);/, "refresher.ts");

const VACIADO_MS = literal(emisor, /flushIntervalMs \?\? ([\d_]+);/, "emitter.ts");
const LOTE = literal(emisor, /maxBatch \?\? ([\d_]+);/, "emitter.ts");
const BUFFER = literal(emisor, /maxBuffer \?\? ([\d_]+);/, "emitter.ts");

const TTL_CANAL_MS = literal(canal, /const TTL_POR_DEFECTO_MS = ([\d_]+);/, "entitlements.ts");
const TIMEOUT_CANAL_MS = literal(canal, /const TIMEOUT_MS = ([\d_]+);/, "entitlements.ts");
const REINTENTO_CANAL_MS = literal(canal, /Math\.min\(([\d_]+), this\.ttlMs\)/, "entitlements.ts");

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

describe("SECURITY.md · Availability dice los plazos del código", () => {
  it("la lista de revocaciones: cadencia, suelo, jitter y timeout", () => {
    expect(disponibilidad).toContain(
      `every ${SONDEO_S / 60} minutes, never more often than every ${SUELO_S / 60} minutes, with ±${JITTER * 100}% jitter`,
    );
    expect(disponibilidad).toContain(`Each request times out after ${TIMEOUT_SONDEO_MS / 1000} seconds`);
  });

  it("el backoff de una caída, calculado con la política real", () => {
    const retrasos = [1, 2, 3, 4, 5, 6].map((consecutiveFailures) =>
      computeNextDelay({
        consecutiveFailures,
        nowSeconds: 0,
        floorSeconds: SUELO_S,
        pollIntervalSeconds: SONDEO_S,
        maxIntervalSeconds: TECHO_S,
        jitterRatio: JITTER,
        random: () => 0.5, // jitter neutro: el factor es exactamente 1
      }) / 60,
    );
    const distintos = [...new Set(retrasos)];
    const techo = distintos.pop()!;
    expect(techo).toBe(TECHO_S / 60);
    const lista = `${distintos.slice(0, -1).join(", ")} and ${distintos.at(-1)}`;
    expect(disponibilidad).toContain(`back off to ${lista} minutes, and then every ${techo} minutes`);
  });

  it("los avisos por consola del sondeo", () => {
    expect(disponibilidad).toContain(
      `after the ${ordinal(FALLOS_AVISO)} consecutive network failure, then every ${ordinal(REPETIR_AVISO)}`,
    );
  });

  it("el techo de frescura del SDK online", () => {
    expect(DEFAULT_MAX_STALENESS_SECONDS % 3600).toBe(0);
    const horas = DEFAULT_MAX_STALENESS_SECONDS / 3600;
    expect(disponibilidad).toContain(`Fail-closed after ${horas} hours`);
    expect(disponibilidad).toContain(`goes ${horas} hours without a confirmed answer`);
    expect(disponibilidad).toContain("`licenseRevocation.maxStalenessSeconds`");
    expect(disponibilidad).toContain(`the gateway has no ${horas}-hour limit`);
  });

  it("la recogida de la licencia renovada: la misma en el SDK y en el gateway", () => {
    // Si un día divergen, el documento tendrá que contar dos historias.
    expect(RENEWAL_LEAD_SECONDS).toBe(ANTELACION_S);
    expect(RENEWAL_INTERVAL_MS).toBe(RECOGIDA_MS);
    expect(RENEWAL_TIMEOUT_MS).toBe(TIMEOUT_RECOGIDA_MS);
    expect(RECOGIDA_MS).toBe(3_600_000); // «once an hour»
    const dias = ANTELACION_S / 86_400;
    const s = TIMEOUT_RECOGIDA_MS / 1000;
    expect(disponibilidad).toContain(
      `From ${dias} days before the license expires, the SDK asks \`<licenseServerUrl>/api/license/current\` once an hour for the renewed license (${s}-second timeout)`,
    );
    expect(disponibilidad).toContain(`Renewal: from ${dias} days before expiry, once an hour (${s}-second timeout)`);
  });

  it("la medición de uso", () => {
    expect(disponibilidad).toContain(`every ${VACIADO_MS / 1000} seconds, in batches of ${LOTE}`);
    expect(disponibilidad).toContain(`up to ${BUFFER.toLocaleString("en-US")} records are kept in memory`);
  });

  it("el arranque del gateway", () => {
    expect(disponibilidad).toContain(
      `waits up to ${STARTUP_TIMEOUT_MS / 1000} seconds, or ${STARTUP_TIMEOUT_WITH_FALLBACK_MS / 1000} seconds when a valid`,
    );
  });

  it("el canal de entitlements del gateway", () => {
    expect(disponibilidad).toContain(`cached for up to ${TTL_CANAL_MS / 60_000} minutes`);
    expect(disponibilidad).toContain(`(${TIMEOUT_CANAL_MS / 1000}-second timeout)`);
    expect(disponibilidad).toContain(`retries within ${REINTENTO_CANAL_MS / 1000} seconds`);
  });

  it("la gracia por defecto de una licencia de suscripción", () => {
    expect(disponibilidad).toContain(`get ${DIAS_DE_GRACIA_POR_DEFECTO} days by default`);
  });
});

// ── Lo que no es una constante, ejecutado ─────────────────────────────────────

const DIA = 86_400;
const kp = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function token(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(sign(null, Buffer.from(`${head}.${body}`), kp.privateKey))}`;
}
const EMITIDA = 1_800_000_000;
const licencia = {
  jti: "disp",
  org_id: "o",
  plan: "pro",
  seats: 1,
  features: [],
  issued_at: EMITIDA,
  expires_at: EMITIDA + 30 * DIA,
  grace_days: DIAS_DE_GRACIA_POR_DEFECTO,
};

describe("SECURITY.md · Availability, comprobado ejecutando", () => {
  it("SDK online: sin respuesta confirmada durante el techo se cierra con `stale`, y el primer contacto lo reabre", () => {
    const arranque = EMITIDA + DIA;
    let ahora = arranque;
    const revocation = new RevocationSnapshot();
    const gate = liveGateFromKey(token(licencia), kp.publicKey, {
      revocation,
      now: () => ahora * 1000,
      startedAt: arranque,
      maxStalenessSeconds: DEFAULT_MAX_STALENESS_SECONDS,
    });
    // Cuenta desde el arranque del proceso.
    ahora = arranque + DEFAULT_MAX_STALENESS_SECONDS - 3600;
    expect(gate.status()).toBe("active");
    ahora = arranque + DEFAULT_MAX_STALENESS_SECONDS + 3600;
    expect(gate.status()).toBe("stale");
    // «serves again as soon as a confirmed answer arrives».
    revocation.markContact(ahora);
    expect(gate.status()).toBe("active");
  });

  it("gateway: sin techo de frescura — diez días sin contactar sigue sirviendo hasta caducidad + gracia", () => {
    const c = verifyGatewayLicense(token(licencia), kp.publicKey);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    let ahoraMs = (EMITIDA + DIA) * 1000;
    const live = buildLiveLicense(c.license, kp.publicKey, new RevocationSnapshot(), () => ahoraMs);
    ahoraMs += 10 * DIA * 1000;
    expect(live.gate.status()).toBe("active");
    ahoraMs = (licencia.expires_at + (DIAS_DE_GRACIA_POR_DEFECTO - 1) * DIA) * 1000;
    expect(live.gate.status()).toBe("grace");
    ahoraMs = (licencia.expires_at + (DIAS_DE_GRACIA_POR_DEFECTO + 1) * DIA) * 1000;
    expect(live.gate.status()).toBe("expired");
  });

  it("gateway: la línea de arranque dice la gracia («+N days grace»)", () => {
    const linea = licenseLine(licencia, "online", "active");
    expect(linea).toContain(`(+${DIAS_DE_GRACIA_POR_DEFECTO} days grace)`);
    expect(disponibilidad).toContain("(`+N days grace`)");
  });
});

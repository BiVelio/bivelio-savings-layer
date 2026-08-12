import type { LicenseGate } from "../contracts/types.js";
import {
  verifyLicenseToken,
  deriveStatus,
  type LicenseStatus,
  type LicenseTokenPayload,
  type LicenseKeyset,
} from "./verify.js";
import type { RevocationSnapshot } from "./revocation.js";

/** A resolved gate that also exposes overall status + a refresh horizon. */
export interface ResolvedGate extends LicenseGate {
  isActive(): boolean;
  status(): LicenseStatus;
  /** Unix seconds after which the online status should be re-checked (poller anchor). */
  refreshAfter?(): number | undefined;
}

/**
 * Build a LIVE license gate from a signed key. The token is verified + decoded
 * ONCE (no per-request Ed25519 verify — hot-path safe); each `isActive()` /
 * `status()` / `isEntitled()` then re-derives the status from the cached payload +
 * the LIVE clock + the (mutable, sticky) {@link RevocationSnapshot}. This is what
 * lets a revocation — or an expiry crossed mid-process — take effect without a
 * restart, while the customer request path never touches the network (it reads an
 * in-memory Set).
 *
 * The offline path passes a fresh, never-updated snapshot (live clock, zero
 * network); the online path passes a snapshot a {@link RevocationPoller} feeds.
 */
export function liveGateFromKey(
  licenseKey: string,
  publicKey: string | LicenseKeyset,
  opts: {
    revocation: RevocationSnapshot;
    now?: () => number;
    /** Online staleness ceiling, seconds. If the gate goes this long without a
     *  confirmed authorized heartbeat, it stops granting (closes the block-egress
     *  fail-open). Undefined = check disabled (the offline path never sets it). */
    maxStalenessSeconds?: number;
    /** Freshness anchor (unix seconds); defaults to construction time (boot). */
    startedAt?: number;
  },
): ResolvedGate {
  const nowSeconds = (): number => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const startedAt = opts.startedAt ?? nowSeconds();
  const v = verifyLicenseToken(licenseKey, publicKey);
  const payload: LicenseTokenPayload | undefined = v.signatureValid ? v.payload : undefined;
  const features = new Set<string>(payload?.features ?? []);

  const status = (): LicenseStatus => {
    if (!payload) return "invalid";
    const s = deriveStatus(payload, nowSeconds(), opts.revocation.snapshot());
    // Online staleness gate: without a confirmed authorized heartbeat for longer
    // than maxStalenessSeconds, stop granting — closing the fail-open window where
    // an adversary blocks egress to keep a revoked license alive until it naturally
    // expires. Anchored to boot so the fire-and-forget warm poll has a full window.
    // Devuelve "stale", NO "expired". Reutilizar "expired" ahorraba tocar el union
    // y a cambio le decía a un cliente al día, con la única falta de tener la
    // salida de red cerrada, que renovara una suscripción que ya tenía pagada.
    if (opts.maxStalenessSeconds != null && (s === "active" || s === "grace")) {
      // Esta verja NO es la caducidad de la licencia (eso lo decide `expires_at`
      // en deriveStatus, arriba: mensual = 30 días, anual = 365, intactos). Es
      // una verja de FRESCURA: obliga a contactar con el control plane cada
      // `maxStaleness` para que una revocación no se pueda mantener viva bloqueando
      // la salida de red.
      //
      // El ancla se acota por el FIN DE LA GRACIA (expires_at + grace_days), no
      // por `issued_at + maxStaleness`. La versión anterior acotaba por issued_at
      // y eso apagaba a un cliente que PAGA: en serverless cada invocación es un
      // proceso nuevo con `startedAt = ahora`, y una licencia mensual de más de
      // unas horas caía en `expired` mucho antes de su caducidad real. También
      // recortaba la ventana de gracia (los días para renovar) a `maxStaleness`.
      // Los dos son sustos que no pueden pasar.
      //
      // Con el fin de la gracia como techo, para una licencia todavía válida
      // (activa o en gracia) se cumple `startedAt <= ahora <= graceEnd`, así que
      // el mínimo es `startedAt` y la verja concede — que es lo correcto: mientras
      // la licencia esté dentro de su validez pagada, no se corta.
      //
      // Consecuencia asumida y correcta: en serverless puro, sin estado
      // persistente entre invocaciones, esta verja no puede exigir frescura de
      // revocación —cada proceso arranca "fresco"— así que es prácticamente un
      // no-op ahí, y la revocación en ese entorno se aplica en el control plane
      // (el ingest rechaza una org revocada). En un proceso de vida larga
      // —desktop, gateway de equipo, servidor— sí muerde: si se bloquea la salida
      // desde el arranque, la puerta se cierra `maxStaleness` después.
      const graceEnd = payload.expires_at + payload.grace_days * 86400;
      const anclaArranque = Math.min(startedAt, graceEnd);
      const lastFresh = Math.max(opts.revocation.lastContactAt, anclaArranque);
      if (nowSeconds() - lastFresh > opts.maxStalenessSeconds) return "stale";
    }
    return s;
  };
  const granted = (): boolean => {
    const s = status();
    return s === "active" || s === "grace";
  };

  return {
    isEntitled: (feature: string) => granted() && features.has(feature),
    isActive: () => granted(),
    status,
    refreshAfter: () => {
      if (!payload) return undefined;
      // Anchor cadence to the token's own refresh horizon (mirrors
      // Entitlements.refreshAfter): re-check within a day, tightening near expiry.
      return Math.min(payload.expires_at, nowSeconds() + 86400);
    },
  };
}

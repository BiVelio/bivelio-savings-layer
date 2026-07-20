import type {
  Entitlements,
  Feature,
  LicensePayload,
  LicenseStatus,
} from "@bivelio/protocol";
import { verifyLicenseToken } from "./token.js";

/**
 * LicenseClient — resolves a signed token into live entitlements, entirely
 * offline. It verifies the signature, then applies the grace policy:
 *
 *   now <= expires_at                      → "active"
 *   expires_at < now <= expires_at+grace   → "grace"   (still entitled; warn)
 *   now > expires_at+grace                 → "expired" (drop to free tier)
 *   bad signature / malformed              → "invalid"
 *   jti on the revocation list             → "revoked"
 *
 * The grace window is the key to the product decision: an expired or briefly
 * unreachable license degrades gracefully — it never bricks the customer's
 * production. Features are only granted while status is "active" or "grace".
 */
export interface LicenseClientOptions {
  /** Ed25519 public key (PEM) that the licensing service signs with. */
  publicKey: string;
  /** Revoked license ids (jti). In production this is refreshed online. */
  revoked?: Iterable<string>;
  /** Injectable clock (seconds). */
  nowSeconds?: () => number;
}

export interface ResolvedLicense {
  status: LicenseStatus;
  entitlements: Entitlements;
  payload?: LicensePayload;
  reason?: string;
}

const FREE_ENTITLEMENTS = (orgId = "anonymous"): Entitlements => ({
  orgId,
  plan: "free",
  seats: 0,
  features: [],
  status: "expired",
});

export class LicenseClient {
  private readonly publicKey: string;
  private revoked: Set<string>;
  private readonly nowSeconds: () => number;
  private current: ResolvedLicense | null = null;
  private currentToken: string | null = null;

  constructor(options: LicenseClientOptions) {
    this.publicKey = options.publicKey;
    this.revoked = new Set(options.revoked ?? []);
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Load and resolve a token; stores it as the active license. */
  load(token: string): ResolvedLicense {
    this.currentToken = token;
    this.current = this.resolve(token);
    return this.current;
  }

  /**
   * Add revoked license ids and re-resolve the loaded token. STICKY: the revoked
   * set only ever grows, so a later call that omits a jti cannot un-revoke it —
   * this is how the online call-home flips a running client to "revoked" and keeps
   * it there. No-op on the re-resolve if no token has been loaded yet.
   */
  setRevoked(jtis: Iterable<string>): void {
    for (const jti of jtis) this.revoked.add(jti);
    this.refresh();
  }

  /**
   * Re-resolve the currently-loaded token against the LIVE clock + revoked set.
   * Picks up BOTH a new revocation and clock-based expiry transitions
   * (active→grace→expired) without reloading. Returns null if nothing is loaded.
   */
  refresh(): ResolvedLicense | null {
    if (this.currentToken === null) return null;
    this.current = this.resolve(this.currentToken);
    return this.current;
  }

  /** Resolve a token to a status + entitlements without storing it. */
  resolve(token: string): ResolvedLicense {
    const v = verifyLicenseToken(token, this.publicKey);
    if (!v.signatureValid || !v.payload) {
      return { status: "invalid", entitlements: { ...FREE_ENTITLEMENTS(), status: "invalid" }, ...(v.reason ? { reason: v.reason } : {}) };
    }
    const p = v.payload;
    if (this.revoked.has(p.jti)) {
      return { status: "revoked", entitlements: { ...FREE_ENTITLEMENTS(p.org_id), status: "revoked" }, payload: p, reason: "license revoked" };
    }

    const now = this.nowSeconds();
    const graceEnd = p.expires_at + p.grace_days * 86400;
    let status: LicenseStatus;
    if (now <= p.expires_at) status = "active";
    else if (now <= graceEnd) status = "grace";
    else status = "expired";

    const granted = status === "active" || status === "grace";
    const entitlements: Entitlements = {
      orgId: p.org_id,
      plan: granted ? p.plan : "free",
      seats: granted ? p.seats : 0,
      features: granted ? p.features : [],
      status,
      refreshAfter: Math.min(p.expires_at, now + 86400),
    };
    return { status, entitlements, payload: p };
  }

  /** Entitlements of the currently-loaded license (free tier if none loaded). */
  entitlements(): Entitlements {
    return this.current?.entitlements ?? FREE_ENTITLEMENTS();
  }

  status(): LicenseStatus {
    return this.current?.status ?? "expired";
  }

  /** Whether a feature is currently granted. */
  isEntitled(feature: Feature): boolean {
    const e = this.entitlements();
    return (e.status === "active" || e.status === "grace") && e.features.includes(feature);
  }
}

/**
 * Adapter to the SDK's structural `LicenseGate` ({ isEntitled(feature): boolean }).
 * The SDK never imports this package — it accepts any object of that shape — so
 * there is no coupling in either direction.
 */
export function createLicenseGate(client: LicenseClient): {
  isEntitled(feature: string): boolean;
  isActive(): boolean;
  status(): LicenseStatus;
  entitlements(): Entitlements;
} {
  return {
    isEntitled: (feature: string) => client.isEntitled(feature as Feature),
    // Satisfies the SDK pipeline's fail-closed entry gate: active or in-grace
    // licenses are allowed to run; expired/invalid/revoked are refused.
    isActive: () => client.status() === "active" || client.status() === "grace",
    status: () => client.status(),
    entitlements: () => client.entitlements(),
  };
}

import { randomUUID } from "node:crypto";
import {
  signLicense,
  signRevocationList,
  LicenseClient,
  generateLicenseKeypair,
  type ResolvedLicense,
} from "@bivelio/license-client";
import type { Feature, LicensePayload, Plan } from "@bivelio/protocol";

/**
 * Licensing service (control-plane core).
 *
 * Pure, transport-agnostic logic for issuing, validating and revoking signed
 * licenses. The HTTP wrapper (server.ts) is a thin adapter over this class, so
 * everything here is unit-testable without a socket.
 *
 * The Ed25519 PRIVATE key lives ONLY here (control plane) and never ships. The
 * PUBLIC key is what the SDK embeds to verify offline. Persistence is in-memory
 * for now; swap the revocation set / issued index for Postgres in production.
 */
export interface IssueInput {
  orgId: string;
  plan: Plan;
  seats: number;
  features: Feature[];
  /** License term in days (default 30). */
  termDays?: number;
  /** Grace window past expiry in days (default 14). */
  graceDays?: number;
}

/**
 * Persistence seam for revocations. The in-memory default is fine for the
 * long-running CP-0 server, but a serverless/Postgres deployment MUST inject a
 * durable store — otherwise a revoked license keeps validating after a cold
 * start (the revocation Set is reborn empty). A Postgres impl implements these
 * three methods with a write-through cache; `has()` stays synchronous by reading
 * a hydrated in-process snapshot refreshed on `add()` and at boot.
 */
export interface RevocationStore {
  has(jti: string): boolean;
  add(jti: string): void;
  list(): string[];
  /**
   * Monotonic, non-decreasing revision of the set. It MUST increase whenever a
   * genuinely-new jti is added and MUST NOT decrease on prune or cold start — it
   * is published as the signed list's `seq`, and clients reject any list whose
   * seq is below the highest they have accepted (rollback protection). It is
   * decoupled from list length so pruning old revocations stays safe.
   */
  revision(): number;
}

export class InMemoryRevocationStore implements RevocationStore {
  private readonly set = new Set<string>();
  private rev = 0;
  has(jti: string): boolean {
    return this.set.has(jti);
  }
  add(jti: string): void {
    // Bump the revision ONLY on a genuinely-new jti, so an idempotent re-revoke
    // does not inflate `seq` (which clients gate polls on for monotonicity).
    if (!this.set.has(jti)) {
      this.set.add(jti);
      this.rev++;
    }
  }
  list(): string[] {
    return [...this.set];
  }
  revision(): number {
    return this.rev;
  }
}

export interface LicensingServiceOptions {
  /** Ed25519 private key PEM (signing). Generated if omitted. */
  privateKey?: string;
  /** Ed25519 public key PEM (verification). Generated with the private key if omitted. */
  publicKey?: string;
  nowSeconds?: () => number;
  /** Durable revocation store. Defaults to in-memory (dev only). */
  revocationStore?: RevocationStore;
}

export class LicensingService {
  readonly publicKey: string;
  private readonly privateKey: string;
  private readonly nowSeconds: () => number;
  private readonly revoked: RevocationStore;
  private readonly issued = new Map<string, LicensePayload>();

  constructor(options: LicensingServiceOptions = {}) {
    if (options.privateKey && options.publicKey) {
      this.privateKey = options.privateKey;
      this.publicKey = options.publicKey;
    } else {
      const kp = generateLicenseKeypair();
      this.privateKey = kp.privateKey;
      this.publicKey = kp.publicKey;
    }
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.revoked = options.revocationStore ?? new InMemoryRevocationStore();
  }

  /** Mint and sign a license. */
  issue(input: IssueInput): { token: string; payload: LicensePayload } {
    const now = this.nowSeconds();
    const payload: LicensePayload = {
      jti: randomUUID(),
      org_id: input.orgId,
      plan: input.plan,
      seats: input.seats,
      features: input.features,
      issued_at: now,
      expires_at: now + (input.termDays ?? 30) * 86400,
      grace_days: input.graceDays ?? 14,
      iss: "bivelio-licensing",
    };
    const token = signLicense(payload, this.privateKey);
    this.issued.set(payload.jti, payload);
    return { token, payload };
  }

  /** Validate a token against the current revocation list. */
  validate(token: string): ResolvedLicense {
    const client = new LicenseClient({
      publicKey: this.publicKey,
      revoked: this.revoked.list(),
      nowSeconds: this.nowSeconds,
    });
    return client.resolve(token);
  }

  revoke(jti: string): void {
    this.revoked.add(jti);
  }

  isRevoked(jti: string): boolean {
    return this.revoked.has(jti);
  }

  revocationList(): string[] {
    return this.revoked.list();
  }

  /** Current monotonic revision of the revocation set (published as list `seq`). */
  revocationRevision(): number {
    return this.revoked.revision();
  }

  /**
   * A signed, monotonic snapshot of the revocation set for the SDK call-home. The
   * client verifies this OFFLINE with the same public key it verifies licenses
   * with, then applies its own seq-monotonic + asOf-skew policy.
   *
   * DURABILITY CONTRACT: a production (Postgres) {@link RevocationStore} MUST
   * persist BOTH the set and a monotonic revision across cold starts, and MUST
   * make the HTTP endpoint return 503 (not sign an authentic empty list) until it
   * is hydrated — otherwise a cold start would emit `seq:0, revoked:[]`, which
   * every client with a higher accepted seq correctly rejects as a rollback, so
   * newly-revoked licenses would stop propagating.
   */
  signedRevocationList(): string {
    return signRevocationList(
      {
        v: 1,
        asOf: this.nowSeconds(),
        seq: this.revoked.revision(),
        revoked: this.revoked.list(),
        iss: "bivelio-licensing",
      },
      this.privateKey,
    );
  }

  issuedCount(): number {
    return this.issued.size;
  }
}

export function createLicensingService(options?: LicensingServiceOptions): LicensingService {
  return new LicensingService(options);
}

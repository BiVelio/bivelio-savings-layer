import { randomUUID } from "node:crypto";
import {
  signLicense,
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
}

export class InMemoryRevocationStore implements RevocationStore {
  private readonly set = new Set<string>();
  has(jti: string): boolean {
    return this.set.has(jti);
  }
  add(jti: string): void {
    this.set.add(jti);
  }
  list(): string[] {
    return [...this.set];
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

  issuedCount(): number {
    return this.issued.size;
  }
}

export function createLicensingService(options?: LicensingServiceOptions): LicensingService {
  return new LicensingService(options);
}

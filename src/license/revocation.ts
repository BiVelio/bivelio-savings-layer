import { verifyCompactSignature } from "./verify.js";

/**
 * Browser-safe revocation-list verification + the SDK's sticky, monotonic view of
 * the revoked set. NO `node:` imports, NO network — it reuses the shared
 * {@link verifyCompactSignature} Ed25519 primitive (same one that verifies license
 * tokens), so a signed revocation list is verified OFFLINE against the SAME public
 * key the SDK already embeds.
 */

/** Header `typ` a signed revocation list must carry (domain separation from
 *  license tokens, whose typ is "BVL"). Mirrors @bivelio/protocol's
 *  REVOCATION_HEADER.typ; declared locally so the SDK stays free of a control-plane
 *  dependency — the same convention verify.ts uses for LicenseTokenPayload. */
const REVOCATION_TYP = "BVSALA-REVOC";

/** Reject a list whose `asOf` is more than this many seconds in the future. */
const DEFAULT_MAX_SKEW_SECONDS = 300;

/** Decoded revocation-list body (mirror of @bivelio/protocol's RevocationListPayload). */
export interface RevocationListBody {
  v: number;
  asOf: number;
  seq: number;
  revoked: string[];
  iss?: string;
}

export interface RevocationListVerification {
  /** True only if signature + typ + monotonic-seq + skew all pass. */
  ok: boolean;
  /** List revision (monotonic). -1 when not ok. */
  seq: number;
  /** Unix seconds the list was minted. 0 when not ok. */
  asOf: number;
  /** Revoked jti in this list (empty when not ok). */
  revoked: Set<string>;
  reason?: string;
}

const dec = new TextDecoder();

/**
 * Verify a signed revocation-list token offline and enforce the client-side
 * policy: (1) valid Ed25519 signature, (2) header `typ` is a revocation list
 * (a license token can't be replayed here), (3) `seq >= minSeq` — reject a
 * stale/rolled-back list, (4) `asOf <= now + maxSkew` — reject a future-dated list.
 * ANY failure returns `ok:false` with an empty set; the poller then keeps its
 * sticky last-known-good (fail-open), never dropping known revocations.
 */
export function verifyRevocationList(
  token: string,
  publicKeyPem: string,
  opts: { minSeq?: number; nowSeconds?: number; maxSkewSeconds?: number } = {},
): RevocationListVerification {
  const fail = (reason: string): RevocationListVerification => ({
    ok: false,
    seq: -1,
    asOf: 0,
    revoked: new Set(),
    reason,
  });

  const v = verifyCompactSignature(token, publicKeyPem);
  if (!v.ok || !v.payloadBytes) return fail(v.reason ?? "bad signature");
  if (v.header?.["typ"] !== REVOCATION_TYP) {
    return fail(`unexpected token type "${String(v.header?.["typ"] ?? "")}" (want ${REVOCATION_TYP})`);
  }

  let body: RevocationListBody;
  try {
    body = JSON.parse(dec.decode(v.payloadBytes)) as RevocationListBody;
  } catch {
    return fail("payload is not valid JSON");
  }
  if (typeof body.seq !== "number" || typeof body.asOf !== "number" || !Array.isArray(body.revoked)) {
    return fail("malformed revocation payload");
  }

  const minSeq = opts.minSeq ?? 0;
  if (body.seq < minSeq) return fail(`stale/rolled-back list (seq ${body.seq} < ${minSeq})`);

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxSkew = opts.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (body.asOf > now + maxSkew) {
    return fail(`asOf too far in the future (${body.asOf} > ${now + maxSkew})`);
  }

  return { ok: true, seq: body.seq, asOf: body.asOf, revoked: new Set(body.revoked) };
}

/**
 * The SDK's live, sticky, monotonic view of the revocation set. It only ever
 * GROWS (a jti, once seen revoked, stays revoked for the process lifetime) and
 * only advances on a higher-or-equal `seq` — so a stale, rolled-back, or empty
 * list can never un-revoke a license. The live gate reads {@link snapshot} on
 * every request; the poller feeds it via {@link apply}.
 */
export class RevocationSnapshot {
  private _seq = -1;
  private _asOf = 0;
  private _lastContactAt = 0;
  private readonly set = new Set<string>();

  get seq(): number {
    return this._seq;
  }
  get asOf(): number {
    return this._asOf;
  }
  /** Unix seconds of the last CONFIRMED authorized heartbeat (a 304 or a verified
   *  list). Feeds the live gate's online staleness check; 0 until the first one. */
  get lastContactAt(): number {
    return this._lastContactAt;
  }
  /** Record a confirmed authorized heartbeat from the control plane (monotonic). */
  markContact(nowSeconds: number): void {
    if (nowSeconds > this._lastContactAt) this._lastContactAt = nowSeconds;
  }

  has(jti: string): boolean {
    return this.set.has(jti);
  }

  /** Live view of the revoked set (the same Set instance — read-only to callers). */
  snapshot(): ReadonlySet<string> {
    return this.set;
  }

  /**
   * Merge an already-verified list. Accepts only `seq >= current seq`; UNIONS the
   * jti (never removes); advances seq/asOf monotonically. Returns whether the
   * revoked set grew or the revision advanced.
   */
  apply(list: { seq: number; asOf: number; revoked: Iterable<string> }): boolean {
    if (list.seq < this._seq) return false;
    const before = this.set.size;
    for (const jti of list.revoked) this.set.add(jti);
    const grew = this.set.size > before;
    const advanced = list.seq > this._seq;
    if (list.seq > this._seq) this._seq = list.seq;
    if (list.asOf > this._asOf) this._asOf = list.asOf;
    return grew || advanced;
  }
}

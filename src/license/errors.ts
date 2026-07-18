/**
 * Thrown when the pipeline is asked to run without a valid, active BiVelio
 * license. This is the fail-closed contract: a paid SDK must refuse to operate
 * unlicensed, rather than silently serving requests for free.
 */
export class LicenseError extends Error {
  /** Resolved license status, when known: expired | invalid | revoked | none. */
  readonly status?: string;
  constructor(message: string, status?: string) {
    super(message);
    this.name = "LicenseError";
    if (status) this.status = status;
  }
}

/**
 * Thrown when the pipeline is asked to run without a valid, active BiVelio
 * license. This is the fail-closed contract: a paid SDK must refuse to operate
 * unlicensed, rather than silently serving requests for free.
 */
export class LicenseError extends Error {
  /**
   * Resolved license status — the stable handle for branching on the cause,
   * since the message text is rewritten whenever it can be made clearer:
   *
   * - `none`    — nothing was configured (no `licenseKey`, no gate).
   * - `invalid` — a key was configured but does not verify.
   * - `expired` / `grace` — it verifies, but the term is over.
   * - `revoked` — cancelled by the control plane.
   * - `stale`   — paid and current, but unconfirmed: a connectivity problem.
   *
   * The same value is repeated at the end of the message (`license status: X`)
   * because an uncaught error prints nothing else.
   */
  readonly status?: string;
  constructor(message: string, status?: string) {
    super(message);
    this.name = "LicenseError";
    if (status) this.status = status;
    // Omite el frame del propio constructor de la traza: el lector quiere ver
    // DÓNDE se pidió la licencia (su `generate()`), no la mecánica interna. La
    // traza corta se apoya además en que el bundle ya no colapsa a una línea
    // gigante (ver tsup.config.ts).
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, LicenseError);
    }
  }
}

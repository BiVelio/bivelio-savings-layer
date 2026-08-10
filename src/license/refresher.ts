import { verifyLicenseToken, type LicenseKeyset } from "./verify.js";

/**
 * Recogida automática del token de licencia renovado.
 *
 * La renovación mensual (`invoice.paid`) emite un token NUEVO y el viejo solo se
 * supersede: muere en su `expires_at` + los días de gracia. La entrega era PULL
 * exclusivamente humana — `/api/license/current` con cookie de sesión — así que
 * una máquina en producción con su `licenseKey` estático se apagaba fail-closed
 * hacia el día ~45 de CADA ciclo aunque la suscripción estuviera cobrada y al
 * día, salvo que alguien volviera al panel y re-pegara el token a mano.
 *
 * Este poller cierra ese hueco: autentica con la clave de servicio `bvk_…` (la
 * misma credencial de org que ya autentica el metering) contra
 * `GET /api/license/current`, verifica la firma del token recibido con la clave
 * pública EMBEBIDA y solo entonces lo entrega a `onNewToken`.
 *
 * Mismas reglas de convivencia que el resto de la telemetría del SDK:
 * best-effort y jamás en el camino de la petición del cliente — un control plane
 * caído deja el token vigente tal cual (que para eso tiene la gracia).
 *
 * La adopción es MONOTÓNICA y verificada: solo un token con firma válida, con
 * `expires_at` estrictamente posterior al vigente y de la MISMA org. Una
 * respuesta rancia, un CP comprometido sin la clave privada o una clave bvk_
 * pegada de otra org no pueden degradar ni sustituir la licencia en uso.
 */
export interface LicenseRefresherOptions {
  /** Endpoint de recogida — `${licenseServerUrl}/api/license/current`. */
  url: string;
  /** Clave de servicio `bvk_…` que autentica la recogida. */
  serviceAccountKey: string;
  /** Clave de verificación del token recogido (la embebida del SDK). */
  publicKey: string | LicenseKeyset;
  /** Token con el que arrancó la capa; fija el punto de partida del expiry monotónico. */
  initialToken: string;
  /** Se invoca SOLO con un token verificado, más nuevo y de la misma org. */
  onNewToken: (token: string) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Cadencia de comprobación, ms (default 1 h). */
  pollIntervalMs?: number;
  /** Antelación sobre `expires_at` con la que se empieza a buscar, s (default 7 días). */
  refreshLeadSeconds?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3600_000;
const DEFAULT_REFRESH_LEAD_SECONDS = 7 * 86400;

export class LicenseRefresher {
  private readonly opts: LicenseRefresherOptions;
  private readonly pollIntervalMs: number;
  private readonly refreshLeadSeconds: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private enVuelo = false;
  /** Unix s de la caducidad del token vigente; 0 si el inicial no verifica
   *  (entonces se intenta recoger uno bueno desde ya). */
  private currentExpiresAt: number;
  private currentOrg: string | undefined;

  constructor(opts: LicenseRefresherOptions) {
    this.opts = opts;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.refreshLeadSeconds = opts.refreshLeadSeconds ?? DEFAULT_REFRESH_LEAD_SECONDS;
    const v = verifyLicenseToken(opts.initialToken, opts.publicKey);
    this.currentExpiresAt = v.signatureValid && v.payload ? v.payload.expires_at : 0;
    this.currentOrg = v.signatureValid ? v.payload?.org_id : undefined;
  }

  start(): void {
    if (this.timer) return;
    // Comprobación inmediata (fire-and-forget): un proceso que arranca con un
    // token ya supersedido se cura al momento, sin esperar a la primera vuelta.
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.pollIntervalMs);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private nowSeconds(): number {
    return Math.floor((this.opts.now ? this.opts.now() : Date.now()) / 1000);
  }

  /** Una comprobación completa. `true` si adoptó un token nuevo. Nunca lanza. */
  async checkNow(): Promise<boolean> {
    if (this.enVuelo) return false;
    // Lejos de la caducidad no hay nada que buscar: el token renovado ni existe
    // hasta que Stripe cobra el ciclo siguiente. Se empieza a mirar con
    // `refreshLead` de antelación y se insiste (cada vuelta) durante la gracia.
    if (this.currentExpiresAt - this.nowSeconds() > this.refreshLeadSeconds) return false;
    this.enVuelo = true;
    try {
      const f =
        this.opts.fetchImpl ??
        (globalThis.fetch.bind(globalThis) as typeof fetch);
      const res = await f(this.opts.url, {
        headers: {
          authorization: `Bearer ${this.opts.serviceAccountKey}`,
          accept: "application/json",
        },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== "string") return false;
      const v = verifyLicenseToken(body.token, this.opts.publicKey);
      if (!v.signatureValid || !v.payload) return false;
      if (v.payload.expires_at <= this.currentExpiresAt) return false; // rancio o el mismo
      if (this.currentOrg && v.payload.org_id !== this.currentOrg) return false; // otra org
      this.currentExpiresAt = v.payload.expires_at;
      this.currentOrg = v.payload.org_id;
      this.opts.onNewToken(body.token);
      return true;
    } catch {
      return false; // best-effort: el token vigente sigue mandando
    } finally {
      this.enVuelo = false;
    }
  }
}

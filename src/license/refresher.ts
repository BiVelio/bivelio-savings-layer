import { verifyLicenseToken, normalizeLicenseKey, type LicenseKeyset } from "./verify.js";

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
  /**
   * Jtis revocados conocidos. Se consulta ANTES de adoptar: un token puede venir
   * firmado, ser más nuevo y ser de la misma org y aun así estar revocado, y
   * adoptarlo tumbaría una flota que estaba funcionando. Es el mismo snapshot que
   * alimenta el gate, así que las dos piezas ven la misma verdad.
   */
  revocados?: { snapshot(): ReadonlySet<string> };
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Cadencia de comprobación, ms (default 1 h). */
  pollIntervalMs?: number;
  /** Antelación sobre `expires_at` con la que se empieza a buscar, s (default 7 días). */
  refreshLeadSeconds?: number;
  /** Corte de una recogida colgada, ms (default 30 s). */
  requestTimeoutMs?: number;
}

/**
 * La URL tal como se puede imprimir: sin `usuario:contraseña@`, sin query y sin
 * fragmento, que son los tres sitios donde viaja un token en una URL. Si no se
 * puede parsear, no se imprime nada de ella: mejor un aviso menos preciso que
 * uno que filtra.
 */
export function urlSinSecretos(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return "the configured licenseServerUrl";
  }
}

const DEFAULT_POLL_INTERVAL_MS = 3600_000;
const DEFAULT_REFRESH_LEAD_SECONDS = 7 * 86400;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class LicenseRefresher {
  private readonly opts: LicenseRefresherOptions;
  private readonly pollIntervalMs: number;
  private readonly refreshLeadSeconds: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private enVuelo = false;
  private parado = false;
  private controller: AbortController | null = null;
  /** Estados HTTP de credencial rechazada ya avisados por ESTA instancia. */
  private readonly credencialAvisada = new Set<number>();
  /** Unix s de la caducidad del token vigente; 0 si el inicial no verifica
   *  (entonces se intenta recoger uno bueno desde ya). */
  private currentExpiresAt: number;
  private currentOrg: string | undefined;

  constructor(opts: LicenseRefresherOptions) {
    this.opts = opts;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.refreshLeadSeconds = opts.refreshLeadSeconds ?? DEFAULT_REFRESH_LEAD_SECONDS;
    // La misma normalización que el gate: el token inicial es la `licenseKey`
    // del cliente tal cual la configuró, con el `\n` de un fichero si lo trae.
    // Sin esto, un token bueno con `\n` daba `currentExpiresAt = 0` y el
    // refresher salía a buscar renovación desde el primer segundo.
    const v = verifyLicenseToken(normalizeLicenseKey(opts.initialToken), opts.publicKey);
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
    this.parado = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Aborta la recogida en vuelo: `SavingsLayer.close()` promete liberar
    // cualquier petición pendiente, y sin esto el socket quedaba referenciado y
    // el proceso Node no terminaba.
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * LA CREDENCIAL DE LA RECOGIDA HA SIDO RECHAZADA (401/403/404).
   *
   * Una credencial mala NO se cura sola, a diferencia de un 5xx. Sin este aviso,
   * rotar la clave de servicio y olvidar actualizarla daba 401 en silencio cada
   * hora durante semanas y el único síntoma era el LicenseError del día ~45, que
   * no apunta a la causa.
   *
   * ⛔ NO OBEDECE `silenceWarnings`, Y ES A PROPÓSITO (decisión del dueño). Los
   * avisos que calla el interruptor señalan algo que se degrada sin romper nada;
   * este anuncia que el SDK DEJARÁ DE FUNCIONAR cuando acabe la gracia, y la
   * observabilidad propia del cliente no lo ve: el 401 ocurre dentro del SDK y
   * nunca llega a sus métricas. Por eso esta clase ni recibe el interruptor, y
   * un test en `avisos-silenciables.test.ts` falla si alguien se lo cablea.
   *
   * Sale UNA vez por estado y por instancia, no en cada vuelta: con la cadencia
   * por defecto (1 h) repetirlo sería spam durante semanas. Estados distintos son
   * causas distintas —clave rotada (401), clave de otra org (403), URL
   * equivocada (404)— y cada uno se avisa una vez. Una respuesta 2xx rearma el
   * aviso: arreglar la clave y volver a romperla es otro episodio y vuelve a salir.
   *
   * El texto NUNCA incluye la clave de servicio, ni un trozo: solo el estado y la
   * URL, y la URL pasa antes por {@link urlSinSecretos} — `user:pass@`, query y
   * fragmento fuera. Hay tests que lo comprueban.
   */
  private avisarCredencialRechazada(status: number): void {
    if (this.credencialAvisada.has(status)) return;
    this.credencialAvisada.add(status);
    console.warn(
      `[bv-sala] automatic pickup of the renewed license is failing with HTTP ${status} ` +
        `at ${urlSinSecretos(this.opts.url)}. Check 'serviceAccountKey' (rotated? from another organization?) and ` +
        `'licenseServerUrl': until this works, the token will NOT renew itself and the SDK will ` +
        `stop operating when the grace period ends. (This warning is not muted by 'silenceWarnings'.)`,
    );
  }

  private nowSeconds(): number {
    return Math.floor((this.opts.now ? this.opts.now() : Date.now()) / 1000);
  }

  /** Una comprobación completa. `true` si adoptó un token nuevo. Nunca lanza. */
  async checkNow(): Promise<boolean> {
    if (this.enVuelo || this.parado) return false;
    // Lejos de la caducidad no hay nada que buscar: el token renovado ni existe
    // hasta que Stripe cobra el ciclo siguiente. Se empieza a mirar con
    // `refreshLead` de antelación y se insiste (cada vuelta) durante la gracia.
    if (this.currentExpiresAt - this.nowSeconds() > this.refreshLeadSeconds) return false;
    this.enVuelo = true;
    // TIMEOUT DURO. Sin esto, un CP que acepta la conexión y gotea bytes deja la
    // promesa sin resolver para siempre: `enVuelo` se queda en true, TODAS las
    // vueltas siguientes salen por la primera línea sin mirar la red, y la
    // máquina muere fail-closed el día ~45 — justo el fallo que esta clase
    // existe para cerrar. El RevocationPoller ya se blindaba así.
    const ctrl = new AbortController();
    this.controller = ctrl;
    const to = setTimeout(() => ctrl.abort(), this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    (to as unknown as { unref?: () => void }).unref?.();
    try {
      const f =
        this.opts.fetchImpl ??
        (globalThis.fetch.bind(globalThis) as typeof fetch);
      const res = await f(this.opts.url, {
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.opts.serviceAccountKey}`,
          accept: "application/json",
        },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) this.avisarCredencialRechazada(res.status);
        return false;
      }
      // El CP ha aceptado la credencial: se rearma el aviso. Si la clave se
      // arregla y vuelve a romperse en el mismo proceso, es un episodio nuevo y
      // se avisa otra vez — una sola vez por episodio.
      this.credencialAvisada.clear();
      const body = (await res.json()) as { token?: unknown };
      if (typeof body.token !== "string") return false;
      // Por red también se normaliza: lo que se entrega a `onNewToken` es lo
      // que el gate va a verificar, y tiene que ser la misma cadena que se
      // verificó aquí — no una con envoltorio que el gate tendría que volver a
      // limpiar.
      const token = normalizeLicenseKey(body.token);
      const v = verifyLicenseToken(token, this.opts.publicKey);
      if (!v.signatureValid || !v.payload) return false;
      if (v.payload.expires_at <= this.currentExpiresAt) return false; // rancio o el mismo
      if (this.currentOrg && v.payload.org_id !== this.currentOrg) return false; // otra org
      // REVOCADO. Firma válida, más nuevo y de la misma org NO basta: un token
      // revocado (chargeback, fuga) cumple las tres cosas, y adoptarlo apagaría
      // una flota que estaba funcionando con un token todavía válido. Pasa
      // también sin atacante: revokeLicense() solo registra el fallo si el UPDATE
      // de la fila falla, así que el CP puede seguir sirviendo un token que el
      // ledger ya da por revocado.
      if (this.opts.revocados?.snapshot().has(v.payload.jti)) return false;
      // Si la capa se cerró mientras la petición estaba en vuelo, no se conmuta
      // el gate de una capa ya cerrada.
      if (this.parado) return false;
      this.currentExpiresAt = v.payload.expires_at;
      this.currentOrg = v.payload.org_id;
      this.opts.onNewToken(token);
      return true;
    } catch {
      return false; // best-effort: el token vigente sigue mandando
    } finally {
      clearTimeout(to);
      if (this.controller === ctrl) this.controller = null;
      this.enVuelo = false;
    }
  }
}

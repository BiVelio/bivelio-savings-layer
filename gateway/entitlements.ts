/**
 * S4a · el canal mínimo de entitlements de la pasarela.
 *
 * La pasarela no verifica licencias Ed25519 (no tiene la pública ni debe):
 * pregunta al control plane con su clave de servicio y cachea la respuesta.
 *
 * FAIL-CLOSED A APAGADO, nunca a romper: cualquier fallo — red, 4xx/5xx, JSON
 * raro, timeout — deja el set de features VACÍO, así que la palanca no se
 * enciende; el tráfico jamás se corta por culpa de este canal. La retirada de
 * un feature en el control plane se propaga en ≤ ttlMs (el tercer interruptor
 * de la palanca, además de la bandera local y del propio passthrough).
 */

export interface OpcionesCanal {
  /** URL completa del endpoint de entitlements. */
  url: string;
  /** Clave de servicio bvk_… (Bearer). */
  serviceAccountKey: string;
  /** TTL de la caché; también el techo de propagación de una retirada. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  log?: (linea: string) => void;
}

const TTL_POR_DEFECTO_MS = 300_000;
const TIMEOUT_MS = 10_000;

export class CanalDeEntitlements {
  private readonly url: string;
  private readonly clave: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (l: string) => void;

  private features = new Set<string>();
  private validoHasta = 0;
  private enVuelo: Promise<void> | null = null;
  private avisado = false;

  constructor(opts: OpcionesCanal) {
    this.url = opts.url;
    this.clave = opts.serviceAccountKey;
    this.ttlMs = opts.ttlMs ?? TTL_POR_DEFECTO_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
    // Primer refresco en el arranque, sin bloquear a nadie.
    void this.refrescar();
  }

  /**
   * ¿La org tiene este feature AHORA según lo último que se supo?
   * Nunca bloquea: responde con la caché (vacía al inicio = apagado) y, si el
   * TTL venció, dispara un refresco en segundo plano.
   */
  tiene(feature: string): boolean {
    if (Date.now() > this.validoHasta && this.enVuelo === null) void this.refrescar();
    return this.features.has(feature);
  }

  /** Refresco explícito (los tests esperan a esta promesa). Jamás lanza. */
  refrescar(): Promise<void> {
    if (this.enVuelo) return this.enVuelo;
    this.enVuelo = this.pedir().finally(() => {
      this.enVuelo = null;
    });
    return this.enVuelo;
  }

  private async pedir(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.clave}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.cerrar(`entitlements HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { features?: unknown; refreshAfterSeconds?: unknown };
      if (!Array.isArray(json.features) || !json.features.every((f) => typeof f === "string")) {
        this.cerrar("entitlements response has an unexpected shape");
        return;
      }
      this.features = new Set(json.features);
      const refresco = typeof json.refreshAfterSeconds === "number" && json.refreshAfterSeconds > 0
        ? Math.min(json.refreshAfterSeconds * 1000, this.ttlMs)
        : this.ttlMs;
      this.validoHasta = Date.now() + refresco;
      this.avisado = false;
    } catch (err) {
      this.cerrar(String(err));
    }
  }

  /** Fail-closed: sin respuesta fiable no hay features — y se reintenta pronto. */
  private cerrar(motivo: string): void {
    this.features = new Set();
    // Reintento más frecuente que el TTL normal: estar apagados de más también cuesta.
    this.validoHasta = Date.now() + Math.min(60_000, this.ttlMs);
    if (!this.avisado) {
      this.avisado = true;
      this.log(`[gateway] entitlements unavailable (${motivo}) — savings features disabled (fail-closed); traffic keeps flowing`);
    }
  }
}

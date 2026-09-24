/**
 * S4a · el canal mínimo de entitlements de la pasarela.
 *
 * La pasarela verifica la LICENCIA por su cuenta (gateway/license.ts). Este canal
 * responde a otras dos preguntas, con la clave de servicio y una caché:
 *
 *   · qué FEATURES concede la org — FAIL-CLOSED A APAGADO: cualquier fallo (red,
 *     4xx/5xx, JSON raro, timeout) deja el set VACÍO y la palanca no se enciende.
 *     La retirada de un feature se propaga en ≤ ttlMs.
 *   · si el control plane da a la org por BLOQUEADA (`reason` en un 200). Es
 *     PEGAJOSO: solo lo pone o lo quita otro 200. Un fallo de red no es una
 *     revocación, así que no lo toca — ni para bien ni para mal.
 *
 * Ni `tiene()` ni `blockReason()` bloquean jamás: responden con lo último que se
 * supo y, si el TTL venció, disparan un refresco en segundo plano. Los dos llevan
 * el MISMO disparador, así que cualquier ruta del gateway refresca el canal (no
 * solo /v1/messages, que es la única que pregunta por features).
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

/** La clave dejó de valer con el proceso vivo (borrada o rotada). No corta nada. */
const LINEA_401 =
  "[gateway] entitlements: BIVELIO_SERVICE_KEY is no longer recognised (HTTP 401): savings features disabled " +
  "and usage is not being reported; create a new key at https://savings.bivelio.com/dashboard/install and relaunch";

export class CanalDeEntitlements {
  private readonly url: string;
  private readonly clave: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (l: string) => void;

  private features = new Set<string>();
  private razonDeBloqueo: string | null = null;
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
    this.refrescarSiVencio();
    return this.features.has(feature);
  }

  /**
   * El último `reason` DEFINITIVO del control plane (un 200 con `reason`), o
   * null. Pegajoso: solo lo cambia otro 200. Dispara el mismo refresco por TTL
   * que `tiene()`.
   */
  blockReason(): string | null {
    this.refrescarSiVencio();
    return this.razonDeBloqueo;
  }

  /** Refresco explícito (los tests esperan a esta promesa). Jamás lanza. */
  refrescar(): Promise<void> {
    if (this.enVuelo) return this.enVuelo;
    this.enVuelo = this.pedir().finally(() => {
      this.enVuelo = null;
    });
    return this.enVuelo;
  }

  private refrescarSiVencio(): void {
    if (Date.now() > this.validoHasta && this.enVuelo === null) void this.refrescar();
  }

  private async pedir(): Promise<void> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.clave}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 401) {
        // Una clave borrada o rotada NO se cura sola, y el emisor tampoco puede
        // reportar con ella: se dice una vez, con el arreglo. La licencia ya
        // verificada sigue sirviendo; solo caen las features (fail-closed).
        this.cerrar("entitlements HTTP 401", LINEA_401);
        return;
      }
      if (!res.ok) {
        this.cerrar(`entitlements HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as { features?: unknown; refreshAfterSeconds?: unknown; reason?: unknown };
      if (!Array.isArray(json.features) || !json.features.every((f) => typeof f === "string")) {
        this.cerrar("entitlements response has an unexpected shape");
        return;
      }
      this.features = new Set(json.features);
      // Contrato del control plane: `reason` presente ⇔ org bloqueada.
      this.razonDeBloqueo = typeof json.reason === "string" && json.reason.trim() !== "" ? json.reason.trim() : null;
      const refresco = typeof json.refreshAfterSeconds === "number" && json.refreshAfterSeconds > 0
        ? Math.min(json.refreshAfterSeconds * 1000, this.ttlMs)
        : this.ttlMs;
      this.validoHasta = Date.now() + refresco;
      this.avisado = false;
    } catch (err) {
      this.cerrar(String(err));
    }
  }

  /**
   * Fail-closed: sin respuesta fiable no hay features — y se reintenta pronto.
   * NO toca `razonDeBloqueo`: un fallo de red no es una revocación.
   */
  private cerrar(motivo: string, linea?: string): void {
    this.features = new Set();
    // Reintento más frecuente que el TTL normal: estar apagados de más también cuesta.
    this.validoHasta = Date.now() + Math.min(60_000, this.ttlMs);
    if (!this.avisado) {
      this.avisado = true;
      this.log(
        linea ??
          `[gateway] entitlements unavailable (${motivo}) — savings features disabled (fail-closed); traffic keeps flowing`,
      );
    }
  }
}

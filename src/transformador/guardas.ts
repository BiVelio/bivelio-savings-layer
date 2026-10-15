/**
 * LAS GUARDAS DEL MOTOR OPCIONAL (D05): el cortacircuitos y la cola justa.
 *
 * Las dos existen por lo mismo: un motor de ahorro lento o caído no puede
 * convertirse en un motor de LATENCIA. Si el sidecar no contesta, la petición
 * sigue con su original autorizado; si contesta mal cinco veces seguidas, deja
 * de preguntársele durante 30 s; si hay más trabajo del que cabe, el que no cabe
 * pasa sin optimizar en vez de esperar.
 *
 * Valores por defecto = decisión provisional del piloto (revisable por el
 * dueño): 4 en vuelo, 16 en cola, abrir tras 5 fallos de infraestructura
 * seguidos, una única sonda tras 30 s. `no_candidate` y el resto de decisiones
 * locales NO son fallos: ni consultan ni alimentan el cortacircuitos.
 *
 * Ambos usan un reloj monótono inyectable (`performance.now` por defecto): un
 * salto del reloj de pared no deja el circuito abierto ni lo cierra antes.
 */

export type EstadoCortacircuitos = "closed" | "open" | "half_open";

export interface OpcionesCortacircuitos {
  /** Fallos de infraestructura consecutivos que lo abren. Por defecto 5. */
  fallosSeguidos?: number;
  /** Cuánto se queda abierto antes de admitir una sonda. Por defecto 30 000 ms. */
  abiertoMs?: number;
  /** Reloj monótono en ms. */
  ahora?: () => number;
}

export type Admision = { ok: true; sonda: boolean } | { ok: false };

const relojMonotono = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

export class Cortacircuitos {
  private readonly umbral: number;
  private readonly abiertoMs: number;
  private readonly ahora: () => number;
  private seguidos = 0;
  private abiertoDesde: number | null = null;
  private sondaEnVuelo = false;

  constructor(o: OpcionesCortacircuitos = {}) {
    this.umbral = o.fallosSeguidos ?? 5;
    this.abiertoMs = o.abiertoMs ?? 30_000;
    this.ahora = o.ahora ?? relojMonotono;
  }

  get estado(): EstadoCortacircuitos {
    if (this.abiertoDesde === null) return "closed";
    return this.ahora() - this.abiertoDesde >= this.abiertoMs ? "half_open" : "open";
  }

  /** Antes de la primera E/S. `sonda: true` sólo para la única llamada que prueba en half-open. */
  admitir(): Admision {
    const e = this.estado;
    if (e === "closed") return { ok: true, sonda: false };
    if (e === "open" || this.sondaEnVuelo) return { ok: false };
    this.sondaEnVuelo = true;
    return { ok: true, sonda: true };
  }

  /** Exactamente un resultado por llamada admitida que hizo E/S. */
  registrar(resultado: "exito" | "fallo", sonda: boolean): void {
    if (sonda) this.sondaEnVuelo = false;
    if (resultado === "exito") {
      // Una sonda buena cierra; en cerrado, un éxito corta la racha.
      if (sonda || this.abiertoDesde === null) {
        this.abiertoDesde = null;
        this.seguidos = 0;
      }
      return;
    }
    if (sonda) {
      this.abiertoDesde = this.ahora();
      return;
    }
    if (this.abiertoDesde !== null) return; // llegó tarde, con el circuito ya abierto
    this.seguidos += 1;
    if (this.seguidos >= this.umbral) {
      this.abiertoDesde = this.ahora();
      this.seguidos = 0;
    }
  }

  /** Una llamada admitida que terminó sin resultado propio (cancelada): libera la sonda. */
  liberar(sonda: boolean): void {
    if (sonda) this.sondaEnVuelo = false;
  }
}

// ---------------------------------------------------------------------------

export interface OpcionesColaJusta {
  /** Trabajos en vuelo a la vez. Por defecto 4. */
  concurrencia?: number;
  /** Trabajos esperando, entre todos los tenants. Por defecto 16. */
  cola?: number;
  /**
   * Cuántos puestos de la cola puede ocupar UN tenant. Por defecto la mitad
   * (8): un tenant ruidoso nunca deja a los demás sin sitio para esperar.
   */
  colaPorTenant?: number;
}

export type Turno = { ok: true; liberar: () => void } | { ok: false; motivo: "capacity" | "cancelled" };

interface Espera {
  resolver: (t: Turno) => void;
  alAbortar: () => void;
  signal: AbortSignal | undefined;
}

/**
 * Concurrencia acotada con cola acotada y reparto por turnos entre tenants: al
 * quedar un hueco entra el siguiente TENANT en la rueda, no el siguiente
 * trabajo. Lo que no cabe en la cola se rechaza al momento (`capacity`); lo que
 * espera y se cancela sale de la cola sin consumir hueco.
 */
export class ColaJusta {
  private readonly concurrencia: number;
  private readonly maxCola: number;
  private readonly maxPorTenant: number;
  private enVuelo = 0;
  private enCola = 0;
  private readonly colas = new Map<string, Espera[]>();
  /** Orden de la rueda: tenants con algo en cola, en el orden en que les toca. */
  private rueda: string[] = [];

  constructor(o: OpcionesColaJusta = {}) {
    this.concurrencia = Math.max(1, o.concurrencia ?? 4);
    this.maxCola = Math.max(0, o.cola ?? 16);
    this.maxPorTenant = Math.max(1, o.colaPorTenant ?? Math.ceil(this.maxCola / 2));
  }

  get estadisticas(): { enVuelo: number; enCola: number } {
    return { enVuelo: this.enVuelo, enCola: this.enCola };
  }

  turno(tenant: string, signal?: AbortSignal): Promise<Turno> {
    if (signal?.aborted) return Promise.resolve({ ok: false, motivo: "cancelled" });
    if (this.enVuelo < this.concurrencia && this.enCola === 0) {
      this.enVuelo += 1;
      return Promise.resolve({ ok: true, liberar: this.liberador() });
    }
    const propia = this.colas.get(tenant) ?? [];
    if (this.enCola >= this.maxCola || propia.length >= this.maxPorTenant) {
      return Promise.resolve({ ok: false, motivo: "capacity" });
    }
    return new Promise<Turno>((resolve) => {
      const espera: Espera = {
        resolver: resolve,
        signal,
        alAbortar: () => {
          const q = this.colas.get(tenant);
          const i = q ? q.indexOf(espera) : -1;
          if (q && i >= 0) {
            q.splice(i, 1);
            this.enCola -= 1;
            if (q.length === 0) {
              this.colas.delete(tenant);
              this.rueda = this.rueda.filter((t) => t !== tenant);
            }
          }
          resolve({ ok: false, motivo: "cancelled" });
        },
      };
      signal?.addEventListener("abort", espera.alAbortar, { once: true });
      if (propia.length === 0) {
        this.colas.set(tenant, propia);
        this.rueda.push(tenant);
      }
      propia.push(espera);
      this.enCola += 1;
    });
  }

  private liberador(): () => void {
    let hecho = false;
    return () => {
      if (hecho) return;
      hecho = true;
      this.enVuelo -= 1;
      this.despachar();
    };
  }

  private despachar(): void {
    while (this.enVuelo < this.concurrencia && this.rueda.length > 0) {
      const tenant = this.rueda.shift()!;
      const q = this.colas.get(tenant)!;
      const espera = q.shift()!;
      this.enCola -= 1;
      if (q.length > 0) this.rueda.push(tenant); // al final de la rueda: le toca a otro
      else this.colas.delete(tenant);
      espera.signal?.removeEventListener("abort", espera.alAbortar);
      this.enVuelo += 1;
      espera.resolver({ ok: true, liberar: this.liberador() });
    }
  }
}

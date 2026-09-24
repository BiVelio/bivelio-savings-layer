import type {
  SavingsResult,
  SavingsStream,
  SavingsStreamEvent,
  StreamingReport,
} from "../contracts/types.js";

// EL CANAL DE UN `generateStream`: el handle que recibe el llamante, la cola de
// eventos que lo alimenta y el sumidero por el que el pipeline le pasa el texto
// en vivo. INTERNO: no se reexporta, y por eso los comentarios van en `//`.
//
// Tres reglas que no se negocian, porque de ellas depende que el informe diga
// la verdad sobre lo que el llamante recibió:
//
//  1. `result` NUNCA se muta. Puede ser el `value` compartido de un singleflight
//     (una petición entera que lideró y a la que siguen otras); pegarle
//     `report.streaming` se lo pegaría a todas. Se construye uno nuevo.
//  2. `done` es el último evento y llega exactamente una vez, con `result` ya
//     resuelto: quien lo recibe puede leer `stream.result` sin esperar.
//  3. Abortar solo cancela mientras el proveedor ESTÁ escribiendo. Una vez que
//     su respuesta terminó (o si se produjo entera), el abort no deshace nada:
//     la llamada está facturada, y la petición se informa y se cachea igual.

export type MotivoEntero = NonNullable<StreamingReport["wholeReason"]>;

export interface SumideroDeStream {
  // La señal del AbortController interno: la del proveedor que streamea.
  readonly senal: AbortSignal;
  // Reenvía un delta al llamante. Ignora "" y todo lo que llegue tras abortar.
  texto(delta: string): void;
  // El proveedor entregó su evento final: a partir de aquí abortar no cancela.
  proveedorTermino(): void;
  // true si la llamada primaria se sirvió por `generateStream` (entrega «live»).
  sirvioEnVivo: boolean;
}

type Paso<T> = IteratorResult<SavingsStreamEvent<T>, undefined>;

interface Espera<T> {
  resolve: (paso: Paso<T>) => void;
  reject: (err: unknown) => void;
}

const FIN = { done: true, value: undefined } as const;

export class CanalDeStream<T> {
  readonly handle: SavingsStream<T>;
  readonly sumidero: SumideroDeStream;

  private readonly now: () => number;
  private readonly inicio: number;
  private readonly controlador = new AbortController();
  private readonly resolver: (r: SavingsResult<T>) => void;
  private readonly rechazar: (err: unknown) => void;

  // La cola: sin tope, un solo consumidor.
  private readonly cola: SavingsStreamEvent<T>[] = [];
  private readonly esperas: Espera<T>[] = [];
  private cerrada = false;
  private errorPendiente: { valor: unknown } | null = null;
  private consumidorSalio = false;
  private iterado = false;

  private _abortado = false;
  private vivo = false;
  private proveedorTerminado = false;
  private terminado = false;
  private primerEventoAt: number | undefined;
  private quitarEscucha: (() => void) | undefined;

  constructor(now: () => number, senalExterna?: AbortSignal) {
    this.now = now;
    this.inicio = now();

    let resolver!: (r: SavingsResult<T>) => void;
    let rechazar!: (err: unknown) => void;
    const promesa = new Promise<SavingsResult<T>>((res, rej) => {
      resolver = res;
      rechazar = rej;
    });
    // Enganchado POR DENTRO para que un stream que falla sin que nadie espere
    // `result` no deje un rechazo sin manejar en el proceso. Quien sí haga
    // `await stream.result` sigue viendo el rechazo: el catch es de una
    // promesa derivada, no de ésta.
    promesa.catch(() => {});
    this.resolver = resolver;
    this.rechazar = rechazar;

    const canal = this;
    this.sumidero = {
      senal: this.controlador.signal,
      texto(delta: string): void {
        canal.recibirTexto(delta);
      },
      proveedorTermino(): void {
        canal.proveedorTerminado = true;
      },
      sirvioEnVivo: false,
    };

    this.handle = {
      result: promesa,
      abort: (reason?: unknown) => this.abort(reason),
      [Symbol.asyncIterator]: () => this.iterador(),
    };

    if (senalExterna) {
      if (senalExterna.aborted) {
        this.abort(senalExterna.reason);
      } else {
        const alAbortar = (): void => this.abort(senalExterna.reason);
        senalExterna.addEventListener("abort", alAbortar, { once: true });
        // Se quita al terminar: una señal de larga vida (la de un servidor
        // entero) no debe retener cada canal que pasó por ella.
        this.quitarEscucha = () => senalExterna.removeEventListener("abort", alAbortar);
      }
    }
  }

  get abortado(): boolean {
    return this._abortado;
  }

  // A partir de aquí la primaria va en vivo: un abort cancela al proveedor.
  entrarEnVivo(): void {
    this.vivo = true;
  }

  completar(result: SavingsResult<T>, entrega: { vivo: boolean; motivo?: MotivoEntero }): void {
    if (this.terminado) return;
    const numLlamadas = result.toolCalls?.length ?? 0;
    const primer =
      this.primerEventoAt ?? (entrega.vivo && numLlamadas > 0 ? this.now() : undefined);
    const streaming: StreamingReport = entrega.vivo
      ? { delivery: "live", ...(primer !== undefined ? { firstEventMs: primer - this.inicio } : {}) }
      : { delivery: "whole", ...(entrega.motivo ? { wholeReason: entrega.motivo } : {}) };
    const final: SavingsResult<T> = { ...result, report: { ...result.report, streaming } };

    this.resolver(final);

    if (!this._abortado) {
      if (!entrega.vivo && final.text !== "") this.encolar({ type: "text", delta: final.text });
      for (const call of final.toolCalls ?? []) this.encolar({ type: "tool_call", call });
      this.encolar({ type: "done", result: final });
    }
    this.cerrar();
    this.acabar();
  }

  fallar(err: unknown): void {
    if (this.terminado) return;
    this.rechazar(err);
    if (this._abortado) this.cerrar();
    else this.fallarCola(err);
    this.acabar();
  }

  private acabar(): void {
    this.terminado = true;
    this.quitarEscucha?.();
    this.quitarEscucha = undefined;
  }

  private abort(reason?: unknown): void {
    // Tras `done` (o tras el error que cerró el stream) no queda nada que parar.
    if (this.terminado || this._abortado) return;
    this._abortado = true;
    // «Iteration ends at once»: lo que quedaba en la cola ya no se entrega.
    this.cola.length = 0;
    this.cerrar();
    if (this.vivo && !this.proveedorTerminado) this.controlador.abort(reason);
  }

  private recibirTexto(delta: string): void {
    if (delta === "" || this._abortado || this.terminado) return;
    if (this.primerEventoAt === undefined) this.primerEventoAt = this.now();
    this.encolar({ type: "text", delta });
  }

  // --- La cola --------------------------------------------------------------

  private encolar(ev: SavingsStreamEvent<T>): void {
    if (this.cerrada) return;
    const espera = this.esperas.shift();
    if (espera) espera.resolve({ done: false, value: ev });
    else this.cola.push(ev);
  }

  private cerrar(): void {
    this.cerrada = true;
    // Solo quedan esperas si la cola estaba vacía: todas acaban sin error.
    for (const espera of this.esperas.splice(0)) espera.resolve(FIN);
  }

  private fallarCola(err: unknown): void {
    this.cerrada = true;
    const [primera, ...resto] = this.esperas.splice(0);
    if (primera) {
      // El error se entrega UNA vez; después, fin.
      primera.reject(err);
      for (const espera of resto) espera.resolve(FIN);
    } else {
      this.errorPendiente = { valor: err };
    }
  }

  private siguiente(): Promise<Paso<T>> {
    if (this.consumidorSalio) return Promise.resolve(FIN);
    const ev = this.cola.shift();
    if (ev) return Promise.resolve({ done: false, value: ev });
    if (this.errorPendiente) {
      const { valor } = this.errorPendiente;
      this.errorPendiente = null;
      return Promise.reject(valor);
    }
    if (this.cerrada) return Promise.resolve(FIN);
    return new Promise<Paso<T>>((resolve, reject) => {
      this.esperas.push({ resolve, reject });
    });
  }

  private iterador(): AsyncIterator<SavingsStreamEvent<T>, undefined> {
    if (this.iterado) throw new Error("[bvsala] a SavingsStream can be iterated only once");
    this.iterado = true;
    return {
      next: () => this.siguiente(),
      // `break` en un for-await llega aquí: es un abort.
      return: () => {
        this.abort();
        this.consumidorSalio = true;
        this.cola.length = 0;
        return Promise.resolve(FIN);
      },
    };
  }
}

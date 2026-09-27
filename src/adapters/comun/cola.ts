// Una cola asíncrona de un solo lector: el observador del framework EMPUJA lo que
// va viendo (deltas de texto, el `done` final) y el núcleo lo CONSUME como el
// `generateStream` de un proveedor.
//
// Hace falta porque los dos ritmos son independientes: quien tira del stream es
// el lector del framework (el `textStream` del cliente, el SDK leyendo el SSE),
// no el núcleo. El núcleo solo espera a que haya algo en la cola.
//
// Sin límite de tamaño a propósito: lo que entra aquí es el texto de UNA
// respuesta, que el núcleo ya acumula igualmente para el informe.

type Esperando<T> = {
  resolver: (r: IteratorResult<T>) => void;
  rechazar: (e: unknown) => void;
};

export class Cola<T> implements AsyncIterable<T> {
  private readonly pendientes: T[] = [];
  private esperando: Esperando<T> | undefined;
  private terminada = false;
  private fallo: { error: unknown } | undefined;

  /** Añade un elemento. Después de `end()` o `fail()` se ignora. */
  push(valor: T): void {
    if (this.terminada || this.fallo) return;
    const e = this.esperando;
    if (e) {
      this.esperando = undefined;
      e.resolver({ value: valor, done: false });
      return;
    }
    this.pendientes.push(valor);
  }

  /** Cierra la cola: el lector recibe lo pendiente y después `done`. */
  end(): void {
    if (this.terminada || this.fallo) return;
    this.terminada = true;
    const e = this.esperando;
    if (e && this.pendientes.length === 0) {
      this.esperando = undefined;
      e.resolver({ value: undefined, done: true });
    }
  }

  /** Falla la cola: el lector recibe el error en cuanto agote lo pendiente. */
  fail(error: unknown): void {
    if (this.terminada || this.fallo) return;
    this.fallo = { error };
    const e = this.esperando;
    if (e && this.pendientes.length === 0) {
      this.esperando = undefined;
      e.rechazar(error);
    }
  }

  /** ¿Se cerró o falló ya? */
  get cerrada(): boolean {
    return this.terminada || this.fallo !== undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.pendientes.length > 0) {
          return Promise.resolve({ value: this.pendientes.shift() as T, done: false });
        }
        if (this.fallo) return Promise.reject(this.fallo.error);
        if (this.terminada) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolver, rechazar) => {
          this.esperando = { resolver, rechazar };
        });
      },
      // El núcleo sale del bucle con `break` en cuanto ve el `done`: eso llama a
      // `return()`. La cola se da por terminada y lo que llegue después se ignora.
      return: (): Promise<IteratorResult<T>> => {
        this.terminada = true;
        this.pendientes.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

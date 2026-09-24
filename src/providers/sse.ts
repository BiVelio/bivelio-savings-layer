// Parser de Server-Sent Events (WHATWG EventSource), INTERNO.
//
// No se reexporta desde providers/index.ts: lo usan los adaptadores del SDK para
// leer sus streams y el gateway para observar los que pasan por él. Va al bundle
// web igual que el resto de src/, así que aquí no puede haber módulos de Node
// ni sus globales: solo `TextDecoder`, que existe en Node y en el navegador
// (test/revocation.test.ts vigila la regla).
//
// Comentarios en `//` y no JSDoc a propósito: si algún día un tipo público
// arrastrara esto al `.d.ts`, el razonamiento interno no debe viajar con él.

export interface SseMessage {
  // "message" cuando el bloque no traía `event:`.
  event: string;
  data: string;
  id?: string;
}

// El tipo de instancia de `TextDecoder` no es global con las libs de este
// proyecto (solo el valor); basta con la forma que se usa.
type Decodificador = { decode(input?: Uint8Array, options?: { stream?: boolean }): string };

export class SseParser {
  // Se crea al primer chunk binario. `{ stream: true }` guarda los bytes de un
  // carácter multibyte partido entre dos chunks hasta que llega el resto.
  private decoder: Decodificador | undefined;
  // Trozo de línea que aún no ha visto su terminador.
  private resto = "";
  // Un `\r` al final de un chunk puede ser la primera mitad de un `\r\n` que
  // termina en el siguiente: si el siguiente empieza por `\n`, es UNA ruptura.
  private crPendiente = false;
  // Aún no se ha visto ningún carácter: el BOM inicial se descarta.
  private alPrincipio = true;
  private datos = "";
  private evento = "";
  private ultimoId: string | undefined;

  push(chunk: string | Uint8Array): SseMessage[] {
    const texto =
      typeof chunk === "string"
        ? chunk
        : (this.decoder ??= new TextDecoder("utf-8")).decode(chunk, { stream: true });
    return this.procesar(texto);
  }

  end(): SseMessage[] {
    const salida: SseMessage[] = [];
    if (this.decoder) {
      const cola = this.decoder.decode();
      if (cola !== "") salida.push(...this.procesar(cola));
    }
    // Una última línea sin terminador sigue siendo una línea.
    if (this.resto !== "") {
      this.linea(this.resto, salida);
      this.resto = "";
    }
    // Y el mensaje pendiente se despacha aunque falte la línea en blanco final:
    // un servidor que cierra justo después del último `data:` no pierde ese
    // mensaje (el `[DONE]` de muchos endpoints llega exactamente así).
    this.despachar(salida);
    this.crPendiente = false;
    return salida;
  }

  private procesar(entrada: string): SseMessage[] {
    const salida: SseMessage[] = [];
    if (entrada === "") return salida;
    let texto = entrada;
    if (this.alPrincipio) {
      this.alPrincipio = false;
      if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
      if (texto === "") return salida;
    }
    let i = 0;
    if (this.crPendiente) {
      this.crPendiente = false;
      if (texto.charCodeAt(0) === 10) i = 1;
    }
    let inicio = i;
    while (i < texto.length) {
      const c = texto.charCodeAt(i);
      if (c !== 10 && c !== 13) {
        i++;
        continue;
      }
      this.linea(this.resto + texto.slice(inicio, i), salida);
      this.resto = "";
      if (c === 13) {
        if (i + 1 < texto.length) {
          if (texto.charCodeAt(i + 1) === 10) i++;
        } else {
          this.crPendiente = true;
        }
      }
      i++;
      inicio = i;
    }
    this.resto += texto.slice(inicio);
    return salida;
  }

  private linea(l: string, salida: SseMessage[]): void {
    if (l === "") {
      this.despachar(salida);
      return;
    }
    if (l.charCodeAt(0) === 58 /* ":" */) return; // comentario
    const dosPuntos = l.indexOf(":");
    let campo: string;
    let valor: string;
    if (dosPuntos === -1) {
      campo = l;
      valor = "";
    } else {
      campo = l.slice(0, dosPuntos);
      valor = l.slice(dosPuntos + 1);
      if (valor.charCodeAt(0) === 32) valor = valor.slice(1);
    }
    switch (campo) {
      case "data":
        this.datos += valor + "\n";
        break;
      case "event":
        this.evento = valor;
        break;
      case "id":
        if (!valor.includes("\0")) this.ultimoId = valor;
        break;
      default:
        // `retry` y los campos desconocidos se ignoran.
        break;
    }
  }

  private despachar(salida: SseMessage[]): void {
    if (this.datos === "") {
      this.evento = "";
      return;
    }
    salida.push({
      event: this.evento === "" ? "message" : this.evento,
      data: this.datos.slice(0, -1),
      ...(this.ultimoId !== undefined ? { id: this.ultimoId } : {}),
    });
    this.datos = "";
    this.evento = "";
  }
}

// Los mensajes de un cuerpo SSE entero (string) o de un `ReadableStream`.
//
// Con un stream se usa `getReader()` y no `for await`: `ReadableStream` no es
// iterable asíncrono en todos los entornos en los que corre el bundle. En el
// `finally` se cancela el reader, para liberar la conexión cuando el consumidor
// sale antes de tiempo (un `break`, un abort); sobre un stream ya cerrado o
// errado la cancelación no hace nada, y su posible rechazo se traga.
export async function* sseMessages(
  source: ReadableStream<Uint8Array> | string,
): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  if (typeof source === "string") {
    yield* parser.push(source);
    yield* parser.end();
    return;
  }
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) yield* parser.push(value);
    }
    yield* parser.end();
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ya cerrado o errado: no hay nada que liberar */
    }
  }
}

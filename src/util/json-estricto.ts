// EL RECORRIDO ESTRICTO DE UN JSON — un solo analizador para el SDK y el gateway.
//
// Dos sitios necesitan saber de un JSON algo que `JSON.parse` no cuenta:
//
//  · el gateway (`gateway/reserializacion.ts`), antes de reescribir un cuerpo
//    con `JSON.stringify`, tiene que saber si hay claves duplicadas, claves con
//    forma de índice o números no canónicos;
//  · la compactación sin pérdida de la cola (`compression/cola.ts`, perfil
//    `lossless-data`), antes de quitar el espacio de un tool_result, tiene que
//    saber que el texto ENTERO es JSON estricto (RFC 8259), sin claves
//    repetidas a ninguna profundidad, y cuáles son sus lexemas exactos.
//
// `JSON.parse` no sirve para ninguna de las dos: se queda con el último valor
// de una clave repetida sin avisar, y lo que devuelve ya no tiene los lexemas
// (`1.10` sale `1.1`, `2^63+1` pierde precisión, `-0` sale `0`). Así que aquí se
// recorre el TEXTO, una pasada lineal sin recursión (un JSON de 100 000 niveles
// no revienta la pila), y se avisa a un visitante de cada lexema, clave y
// número. Quien llama decide qué rechazar; lo que es gramática lo rechaza esto.
//
// Lo que se rechaza siempre, con su código:
//  · `invalid_json`: cualquier cosa fuera de la gramática estricta — comas
//    finales, comillas simples, comentarios, `NaN`, ceros a la izquierda,
//    caracteres de control sin escapar dentro de una cadena, escapes
//    desconocidos, espacio que no sea uno de los cuatro de JSON (ni BOM ni
//    NBSP), texto después del valor.
//  · `duplicate_keys`: dos claves iguales en el MISMO objeto, comparadas ya
//    decodificadas (`"a"` y `"a"` son la misma). En objetos distintos, o
//    dentro de una cadena, no cuentan.
//  · `invalid_unicode`: un sustituto UTF-16 suelto escrito EN CRUDO. Al cable
//    sale como U+FFFD, así que lo que el modelo ve ya no es lo que dijo la
//    herramienta. (Un `\ud800` ESCAPADO es gramática válida y sale byte a byte:
//    no se rechaza; en el gateway, que decodifica UTF-8 estricto, el crudo no
//    puede ni aparecer.)

/** Por qué un texto no pasó el recorrido estricto. `stopped`: lo paró el visitante. */
export type FalloJsonEstricto = "invalid_json" | "duplicate_keys" | "invalid_unicode" | "stopped";

export type ResultadoJsonEstricto = { ok: true } | { ok: false; fallo: FalloJsonEstricto; posicion: number };

/**
 * Lo que el recorrido cuenta. Cada método es opcional; devolver `false` para el
 * recorrido en seco (`fallo: "stopped"`).
 */
export interface VisitanteJson {
  /** Cada lexema, en orden: `texto.slice(inicio, fin)` es su texto exacto. */
  lexema?(inicio: number, fin: number): boolean | void;
  /** Cada clave de objeto, ya decodificada. */
  clave?(clave: string): boolean | void;
  /** Cada literal numérico, tal como está escrito. */
  numero?(literal: string): boolean | void;
}

const esBlanco = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
const esDigito = (c: number): boolean => c >= 0x30 && c <= 0x39;
const esHex = (c: number): boolean =>
  esDigito(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

// Lo que puede seguir a `\` dentro de una cadena: " \ / b f n r t u
const ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74, 0x75]);

const RE_NUMERO = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Fin (exclusivo) de la cadena que empieza en `i`, o el fallo. `escapes`: si llevaba alguno. */
function finDeCadena(texto: string, i: number): { fin: number; escapes: boolean } | { fallo: FalloJsonEstricto; posicion: number } {
  const n = texto.length;
  let escapes = false;
  let j = i + 1;
  while (j < n) {
    const c = texto.charCodeAt(j);
    if (c === 0x22) return { fin: j + 1, escapes };
    if (c === 0x5c) {
      const e = texto.charCodeAt(j + 1);
      if (!ESCAPES.has(e)) return { fallo: "invalid_json", posicion: j };
      escapes = true;
      if (e === 0x75) {
        for (let k = j + 2; k < j + 6; k++) if (!esHex(texto.charCodeAt(k))) return { fallo: "invalid_json", posicion: j };
        j += 6;
      } else {
        j += 2;
      }
      continue;
    }
    if (c < 0x20) return { fallo: "invalid_json", posicion: j };
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = texto.charCodeAt(j + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return { fallo: "invalid_unicode", posicion: j };
      j += 2;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return { fallo: "invalid_unicode", posicion: j };
    j++;
  }
  return { fallo: "invalid_json", posicion: n };
}

type Estado = "valor" | "valorOFin" | "claveOFin" | "clave" | "dosPuntos" | "comaOFin" | "fin";

/**
 * Recorre `texto` como UN valor JSON estricto (RFC 8259) rodeado, como mucho,
 * de espacio JSON. Rechaza claves duplicadas en un mismo objeto a cualquier
 * profundidad. Pura, lineal, sin recursión.
 */
export function recorrerJsonEstricto(texto: string, visitante: VisitanteJson = {}): ResultadoJsonEstricto {
  const n = texto.length;
  // Un marco por contenedor abierto: las claves vistas de un objeto, o null si es un array.
  const pila: (Set<string> | null)[] = [];
  let estado: Estado = "valor";
  let i = 0;
  const mal = (fallo: FalloJsonEstricto, posicion = i): ResultadoJsonEstricto => ({ ok: false, fallo, posicion });
  const emitir = (inicio: number, fin: number): boolean => visitante.lexema?.(inicio, fin) !== false;
  const trasValor = (): Estado => (pila.length === 0 ? "fin" : "comaOFin");

  for (;;) {
    while (i < n && esBlanco(texto.charCodeAt(i))) i++;
    if (estado === "fin") return i === n ? { ok: true } : mal("invalid_json");
    if (i >= n) return mal("invalid_json");
    const c = texto.charCodeAt(i);

    if (estado === "valorOFin") {
      if (c === 0x5d) {
        pila.pop();
        if (!emitir(i, i + 1)) return mal("stopped");
        i++;
        estado = trasValor();
        continue;
      }
      estado = "valor";
    }
    if (estado === "claveOFin") {
      if (c === 0x7d) {
        pila.pop();
        if (!emitir(i, i + 1)) return mal("stopped");
        i++;
        estado = trasValor();
        continue;
      }
      estado = "clave";
    }

    switch (estado) {
      case "valor": {
        if (c === 0x7b || c === 0x5b) {
          pila.push(c === 0x7b ? new Set() : null);
          if (!emitir(i, i + 1)) return mal("stopped");
          i++;
          estado = c === 0x7b ? "claveOFin" : "valorOFin";
          continue;
        }
        if (c === 0x22) {
          const r = finDeCadena(texto, i);
          if ("fallo" in r) return mal(r.fallo, r.posicion);
          if (!emitir(i, r.fin)) return mal("stopped");
          i = r.fin;
          estado = trasValor();
          continue;
        }
        if (c === 0x2d || esDigito(c)) {
          RE_NUMERO.lastIndex = i;
          const m = RE_NUMERO.exec(texto);
          if (!m) return mal("invalid_json");
          const fin = i + m[0].length;
          if (visitante.numero?.(m[0]) === false || !emitir(i, fin)) return mal("stopped");
          i = fin;
          estado = trasValor();
          continue;
        }
        const literal = c === 0x74 ? "true" : c === 0x66 ? "false" : c === 0x6e ? "null" : null;
        if (literal && texto.startsWith(literal, i)) {
          if (!emitir(i, i + literal.length)) return mal("stopped");
          i += literal.length;
          estado = trasValor();
          continue;
        }
        return mal("invalid_json");
      }
      case "clave": {
        if (c !== 0x22) return mal("invalid_json");
        const r = finDeCadena(texto, i);
        if ("fallo" in r) return mal(r.fallo, r.posicion);
        const clave = r.escapes ? (JSON.parse(texto.slice(i, r.fin)) as string) : texto.slice(i + 1, r.fin - 1);
        const vistas = pila[pila.length - 1]!;
        if (vistas.has(clave)) return mal("duplicate_keys");
        vistas.add(clave);
        if (visitante.clave?.(clave) === false || !emitir(i, r.fin)) return mal("stopped");
        i = r.fin;
        estado = "dosPuntos";
        continue;
      }
      case "dosPuntos": {
        if (c !== 0x3a) return mal("invalid_json");
        if (!emitir(i, i + 1)) return mal("stopped");
        i++;
        estado = "valor";
        continue;
      }
      case "comaOFin": {
        const tope = pila[pila.length - 1];
        if (c === 0x2c) {
          if (!emitir(i, i + 1)) return mal("stopped");
          i++;
          estado = tope ? "clave" : "valor";
          continue;
        }
        if ((c === 0x7d && tope) || (c === 0x5d && tope === null)) {
          pila.pop();
          if (!emitir(i, i + 1)) return mal("stopped");
          i++;
          estado = trasValor();
          continue;
        }
        return mal("invalid_json");
      }
    }
  }
}

/** Los lexemas de un JSON estricto, en orden y con su texto exacto; o el fallo. */
export function lexemasJsonEstricto(texto: string): { ok: true; lexemas: string[] } | { ok: false; fallo: FalloJsonEstricto } {
  const lexemas: string[] = [];
  const r = recorrerJsonEstricto(texto, {
    lexema: (a, b) => {
      lexemas.push(texto.slice(a, b));
    },
  });
  return r.ok ? { ok: true, lexemas } : { ok: false, fallo: r.fallo };
}

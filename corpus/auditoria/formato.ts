/**
 * Serializador que respeta el estilo con el que cada corpus se escribió.
 *
 * No es cosmética: la reparación toca 150 casos repartidos en cinco ficheros, y
 * si al reescribirlos se reformatea todo, el diff que tiene que revisar una
 * persona pasa de «cambian estas doce líneas» a «cambian cuatro mil». Un cambio
 * de datos que nadie puede leer es un cambio de datos que nadie ha revisado.
 *
 * Dos estilos:
 *
 *   · `"expandido"` — `JSON.stringify(x, null, 2)`, el de facturación. Vuelve a
 *                     salir byte a byte igual que el original.
 *   · `"compacto"`  — igual, pero los arrays de primitivas y los objetos cortos
 *                     de primitivas caben en una línea, como los escribieron
 *                     contratos y soporte.
 *
 * El compacto NO reproduce sus originales al byte, y conviene decirlo: contratos
 * y soporte no siguen la misma regla —uno expande un objeto de cuatro campos que
 * el otro deja en línea— y perseguir esa diferencia sería adivinar. Lo que sí
 * garantiza, y es lo que hace falta, es que sea IDEMPOTENTE: reescribir un
 * fichero sin cambiar nada no produce diff. `test/corpus-auditoria.test.ts` lo
 * comprueba, así que la reformateada de los ficheros compactos ocurre una vez
 * —la de esta reparación— y no vuelve a ensuciar ningún diff.
 */

export type Estilo = "expandido" | "compacto";

const esPrimitiva = (v: unknown): boolean =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

function escribir(v: unknown, indent: string, estilo: Estilo): string {
  if (esPrimitiva(v)) return JSON.stringify(v);
  const dentro = indent + "  ";

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (estilo === "compacto" && v.every(esPrimitiva)) {
      return `[${v.map((x) => JSON.stringify(x)).join(", ")}]`;
    }
    const filas = v.map((x) => dentro + escribir(x, dentro, estilo));
    return `[\n${filas.join(",\n")}\n${indent}]`;
  }

  const entradas = Object.entries(v as Record<string, unknown>).filter(
    ([, x]) => x !== undefined,
  );
  if (entradas.length === 0) return "{}";
  if (estilo === "compacto" && entradas.every(([, x]) => esPrimitiva(x))) {
    const linea = `{ ${entradas
      .map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`)
      .join(", ")} }`;
    if (indent.length + linea.length <= 100) return linea;
  }
  const filas = entradas.map(
    ([k, x]) => `${dentro}${JSON.stringify(k)}: ${escribir(x, dentro, estilo)}`,
  );
  return `{\n${filas.join(",\n")}\n${indent}}`;
}

export function serializar(valor: unknown, estilo: Estilo): string {
  return escribir(valor, "", estilo) + "\n";
}

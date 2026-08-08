/**
 * Marca INFALSIFICABLE de "proveedor de demo interno".
 *
 * Vive en un WeakSet privado que NO se reexporta desde ningún barrel: un
 * atacante que importe el bundle no tiene forma de nombrar `marcarDemo` ni de
 * meter su propio proveedor en el conjunto. El bundle web permite correr sin
 * licencia SOLO contra un proveedor de esta marca (ver `devOpen` en
 * pipeline.ts): la demo del landing usa un mock —que no sirve valor real— y
 * quien importe el bundle con un proveedor DE VERDAD queda gateado. Un
 * `id: "mock"` sería falsificable con una cadena; esto no.
 *
 * Este fichero se importa directamente donde hace falta; providers/index.ts NO
 * lo reexporta a propósito, así que no forma parte de la API pública.
 */
const proveedoresDemo = new WeakSet<object>();

/** Marca una instancia como proveedor de demo interno. Solo lo llama el mock. */
export function marcarDemo(p: object): void {
  proveedoresDemo.add(p);
}

/** ¿Es este el proveedor de demo interno? Solo lo consulta el pipeline. */
export function isBuiltInDemoProvider(p: unknown): boolean {
  return typeof p === "object" && p !== null && proveedoresDemo.has(p);
}

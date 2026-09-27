// Precarga de los hijos que ejecutan los ejemplos de `bvsala init`: sin red.
// Cualquier fetch (proveedor, licencia, medición) falla en vez de salir de la
// máquina. El ejemplo tiene que funcionar igual: la pregunta la contesta la capa.
globalThis.fetch = async (url) => {
  throw new Error(`[sin-red] network is forbidden in this run: ${String(url)}`);
};

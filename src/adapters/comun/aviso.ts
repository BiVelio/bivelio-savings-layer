// Avisos de los adaptadores: UNA vez por causa y proceso, y ninguno con
// `silenceWarnings`, igual que los del núcleo. Todo lo que se avisa es algo cuyo
// síntoma sería invisible de otra forma (un informe que no llega, un contador
// que no es la factura); ninguno cambia lo que hace el adaptador.

const dados = new Set<string>();

export function avisarUnaVez(silencio: boolean | undefined, clave: string, mensaje: string): void {
  if (silencio === true || dados.has(clave)) return;
  dados.add(clave);
  console.warn(mensaje);
}

/**
 * Un aviso por proceso y por causa.
 *
 * Los avisos que importan son los que señalan que una cifra publicada vale menos
 * de lo que parece — un contrato que no cumple el modo estricto, una salida
 * cortada por el tope. Repetirlos en cada petición los convierte en ruido de
 * fondo, y un aviso que nadie lee es igual que no tenerlo.
 */
const vistos = new Set<string>();

export function avisarUnaVez(clave: string, mensaje: string): void {
  if (vistos.has(clave)) return;
  vistos.add(clave);
  console.warn(mensaje);
}

/** ¿Ya salió el aviso de esta causa? Para no calcular un mensaje que no se va a imprimir. */
export function yaSeAviso(clave: string): boolean {
  return vistos.has(clave);
}

/** Solo para tests: permite comprobar que un aviso se emite. */
export function reiniciarAvisos(): void {
  vistos.clear();
}

/**
 * La variable de entorno que calla los avisos de lo que la 0.5 quita o
 * renombra; la misma que ya obedece la CLI (gateway/argumentos.ts). Solo los de
 * obsolescencia: `silenceWarnings` los calla todos.
 */
export const SILENCIAR_OBSOLETOS = "BVSALA_SILENCE_DEPRECATIONS";

/** ¿Está puesta `BVSALA_SILENCE_DEPRECATIONS` (cualquier valor salvo vacío o «0»)? Sin `process` (navegador, edge), no. */
export function obsoletosSilenciados(): boolean {
  const v = typeof process !== "undefined" ? process.env?.[SILENCIAR_OBSOLETOS]?.trim() : undefined;
  return v !== undefined && v !== "" && v !== "0";
}

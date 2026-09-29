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

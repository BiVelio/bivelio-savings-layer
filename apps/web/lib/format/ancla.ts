/**
 * EL ANCLA DE LA URL, DESCODIFICADA — O NADA SI VIENE ROTA.
 *
 * `decodeURIComponent` LANZA (`URIError: URI malformed`) con un `%` suelto o
 * una secuencia UTF-8 a medias, y el fragmento lo escribe quien quiera: basta
 * abrir `/es#%`. Dos efectos del cliente lo descodificaban a pelo —el que
 * atiende los enlaces antiguos de la portada y el que despliega la sección
 * enlazada del banco—, así que una URL así tiraba una excepción sin capturar
 * al hidratar (prelanzamiento, 2026-11-16).
 *
 * Un ancla que no se puede leer no apunta a ninguna sección: se trata igual
 * que si no hubiera ancla. Acepta el `location.hash` tal cual, con su `#`.
 */
export function anclaDe(hash: string): string {
  const crudo = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(crudo);
  } catch {
    return "";
  }
}

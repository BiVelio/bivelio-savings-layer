/**
 * EL MARCADOR DE LA CAMPAÑA (la pieza «Your LLM bill, under *control.*»): un
 * bloque cian pálido detrás de la palabra que remata un titular, trazado de
 * izquierda a derecha al entrar. Es solo presentación: el texto sigue siendo
 * texto (se lee, se copia, se traduce) y el bloque es un pseudo-elemento.
 *
 * Qué se marca:
 *  · `marca` — la cadena exacta a marcar, si el idioma la declara (p. ej. el
 *    vietnamita, donde «tiết kiệm» son dos sílabas separadas por espacio, o
 *    «Savings Layer», que son dos palabras);
 *  · si no, la ÚLTIMA palabra del texto.
 * La puntuación pegada detrás de la marca («ahorro.», «control.») entra en el
 * bloque, como en la pieza promocional. Si la marca no aparece en el texto, se
 * pinta el texto tal cual: nunca se inventa ni se pierde una letra.
 */
export function Marcado({ texto, marca, className }: { texto: string; marca?: string; className?: string }) {
  const partes = partirMarca(texto, marca);
  if (!partes) return <>{texto}</>;
  const [antes, marcado, despues] = partes;
  return (
    <>
      {antes}
      <span className={className ? `mk ${className}` : "mk"}>{marcado}</span>
      {despues}
    </>
  );
}

const PUNTUACION_FINAL = /[.!?…:;,»”"')\]¡¿]/u;

/** [antes, marcado, después], o null si no hay nada que marcar. Exportada para la prueba. */
export function partirMarca(texto: string, marca?: string): [string, string, string] | null {
  const objetivo = (marca && marca.trim()) || ultimaPalabra(texto);
  if (!objetivo) return null;
  const i = texto.lastIndexOf(objetivo);
  if (i < 0) return null;
  let fin = i + objetivo.length;
  while (fin < texto.length && PUNTUACION_FINAL.test(texto[fin])) fin++;
  return [texto.slice(0, i), texto.slice(i, fin), texto.slice(fin)];
}

function ultimaPalabra(texto: string): string {
  const fichas = texto.trim().split(/\s+/u);
  const ultima = fichas[fichas.length - 1] ?? "";
  // Sin la puntuación final: `partirMarca` la vuelve a pegar dentro del bloque.
  let fin = ultima.length;
  while (fin > 0 && PUNTUACION_FINAL.test(ultima[fin - 1])) fin--;
  return ultima.slice(0, fin);
}

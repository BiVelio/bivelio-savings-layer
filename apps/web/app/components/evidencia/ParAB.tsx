import { AbBranches } from "@/vendor/affectui/ab-branches";

/**
 * CÓMO ES UN PAR A/B, DIBUJADO — la ilustración «Outreach Branches» de
 * affectUI, bifurcada para explicar una sola cosa: la MISMA petición se envía
 * por dos brazos (A tal cual, B a través de la capa) y el contador de uso del
 * propio proveedor mide los dos.
 *
 * El dibujo no lleva texto (solo las letras A y B) ni dice nada del resultado:
 * los dos brazos tienen el mismo tamaño. La leyenda va al lado, en texto de
 * verdad y en el idioma de la página; por eso el SVG es decorativo.
 */
export function ParAB({
  peticion,
  brazoA,
  brazoB,
  contador,
  className,
}: {
  peticion: string;
  brazoA: string;
  brazoB: string;
  contador: string;
  className?: string;
}) {
  return (
    <figure className={className ? `par-ab ${className}` : "par-ab"}>
      <AbBranches className="par-ab-art" />
      <figcaption className="par-ab-leyenda">
        <ol>
          <li>
            <span className="par-ab-k par-ab-k--req" aria-hidden />
            {peticion}
          </li>
          <li>
            <span className="par-ab-k" aria-hidden>
              A
            </span>
            {brazoA}
          </li>
          <li>
            <span className="par-ab-k par-ab-k--b" aria-hidden>
              B
            </span>
            {brazoB}
          </li>
          <li>
            <span className="par-ab-k par-ab-k--meter" aria-hidden />
            {contador}
          </li>
        </ol>
      </figcaption>
    </figure>
  );
}

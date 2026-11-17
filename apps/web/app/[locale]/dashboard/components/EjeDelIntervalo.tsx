/**
 * LA LEYENDA DE UNA BANDA DE INTERVALO, CON EL CERO DEBAJO DE SU LÍNEA.
 *
 * Antes eran tres etiquetas repartidas con `space-between`: el «0 %» caía en el
 * centro de la banda aunque la línea roja del cero estuviera a un 8 % del borde
 * izquierdo, y la banda se leía como si el cero estuviera en medio. Aquí el cero
 * va colocado en la misma `left` que su línea (`x0`, el `xp(0)` de quien pinta la
 * banda); los extremos quedan pegados a sus bordes.
 *
 * El extremo izquierdo es relleno del eje (5 puntos por debajo del suelo), no un
 * dato: cuando el cero queda tan cerca del borde que las dos etiquetas se
 * pisarían, se calla el extremo y habla el cero. Cerca de un borde el cero se
 * alinea hacia dentro en vez de centrarse, para no salirse de la banda.
 */
export function EjeDelIntervalo({
  min,
  cero,
  max,
  x0,
}: {
  min: string;
  cero: string;
  max: string;
  /** Posición del cero en la banda, en % (0–100). */
  x0: number;
}) {
  const alinear = x0 < 6 ? "inicio" : x0 > 94 ? "fin" : "centro";
  return (
    <div className="ci-legend2 ci-eje">
      {x0 >= 22 ? <span className="ci-eje-min">{min}</span> : null}
      <span className="ci-eje-cero" data-alinear={alinear} style={{ left: `${x0}%` }}>
        {cero}
      </span>
      {x0 <= 78 ? <span className="ci-eje-max">{max}</span> : null}
    </div>
  );
}

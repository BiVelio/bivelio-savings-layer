import { BANCO_EN_VIVO } from "./banco-en-vivo";

/**
 * LA FACTURA DEL HÉROE: UNA IMAGEN EN VEZ DE UN PÁRRAFO (dueño, 2026-10-03:
 * «mejor 1 imagen que 1000 palabras»).
 *
 * El héroe pinta dos barras —tu factura directa al proveedor y la misma con
 * Savings— y la cifra del banco en vivo encima. Todo sale de aquí, y aquí todo
 * sale de BANCO_EN_VIVO (con verja contra su informe en banco-en-vivo.test.ts):
 *   · la cifra es el ahorro medido de gpt-4o-mini, con su IC 95 %;
 *   · la condición (el 30 % de repeticiones exactas) va siempre al lado;
 *   · los anchos de las barras son la factura relativa: la directa vale 1 y la
 *     de Savings 1 − ahorro; el intervalo, 1 − alto … 1 − bajo.
 * Ni un número escrito a mano, ni un cero, ni un «≈».
 */
export function facturaDelHeroe(locale: string) {
  const V = BANCO_EN_VIVO;
  const a = V.openai.ahorro;
  const pct1 = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct0 = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  // «−31,5 %» con el signo menos tipográfico (U+2212), no el guion: la cifra es
  // una bajada de la factura y así se lee de un vistazo.
  const bajada = pct1.format(-a.point).replace("-", "−");
  return {
    marca: "OpenAI",
    modelo: V.openai.modelo.split("/").pop() ?? V.openai.modelo,
    bateria: V.bateria,
    version: V.versionSdk,
    fecha: V.fecha,
    bajada,
    bajo: pct1.format(a.lower),
    alto: pct1.format(a.upper),
    rep: pct0.format(V.repeticiones),
    /** Factura relativa (la directa = 1) para las barras. */
    barra: { con: 1 - a.point, desde: 1 - a.upper, hasta: 1 - a.lower },
  };
}

export type FacturaDelHeroe = ReturnType<typeof facturaDelHeroe>;

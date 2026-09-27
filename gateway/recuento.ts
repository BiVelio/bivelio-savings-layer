/**
 * EL RECUENTO DE LO MEDIDO — cuántas peticiones de inferencia de este proceso
 * se midieron con el contador del proveedor y cuántas se reenviaron SIN medir,
 * y por qué.
 *
 * Existe por los envoltorios (`bvsala claude|codex|opencode|…`): ahí el log por
 * petición va callado para no pisar el TUI, y cada línea «not metered» se
 * perdía con él. Un terminal mal apuntado, un stream que nunca pidió su usage
 * o un modelo sin precio en el catálogo dejaban la sesión entera sin medir sin
 * que nada lo dijera. Al salir, `bin.ts` imprime este resumen por stderr.
 *
 * Es local, como el vigía de degradaciones: no viaja en el registro de uso
 * (la LICENSE §5 enumera los campos y este no está) y no estima nada en lugar
 * de lo que no se midió.
 */

export interface EstadoDeMedicion {
  /** Peticiones que viajaron y se midieron con el contador del proveedor. */
  medidas: number;
  /**
   * Peticiones idénticas a otra en vuelo que recibieron su réplica sin viajar
   * (`BVSALA_GATEWAY_COALESCE=1`): se registran valoradas con el contador de la
   * que sí viajó, no con uno propio. Aparte, para no llamarlas «medidas».
   */
  replicas: number;
  /** Reenviadas sin medir, por motivo (el mismo texto que su línea de log). */
  noMedidas: Readonly<Record<string, number>>;
}

/** Tope de motivos distintos que se guardan: un motivo lleva el id del modelo. */
const MAX_MOTIVOS = 50;
const MOTIVO_OTROS = "other reasons";

export class RecuentoDeMedicion {
  private medidas = 0;
  private replicas = 0;
  private readonly noMedidas = new Map<string, number>();

  medida(): void {
    this.medidas++;
  }

  replica(): void {
    this.replicas++;
  }

  noMedida(motivo: string): void {
    const clave = this.noMedidas.has(motivo) || this.noMedidas.size < MAX_MOTIVOS ? motivo : MOTIVO_OTROS;
    this.noMedidas.set(clave, (this.noMedidas.get(clave) ?? 0) + 1);
  }

  estado(): EstadoDeMedicion {
    return { medidas: this.medidas, replicas: this.replicas, noMedidas: Object.fromEntries(this.noMedidas) };
  }
}

/**
 * La línea de salida. `quien` es el comando (`claude`, `copilot`, `gateway`…).
 * Tres casos: nada pasó por el gateway, todo se midió, o parte se quedó fuera
 * (con los motivos, de más a menos frecuente). Jamás una cifra estimada.
 */
export function resumenDeMedicion(e: EstadoDeMedicion, quien: string): string {
  const cabeza = `[bvsala ${quien}] metering in this run:`;
  const motivos = Object.entries(e.noMedidas).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sinMedir = motivos.reduce((s, [, n]) => s + n, 0);
  if (e.medidas === 0 && e.replicas === 0 && sinMedir === 0) {
    return (
      `${cabeza} no inference request went through the gateway. If the terminal did call a model, ` +
      "those calls went straight to the provider and were not metered: check its guide in docs/terminales/."
    );
  }
  const medidas =
    `${e.medidas} request(s) metered with the provider's usage` +
    (e.replicas > 0 ? ` · ${e.replicas} duplicate(s) answered with a replica, valued from the request that travelled` : "");
  if (sinMedir === 0) return `${cabeza} ${medidas}.`;
  const detalle = motivos.map(([m, n]) => `${n} × ${m}`).join("; ");
  return (
    `${cabeza} ${medidas} · ${sinMedir} forwarded but NOT metered (nothing is estimated in their place): ${detalle}. ` +
    "What each reason means and what to do: docs/terminales/README.md."
  );
}

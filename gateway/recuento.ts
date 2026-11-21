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
 *
 * EL DINERO (1.2.4). Hasta la 1.2.3 la línea solo contaba peticiones, y quien
 * salía de `bvsala claude` leía «16 request(s) metered» sin una sola cifra: se
 * entendía como «esto solo cuenta». Ahora suma lo que cada informe YA llevaba
 * —el mismo objeto que va al panel y al buzón local, sin recalcular nada— y
 * dice el gasto a precio de lista y el ahorro, cada base por separado
 * (`measured`, `reference`, `estimated`: jamás sumadas en una cifra). No toca
 * el tráfico: solo lee el `cost` de un informe ya construido.
 */

/** Lo que el recuento lee del `cost` de un informe ya construido (SavingsReport.cost). */
export interface CosteDeInforme {
  /** Lo que costó la petición a precio de lista, con el contador del proveedor. */
  actual: number;
  /** Baseline − actual. Negativo cuando una palanca salió cara (fallo de caché tras la rebaja de TTL). */
  netSavingsUsd: number;
  basis: string;
}

/** El dinero de la sesión. Local: no se envía a ninguna parte. */
export interface DineroDeLaSesion {
  /** Suma de `cost.actual` de las peticiones medidas: gasto a precio de lista. */
  gastoUsd: number;
  /** Ahorro neto con base `measured` (puede ser negativo). */
  ahorroMedidoUsd: number;
  /** Ahorro con base `reference`: réplicas valoradas con el contador de la que viajó. */
  ahorroPorReferenciaUsd: number;
  /** Ahorro con base `estimated`: réplicas sin referencia. Nunca se suma al medido. */
  ahorroEstimadoUsd: number;
  /** De las medidas, cuántas eran tráfico de suscripción (equivalente a precio de lista, sin factura por token). */
  deSuscripcion: number;
}

export interface EstadoDeMedicion {
  /**
   * Peticiones de INFERENCIA (POST a una ruta con dialecto de usage) que
   * llegaron al gateway, acabaran como acabaran. Es lo que impide decir «no
   * pasó ninguna» cuando sí pasaron y ninguna dejó contador.
   */
  recibidas: number;
  /**
   * De las recibidas, las que terminaron sin medida y sin motivo propio: el
   * proveedor respondió un error (no factura), no respondió, o el cliente se
   * fue antes. No se estima nada en su lugar.
   */
  sinContador: number;
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
  /** El dinero de lo medido y de las réplicas. */
  dinero: DineroDeLaSesion;
}

/** Lo que el resumen necesita saber de cómo corrió el proceso. */
export interface OpcionesDeResumen {
  /**
   * El log por petición se vio en pantalla (`bvsala gateway`, o un envoltorio
   * con BVSALA_GATEWAY_LOG=1). Si no, la línea dice cómo verlo la próxima vez.
   */
  logVisible?: boolean;
  /**
   * `BVSALA_GATEWAY_OBSERVE_ONLY=1`: ninguna palanca actuó, así que el «saved
   * $0.00» lo explica ESO y no la regla de la rebaja de TTL (verificación final
   * de la 1.2.4: la línea daba un motivo falso a una sesión que sí pedía 1 h).
   */
  soloObservar?: boolean;
}

/** Tope de motivos distintos que se guardan: un motivo lleva el id del modelo. */
const MAX_MOTIVOS = 50;
const MOTIVO_OTROS = "other reasons";

export class RecuentoDeMedicion {
  private recibidas = 0;
  private medidas = 0;
  private replicas = 0;
  private noMedidasDeInferencia = 0;
  private readonly noMedidas = new Map<string, number>();
  private gastoUsd = 0;
  private ahorroMedidoUsd = 0;
  private ahorroPorReferenciaUsd = 0;
  private ahorroEstimadoUsd = 0;
  private deSuscripcion = 0;

  /** Llegó una petición de inferencia (antes de saber cómo acaba). */
  recibida(): void {
    this.recibidas++;
  }

  /**
   * Una petición que viajó y se midió. `coste` es el `cost` del informe que se
   * acaba de construir para ella; `suscripcion`, si no deja factura por token.
   */
  medida(coste: CosteDeInforme, suscripcion = false): void {
    this.medidas++;
    if (suscripcion) this.deSuscripcion++;
    this.sumar(coste);
  }

  /** Una gemela servida con la réplica de otra: no gastó, y su ahorro va por su base. */
  replica(coste: CosteDeInforme): void {
    this.replicas++;
    this.sumar(coste);
  }

  private sumar(coste: CosteDeInforme): void {
    if (Number.isFinite(coste.actual)) this.gastoUsd += coste.actual;
    if (!Number.isFinite(coste.netSavingsUsd)) return;
    if (coste.basis === "measured") this.ahorroMedidoUsd += coste.netSavingsUsd;
    else if (coste.basis === "reference") this.ahorroPorReferenciaUsd += coste.netSavingsUsd;
    else if (coste.basis === "estimated") this.ahorroEstimadoUsd += coste.netSavingsUsd;
    // Cualquier otra base (p. ej. `shadow`, hipotética) no es dinero de esta sesión.
  }

  /**
   * `deInferencia`: la petición era una de las `recibidas` (ruta con dialecto).
   * Falso solo para rutas de la API sin dialecto (embeddings…), que se cuentan
   * por su motivo pero no entran en las recibidas.
   */
  noMedida(motivo: string, deInferencia = true): void {
    if (deInferencia) this.noMedidasDeInferencia++;
    const clave = this.noMedidas.has(motivo) || this.noMedidas.size < MAX_MOTIVOS ? motivo : MOTIVO_OTROS;
    this.noMedidas.set(clave, (this.noMedidas.get(clave) ?? 0) + 1);
  }

  estado(): EstadoDeMedicion {
    return {
      recibidas: this.recibidas,
      sinContador: Math.max(0, this.recibidas - this.medidas - this.replicas - this.noMedidasDeInferencia),
      medidas: this.medidas,
      replicas: this.replicas,
      noMedidas: Object.fromEntries(this.noMedidas),
      dinero: {
        gastoUsd: this.gastoUsd,
        ahorroMedidoUsd: this.ahorroMedidoUsd,
        ahorroPorReferenciaUsd: this.ahorroPorReferenciaUsd,
        ahorroEstimadoUsd: this.ahorroEstimadoUsd,
        deSuscripcion: this.deSuscripcion,
      },
    };
  }
}

/** Por debajo de esto una suma de dólares es ruido de coma flotante, no dinero. */
const CASI_CERO = 5e-7;

/** Un importe para leer de un vistazo: céntimos desde 1 $, cuatro decimales por debajo. */
export function dolares(usd: number): string {
  const abs = Math.abs(usd);
  if (abs < CASI_CERO) return "$0.00";
  return `$${abs >= 1 ? abs.toFixed(2) : abs.toFixed(4)}`;
}

/**
 * El dinero de la sesión, en una frase: el gasto a precio de lista y el ahorro
 * por base. Si no hubo ahorro dice POR QUÉ con lo que el recuento sabe (todo
 * era suscripción, o ninguna palanca cambió nada); si las palancas salieron
 * caras lo dice igual, con la variable que las apaga. Vacía si nada se midió.
 */
export function fraseDeDinero(e: EstadoDeMedicion, opciones?: OpcionesDeResumen): string {
  if (e.medidas === 0 && e.replicas === 0) return "";
  const d = e.dinero;
  const todoSuscripcion = e.medidas > 0 && d.deSuscripcion === e.medidas;
  const gasto = todoSuscripcion
    ? `spent ${dolares(d.gastoUsd)} at list-price equivalent (subscription traffic: there is no per-token invoice)`
    : `spent ${dolares(d.gastoUsd)} at list price` +
      (d.deSuscripcion > 0 ? ` (${d.deSuscripcion} request(s) on a subscription count at list-price equivalent)` : "");
  const partes: string[] = [];
  if (d.ahorroMedidoUsd >= CASI_CERO) partes.push(`saved ${dolares(d.ahorroMedidoUsd)} (measured)`);
  else if (d.ahorroMedidoUsd <= -CASI_CERO) {
    partes.push(
      `the levers cost ${dolares(d.ahorroMedidoUsd)} more than they saved (measured; usually a 5-minute cache entry ` +
        "that expired during a pause and was rewritten; BVSALA_GATEWAY_ELISION=0 turns cache TTL tuning off)",
    );
  }
  if (d.ahorroPorReferenciaUsd >= CASI_CERO) {
    partes.push(`${dolares(d.ahorroPorReferenciaUsd)} in duplicate calls avoided (by reference)`);
  }
  if (d.ahorroEstimadoUsd >= CASI_CERO) {
    partes.push(`about ${dolares(d.ahorroEstimadoUsd)} in duplicate calls avoided (estimated, never added to the measured figure)`);
  }
  if (partes.length === 0) {
    partes.push(
      opciones?.soloObservar
        ? "saved $0.00: observe-only mode (BVSALA_GATEWAY_OBSERVE_ONLY=1) applies no lever; what they would have " +
            "saved is in the per-request `measure (shadow)` lines, never counted as a saving"
        : todoSuscripcion
        ? "saved $0.00: no saving is credited on a subscription (there is no per-token invoice); " +
            "with the defaults the gateway changes nothing there"
        : "saved $0.00: nothing was credited (cache TTL tuning is credited only on Anthropic API-key traffic " +
            "sent to the official API that asks for the 1-hour cache; an opt-in lever or a proxy upstream can " +
            "change a request without a credited saving; the gateway's levers act on Anthropic /v1/messages only; " +
            "see `bvsala --help`)",
    );
  }
  return `${gasto} · ${partes.join(" · ")}`;
}

/** Dónde está el detalle por petición, según se viera o no el log. */
function dondeElDetalle(o: OpcionesDeResumen | undefined): string {
  return o?.logVisible
    ? " Per-request detail: the log lines above."
    : " Per-request detail: run it again with BVSALA_GATEWAY_LOG=1 (one line per request, on stderr).";
}

/**
 * La línea de salida. `quien` es el comando (`claude`, `copilot`, `gateway`…).
 * Tres casos: nada pasó por el gateway, todo se midió, o parte se quedó fuera
 * (con los motivos, de más a menos frecuente). Jamás una cifra estimada en
 * lugar de lo no medido. Con peticiones recibidas la línea dice cuántas PASARON
 * y cuántas se midieron: «no pasó ninguna» solo se dice cuando de verdad no
 * llegó ninguna. Con algo medido dice además el dinero (`fraseDeDinero`) y
 * dónde ver el detalle por petición.
 */
export function resumenDeMedicion(e: EstadoDeMedicion, quien: string, opciones?: OpcionesDeResumen): string {
  const cabeza = `[bvsala ${quien}] metering in this run:`;
  const motivos = Object.entries(e.noMedidas).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sinMedir = motivos.reduce((s, [, n]) => s + n, 0);
  if (e.recibidas === 0 && e.medidas === 0 && e.replicas === 0 && sinMedir === 0) {
    return (
      `${cabeza} no inference request went through the gateway. If the terminal did call a model, ` +
      "those calls went straight to the provider and were not metered: check its guide in docs/terminales/."
    );
  }
  const dinero = fraseDeDinero(e, opciones);
  const medidas =
    (e.recibidas > 0 ? `${e.recibidas} inference request(s) went through the gateway · ` : "") +
    `${e.medidas} request(s) metered with the provider's usage` +
    (e.replicas > 0 ? ` · ${e.replicas} duplicate(s) answered with a replica, valued from the request that travelled` : "") +
    (e.sinContador > 0
      ? ` · ${e.sinContador} ended with no usage to meter (provider error, no answer, or closed before the final usage)`
      : "") +
    (dinero ? ` · ${dinero}` : "");
  const detalle = dinero ? dondeElDetalle(opciones) : "";
  if (sinMedir === 0) return `${cabeza} ${medidas}.${detalle}`;
  const porMotivo = motivos.map(([m, n]) => `${n} × ${m}`).join("; ");
  return (
    `${cabeza} ${medidas} · ${sinMedir} forwarded but NOT metered (nothing is estimated in their place): ${porMotivo}. ` +
    `What each reason means and what to do: docs/terminales/README.md.${detalle}`
  );
}

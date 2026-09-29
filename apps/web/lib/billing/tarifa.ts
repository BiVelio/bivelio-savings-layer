/**
 * LA TARIFA VARIABLE — única fuente de verdad.
 *
 * Decidida por el dueño el 2026-08-23 (plan maestro «La medición manda») y
 * revisada por el dueño el 2026-09-01: SIN MÍNIMO.
 *
 *   · Se comisiona SOLO el ahorro MEDIDO: el del contador de la propia
 *     petición (basis=measured) y el MEDIDO POR REFERENCIA (basis=reference,
 *     bajo COMISIONAR_REFERENCIA). Lo estimado nunca.
 *   · SIN umbral ni rampa: la comisión por tramos aplica desde el primer euro
 *     medido. (Hasta el 2026-09-01 existía un umbral del 30% con rampa hasta
 *     el 35%; los clientes con ratio ≥35% no notan el cambio — la franja
 *     0–35% pasa de comisión 0 a comisión por tramos.)
 *   · La garantía que lo sustituye, testeada y por construcción: el cliente
 *     se queda SIEMPRE con GARANTIA_NETA_RATIO o más de cada euro ahorrado,
 *     porque ningún tramo supera el tipo máximo. Sin ahorro medido no hay
 *     COMISIÓN; la cuota por asiento es otra cosa y se cobra siempre.
 *   · Escalado A — marginal por volumen, cada tramo a su tipo (como el IRPF):
 *     10% / 8% / 6% / 4% con cortes en 1.000 / 5.000 / 20.000 €.
 *   · Mes de calibración: el primer período de cada organización no se cobra;
 *     su extracto existe igualmente, etiquetado, con la cifra que HABRÍA sido.
 *
 * Cuando la web publique estos números (F3/GA), su test de anclaje debe leer
 * ESTAS constantes — nunca duplicarlas. Patrón `precio-publicado.test.ts`.
 */

/**
 * EL INTERRUPTOR del suelo de la elisión del proveedor (migración 0025).
 *
 * `usage_daily.eliminated_floor_cost` guarda, por día, los tokens que el
 * proveedor borró (`applied_edits`, cuando NUESTROS diales cambiaron la
 * petición) valorados al precio de LECTURA de caché. Ese dólar se GUARDA y se
 * enseña como CONTEO — pero NO entra en la base de la comisión mientras esto
 * sea `false`, por la doctrina de arriba: se comisiona SOLO el ahorro MEDIDO,
 * el que el cliente puede contrastar con la factura de su proveedor. El suelo
 * no lo es todavía: es el BRUTO del turno (lectura evitada) sin restar la
 * invalidación de prefijo del mismo corte, y la evidencia congelada da
 * opus-4-8 NETO negativo. Cobrar sobre eso sería cobrar sobre un dólar que su
 * consola puede desmentir.
 *
 * Ponerlo a `true` es DECISIÓN DEL DUEÑO y obliga a reescribir, como mínimo:
 *   1. apps/web/lib/billing/extracto.ts — hoy solo suma el carril bajo este
 *      interruptor (`extraSuelo`); la base y el ahorro medidos NO lo llevan.
 *   2. apps/web/lib/billing/types.ts / el cierre sellado (cierre.ts + el cron
 *      cierre-extractos, que selecciona columnas explícitas y no lee las nuevas).
 *   3. gateway/recibo.ts — «DEL PROVEEDOR: se enseña, no se cobra».
 *   4. src/pricing/aptitud-de-elision.ts — la condición de salida: NETO por
 *      modelo medido con el mecanismo real (lectura evitada − invalidación).
 *   5. apps/web/lib/billing/accounting.ts — `basis` medido/estimado excluyentes.
 *   6. liveLedgerTiles.elisionNota y elisionProveedor.nota ×12 idiomas, que hoy
 *      prometen «nunca entra en tu comisión».
 * Precondición técnica ya desplegada: el techo server-side del ingest
 * (apps/web/lib/metering/techo-precio-lectura.ts) — sin él, un gateway rezagado
 * que tarifara a precio de entrada se cobraría ×10-40.
 *
 * Tipado como `boolean` (no literal) a propósito: el código que lo consulta
 * tiene que compilar en las dos posiciones. tarifa.test.ts lo ancla en `false`.
 */
export const COMISIONAR_ELISION_SUELO: boolean = false;

/**
 * EL INTERRUPTOR del carril MEDIDO POR REFERENCIA (migración 0029).
 *
 * `usage_daily.reference_*` guarda, por día, las llamadas EVITADAS (acierto
 * exacto o seguidor coalescido) cuya repetición es byte a byte una petición que
 * sí se ejecutó a través de la capa sin que la capa la tocara. Su baseline es
 * el contador que el proveedor devolvió para esa petición idéntica —la que el
 * cliente ya pagó—, valorado a la BAJA: toda la entrada al precio de entrada
 * cacheada (el mínimo que el proveedor cobra por repetir un prompt) y la salida
 * solo con muestreo determinista y sin razonamiento oculto, al
 * REGLA_REFERENCIA.cuotaSalida de su contador.
 *
 * El contraste con COMISIONAR_ELISION_SUELO es la razón de que este nazca
 * encendido: aquel es un BRUTO sin neto (lectura evitada sin restar la
 * invalidación de prefijo del mismo corte) que ninguna línea de la factura del
 * cliente respalda; este es el contador de una llamada idéntica ya ejecutada,
 * tarifado por debajo de lo que la repetición habría costado. Es medido.
 *
 * Apagarlo (`false` + su test + un PR) deja de cobrar lo acumulado en los
 * períodos NO sellados: el extracto lo sigue enseñando como contexto
 * («referenciaExcluida») y el cierre sella la regla con el sufijo «:excluded». Cortar la
 * ACUMULACIÓN misma es el otro interruptor, sin código:
 * BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1 en la ruta del ingest.
 *
 * Tipado como `boolean` (no literal) a propósito, como el de arriba: el código
 * que lo consulta tiene que compilar en las dos posiciones. tarifa.test.ts lo
 * ancla en `true`.
 */
export const COMISIONAR_REFERENCIA: boolean = true;

/**
 * LA REGLA con la que el SDK valora una repetición por referencia, publicada
 * en cada extracto (`parametros.referencia`) y sellada en el cierre
 * (`extractos.regla_referencia`): lo que hace el documento autocontenido.
 *
 * v2: el tráfico con contrato de salida entra cuando el esquema del cliente
 * viajó tal cual, en modo estricto, en el parámetro nativo de formato de
 * respuesta, sin nada añadido al prompt; y la salida solo se acredita con un
 * modelo del catálogo que no razona y honra `temperature: 0`, y si la llamada
 * que corrió no llevó razonamiento oculto (0 tokens de razonamiento declarados
 * o, donde el proveedor no los desglosa, ningún bloque de razonamiento). El
 * texto que ve el cliente es `dashboard.extracto.parametrosReferencia`.
 *
 * QUÉ HACE CIERTO ESTE SELLO: no el orden de publicación. La etiqueta v0.4.23
 * se cortó con la regla v1, de la 0.4.24 a la 0.4.32 el SDK podía repetir una
 * negativa del proveedor como referencia (la que el modelo escribe como texto,
 * hasta la 0.4.30: #384; el `content_filter: OTHER` de Gemini, las que #384 no
 * veía y los temas sensibles, hasta la 0.4.31: #393, #401, #402; las negativas
 * parciales y la carencia tras una disculpa, hasta la 0.4.32: #422), y la regla
 * no viaja en el registro de uso, así que el
 * ingest (app/api/metering/usage/route.ts) degrada a "estimated" toda
 * referencia de un proceso que no declara versión, que declara una anterior a
 * VERSION_MINIMA_REFERENCIA, o que es el gateway, que no pasa por el pipeline
 * que aplica esta regla (lib/metering/version.ts). Lo que llega a
 * reference_* después de desplegar esa verja se calculó con esta regla. Si la
 * regla cambia de versión, la mínima sube con ella en el mismo PR.
 *
 * apps/web no puede importar de src/ (proyecto aparte): estas cifras DUPLICAN
 * las constantes del SDK (REFERENCE_OUTPUT_SHARE, REFERENCE_MAX_AGE_MS y
 * REFERENCE_MESSAGE_ALLOWANCE) y tarifa.test.ts las ata leyendo el fuente del
 * SDK como texto en cuanto existe.
 */
export const REGLA_REFERENCIA = {
  /**
   * El identificador PÚBLICO de la regla: lo ve el cliente en el extracto
   * («Rule for repeated requests (reference-v2)») y queda SELLADO en
   * `extractos.regla_referencia`, inmutable. Por eso en inglés y ASCII, como
   * todo lo que ve el cliente; tarifa.test.ts lo fija.
   */
  version: "reference-v2",
  /** Fracción del contador de salida que se acredita (solo con muestreo determinista y sin razonamiento oculto). */
  cuotaSalida: 0.95,
  /** Edad máxima del contador de referencia, en días. */
  edadMaximaDias: 30,
  /** Tokens de entrada que se descuentan por cada pieza que la capa insertó en la llamada que corrió (un mensaje, el envoltorio del esquema nativo; dos por los parámetros vacíos de una herramienta que no traía). */
  margenPorMensajeTokens: 8,
} as const;

/**
 * La moneda de los tramos, de la comisión y del mínimo facturable: la de
 * `hastaEur`, `comisionEur` y `cargo_eur`. El cierre convierte a ella el ahorro
 * medido (que se cuenta en USD) con el cambio del BCE (fx.ts). La página
 * pública de precios formatea con ella; no es la del Price de Stripe (la cuota
 * por asiento), aunque hoy coincidan.
 */
export const MONEDA_DE_LA_COMISION = "EUR";

/** Tramos marginales sobre el ahorro medido del período, en EUR. */
export const TRAMOS: readonly { hastaEur: number; tipo: number }[] = [
  { hastaEur: 1_000, tipo: 0.1 },
  { hastaEur: 5_000, tipo: 0.08 },
  { hastaEur: 20_000, tipo: 0.06 },
  { hastaEur: Number.POSITIVE_INFINITY, tipo: 0.04 },
];

/**
 * La fracción de cada euro ahorrado que el cliente conserva COMO MÍNIMO.
 * Derivada del tramo más caro — no es una constante aparte que pueda divergir:
 * si la tarifa cambia, la garantía publicada cambia con ella, sola.
 */
export const GARANTIA_NETA_RATIO = 1 - Math.max(...TRAMOS.map((t) => t.tipo));

export interface TramoAplicado {
  desdeEur: number;
  hastaEur: number;
  tipo: number;
  baseEur: number;
  comisionEur: number;
}

/** Comisión marginal por tramos (SIN rampa): cada tramo cobra su tipo. */
export function comisionPorTramos(ahorroEur: number): { totalEur: number; tramos: TramoAplicado[] } {
  const tramos: TramoAplicado[] = [];
  let restante = Math.max(0, ahorroEur);
  let desde = 0;
  let total = 0;
  for (const t of TRAMOS) {
    if (restante <= 0) break;
    const anchura = t.hastaEur - desde;
    const base = Math.min(restante, anchura);
    const comision = base * t.tipo;
    tramos.push({ desdeEur: desde, hastaEur: t.hastaEur, tipo: t.tipo, baseEur: base, comisionEur: comision });
    total += comision;
    restante -= base;
    desde = t.hastaEur;
  }
  return { totalEur: total, tramos };
}

export interface ComisionCalculada {
  /** Base medida del período (lo que habría costado sin la capa), EUR. */
  baseMedidaEur: number;
  /** Ahorro medido del período, EUR. */
  ahorroMedidoEur: number;
  /** ahorroMedido / baseMedida, o 0 si la base es 0. Informativo. */
  ratio: number;
  /** Desglose marginal (lo que enseña el extracto). */
  tramos: TramoAplicado[];
  /** La comisión del período: los tramos, sin más. 0 solo si el ahorro es 0. */
  comisionEur: number;
  /** Ahorro que le queda al cliente tras la comisión, EUR. */
  netoClienteEur: number;
}

/**
 * La comisión de un período: tramos marginales sobre el ahorro medido, desde
 * el primer euro. Redondeada a céntimos (half-up), porque es una cifra de
 * factura.
 */
export function calcularComision(baseMedidaEur: number, ahorroMedidoEur: number): ComisionCalculada {
  const base = Math.max(0, baseMedidaEur);
  const ahorro = Math.max(0, ahorroMedidoEur);
  const ratio = base > 0 ? ahorro / base : 0;
  const { totalEur, tramos } = comisionPorTramos(ahorro);
  const comision = redondearCentimos(totalEur);
  return {
    baseMedidaEur: base,
    ahorroMedidoEur: ahorro,
    ratio,
    tramos,
    comisionEur: comision,
    netoClienteEur: redondearCentimos(ahorro - comision),
  };
}

export function redondearCentimos(eur: number): number {
  return Math.round(eur * 100) / 100;
}

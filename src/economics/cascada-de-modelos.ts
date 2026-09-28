// LA CASCADA DE MODELOS: mandar la petición al modelo BARATO, verificar la
// respuesta con una verja DETERMINISTA, y escalar al FUERTE solo si la verja la
// rechaza.
//
// Es la única palanca de la capa que multiplica la factura ENTERA. Todas las
// demás tocan un solo eje —quitan tokens de entrada, evitan una llamada,
// abaratan un prefijo—; ésta cambia el PRECIO POR TOKEN en los dos lados a la
// vez, entrada y salida.
//
// ── LA ARITMÉTICA, Y ES LA QUE MANDA ───────────────────────────────────────
//
// Normalizando a coste(fuerte) = 1 sobre el tráfico que de verdad se enruta:
//
//     aceptada  (prob 1−P)   cuesta  r          r = coste(barato)/coste(fuerte)
//     escalada  (prob P)     cuesta  r + 1      (se pagan las DOS llamadas)
//     esperado               =       r + P
//     ahorro                 =   1 − r − P
//     equilibrio             =   P > 1 − r      ← por encima PIERDE dinero
//
// Con los precios de `pricing/catalogo.ts` (comprobado en
// `test/cascada-de-modelos.test.ts`, que DERIVA la tabla en vez de copiarla):
//
//     gpt-4o        → gpt-4o-mini         r=0,060   equilibrio 94,0%
//     gpt-4.1       → gpt-4.1-mini        r=0,200   equilibrio 80,0%
//     claude-opus-4 → claude-haiku-4-5    r=0,067   equilibrio 93,3%
//     claude-sonnet-4 → claude-haiku-4-5  r=0,333   equilibrio 66,7%
//     gpt-4o-mini   → gpt-4.1-nano        r=0,667   NO VIABLE
//     claude-haiku-4-5 → claude-3-5-haiku r=0,800   NO VIABLE
//
// ── POR QUÉ EL VERIFICADOR TIENE QUE SER DETERMINISTA ──────────────────────
//
// No es una preferencia de diseño: con un juez que cueste dinero la palanca DEJA
// DE EXISTIR. Si el juez es un LLM barato del mismo tramo que el modelo barato,
// se paga r de más en cada petición y el objetivo pasa a `captura = 0,5 − 2r`;
// si el juez es el modelo FUERTE, el coste es `r + 1 + P > 1` — o sea que
// verificar cuesta más que no haber enrutado, SIEMPRE y para cualquier P. La
// verja de esta cascada es por tanto local, barata y sin red: esquema, límites
// de VALOR del contrato y unas cuantas comprobaciones que no llaman a nadie
// (ver `constraints/verificador-de-cascada.ts`).
//
// ── LO QUE ESTA VERJA NO PUEDE ATRAPAR, Y HAY QUE LEERLO ANTES DE ENCENDER ──
//
// Fíjese en los equilibrios de la tabla: 94%, 93%, 80%. Con un par bueno hay que
// escalar CASI SIEMPRE para que enrutar pierda dinero. Eso suena tranquilizador
// y es justo lo contrario: significa que el apagado automático de más abajo casi
// nunca va a dispararse, y por tanto que NO ES una red de calidad. Es una verja
// de DINERO, y solo eso.
//
// El fallo que ninguna verja cubre son los FALSOS VÁLIDOS: una respuesta del
// modelo barato con JSON impecable y contenido equivocado. Baja P, sube el
// ahorro reportado, y el apagado automático no salta porque vigila P y P se ve
// estupenda. Su firma es idéntica a la del éxito. No se resuelve con código:
// está documentado en la superficie pública (`ModelCascadeReport`) y en la traza,
// y por eso este módulo NO publica jamás una «tasa de aceptación» — publica la
// tasa de ESCALADO, que es una cifra de dinero y no de calidad.

import type { CostModel } from "../tokenizer/accounting.js";
import { precioDeLista } from "../pricing/catalogo.js";

/**
 * Fracción de la factura que se pretende capturar sobre el tráfico enrutado.
 *
 * NO es el equilibrio (`1 − r`, donde enrutar empieza a perder dinero) sino el
 * listón de producto: un par que ni con CERO escalados llegara a este ahorro no
 * merece el riesgo de calidad que se corre a cambio. De aquí sale la columna
 * «Pmax» y de aquí sale que `gpt-4o-mini → gpt-4.1-nano` (r=0,667) se descarte:
 * su Pmax es negativo, o sea que el par no llega al objetivo ni en el mejor caso
 * imaginable.
 */
export const CAPTURA_OBJETIVO = 0.5;

/** Mezcla de tokens de una petición. Es lo que hace que `r` no sea un escalar. */
export interface MezclaDeTokens {
  entrada: number;
  salida: number;
}

/**
 * `r` sobre una mezcla concreta de tokens.
 *
 * Casi todos los pares del catálogo tienen la MISMA razón en entrada y en salida
 * (gpt-4o → gpt-4o-mini es 0,060 en los dos ejes), y con eso `r` sale igual para
 * cualquier mezcla. Pero no es una ley: `gpt-4 → gpt-4o` vale 0,083 en entrada y
 * 0,167 en salida, así que su `r` va de 0,084 a 0,163 según cuánto escriba el
 * modelo. Por eso esto toma una mezcla y no dos precios.
 *
 * Devuelve `null` cuando el modelo fuerte sale gratis en esa mezcla: dividir
 * daría infinito y una razón sin denominador no es una razón.
 */
export function razonDeCoste(
  mezcla: MezclaDeTokens,
  barato: CostModel,
  fuerte: CostModel,
): number | null {
  const entrada = Math.max(0, mezcla.entrada);
  const salida = Math.max(0, mezcla.salida);
  const costeFuerte = (entrada / 1000) * fuerte.inputPer1k + (salida / 1000) * fuerte.outputPer1k;
  if (costeFuerte <= 0) return null;
  const costeBarato = (entrada / 1000) * barato.inputPer1k + (salida / 1000) * barato.outputPer1k;
  return costeBarato / costeFuerte;
}

/**
 * `r` en el PEOR CASO sobre cualquier mezcla posible: el mayor de los dos ejes.
 *
 * Es la cifra con la que decide la verja, y tiene que ser una cota de verdad por
 * el mismo motivo que `peorCasoDeEsquemas` en schema-on-demand: si la cuenta con
 * la que se aprueba un par se queda corta, la verja aprueba peticiones que
 * pierden dinero. `razonDeCoste` es una media ponderada de los dos ejes, así que
 * nunca puede superar al mayor de ellos — la cota es exacta, no un margen
 * inventado.
 *
 * La mezcla sí manda para lo que se PUBLICA (el ahorro estimado de esta
 * petición): ahí la cifra honesta es la de la petición real, no la del peor caso.
 */
export function razonPeorCaso(barato: CostModel, fuerte: CostModel): number | null {
  if (fuerte.inputPer1k <= 0 || fuerte.outputPer1k <= 0) return null;
  return Math.max(barato.inputPer1k / fuerte.inputPer1k, barato.outputPer1k / fuerte.outputPer1k);
}

/** P(escalar) por encima de la cual enrutar cuesta MÁS que no haber enrutado. */
export function equilibrioDeEscalado(r: number): number {
  return 1 - r;
}

/**
 * P(escalar) máxima compatible con capturar `captura` sobre el tráfico enrutado.
 * Negativa = el par no llega al objetivo ni escalando cero veces.
 */
export function escaladoMaximo(r: number, captura = CAPTURA_OBJETIVO): number {
  return captura - r;
}

/** La economía completa de un par, toda derivada de `r`. */
export interface EconomiaDelPar {
  /** Peor caso sobre cualquier mezcla; es con el que se decide. */
  r: number;
  /** `1 − r`. Por encima, enrutar pierde dinero. */
  equilibrio: number;
  /** `CAPTURA_OBJETIVO − r`. Negativo = par descartado. */
  escaladoMaximo: number;
  /** Si el par merece existir: `escaladoMaximo > 0`. */
  viable: boolean;
  razon: string;
}

/**
 * ¿Merece la pena este par? Todo sale del catálogo o de los precios del cliente;
 * nada está escrito a mano, así que un par NUEVO calcula su propio veredicto sin
 * tocar este fichero.
 *
 * `null` cuando no se conoce el precio de alguno de los dos: sin precio no hay
 * aritmética, y enrutar «a ver qué pasa» es apostar con dinero ajeno.
 */
export function economiaDelPar(
  precioBarato: CostModel | undefined,
  precioFuerte: CostModel | undefined,
  captura = CAPTURA_OBJETIVO,
): EconomiaDelPar | null {
  if (!precioBarato || !precioFuerte) return null;
  const r = razonPeorCaso(precioBarato, precioFuerte);
  if (r == null || !Number.isFinite(r)) return null;

  const equilibrio = equilibrioDeEscalado(r);
  const maximo = escaladoMaximo(r, captura);
  const viable = maximo > 0;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  return {
    r,
    equilibrio,
    escaladoMaximo: maximo,
    viable,
    razon: viable
      ? `the cheap model costs ${pct(r)} of the strong one, so routing pays off while ` +
        `escalations stay under ${pct(maximo)} (it stops saving money at ${pct(equilibrio)})`
      : `the cheap model costs ${pct(r)} of the strong one: even with zero escalations it ` +
        `cannot reach the ${pct(captura)} target, so this pair is not worth the quality risk`,
  };
}

/**
 * PARES POR DEFECTO, fuerte → barato.
 *
 * Solo dentro de la MISMA familia y el mismo proveedor, y no es purismo: el
 * adaptador de proveedor es uno, con una credencial y un dialecto. Enrutar de
 * Anthropic a OpenAI no es una decisión de coste, es cambiar de integración a
 * espaldas del llamante.
 *
 * Todos son viables con los precios del catálogo, y `test/cascada-de-modelos.test.ts`
 * lo COMPRUEBA derivándolo — si mañana un precio cambia y un par deja de valer la
 * pena, el test se pone rojo en vez de que la tabla mienta en silencio.
 *
 * Lo que NO está aquí importa igual: `gpt-4o-mini`, `gpt-4.1-nano` y
 * `claude-haiku-4-5` no aparecen como CLAVE. Ya son el suelo de su familia; por
 * debajo no queda nada barato que justifique el riesgo (r=0,667 y r=0,800 dan
 * Pmax negativo). Y `claude-3-opus` tampoco: su par era `claude-3-haiku`, que
 * Anthropic retiró del API el 2026-04-20 y ya no tiene fila en el catálogo;
 * enrutar a un modelo retirado no ahorra, falla.
 */
export const PARES_POR_DEFECTO: Readonly<Record<string, string>> = {
  "gpt-4": "gpt-4o",
  "gpt-4-turbo": "gpt-4o-mini",
  "gpt-4o": "gpt-4o-mini",
  // `mini` y no `nano` a propósito: los dos son viables (r=0,200 y r=0,050), y
  // entre dos pares que ahorran se elige el que menos distancia de capacidad
  // mete. Quien quiera nano lo declara en `modelCascade.pairs`.
  "gpt-4.1": "gpt-4.1-mini",
  "claude-opus-4": "claude-haiku-4-5",
  "claude-sonnet-4": "claude-haiku-4-5",
  "claude-3-5-sonnet": "claude-3-5-haiku",
};

/** Claves más largas primero, para que gane el prefijo más específico. */
function clavesPorLongitud(tabla: Readonly<Record<string, string>>): string[] {
  return Object.keys(tabla).sort((a, b) => (b.length - a.length) || a.localeCompare(b));
}

/**
 * El modelo barato que le toca a `model`, conservando su prefijo de proveedor.
 *
 * Devuelve el barato CON el prefijo del llamante (`openai/gpt-4o-mini`), porque
 * es lo que su adaptador sabe resolver.
 *
 * EL PREFIJO SOLO CASA CON INSTANTÁNEAS FECHADAS —guion, y después un AÑO— y
 * eso es más estricto que `precioDeLista`, que admite cualquier separador y
 * cualquier resto. Aquí la regla laxa hace dos destrozos que allí no:
 *
 *   · `gpt-4o-mini` empieza por `gpt-4o`, así que heredaría su par y saldría
 *     `gpt-4o-mini → gpt-4o-mini`: un modelo enrutado A SÍ MISMO.
 *   · `gpt-4.1-nano` empieza por `gpt-4`, y con el punto como separador saldría
 *     `gpt-4.1-nano → gpt-4o`: un nano enrutado a un modelo VEINTICINCO VECES
 *     más caro. Eso ya no es ahorro no capturado, es factura de más.
 *
 * Un sello de instantánea empieza por un año (`2024-08-06`, `20250929`); un
 * sufijo de tamaño o de versión menor, no. Lo que no case aquí simplemente no se
 * enruta, y no enrutar nunca cuesta dinero: los dos errores no valen lo mismo.
 *
 * El orden de recorrido es por longitud y después alfabético: dos claves de la
 * misma longitud no pueden depender del orden de inserción del objeto.
 */
export function modeloBarato(
  model: string,
  tabla: Readonly<Record<string, string>> = PARES_POR_DEFECTO,
): string | null {
  if (!model) return null;
  const barra = model.lastIndexOf("/");
  const prefijo = barra >= 0 ? model.slice(0, barra + 1) : "";
  const desnudo = barra >= 0 ? model.slice(barra + 1) : model;

  const elegido = tabla[model] ?? tabla[desnudo] ?? porInstantanea(desnudo, tabla);
  // Nadie se enruta a sí mismo. Es una invariante, no una comprobación
  // defensiva: una tabla escrita a mano puede declararlo, y "ahorrar" cambiando
  // un modelo por él mismo no es un caso raro sino una cuenta que da cero.
  if (!elegido || elegido === desnudo) return null;
  return prefijo + elegido;
}

/** El par de `gpt-4o-2024-08-06` es el de `gpt-4o`; el de `gpt-4o-mini`, no. */
function porInstantanea(
  desnudo: string,
  tabla: Readonly<Record<string, string>>,
): string | undefined {
  for (const clave of clavesPorLongitud(tabla)) {
    if (!desnudo.startsWith(clave)) continue;
    if (desnudo.charAt(clave.length) !== "-") continue;
    // Cuatro dígitos = un año. Menos que eso es una versión menor
    // (`claude-sonnet-4-5`), que es OTRO modelo y no hereda nada.
    if (/^\d{4}/.test(desnudo.slice(clave.length + 1))) return tabla[clave]!;
  }
  return undefined;
}

/**
 * La tabla de go/no-go entera, DERIVADA de los precios que se le pasen.
 *
 * Existe para que un par nuevo calcule su propio veredicto y para que el test
 * pueda comprobar la tabla contra el catálogo en vez de contra una copia. El
 * `precio` por defecto es el catálogo de lista; un cliente con tarifas
 * negociadas pasa las suyas y la tabla cambia con ellas.
 */
export function tablaDePares(
  tabla: Readonly<Record<string, string>> = PARES_POR_DEFECTO,
  precio: (model: string) => CostModel | undefined = precioDeLista,
  captura = CAPTURA_OBJETIVO,
): Array<{ fuerte: string; barato: string; economia: EconomiaDelPar | null }> {
  return Object.entries(tabla)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fuerte, barato]) => ({
      fuerte,
      barato,
      economia: economiaDelPar(precio(barato), precio(fuerte), captura),
    }));
}

// ── EL APAGADO AUTOMÁTICO ──────────────────────────────────────────────────

/** Contadores acumulados de un bucket concreto. */
export interface EstadoDelBucket {
  /** Peticiones que de verdad se enrutaron al barato. */
  enrutadas: number;
  /** De ésas, cuántas rechazó el verificador y hubo que escalar. */
  escaladas: number;
  /** Latch: la verja midió que enrutar pierde dinero y dejó de enrutar. */
  apagada: boolean;
}

export interface DecisionDeLaVerja {
  enrutar: boolean;
  razon: string;
  /** P(escalar) observada en este bucket, o `null` si aún no hay nada medido. */
  observada: number | null;
  muestras: number;
}

export interface OpcionesDeLaVerja {
  /**
   * Cuántas peticiones se enrutan antes de juzgar la tasa observada.
   *
   * Acota el experimento igual que en la verja de la caché de prefijo: el peor
   * caso (escalar SIEMPRE) cuesta `exploracion · r · coste(fuerte)`, porque una
   * escalada paga `r + 1` en vez de `1`. Con gpt-4o → gpt-4o-mini y 20 peticiones
   * son 20·0,06 = 1,2 peticiones equivalentes de más, UNA vez por bucket y por
   * instancia. Ése es el precio de saber; la alternativa es no medir nunca.
   *
   * Más alto que en la caché de prefijo (8) porque aquí se estima una
   * PROPORCIÓN: con 8 muestras el error de muestreo es del orden del propio
   * umbral, y una verja que se apaga por ruido es una verja rota.
   */
  exploracion?: number;
}

/**
 * Verja con memoria, POR BUCKET.
 *
 * Por bucket y no global, y es la diferencia entre medir y engañarse: una
 * P(escalar) media del 20% puede ser «un tipo de petición escala siempre y otro
 * nunca», y enrutar el primero es tirar dinero mientras el promedio dice que
 * todo va bien.
 *
 * En memoria y por instancia, con el mismo razonamiento que
 * `VerjaDeCacheDePrefijo`: un contador compartido entre procesos se aprendería
 * una vez para todo el despliegue, pero exigiría almacenamiento, y una verja que
 * se cae porque Redis no responde es peor que una que reaprende. El coste de
 * reaprender está acotado arriba.
 */
export class VerjaDeCascada {
  private readonly exploracion: number;
  private readonly estados = new Map<string, EstadoDelBucket>();

  constructor(opts: OpcionesDeLaVerja = {}) {
    this.exploracion = Math.max(1, opts.exploracion ?? 20);
  }

  /** Coste máximo de explorar un bucket, en peticiones equivalentes al fuerte. */
  costeDeExploracion(r: number): number {
    return this.exploracion * Math.max(0, r);
  }

  estado(bucket: string): EstadoDelBucket | undefined {
    return this.estados.get(bucket);
  }

  decidir(bucket: string, economia: EconomiaDelPar): DecisionDeLaVerja {
    const st = this.estados.get(bucket);
    const observada = tasaObservada(st);
    const muestras = st?.enrutadas ?? 0;
    const pct = (x: number | null): string => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);

    if (st?.apagada) {
      return {
        enrutar: false,
        razon:
          `model cascade OFF for this workload: measured escalation rate ${pct(observada)} is at or ` +
          `above the ${pct(economia.equilibrio)} break-even, so routing was costing money`,
        observada,
        muestras,
      };
    }

    if (muestras < this.exploracion) {
      return {
        enrutar: true,
        razon:
          `measuring this workload (${muestras}/${this.exploracion}); the escalation rate is only ` +
          `observable on requests that were actually routed`,
        observada,
        muestras,
      };
    }

    // Ya hay medición suficiente: manda ella, no la esperanza.
    if (observada != null && observada < economia.equilibrio) {
      return {
        enrutar: true,
        razon:
          `measured escalation rate ${pct(observada)} stays under the ${pct(economia.equilibrio)} ` +
          `break-even (this is a MONEY check, not a quality one)`,
        observada,
        muestras,
      };
    }
    // El latch se enciende AQUÍ y no se apaga solo. Reabrirlo cada N peticiones
    // sería volver a pagar la exploración de un bucket que ya demostró no salir
    // a cuenta; quien crea que su tráfico cambió reinicia el proceso o lo declara.
    if (st) st.apagada = true;
    return {
      enrutar: false,
      razon:
        `model cascade OFF for this workload: measured escalation rate ${pct(observada)} is at or ` +
        `above the ${pct(economia.equilibrio)} break-even, so routing was costing money`,
      observada,
      muestras,
    };
  }

  /**
   * Apunta el desenlace de una petición ENRUTADA (o de una muestra de sombra,
   * que es lo mismo: el modelo barato contestó y la verja la juzgó).
   *
   * Solo debe llamarse cuando el modelo barato de verdad respondió y el
   * verificador de verdad opinó. Apuntar una petición que nunca se enrutó
   * contaminaría la tasa con casos que no son sobre ella — el mismo error que
   * `VerjaDeCacheDePrefijo.registrar` documenta para los aciertos de prefijo.
   */
  registrar(bucket: string, escalo: boolean): void {
    const st = this.estados.get(bucket) ?? { enrutadas: 0, escaladas: 0, apagada: false };
    st.enrutadas += 1;
    if (escalo) st.escaladas += 1;
    this.estados.set(bucket, st);
  }
}

/**
 * P(escalar) observada: escaladas / enrutadas.
 *
 * En PETICIONES, no en tokens, y aquí sí es lo correcto: la aritmética de la
 * cascada es por petición (`r + P`), no por token. Es la diferencia con la verja
 * de prefijo, donde lo que decide el dinero es qué fracción de los TOKENS se
 * sirvió barata.
 */
function tasaObservada(st: EstadoDelBucket | undefined): number | null {
  if (!st || st.enrutadas <= 0) return null;
  return st.escaladas / st.enrutadas;
}

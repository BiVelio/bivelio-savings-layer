// La verja que impide que marcar la caché de prefijo CUESTE dinero.
//
// Marcar no es gratis. Anthropic cobra la ESCRITURA de la caché a 1,25x el
// precio normal de entrada y la LECTURA a 0,10x. O sea que marcar un prefijo de
// P tokens sale a cuenta sólo si la tasa de aciertos h cumple
//
//     h·0,10 + (1−h)·1,25  <  1
//     0,10h + 1,25 − 1,25h <  1
//     −1,15h               <  −0,25
//     h                    >  0,25 / 1,15  =  0,2173913…
//
// POR DEBAJO DE ~21,7% DE ACIERTO, MARCAR LA CACHÉ PIERDE DINERO. Comprobado
// numéricamente contra `costeEsperado` en `test/verja-de-cache-de-prefijo.test.ts`,
// no sólo derivado a mano.
//
// El umbral NO se reimplementa aquí: sale de `equilibrioPrefixHitRate`, que ya
// resuelve exactamente esta pregunta con otro nombre. La equivalencia no es una
// coincidencia y conviene entenderla, porque es lo que permite reutilizar el
// módulo en vez de duplicar la aritmética en dos sitios que luego divergen:
//
//     NO marcar  ==  "comprimir a la MISMA talla"
//
// Las dos cosas dejan el prompt igual de largo y renuncian al prefijo cacheable.
// Así que `decidirCompresion({original: T, compressed: T, prefijo: P})` compara
// literalmente marcar contra no marcar, y su equilibrio en h es el nuestro.
//
// LO QUE ESTA VERJA NO PUEDE SABER, y de ahí su forma: h no se puede estimar
// antes de marcar. El proveedor sólo reporta `cache_read_input_tokens` de un
// prefijo que YA se marcó, así que preguntarse "¿acertará?" sin marcar nunca es
// un huevo y una gallina. La salida es explorar un poco y medir: se marca un
// número ACOTADO de peticiones, se lee la tasa real, y si no llega al umbral se
// deja de marcar. El coste máximo de esa exploración está acotado y se publica
// (`costeDeExploracion`), que es la diferencia entre una apuesta y un experimento.
//
// EL PREFIJO QUE NO SE REPITE NUNCA, y por qué hay un segundo contador. La
// exploración se cuenta POR HUELLA del prefijo, y la huella lleva su texto. Un
// `system` con la fecha y la hora de cada petición (o un UUID, o un epoch) da una
// huella nueva en cada llamada: todas empezaban en «0/8», todas se marcaban y
// ninguna podía acertar. Medido con un proveedor falso en la 1.2.3: 60 de 60
// peticiones marcadas, 0 lecturas, +21,6 % de factura frente a no llevar capa.
// La exploración «acotada» no lo estaba.
//
// Por eso la verja lleva además un contador POR CLASE (modelo + herramientas +
// forma del prefijo, sin su texto), que contesta otra pregunta: «un prefijo que
// esta instancia no ha visto nunca, ¿llega a leerse?». Solo apuntan en él las
// peticiones marcadas de huellas que TODAVÍA no han leído nada; una huella que
// ya acierta deja de contar, así que un prefijo estable con mucho tráfico no
// tapa a otro que cambia en cada petición. Cuando esa tasa no llega al
// equilibrio, las huellas NUEVAS de la clase dejan de marcarse. Tres salidas,
// las tres con coste acotado:
//
//   1. Una huella que la instancia YA VIO (aunque no la marcara) se explora
//      como siempre desde su segunda petición. Ver repetirse un prefijo es
//      gratis —se compara en local— y es justo la prueba que faltaba. Un
//      prefijo estable que comparte clase con uno que cambia pierde una lectura,
//      una vez.
//   2. Una huella con contador propio decide con el suyo, como hasta ahora.
//   3. Cada cierto número de peticiones sin marcar se vuelve a probar con una
//      ráfaga de `exploracion` marcas; el intervalo se dobla en cada intento
//      fallido (64, 128, … hasta 1024), así que el sobrecoste de reintentar
//      tiende a cero en vez de ser un porcentaje fijo.

import {
  costeEsperado,
  equilibrioPrefixHitRate,
  type CacheTier,
} from "./cache-tier.js";

/** Lo que hace falta saber del prompt de ESTA petición para decidir. */
export interface EntradaDeMarcado {
  /** Tokens del prompt completo que se va a enviar. */
  totalTokens: number;
  /** Tokens del prefijo que el pipeline afirma estable byte a byte. */
  stablePrefixTokens: number;
  tier: CacheTier;
}

export interface DecisionDeMarcado {
  marcar: boolean;
  /** Motivo publicable en la traza. Nunca vacío. */
  razon: string;
  /** Tasa de aciertos a partir de la cual marcar compensa; `null` si no puede perder. */
  umbral: number | null;
  /** Tasa observada hasta ahora, o `null` si aún no hay nada medido. */
  observada: number | null;
}

/** Contadores acumulados de un prefijo concreto. */
export interface EstadoDelPrefijo {
  /** Peticiones enviadas CON marca. */
  marcadas: number;
  /** `cache_read_input_tokens` acumulado. Es el descuento. */
  tokensLeidos: number;
  /** `cache_creation_input_tokens` acumulado. Es la PRIMA, no el descuento. */
  tokensEscritos: number;
  /** Latch: la verja decidió que no compensa y dejó de marcar. */
  apagada: boolean;
}

export interface OpcionesDeVerja {
  /**
   * Cuántas peticiones se marcan a ciegas antes de juzgar la tasa observada.
   *
   * No es un número mágico: acota el experimento. Con el peor caso posible
   * (h = 0, nunca acierta) el coste de descubrirlo es
   *
   *     exploracion · (writeMultiplier − 1) · tokensPrefijo
   *
   * — con Anthropic, 8 · 0,25 · P = 2·P tokens equivalentes. Sobre un prefijo de
   * 1.000 tokens son 2.000 tokens de más, UNA vez por prefijo y por instancia.
   * Ese es el precio de saber, y es el único camino: la alternativa es no marcar
   * nunca y renunciar al 90% de descuento por si acaso.
   */
  exploracion?: number;
  /**
   * Cuántas huellas (y cuántas clases) se recuerdan como mucho. Con un prefijo
   * que cambia en cada petición el mapa crecía una entrada por llamada, sin
   * techo. Al llenarse se olvida la que lleva más tiempo sin usarse; olvidar
   * una huella apagada solo permite volver a explorarla, con el coste de arriba.
   */
  maxHuellas?: number;
  /** Peticiones sin marcar antes del primer reintento de una clase apagada. Se dobla en cada intento. */
  reintentoTras?: number;
}

/** Contadores de una CLASE: lo que pasó con las huellas que aún no habían leído nada. */
export interface EstadoDeLaClase {
  /** Peticiones marcadas de huellas sin lecturas previas, con algún token escrito o leído. */
  marcadas: number;
  tokensLeidos: number;
  tokensEscritos: number;
  /** Peticiones de huellas nuevas que se dejaron sin marcar desde el último reintento. */
  sinMarcar: number;
  /** Cuántas sin marcar hacen falta para el próximo reintento. */
  intervalo: number;
  /** Marcas que quedan de la ráfaga de reintento en curso. */
  sonda: number;
}

/** A partir de cuántas muestras se envejece el contador de una clase (se parte por dos). */
const VENTANA_DE_CLASE = 32;
const REINTENTO_MAXIMO = 1024;

/**
 * La tasa de aciertos a partir de la cual marcar la caché compensa.
 *
 * `null` significa que marcar NO PUEDE perder dinero en este tramo — con una
 * escritura que no lleva prima (OpenAI cobra 1x), o con un prompt por debajo del
 * mínimo, donde marcar simplemente no hace nada.
 */
export function umbralDeMarcado(e: EntradaDeMarcado): number | null {
  const h = equilibrioPrefixHitRate({
    originalTokens: e.totalTokens,
    compressedTokens: e.totalTokens, // no marcar == mismo tamaño, sin prefijo cacheable
    stablePrefixTokens: e.stablePrefixTokens,
    tier: e.tier,
  });
  if (h != null) return h;

  // `equilibrioPrefixHitRate` devuelve `null` en dos casos opuestos y no dice
  // cuál. Se desambigua midiendo el peor caso directamente en vez de razonar
  // sobre el signo: si marcando EN FRÍO ya no se paga de más, no hay umbral que
  // superar. Una comprobación de cuatro líneas contra una deducción que se
  // rompería el día que alguien invente un tramo con lectura por encima de 1.
  const enFrio = costeEsperado(e.totalTokens, e.stablePrefixTokens, 0, e.tier);
  return enFrio <= e.totalTokens ? null : 1;
}

/**
 * Verja con memoria: decide si marcar el prefijo de esta petición y aprende de
 * lo que el proveedor conteste.
 *
 * Es por instancia y en memoria a propósito. Un contador compartido entre
 * procesos sería mejor —se aprendería una vez para todo el despliegue— pero
 * exigiría almacenamiento, y una verja que se cae porque Redis no responde es
 * peor que una que reaprende. El coste de reaprender está acotado arriba.
 */
export class VerjaDeCacheDePrefijo {
  private readonly exploracion: number;
  private readonly maxHuellas: number;
  private readonly reintentoTras: number;
  private readonly estados = new Map<string, EstadoDelPrefijo>();
  private readonly clases = new Map<string, EstadoDeLaClase>();
  /** Huellas que pasaron sin marcar con su clase apagada: si vuelven, se exploran. */
  private readonly vistas = new Set<string>();

  constructor(opts: OpcionesDeVerja = {}) {
    this.exploracion = Math.max(1, opts.exploracion ?? 8);
    this.maxHuellas = Math.max(1, opts.maxHuellas ?? 4096);
    this.reintentoTras = Math.max(1, opts.reintentoTras ?? 64);
  }

  /** Coste máximo, en tokens equivalentes, de explorar un prefijo de este tamaño. */
  costeDeExploracion(stablePrefixTokens: number, tier: CacheTier): number {
    return this.exploracion * Math.max(0, tier.cacheWriteMultiplier - 1) * stablePrefixTokens;
  }

  estado(huella: string): EstadoDelPrefijo | undefined {
    return this.estados.get(huella);
  }

  estadoDeLaClase(clase: string): EstadoDeLaClase | undefined {
    return this.clases.get(clase);
  }

  /** Cuántas huellas recuerda (con contador propio + vistas sin marcar). Acotado por `maxHuellas` cada uno. */
  get huellasRecordadas(): number {
    return this.estados.size + this.vistas.size;
  }

  /**
   * `clase` es opcional y la pasa quien decide por una llave que lleva el TEXTO
   * del prefijo (la colocación fija, y el colocador, cuya clase del espejo
   * incluye el `system`). Una llave que ya es estable —el catálogo de
   * herramientas— no la necesita y decide exactamente como antes.
   */
  decidir(huella: string, e: EntradaDeMarcado, clase?: string): DecisionDeMarcado {
    const umbral = umbralDeMarcado(e);
    const st = this.estados.get(huella);
    const observada = tasaObservada(st);

    // ESTA COMPROBACIÓN VA LA PRIMERA, y el orden importa: sin prefijo el umbral
    // sale `null` («marcar no puede perder dinero», que es cierto — no cuesta
    // nada marcar la nada) y la verja contestaría `marcar: true`. No perdería un
    // céntimo, pero afirmaría en la traza un prefijo estable que no existe y
    // haría al adaptador colocar un punto de ruptura para cero tokens. Un
    // informe que dice «marcado» donde no había nada que marcar es exactamente
    // el tipo de cifra que no se puede publicar.
    if (e.stablePrefixTokens <= 0) {
      return { marcar: false, razon: "no stable prefix to cache", umbral, observada };
    }

    // Sin prima de escritura marcar no puede salir caro: se marca siempre y no
    // hace falta ni explorar. Es el caso de OpenAI, donde además la caché es
    // automática y esto sólo afecta a lo que el adaptador declara.
    if (umbral == null) {
      return {
        marcar: true,
        razon: "marking cannot lose money at this tier (no write premium)",
        umbral,
        observada,
      };
    }

    if (st?.apagada) {
      return {
        marcar: false,
        razon:
          `prefix-cache marking OFF: measured hit rate ${pct(observada)} did not reach the ` +
          `${pct(umbral)} break-even, so marking was costing money`,
        umbral,
        observada,
      };
    }

    // LA HUELLA NUEVA EN UNA CLASE CUYAS HUELLAS NUEVAS NO SE LEEN. Solo aquí
    // manda la clase: con contador propio (`st`), decide el suyo.
    let repetida = false;
    if (st == null && clase != null) {
      const c = this.clases.get(clase);
      const deLaClase = c ? tasaObservada(c) : null;
      if (c && c.marcadas >= this.exploracion && deLaClase != null && deLaClase <= umbral) {
        if (this.vistas.has(huella)) {
          repetida = true;
        } else if (c.sonda > 0) {
          c.sonda -= 1;
          return {
            marcar: true,
            razon:
              `re-probing the prefix cache (${this.exploracion - c.sonda}/${this.exploracion}): new prefixes of ` +
              `this shape were not being read back (${pct(deLaClase)}, break-even ${pct(umbral)}), checking again`,
            umbral,
            observada: deLaClase,
          };
        } else {
          this.recordarVista(huella);
          const faltan = Math.max(0, c.intervalo - c.sinMarcar - 1);
          c.sinMarcar += 1;
          if (c.sinMarcar >= c.intervalo) {
            c.sinMarcar = 0;
            c.sonda = this.exploracion;
            c.intervalo = Math.min(REINTENTO_MAXIMO, c.intervalo * 2);
          }
          return {
            marcar: false,
            razon:
              `prefix-cache marking OFF for prefixes not seen before: the prefix differs on every request ` +
              `(new prefixes hit ${pct(deLaClase)}, break-even ${pct(umbral)}), so writing it was costing money. ` +
              `A prefix that is sent again is marked from its second request; re-probing in ${faltan} requests`,
            umbral,
            observada: deLaClase,
          };
        }
      } else if (c && deLaClase != null && deLaClase > umbral) {
        // Las huellas nuevas vuelven a leerse: el próximo apagón empieza de cero.
        c.sinMarcar = 0;
        c.sonda = 0;
        c.intervalo = this.reintentoTras;
      }
    }

    if (st == null || st.marcadas < this.exploracion) {
      return {
        marcar: true,
        razon:
          (repetida ? "this exact prefix was sent before; " : "") +
          `exploring the prefix cache (${st?.marcadas ?? 0}/${this.exploracion}); ` +
          `hit rate is only observable on requests that were marked`,
        umbral,
        observada,
      };
    }

    // Ya hay medición suficiente: manda ella, no la esperanza.
    if (observada != null && observada > umbral) {
      return {
        marcar: true,
        razon: `measured hit rate ${pct(observada)} beats the ${pct(umbral)} break-even`,
        umbral,
        observada,
      };
    }
    st.apagada = true;
    return {
      marcar: false,
      razon:
        `prefix-cache marking OFF: measured hit rate ${pct(observada)} did not reach the ` +
        `${pct(umbral)} break-even, so marking was costing money`,
      umbral,
      observada,
    };
  }

  /**
   * Apunta lo que contestó el proveedor. Sólo debe llamarse con peticiones que
   * de verdad se marcaron: contar una sin marcar como "no acertó" hundiría la
   * tasa observada con peticiones que nunca tuvieron ocasión de acertar, y la
   * verja se apagaría por una medición que no es sobre ella.
   */
  registrar(
    huella: string,
    usage: { cachedInputTokens?: number; cacheWriteInputTokens?: number },
    clase?: string,
  ): void {
    const st = this.estados.get(huella) ?? {
      marcadas: 0,
      tokensLeidos: 0,
      tokensEscritos: 0,
      apagada: false,
    };
    const leidos = Math.max(0, usage.cachedInputTokens ?? 0);
    const escritos = Math.max(0, usage.cacheWriteInputTokens ?? 0);
    // LA CLASE SOLO CUENTA HUELLAS QUE AÚN NO HABÍAN LEÍDO, y solo respuestas
    // con algún token de caché. Lo primero, para que un prefijo estable (una
    // escritura, una lectura, y ya no cuenta más) no tape a otro que cambia en
    // cada petición. Lo segundo, porque sin escritura no hay prima que evitar:
    // un prefijo por debajo del mínimo del proveedor no dice nada de la clase.
    if (clase != null && st.tokensLeidos === 0 && leidos + escritos > 0) {
      const c = this.clases.get(clase) ?? {
        marcadas: 0, tokensLeidos: 0, tokensEscritos: 0, sinMarcar: 0, intervalo: this.reintentoTras, sonda: 0,
      };
      c.marcadas += 1;
      c.tokensLeidos += leidos;
      c.tokensEscritos += escritos;
      if (c.marcadas >= VENTANA_DE_CLASE) {
        // Envejecer: lo reciente pesa más, y una clase que cambia de
        // comportamiento se corrige en decenas de peticiones, no en miles.
        c.marcadas = Math.ceil(c.marcadas / 2);
        c.tokensLeidos /= 2;
        c.tokensEscritos /= 2;
      }
      this.clases.delete(clase);
      this.clases.set(clase, c);
      podar(this.clases, this.maxHuellas);
    }
    st.marcadas += 1;
    st.tokensLeidos += leidos;
    st.tokensEscritos += escritos;
    // Reinsertar deja la huella como la más reciente: se olvida la que lleva
    // más tiempo sin usarse, no la que más tráfico tiene.
    this.estados.delete(huella);
    this.estados.set(huella, st);
    this.vistas.delete(huella);
    podar(this.estados, this.maxHuellas);
  }

  private recordarVista(huella: string): void {
    this.vistas.add(huella);
    podar(this.vistas, this.maxHuellas);
  }
}

/** Quita lo más antiguo (orden de inserción) hasta caber en `max`. */
function podar(m: Map<string, unknown> | Set<string>, max: number): void {
  while (m.size > max) {
    const primera = m.keys().next();
    if (primera.done) return;
    m.delete(primera.value);
  }
}

/**
 * La tasa de aciertos, medida en TOKENS y no en peticiones.
 *
 * Contar peticiones ("¿acertó algo?") daría 100% a una que reutilizó diez tokens
 * de mil. Lo que decide el dinero es qué fracción de los tokens del prefijo se
 * sirvió barata, y ésa es exactamente la h de la desigualdad de arriba.
 */
function tasaObservada(
  st: Pick<EstadoDelPrefijo, "marcadas" | "tokensLeidos" | "tokensEscritos"> | undefined,
): number | null {
  if (!st) return null;
  const total = st.tokensLeidos + st.tokensEscritos;
  if (total <= 0) {
    // Marcado varias veces y el proveedor no reportó NI lectura NI escritura:
    // no cacheó nada (normalmente, por debajo del mínimo de tramo). Cero
    // aciertos es la lectura honesta, y hace que la verja se apague.
    return st.marcadas > 0 ? 0 : null;
  }
  return st.tokensLeidos / total;
}

function pct(x: number | null): string {
  return x == null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

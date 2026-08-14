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
}

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
  private readonly estados = new Map<string, EstadoDelPrefijo>();

  constructor(opts: OpcionesDeVerja = {}) {
    this.exploracion = Math.max(1, opts.exploracion ?? 8);
  }

  /** Coste máximo, en tokens equivalentes, de explorar un prefijo de este tamaño. */
  costeDeExploracion(stablePrefixTokens: number, tier: CacheTier): number {
    return this.exploracion * Math.max(0, tier.cacheWriteMultiplier - 1) * stablePrefixTokens;
  }

  estado(huella: string): EstadoDelPrefijo | undefined {
    return this.estados.get(huella);
  }

  decidir(huella: string, e: EntradaDeMarcado): DecisionDeMarcado {
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

    if (st == null || st.marcadas < this.exploracion) {
      return {
        marcar: true,
        razon:
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
  ): void {
    const st = this.estados.get(huella) ?? {
      marcadas: 0,
      tokensLeidos: 0,
      tokensEscritos: 0,
      apagada: false,
    };
    st.marcadas += 1;
    st.tokensLeidos += Math.max(0, usage.cachedInputTokens ?? 0);
    st.tokensEscritos += Math.max(0, usage.cacheWriteInputTokens ?? 0);
    this.estados.set(huella, st);
  }
}

/**
 * La tasa de aciertos, medida en TOKENS y no en peticiones.
 *
 * Contar peticiones ("¿acertó algo?") daría 100% a una que reutilizó diez tokens
 * de mil. Lo que decide el dinero es qué fracción de los tokens del prefijo se
 * sirvió barata, y ésa es exactamente la h de la desigualdad de arriba.
 */
function tasaObservada(st: EstadoDelPrefijo | undefined): number | null {
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

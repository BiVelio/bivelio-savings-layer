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
// LA CABECERA QUE NO VUELVE NUNCA, y por qué hay un segundo registro. La
// exploración se cuenta POR HUELLA del prefijo, y la huella lleva su texto. Un
// `system` con la hora de cada petición (o un UUID, o un id de petición) da una
// huella nueva en cada llamada: todas empezaban en «0/8», todas se marcaban y
// ninguna podía acertar. Medido con un proveedor falso en la 1.2.3: 60 de 60
// peticiones marcadas, 0 lecturas, +21,6 % de factura frente a no llevar capa.
//
// Lo que decide si una escritura se desperdicia NO es si el `system` «parece»
// llevar una hora o un UUID (la 1.2.4 lo adivinaba con un detector, y fallaba en
// los dos sentidos: un id de sesión o la fecha del día son estables, y «10:42
// AM» o un UUID v7 no los veía). Lo que decide es si la CABECERA —herramientas +
// `system`, sin historial— vuelve a llegar antes de que caduque su entrada de
// caché. Eso se puede OBSERVAR en local y gratis, sin marcar nada:
//
//   · Por CLASE (modelo servido + herramientas + modo de colocar, sin texto) se
//     recuerda cada huella de cabecera vista (LRU acotado) con su primera
//     aparición.
//   · Una cabecera MADURA cuando vuelve a llegar dentro de su TTL («se repite»)
//     o cuando, sin volver, ha pasado su TTL: 5 min, o 1 h si esa petición
//     escribe a 1 h («un solo uso»). Las que se repiten pasan a otro LRU, así
//     que un torrente de cabeceras de un solo uso no echa de la memoria a las
//     que sí vuelven.
//   · La clase entra en modo VOLÁTIL solo con evidencia fuerte: al menos
//     `minimoDeMaduras` maduras y una proporción de un solo uso de al menos
//     `umbralVolatil` entre las últimas `memoriaDeMaduras`. En modo volátil una
//     cabecera NUNCA vista no se marca; una ya vista decide como en la 1.2.3. En
//     cuanto vuelven a llegar cabeceras que se repiten, la proporción baja y la
//     clase sale del modo volátil.
//   · Fuera del modo volátil la verja decide EXACTAMENTE como en la 1.2.3.
//
// POR QUÉ SOLO EL TTL Y NO TAMBIÉN «N PETICIONES SIN VOLVER». Se probó madurar
// como de un solo uso tras N peticiones de la clase (N = 256 y 1.024): ninguna N
// distingue un solo uso de muchas conversaciones a la vez, porque la segunda
// petición de cada una llega detrás de las primeras de todas las demás. Medido
// con un proveedor falso que caduca la caché: 400 sesiones a la vez con N = 256,
// −43,5 % en la 1.2.3 y −35,4 %; 1.500 sesiones que llegan de golpe tras un rato
// tranquilo con N = 1.024, −27,4 % y −16,1 %. Con el TTL no hay confusión
// posible: una cabecera que vuelve antes de caducar nunca cuenta como de un
// solo uso. El precio es que un proceso que vive menos de un TTL no llega a
// madurar nada, y entonces marca como la 1.2.3: nunca peor.
//
// No hace falta reintentar marcando: ver si una cabecera vuelve no exige
// marcarla, así que la verja sigue observando sin gastar un céntimo.
//
// EN LA 1.2.4 LA REGLA DEL MODO VOLÁTIL ESTÁ APAGADA (`VERJA_DE_CABECERAS_ACTIVA`,
// más abajo): se observa, pero se decide exactamente como en la 1.2.3.

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
  /** El reloj, en milisegundos. Inyectable para probar el TTL sin esperar. */
  ahora?: () => number;
  /** Cabeceras maduras que hacen falta, como mínimo, para declarar volátil una clase. */
  minimoDeMaduras?: number;
  /** Proporción de un solo uso, entre las maduras recientes, a partir de la cual la clase es volátil. */
  umbralVolatil?: number;
  /** Cuántas maduras recientes se miran para esa proporción. */
  memoriaDeMaduras?: number;
}

/** La cabecera de una petición (herramientas + `system`, sin historial) y su clase (sin texto). */
export interface CabeceraDePeticion {
  /** Modelo servido + herramientas + modo de colocar. Sin texto del cliente. */
  clase: string;
  /** Huella de herramientas + `system`. */
  huella: string;
}

/** Lo que la verja sabe de la cabecera de ESTA petición al llegar. */
export interface VistazoDeCabecera {
  /** La instancia ya había visto llegar esta cabecera en su clase. */
  readonly vista: boolean;
  /** La clase está en modo volátil: casi ninguna cabecera vuelve antes de caducar. */
  readonly volatil: boolean;
  /** Proporción de un solo uso entre las maduras recientes; `null` sin maduras. */
  readonly unSoloUso: number | null;
  /** Cuántas maduras recientes hay detrás de esa proporción. */
  readonly maduras: number;
  /** Esta petición escribe con otro TTL (1 h): su cabecera tarda eso en madurar por tiempo. */
  conTtl(ms: number): void;
}

/** Lo que se publica de una clase de cabeceras (para tests y trazas). */
export interface EstadoDeCabeceras {
  peticiones: number;
  /** Cabeceras recordadas que aún no se han visto volver a tiempo. */
  pendientes: number;
  /** Cabeceras recordadas que han vuelto antes de caducar. */
  repetidas: number;
  /** Maduras recientes de un solo uso y que se repiten. */
  unSoloUso: number;
  seRepiten: number;
  volatil: boolean;
}

/** TTL por defecto de una entrada de caché de prompt (Anthropic y la mayoría): 5 minutos. */
export const TTL_DE_CACHE_MS = 5 * 60_000;

interface EntradaDeCabecera {
  /** Número de la observación que la puso a madurar (identifica su sitio en la cola). */
  id: number;
  instante: number;
  ttlMs: number;
  /** `true` mientras no haya madurado como de un solo uso. */
  pendiente: boolean;
}

interface ClaseDeCabeceras {
  peticiones: number;
  /** Vistas que aún no han vuelto a tiempo (LRU por uso). */
  pendientes: Map<string, EntradaDeCabecera>;
  /** Vistas que han vuelto antes de caducar (LRU por uso, aparte). */
  repetidas: Map<string, true>;
  /** Pendientes en orden de llegada: las primeras son las primeras en caducar. */
  cola: { huella: string; id: number }[];
  cabeza: number;
  /** Las últimas maduras: `true` = un solo uso. */
  recientes: boolean[];
}

const MAX_CLASES_DE_CABECERAS = 256;

/**
 * LA REGLA DE LA CLASE VOLÁTIL, APAGADA EN LA 1.2.4 (verificación 2): «no marcar
 * una cabecera nunca vista en una clase volátil» salía MÁS CARA que la 1.2.3 en
 * dos patrones normales, medidos con un proveedor falso que caduca la caché:
 * tráfico mixto en el mismo modelo (llamadas auxiliares diminutas con la hora +
 * chats con su system propio: de −9,8 % a +2,4 % con chats de 2 turnos) y
 * ráfagas tras un rato de sesiones sueltas (noche de 40 + 1.200 chats × 2: de
 * −26,5 % a +10,5 %). Además rompía `savings.cachePrefix` a partir de los 5
 * minutos. Con la regla apagada la verja decide EXACTAMENTE como en la 1.2.3 y
 * sigue observando las cabeceras (`observarCabecera`, `estadoDeCabeceras`), que
 * no cuesta nada. Para la 1.2.5: no observar cabeceras por debajo del mínimo
 * cacheable, meter el tamaño de la cabecera en la clase y hacer caducar la
 * evidencia de volatilidad; los tests de la regla encendida están en `it.skip`.
 */
const VERJA_DE_CABECERAS_ACTIVA: boolean = false;

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
  private readonly ahora: () => number;
  private readonly minimoDeMaduras: number;
  private readonly umbralVolatil: number;
  private readonly memoriaDeMaduras: number;
  private readonly estados = new Map<string, EstadoDelPrefijo>();
  private readonly clasesDeCabeceras = new Map<string, ClaseDeCabeceras>();

  constructor(opts: OpcionesDeVerja = {}) {
    this.exploracion = Math.max(1, opts.exploracion ?? 8);
    this.maxHuellas = Math.max(1, opts.maxHuellas ?? 4096);
    this.ahora = opts.ahora ?? (() => Date.now());
    this.minimoDeMaduras = Math.max(1, opts.minimoDeMaduras ?? 16);
    this.umbralVolatil = Math.min(1, Math.max(0, opts.umbralVolatil ?? 0.9));
    this.memoriaDeMaduras = Math.max(this.minimoDeMaduras, opts.memoriaDeMaduras ?? 32);
  }

  /** Coste máximo, en tokens equivalentes, de explorar un prefijo de este tamaño. */
  costeDeExploracion(stablePrefixTokens: number, tier: CacheTier): number {
    return this.exploracion * Math.max(0, tier.cacheWriteMultiplier - 1) * stablePrefixTokens;
  }

  estado(huella: string): EstadoDelPrefijo | undefined {
    return this.estados.get(huella);
  }

  /** Cuántas huellas de prefijo recuerda. Acotado por `maxHuellas`. */
  get huellasRecordadas(): number {
    return this.estados.size;
  }

  estadoDeCabeceras(clase: string): EstadoDeCabeceras | undefined {
    const c = this.clasesDeCabeceras.get(clase);
    if (!c) return undefined;
    const unSoloUso = c.recientes.filter(Boolean).length;
    return {
      peticiones: c.peticiones,
      pendientes: c.pendientes.size,
      repetidas: c.repetidas.size,
      unSoloUso,
      seRepiten: c.recientes.length - unSoloUso,
      volatil: this.esVolatil(c),
    };
  }

  /**
   * Apunta que ha llegado una petición con esta cabecera, y devuelve si ya se
   * había visto y si su clase está en modo volátil. Una vez por petición, antes
   * de decidir. No marca nada ni cuesta nada: es comparar huellas en local.
   */
  observarCabecera(cab: CabeceraDePeticion, ttlMs: number = TTL_DE_CACHE_MS): VistazoDeCabecera {
    const ahora = this.ahora();
    let c = this.clasesDeCabeceras.get(cab.clase);
    if (c) this.clasesDeCabeceras.delete(cab.clase);
    else c = { peticiones: 0, pendientes: new Map(), repetidas: new Map(), cola: [], cabeza: 0, recientes: [] };
    this.clasesDeCabeceras.set(cab.clase, c);
    podar(this.clasesDeCabeceras, MAX_CLASES_DE_CABECERAS);

    c.peticiones += 1;
    const id = c.peticiones;
    this.madurarPendientes(c, ahora);

    let vista = false;
    let aMadurar: EntradaDeCabecera | null = null;
    if (c.repetidas.has(cab.huella)) {
      vista = true;
      c.repetidas.delete(cab.huella);
      c.repetidas.set(cab.huella, true);
    } else {
      const e = c.pendientes.get(cab.huella);
      if (e == null) {
        aMadurar = { id, instante: ahora, ttlMs, pendiente: true };
        c.pendientes.set(cab.huella, aMadurar);
        c.cola.push({ huella: cab.huella, id });
      } else {
        vista = true;
        c.pendientes.delete(cab.huella);
        if (e.pendiente && ahora - e.instante < e.ttlMs) {
          // Ha vuelto antes de caducar: se repite, y pasa al LRU de las que vuelven.
          this.anotarMadura(c, false);
          c.repetidas.set(cab.huella, true);
          podar(c.repetidas, this.maxHuellas);
        } else {
          // Ha vuelto tarde: su escritura ya se había perdido. Cuenta como un
          // solo uso (si no lo había hecho ya) y se vuelve a observar desde ahora.
          if (e.pendiente) this.anotarMadura(c, true);
          aMadurar = { id, instante: ahora, ttlMs, pendiente: true };
          c.pendientes.set(cab.huella, aMadurar);
          c.cola.push({ huella: cab.huella, id });
        }
      }
      podar(c.pendientes, this.maxHuellas);
    }

    const recientes = c.recientes.length;
    const entrada = aMadurar;
    return {
      vista,
      volatil: this.esVolatil(c),
      unSoloUso: recientes > 0 ? c.recientes.filter(Boolean).length / recientes : null,
      maduras: recientes,
      conTtl(ms: number): void {
        if (entrada?.pendiente === true) entrada.ttlMs = Math.max(entrada.ttlMs, ms);
      },
    };
  }

  /** Madura, de la más antigua a la más nueva, las pendientes que ya han pasado su TTL sin volver. */
  private madurarPendientes(c: ClaseDeCabeceras, ahora: number): void {
    // La cola no crece sin techo: vivas solo puede haber `maxHuellas` (las del
    // LRU); lo que pase de dos veces eso se descarta por delante sin contarlo,
    // que es el lado prudente (menos evidencia, menos modo volátil).
    if (c.cola.length - c.cabeza > 2 * this.maxHuellas) c.cabeza = c.cola.length - 2 * this.maxHuellas;
    while (c.cabeza < c.cola.length) {
      const p = c.cola[c.cabeza]!;
      const e = c.pendientes.get(p.huella);
      if (e == null || !e.pendiente || e.id !== p.id) {
        c.cabeza += 1; // olvidada, ya madura o vuelta a observar: no cuenta aquí
        continue;
      }
      if (ahora - e.instante < e.ttlMs) break;
      e.pendiente = false;
      this.anotarMadura(c, true);
      c.cabeza += 1;
    }
    if (c.cabeza > 1024 && c.cabeza * 2 > c.cola.length) {
      c.cola.splice(0, c.cabeza);
      c.cabeza = 0;
    }
  }

  private anotarMadura(c: ClaseDeCabeceras, unica: boolean): void {
    c.recientes.push(unica);
    if (c.recientes.length > this.memoriaDeMaduras) c.recientes.shift();
  }

  private esVolatil(c: ClaseDeCabeceras): boolean {
    if (c.recientes.length < this.minimoDeMaduras) return false;
    return c.recientes.filter(Boolean).length / c.recientes.length >= this.umbralVolatil;
  }

  /**
   * `cabecera` es opcional y la pasa quien decide por una llave que lleva el
   * TEXTO del prefijo (la colocación fija y el colocador): es lo que
   * `observarCabecera` vio al llegar la petición. Una llave que ya es estable
   * —el catálogo de herramientas— no la necesita, y sin ella (o con la clase
   * fuera del modo volátil) se decide exactamente como en la 1.2.3.
   */
  decidir(huella: string, e: EntradaDeMarcado, cabecera?: VistazoDeCabecera): DecisionDeMarcado {
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

    // LA CABECERA NUNCA VISTA EN UNA CLASE VOLÁTIL. Solo aquí se aparta de la
    // 1.2.3, y solo en lo que no puede salir bien: escribir un prefijo cuya
    // cabecera, en esta clase, casi nunca vuelve antes de caducar.
    if (VERJA_DE_CABECERAS_ACTIVA && cabecera?.volatil === true && !cabecera.vista) {
      return {
        marcar: false,
        razon:
          `prefix-cache marking OFF for a system prompt not seen before: ${pct(cabecera.unSoloUso)} of the last ` +
          `${cabecera.maduras} system prompts of this shape were never sent again before their cache entry ` +
          "expired, so writing them was costing money. A system prompt that is sent again is marked as usual",
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
  registrar(huella: string, usage: { cachedInputTokens?: number; cacheWriteInputTokens?: number }): void {
    const st = this.estados.get(huella) ?? {
      marcadas: 0,
      tokensLeidos: 0,
      tokensEscritos: 0,
      apagada: false,
    };
    st.marcadas += 1;
    st.tokensLeidos += Math.max(0, usage.cachedInputTokens ?? 0);
    st.tokensEscritos += Math.max(0, usage.cacheWriteInputTokens ?? 0);
    // Reinsertar deja la huella como la más reciente: se olvida la que lleva
    // más tiempo sin usarse, no la que más tráfico tiene.
    this.estados.delete(huella);
    this.estados.set(huella, st);
    podar(this.estados, this.maxHuellas);
  }
}

/** Quita lo más antiguo (orden de inserción) hasta caber en `max`. */
function podar(m: Map<string, unknown>, max: number): void {
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

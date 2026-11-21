import { createHash } from "node:crypto";

import type { ModelDia, UsageRollup } from "@/app/[locale]/dashboard/data";

import { BANCO_EN_VIVO } from "./banco-en-vivo";

/**
 * EL PANEL DE LA PORTADA, ALIMENTADO SOLO CON EL BANCO PÚBLICO (2026-10-03).
 * ---------------------------------------------------------------------------
 * La imagen del héroe es una captura del panel de verdad (los componentes de
 * `app/[locale]/dashboard/`), y cada cifra que se ve en ella sale de aquí. No
 * hay ningún dato de cliente ni ninguna cifra inventada: es una organización
 * de demostración, rotulada como tal en la propia captura, cuyo único tráfico
 * es el flujo GSM8K en vivo del banco público del 2026-09-28 — el mismo de
 * `BANCO_EN_VIVO` —, con los cuatro modelos que esos dos informes midieron.
 *
 * CÓMO SE PASA DEL A/B DEL BANCO A LAS FILAS DEL PANEL (todo por modelo):
 *   · peticiones           = las del brazo B (la capa, configuración por defecto).
 *   · llamadas evitadas    = las de B servidas desde la caché exacta
 *                            (`resumen.brazos.B.fuentes.exact_cache`).
 *   · llamadas ejecutadas  = las de B que llegaron al proveedor.
 *   · coste base           = lo que costó el brazo A, el mismo flujo DIRECTO al
 *                            proveedor, medido con su contador (`costeUsd` de A).
 *   · coste real           = lo que costó B, medido igual, MÁS la parte que es
 *                            caché de prefijo del proveedor (`desglose[B]
 *                            .prefijoNetoUsd`, solo Claude Sonnet 5). El panel
 *                            enseña ese descuento APARTE y nunca en su titular
 *                            (`deriveVerdict` no lo lee), así que aquí tampoco
 *                            entra: el titular de la captura es el ahorro de la
 *                            capa sobre la factura de A, sin el del proveedor.
 *   · todo es MEDIDO: A y B se valoran con el contador del proveedor.
 *   · tokens               = los de A (base) y los de B (real), del informe.
 *
 * Los números están escritos a mano por la misma razón que en
 * `banco-en-vivo.ts` (la portada es ISR y no lee `docs/` en Vercel), y con la
 * misma verja: `panel-del-banco.test.ts` los lee de los JSON de los informes y
 * exige que coincidan, y la imagen se regenera con `scripts/captura-panel.ts`
 * desde la ruta de desarrollo que pinta estas filas.
 */

export interface ModeloDelBanco {
  /** Id del modelo en el informe. */
  modelo: string;
  /** Cómo lo guarda el panel (sin el prefijo del proveedor). */
  nombre: string;
  informe: string;
  peticiones: number;
  llamadasAlProveedor: number;
  servidasDesdeCache: number;
  /** USD del brazo A (directo al proveedor). */
  costeA: number;
  /** USD del brazo B (a través de la capa). */
  costeB: number;
  /** USD de la caché de prefijo del proveedor dentro de B (`desglose[B].prefijoNetoUsd`); 0 si no la hay. */
  prefijoDelProveedor: number;
  tokensA: { entrada: number; salida: number };
  tokensB: { entrada: number; salida: number; cacheada: number };
}

const OPENAI = BANCO_EN_VIVO.openai.informe;
const ANTHROPIC = BANCO_EN_VIVO.anthropic.informe;

export const PANEL_DEL_BANCO = {
  /** El día del panel: el de las tiradas. */
  dia: BANCO_EN_VIVO.fecha,
  bateria: BANCO_EN_VIVO.bateria,
  versionSdk: BANCO_EN_VIVO.versionSdk,
  /**
   * LA CAPTURA SE HACE EN DOS IDIOMAS (auditoría m10, 2026-11-21). Hasta
   * entonces solo había una, en español, y la portada la servía en los doce
   * idiomas («Lo que ahorró Savings…», «Cerrar sesión»). Ahora la española la
   * ven `es` y `ca`, y la inglesa los otros diez (`idiomaDeLaCaptura`). Las
   * cifras son las mismas: solo cambian los rótulos y el idioma de la página
   * que se captura.
   *
   * Los rótulos que la captura pone donde el panel de un cliente diría «tu
   * factura», «últimos 30 días» o «live · tu organización»: aquí son UN día
   * del banco público en una organización de demostración, y se dice así.
   * `{peticiones}` y `{evitadas}` se rellenan con las filas de abajo, y
   * `{repeticiones}` con la condición del flujo (`BANCO_EN_VIVO.repeticiones`):
   * el ahorro solo vale para un tráfico que repite así, y la captura lo dice.
   * «Menos coste a precios de lista» y no «menos factura»: A y B se valoran
   * con el contador del proveedor a precios de lista versionados, como dice el
   * recibo de al lado («no es una conciliación de factura»).
   */
  rotulos: {
    es: {
      /** El nombre de la organización de demostración, tal como sale en la barra de la captura. */
      organizacion: "Banco público · demo",
      antetituloPagina: "Banco público · demo",
      tituloPagina: "Lo que ahorró Savings en el banco público",
      antetitulo: "Medido en vivo contra el proveedor · GSM8K · 2026-09-28",
      pastilla: "Banco público · demo",
      pie: "menos coste a precios de lista · en un flujo con un {repeticiones} de peticiones repetidas · {peticiones} peticiones, {evitadas} respondidas sin llamar al proveedor",
      columnaValor: "Peticiones",
      columnaAhorro: "Ahorro",
    },
    en: {
      organizacion: "Public bench · demo",
      antetituloPagina: "Public bench · demo",
      tituloPagina: "What Savings saved on the public bench",
      antetitulo: "Measured against the provider · GSM8K · 2026-09-28",
      pastilla: "Public bench · demo",
      pie: "lower cost at list prices · in a stream with {repeticiones} repeated requests · {peticiones} requests, {evitadas} answered without calling the provider",
      columnaValor: "Requests",
      columnaAhorro: "Saving",
    },
  },
  modelos: [
    {
      modelo: "openai/gpt-4o-mini",
      nombre: "gpt-4o-mini",
      informe: OPENAI,
      peticiones: 200,
      llamadasAlProveedor: 141,
      servidasDesdeCache: 59,
      costeA: 0.041238,
      costeB: 0.0282477,
      prefijoDelProveedor: 0,
      tokensA: { entrada: 258548, salida: 32765 },
      tokensB: { entrada: 181790, salida: 21520, cacheada: 159104 },
    },
    {
      modelo: "openai/gpt-5.4-mini",
      nombre: "gpt-5.4-mini",
      informe: OPENAI,
      peticiones: 176,
      llamadasAlProveedor: 120,
      servidasDesdeCache: 56,
      costeA: 0.23223375,
      costeB: 0.15855,
      prefijoDelProveedor: 0,
      tokensA: { entrada: 226935, salida: 13785 },
      tokensB: { entrada: 154436, salida: 9494, cacheada: 0 },
    },
    {
      modelo: "anthropic/claude-haiku-4-5",
      nombre: "claude-haiku-4-5",
      informe: ANTHROPIC,
      peticiones: 116,
      llamadasAlProveedor: 78,
      servidasDesdeCache: 38,
      costeA: 0.240566,
      costeB: 0.163117,
      prefijoDelProveedor: 0,
      tokensA: { entrada: 168691, salida: 14375 },
      tokensB: { entrada: 113362, salida: 9951, cacheada: 0 },
    },
    {
      modelo: "anthropic/claude-sonnet-5",
      nombre: "claude-sonnet-5",
      informe: ANTHROPIC,
      peticiones: 62,
      llamadasAlProveedor: 42,
      servidasDesdeCache: 20,
      costeA: 0.315284,
      costeB: 0.0785669,
      prefijoDelProveedor: 0.1295211,
      tokensA: { entrada: 115092, salida: 8510 },
      tokensB: { entrada: 77724, salida: 5264, cacheada: 72447 },
    },
  ] satisfies ModeloDelBanco[],
} as const;

/** Lo que cuesta B a efectos del panel: sin el descuento del proveedor, que el panel enseña aparte. */
const costeRealDelPanel = (m: ModeloDelBanco) => m.costeB + m.prefijoDelProveedor;

/** Las filas por modelo del día, con la forma de `usage_daily_by_model`. */
export function filasPorModeloDelBanco(): ModelDia[] {
  return PANEL_DEL_BANCO.modelos.map((m) => ({
    day: PANEL_DEL_BANCO.dia,
    model: m.nombre,
    requests: m.peticiones,
    baselineCost: m.costeA,
    actualCost: costeRealDelPanel(m),
    actualInputTokens: m.tokensB.entrada,
    actualOutputTokens: m.tokensB.salida,
  }));
}

/** La fila diaria, con la forma de `usage_daily`: la suma de los cuatro modelos. */
export function filasDiariasDelBanco(): UsageRollup[] {
  const ms: readonly ModeloDelBanco[] = PANEL_DEL_BANCO.modelos;
  const suma = (f: (m: ModeloDelBanco) => number) => ms.reduce((n, m) => n + f(m), 0);
  const base = suma((m) => m.costeA);
  const real = suma(costeRealDelPanel);
  return [
    {
      day: PANEL_DEL_BANCO.dia,
      requests: suma((m) => m.peticiones),
      avoidedLlm: suma((m) => m.servidasDesdeCache),
      actualLlm: suma((m) => m.llamadasAlProveedor),
      // La batería no lleva datos estructurados y el paquete no trae compresor:
      // esos dos libros son 0 por construcción (lo dice el propio informe).
      eliminatedInputTokens: 0,
      compressedInputTokens: 0,
      providerCachedInputTokens: suma((m) => m.tokensB.cacheada),
      baselineCost: base,
      actualCost: real,
      measuredRequests: suma((m) => m.peticiones),
      measuredBaselineCost: base,
      measuredActualCost: real,
      baselineInputTokens: suma((m) => m.tokensA.entrada),
      actualInputTokens: suma((m) => m.tokensB.entrada),
      baselineOutputTokens: suma((m) => m.tokensA.salida),
      actualOutputTokens: suma((m) => m.tokensB.salida),
    },
  ];
}

/**
 * La ruta de la captura (`app/[locale]/captura-panel`) solo existe en
 * desarrollo: con cualquier otro NODE_ENV —el build y el servidor de Vercel
 * corren en `production`— contesta la 404.
 */
/**
 * El ahorro de cada modelo tal como lo enseña la captura: 1 − real / base, con
 * la caché de prefijo del proveedor fuera (como el titular). Fracciones.
 */
export function ahorroPorModeloDelBanco(): Record<string, number> {
  return Object.fromEntries(PANEL_DEL_BANCO.modelos.map((m) => [m.nombre, 1 - costeRealDelPanel(m) / m.costeA]));
}

/** Los dos idiomas en que se captura el panel. */
export const IDIOMAS_DE_LA_CAPTURA = ["es", "en"] as const;
export type IdiomaDeLaCaptura = (typeof IDIOMAS_DE_LA_CAPTURA)[number];

/** Qué captura ve cada idioma de la web: la española, `es` y `ca`; la inglesa, el resto. */
export function idiomaDeLaCaptura(locale: string): IdiomaDeLaCaptura {
  return locale === "es" || locale === "ca" ? "es" : "en";
}

/** Los rótulos de la captura en ese idioma de la web. */
export function rotulosDeLaCaptura(locale: string) {
  return PANEL_DEL_BANCO.rotulos[idiomaDeLaCaptura(locale)];
}

const FORMATO_DE_LA_CAPTURA: Record<IdiomaDeLaCaptura, string> = { es: "es-ES", en: "en-US" };

/** El pie del titular de la captura, con sus dos recuentos sacados de las filas. */
export function pieDelTitular(locale: string): string {
  const idioma = idiomaDeLaCaptura(locale);
  const formato = FORMATO_DE_LA_CAPTURA[idioma];
  const d = filasDiariasDelBanco()[0]!;
  return PANEL_DEL_BANCO.rotulos[idioma].pie
    .replace("{repeticiones}", new Intl.NumberFormat(formato, { style: "percent", maximumFractionDigits: 0 }).format(BANCO_EN_VIVO.repeticiones))
    .replace("{peticiones}", d.requests.toLocaleString(formato))
    .replace("{evitadas}", d.avoidedLlm.toLocaleString(formato));
}

/**
 * El titular que pinta la captura (fracción): el ahorro de los CUATRO modelos
 * juntos, sin el contraste de precios de caché de Claude Sonnet 5 — lo que
 * `deriveVerdict` saca de `filasDiariasDelBanco()`. El pie de la portada lo
 * cita para explicar por qué no es la cifra del recibo de al lado (que es un
 * solo modelo, gpt-4o-mini).
 */
export function titularDelPanel(): number {
  const d = filasDiariasDelBanco()[0]!;
  return 1 - d.measuredActualCost / d.measuredBaselineCost;
}

/**
 * La huella de las cifras que pinta la captura. La ruta de la captura la deja
 * en la página y `scripts/captura-panel.ts` la guarda junto a la imagen
 * (`assets/portada/panel-del-banco.json`): si alguien cambia una cifra de aquí
 * sin volver a capturar, `panel-del-banco.test.ts` se pone rojo.
 */
export function huellaDelPanel(): string {
  return createHash("sha256").update(JSON.stringify(PANEL_DEL_BANCO)).digest("hex").slice(0, 16);
}

export function capturaDisponible(entorno: string | undefined = process.env.NODE_ENV): boolean {
  return entorno === "development";
}

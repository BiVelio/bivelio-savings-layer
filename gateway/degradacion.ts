/**
 * EL VIGÍA DEL TRÁFICO DEGRADADO — funciones PURAS que miran una petición ya
 * servida (el cuerpo que mandó el cliente y el `usage` que declaró el
 * proveedor) y dicen si el cliente está pagando más de lo que pidió pagar.
 *
 * Por qué existe (recomendación n.º 6 del informe de competencia del
 * 26-09-2026): poner un proxy delante puede empeorar la factura sin que nadie
 * lo note. Nos pasó a nosotros —Claude Code apaga la búsqueda de herramientas
 * si ve un base URL ajeno— y a otros: un tercero documentó un gateway que
 * rebajaba en silencio el TTL de 1 h a 5 min
 * (https://www.danielternyak.com/articles/vercel-ai-gateway-downgrades-anthropic-prompt-cache,
 * 22-06-2026). La batería test/gateway-no-empeora.test.ts demuestra que ESTE
 * gateway no lo hace; esto vigila que nadie más en la cadena lo haga.
 *
 * Tres firmas, las tres sobre el contador del proveedor, nunca estimadas:
 *
 *  · `cacheIgnorada`: la petición marca `cache_control` al final del prompt, el
 *    proveedor cuenta al menos ENTRADA_MINIMA_PARA_ESPERAR_CACHE tokens de
 *    entrada y aun así no declara ni lectura ni escritura de caché.
 *  · `ttlAcortado`: TODAS las marcas piden `ttl: "1h"`, la palanca de TTL no
 *    tocó esa petición y el proveedor escribió solo a 5 min.
 *  · `busquedaApagada`: tráfico de Claude Code cuyo catálogo entero de
 *    herramientas viaja sin diferir y sin `tool_reference`
 *    (busqueda-de-herramientas.ts). Solo Claude Code: es el cliente que apaga
 *    la búsqueda al ver un proxy delante —este gateway incluido—; otro cliente
 *    con muchas herramientas puede no haberla usado nunca.
 *
 * Lo que NO hace: viajar. La lista blanca de la ingesta
 * (apps/web/lib/metering/usage.ts) rechaza cualquier campo que no conozca con
 * un 400 que tira el LOTE entero, y la LICENSE §5 enumera lo que sale de la
 * máquina. Así que se queda en local: una línea de log por sesión y tipo, y un
 * contador que el gateway expone y `bvsala` resume al salir.
 */

import type { UsoSse } from "./medidor.js";
import { declaraHerramientaDeServidor, visitarMarcasDeCache } from "./tarifa.js";

export type TipoDeDegradacion = "cacheIgnorada" | "ttlAcortado" | "busquedaApagada";

export const TIPOS_DE_DEGRADACION: readonly TipoDeDegradacion[] = ["cacheIgnorada", "ttlAcortado", "busquedaApagada"];

/**
 * Por debajo de esta entrada, que el proveedor no cachee es lo esperado: el
 * mínimo cacheable depende del modelo, de 512 a 4.096 tokens, y el mayor de la
 * tabla es este (Claude Opus 4.6, Opus 4.5 y Haiku 4.5). Fuente: la tabla de
 * mínimos de https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * (consultada el 2026-09-27). Un modelo futuro con un mínimo mayor daría falsos
 * positivos hasta subir esto.
 */
export const ENTRADA_MINIMA_PARA_ESPERAR_CACHE = 4_096;

/** Lo que se ve de las marcas de caché de un cuerpo /v1/messages. */
export interface VistaDeMarcas {
  /** Marcas `cache_control` donde la API las lee, la de la raíz incluida. */
  marcas: number;
  /** Las que piden `ttl: "1h"`. */
  de1h: number;
  /** Las demás: `ttl: "5m"` o sin `ttl` (5 min, el defecto de la API). */
  deOtroTtl: number;
  /**
   * Hay una marca que cubre el prompt entero: la de la raíz (caché automática,
   * que se coloca en el último bloque) o una dentro del último mensaje. Sin
   * ella, lo marcado puede ser un prefijo corto por debajo del mínimo
   * cacheable y la ausencia de caché no dice nada.
   */
  enLaCola: boolean;
  /**
   * La petición declara herramientas que corren en el servidor del proveedor
   * (búsqueda web, ejecución de código, tool search, advisor, MCP…). Si Claude
   * usa una, la API escribe SU resultado en caché a 5 min por su cuenta, sea
   * cual sea el TTL de las marcas del cliente
   * (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#server-tool-results-are-cached-automatically,
   * consultada el 2026-09-27), así que una escritura a 5 min no demuestra que
   * alguien acortara el TTL. La regla vive en tarifa.ts
   * (declaraHerramientaDeServidor): es la misma que deja sin acreditar la
   * palanca de TTL.
   */
  herramientaDeServidor: boolean;
}

export function verMarcasDeCache(json: Record<string, unknown>): VistaDeMarcas {
  const vista: VistaDeMarcas = { marcas: 0, de1h: 0, deOtroTtl: 0, enLaCola: false, herramientaDeServidor: false };
  visitarMarcasDeCache(json, (marca, sitio) => {
    vista.marcas++;
    if (marca.ttl === "1h") vista.de1h++;
    else vista.deOtroTtl++;
    if (sitio === "raiz" || sitio === "ultimoMensaje") vista.enLaCola = true;
  });
  vista.herramientaDeServidor = declaraHerramientaDeServidor(json);
  return vista;
}

/**
 * ¿Lo manda Claude Code? Por su id de sesión (`x-claude-code-session-id`) o
 * por su user-agent (`claude-cli/…`). Solo limita la firma `busquedaApagada`:
 * apagar la búsqueda al ver un proxy delante es cosa de Claude Code.
 */
export function esTraficoDeClaudeCode(cabeceras: Readonly<Record<string, string | string[] | undefined>>): boolean {
  const sesion = cabeceras["x-claude-code-session-id"];
  if (typeof sesion === "string" ? sesion !== "" : Array.isArray(sesion) && sesion.length > 0) return true;
  const agente = cabeceras["user-agent"];
  return typeof agente === "string" && agente.startsWith("claude-cli/");
}

const escritaDe = (uso: UsoSse): number =>
  uso.cache_creation_input_tokens ??
  (uso.cache_creation?.ephemeral_5m_input_tokens ?? 0) + (uso.cache_creation?.ephemeral_1h_input_tokens ?? 0);

/**
 * ¿Merece la pena mirar el cuerpo? Solo el `usage`, sin tocar la petición: el
 * caso sano (lee o escribe a 1 h, o una entrada pequeña) sale aquí y el cuerpo
 * no se parsea.
 */
export function usoConFormaDeDegradacion(uso: UsoSse): boolean {
  const sinCache = (uso.cache_read_input_tokens ?? 0) === 0 && escritaDe(uso) === 0;
  if (sinCache && (uso.input_tokens ?? 0) >= ENTRADA_MINIMA_PARA_ESPERAR_CACHE) return true;
  const d = uso.cache_creation;
  return d !== undefined && (d.ephemeral_5m_input_tokens ?? 0) > 0 && (d.ephemeral_1h_input_tokens ?? 0) === 0;
}

/**
 * La firma de caché de una petición servida, o null si no hay nada que decir.
 * `ttlReescritoPorLaCapa`: la palanca de TTL cambió esta petición (entonces
 * los 5 min son nuestros y declarados, no una degradación).
 */
export function degradacionDeCache(entrada: {
  vista: VistaDeMarcas;
  uso: UsoSse;
  ttlReescritoPorLaCapa: boolean;
}): Exclude<TipoDeDegradacion, "busquedaApagada"> | null {
  const { vista, uso, ttlReescritoPorLaCapa } = entrada;
  if (vista.marcas === 0) return null;
  const leida = uso.cache_read_input_tokens ?? 0;
  if (leida === 0 && escritaDe(uso) === 0 && vista.enLaCola && (uso.input_tokens ?? 0) >= ENTRADA_MINIMA_PARA_ESPERAR_CACHE) {
    return "cacheIgnorada";
  }
  const d = uso.cache_creation;
  if (
    !ttlReescritoPorLaCapa &&
    vista.de1h > 0 &&
    vista.deOtroTtl === 0 &&
    !vista.herramientaDeServidor &&
    d !== undefined &&
    (d.ephemeral_1h_input_tokens ?? 0) === 0 &&
    (d.ephemeral_5m_input_tokens ?? 0) > 0
  ) {
    return "ttlAcortado";
  }
  return null;
}

/** Los datos que la línea de log enseña, todos del contador del proveedor o del cuerpo. */
export interface DetalleDeDegradacion {
  sesion?: string | undefined;
  /** cacheIgnorada: la entrada que contó el proveedor. */
  entrada?: number;
  /** ttlAcortado: lo que escribió a 5 min. */
  escrita5m?: number;
  /** busquedaApagada: las definiciones completas que viajaron. */
  definiciones?: number;
}

/**
 * La línea de log, en inglés (la lee quien usa el gateway). Una por sesión y
 * tipo: el resto de casos de esa sesión se cuentan en silencio.
 */
export function lineaDeDegradacion(tipo: TipoDeDegradacion, d: DetalleDeDegradacion): string {
  const cabeza = `[gateway] degraded traffic${d.sesion ? ` (session ${d.sesion})` : ""} · `;
  const cola = " Logged once per session; further cases are counted, not logged.";
  if (tipo === "cacheIgnorada") {
    return (
      cabeza +
      `prompt caching: the request carried cache_control and the provider counted ${d.entrada ?? 0} input tokens, ` +
      "but reported no cache read and no cache write. The gateway forwards cache_control as the client sent it " +
      "(the TTL lever only changes ttl), so look upstream: another proxy in the chain, or an endpoint that ignores prompt caching." +
      cola
    );
  }
  if (tipo === "ttlAcortado") {
    return (
      cabeza +
      'cache TTL: every cache_control in the request asked for ttl "1h" and the provider wrote the cache at the 5-minute TTL only ' +
      `(${d.escrita5m ?? 0} tokens at 5m, none at 1h). The gateway did not change this request's ttl, so something upstream did ` +
      "(another proxy in the chain, or the endpoint). A 5-minute entry expires between turns more than 5 minutes apart." +
      cola
    );
  }
  return (
    cabeza +
    `tool search: the client sent ${d.definiciones ?? 0} full tool definitions, none deferred and no tool_reference, ` +
    "so tool search is off and the whole catalog is billed in every request. Behind a proxy, Claude Code turns it off by default: " +
    "`bvsala claude` turns it back on in a NEW WINDOW, or export ENABLE_TOOL_SEARCH=true before launching it by hand." +
    cola
  );
}

/**
 * El contador local y la memoria de «ya lo dije en esta sesión». Acotada: un
 * gateway de escritorio no crece sin techo; si se desborda, olvida la sesión
 * más vieja (lo peor que pasa es repetir una línea).
 */
export class VigiaDeDegradacion {
  private readonly cuentas: Record<TipoDeDegradacion, number> = { cacheIgnorada: 0, ttlAcortado: 0, busquedaApagada: 0 };
  private readonly dichas = new Set<string>();

  constructor(private readonly maxSesiones = 4_096) {}

  /** Cuenta una petición degradada. true si es la PRIMERA de su tipo en su sesión: toca decirlo. */
  anotar(tipo: TipoDeDegradacion, sesion: string | undefined): boolean {
    this.cuentas[tipo]++;
    const clave = `${tipo}|${sesion ?? ""}`;
    if (this.dichas.has(clave)) return false;
    this.dichas.add(clave);
    if (this.dichas.size > this.maxSesiones) {
      const masVieja = this.dichas.values().next();
      if (masVieja.done !== true) this.dichas.delete(masVieja.value);
    }
    return true;
  }

  contadores(): Readonly<Record<TipoDeDegradacion, number>> {
    return { ...this.cuentas };
  }
}

/**
 * El resumen que `bvsala` imprime al terminar, o null si no hubo nada. En modo
 * envoltorio el log por petición está callado (el terminal es un TUI): esta es
 * la única forma de que el usuario se entere sin mirar el panel.
 */
export function resumenDeDegradaciones(c: Readonly<Record<TipoDeDegradacion, number>>): string | null {
  const partes: string[] = [];
  if (c.cacheIgnorada > 0) partes.push(`${c.cacheIgnorada} request(s) with cache_control but no cache read or write`);
  if (c.ttlAcortado > 0) partes.push(`${c.ttlAcortado} request(s) whose 1-hour cache TTL was written at 5 minutes upstream`);
  if (c.busquedaApagada > 0) partes.push(`${c.busquedaApagada} request(s) with tool search off`);
  if (partes.length === 0) return null;
  return (
    `[bvsala gateway] degraded traffic in this run: ${partes.join(" · ")}. ` +
    'What each one means and what to do: "What the gateway guarantees" in docs/terminales/README.md of the package.'
  );
}

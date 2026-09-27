import { createHash } from "node:crypto";
import { PRIMA_ESCRITURA_CACHE, PRIMA_ESCRITURA_CACHE_1H } from "../src/pricing/primas.js";
import { parsearParaReescribir } from "./reserializacion.js";

/**
 * LA PALANCA DE TARIFA — el dinero que se ahorra sin tocar un solo token.
 *
 * El corpus del espía (3.305 peticiones reales, 921 M de tokens, 23-08 → 06-09)
 * valorado con el catálogo del producto (src/pricing/catalogo.ts, verificado
 * el 06-09 contra la página oficial) cuesta $1.232,91 y se reparte así:
 *
 *     lectura de caché   $819,27   66,4 %  ·  897,3 M tok  (97,4 %)
 *     escritura 1h       $242,35   19,7 %  ·   14,9 M tok   (1,6 %)
 *     salida             $126,86   10,3 %  ·    3,3 M tok   (0,4 %)
 *     escritura 5m        $39,39    3,2 %  ·    5,0 M tok   (0,5 %)
 *     entrada sin caché    $5,04    0,4 %  ·    0,8 M tok   (0,1 %)
 *
 * Claude Code pide TTL 1h SIEMPRE (12.580 marcas `"ttl":"1h"`, cero de `"5m"`),
 * y Anthropic factura esa escritura a 2× el precio de entrada frente al 1,25×
 * de los 5 minutos. La prima de la hora vale $90,88 en el corpus: el 7,4 % de
 * la factura. Y el hueco hasta el turno siguiente, medido POR HILO (sesión +
 * system: el agente principal y sus subagentes comparten id de sesión pero no
 * prefijo), es menor de 5 minutos el 97,5 % de las veces.
 *
 * LA TRAMPA, medida antes de caer en ella dos veces: decidir por el reloj.
 *
 * La prima se ahorra sobre lo que se ESCRIBE en el turno —en un turno
 * encadenado, unos pocos K de mensaje nuevo— pero el fallo se paga sobre lo
 * que se LEE, que es el prefijo entero: mediana 199K tokens, p90 587K. Un
 * acierto ahorra 0,75× sobre lo pequeño; un fallo cuesta 1,15× sobre lo gordo.
 * Rebajar todos los turnos «calientes» (la política de #229, hueco previo
 * < 4 min) sale a −$77,68 sobre el corpus: PIERDE el 6,3 % de la factura, con
 * 40 fallos que cuestan $140 para ahorrar $63. «Siempre 5m» es aún peor.
 *
 * LA REGLA: se rebaja solo cuando lo que se va a escribir es una parte GRANDE
 * de lo que se va a leer — arranque de sesión, compactación, historial
 * reescrito. Ahí la prima es gorda y el riesgo, el mismo. Con el umbral en el
 * 30 % del cuerpo (`UMBRAL_REESCRITURA`) el corpus da +$61,00 (+4,9 %) con 4
 * fallos que cuestan $0,87; al 10 % da +$64,72. El punto de equilibrio con un
 * 2 % de fallos está en el 3 % del cuerpo: el umbral lleva un margen de 10×.
 *
 * Por qué la ventana de riesgo dura UN turno y no toda la sesión: la entrada
 * de 5m cubre el prefijo entero, sí, pero el turno encadenado siguiente (no
 * rebajado) lleva sus marcas de 1h y crea una entrada de 1h para ese mismo
 * prefijo pagando solo el delta — es la aritmética A/B/C de la página oficial
 * de caché de prompts. A partir de ahí, la hora protege otra vez.
 *
 * Por qué esta palanca es DISTINTA de la elisión, y por qué importa tanto:
 *
 *  · NO cambia lo que el modelo lee. Ni un token entra, sale o se mueve. El
 *    riesgo de calidad no es «bajo»: es CERO por construcción.
 *  · Su ahorro es ARITMÉTICA, no contrafactual. La misma escritura, los
 *    mismos tokens que el proveedor declaró, dos tarifas públicas. No hay que
 *    imaginar «qué habría pasado si no» — que es justo lo que obliga a marcar
 *    la elisión como `estimated` (ver src/tokenizer/accounting.ts). Esta se
 *    cobra como `measured` con la cara bien alta.
 *
 * Todo aquí es PURO y determinista, como la palanca de diales: ante cualquier
 * duda se devuelve null y el cuerpo original viaja intacto.
 */

/** Prima de escritura con TTL 5m (el defecto de Anthropic): 1,25× la entrada.
 *  Alias del único domicilio: src/pricing/primas.ts. */
export const PRIMA_5M = PRIMA_ESCRITURA_CACHE;
/** Prima de escritura con TTL 1h: 2× la entrada. Mismo domicilio. */
export const PRIMA_1H = PRIMA_ESCRITURA_CACHE_1H;

/**
 * Qué parte del cuerpo tiene que ser NUEVA respecto al turno anterior del
 * hilo para que compense rebajar. 30 %: diez veces el punto de equilibrio con
 * un 2 % de fallos, y muy lejos del 1-3 % de un turno encadenado normal.
 */
export const UMBRAL_REESCRITURA = 0.3;

/** Lo que la rebaja encontró y cambió en un cuerpo. */
export interface RebajaTtl {
  /** El cuerpo con los `ttl` de 1h reescritos a 5m. */
  cuerpo: Buffer<ArrayBuffer>;
  /** Cuántas marcas `cache_control` de 1h se reescribieron. */
  rebajadas: number;
  /**
   * Cuántas marcas pedían ya 5m ANTES de tocar nada. Si es > 0 el informe no
   * puede atribuirse la escritura entera (el usage no dice qué bloque escribió
   * qué tokens), así que el ahorro se declara 0 — quedarse corto por defecto,
   * la misma doctrina que la prima de escritura del medidor.
   */
  yaEran5m: number;
  /**
   * La petición declara herramientas de servidor (declaraHerramientaDeServidor).
   * Si Claude usa una, la API pone por su cuenta un breakpoint de 5 min sobre
   * su resultado, y esa escritura sale en `ephemeral_5m_input_tokens` junto a
   * la nuestra: el usage no las separa, así que el ahorro se declara 0.
   */
  herramientaDeServidor: boolean;
}

/**
 * Familias de herramientas TIPADAS que ejecuta el cliente (bash, editor de
 * texto, computer use, browser use, memoria): no escriben caché por su cuenta.
 * Cualquier otro `type` —web search, web fetch, code execution, tool search,
 * el advisor, un `mcp_toolset`, o uno que aún no conocemos— se trata como de
 * servidor: ante la duda, no se acredita.
 */
const HERRAMIENTA_DEL_CLIENTE = /^(custom|bash_|text_editor_|computer_|browser_|memory_)/;

/**
 * ¿Declara la petición alguna herramienta que corre en el servidor del
 * proveedor? Una herramienta sin `type` (o `custom`) es del cliente; un
 * `mcp_servers` no vacío es el conector MCP, que también corre en el servidor.
 *
 * Por qué importa: «When your request has prompt caching enabled and Claude
 * uses a server tool such as web search, web fetch, or code execution, the API
 * automatically places a cache breakpoint on the server tool result […] This
 * automatic breakpoint always uses the default 5-minute TTL, independent of
 * any TTL you set on your own cache_control markers» —
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching#server-tool-results-are-cached-automatically
 * (consultada el 2026-09-27). Con una de estas declarada, una escritura a 5 min
 * no es atribuible ni a la palanca de TTL ni a nadie aguas arriba.
 */
export function declaraHerramientaDeServidor(json: Record<string, unknown>): boolean {
  if (Array.isArray(json.mcp_servers) && json.mcp_servers.length > 0) return true;
  if (!Array.isArray(json.tools)) return false;
  return json.tools.some((t) => {
    const tipo = t !== null && typeof t === "object" ? (t as { type?: unknown }).type : undefined;
    return typeof tipo === "string" && !HERRAMIENTA_DEL_CLIENTE.test(tipo);
  });
}

/**
 * La HUELLA de un cuerpo: lo justo para saber, en el turno siguiente, qué
 * parte del prefijo sigue siendo la misma. Hashes sin las marcas de caché —
 * la marca se mueve de mensaje cada turno y no cambia lo que hay cacheado.
 */
export interface Huella {
  system: string;
  tools: string;
  /** Hash de cada mensaje, en orden. */
  mensajes: string[];
  /** Bytes JSON de cada mensaje, en el mismo orden. */
  bytes: number[];
  /** Bytes JSON de system + tools. */
  bytesFijos: number;
}

/** Tope de mensajes que se recuerdan por hilo: más allá, el resto cuenta como nuevo. */
const MAX_MENSAJES_EN_HUELLA = 4_096;

const sinMarcas = (clave: string, valor: unknown): unknown => (clave === "cache_control" ? undefined : valor);

function serieDe(nodo: unknown): string {
  return nodo === undefined ? "" : (JSON.stringify(nodo, sinMarcas) ?? "");
}

/**
 * Las herramientas DIFERIDAS (`defer_loading: true`, búsqueda de herramientas de
 * Claude Code) no forman parte del prefijo cacheado: el proveedor las carga en la
 * posición del bloque `tool_reference` que las trajo, DESPUÉS del prefijo. Medido
 * el 2026-09-09: al añadirse WebFetch diferida a `tools`, el turno siguiente leyó
 * de caché el 100 % del prefijo anterior (35.677 = 13.418 + 22.259). Si entraran
 * en la huella, cada carga diferida parecería «prefijo roto» y la rebaja de TTL
 * se decidiría sobre una premisa falsa.
 */
function sinDiferidas(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((t) => !(t !== null && typeof t === "object" && (t as { defer_loading?: unknown }).defer_loading === true));
}

function hashDe(serie: string): string {
  return createHash("sha1").update(serie).digest("base64url").slice(0, 16);
}

/**
 * Parsea un cuerpo /v1/messages, o devuelve null — «no tocar, reenviar
 * intacto» — si llega comprimido, no es UTF-8 válido, no es JSON, no tiene forma
 * de mensajes, o reescribirlo cambiaría algo más que lo que la palanca declara
 * (números no canónicos, claves con forma de índice: ver reserializacion.ts).
 */
export function parsearMensajes(cuerpo: Buffer, codificacion?: string): Record<string, unknown> | null {
  // La puerta común de las palancas que reescriben (reserializacion.ts): si
  // volver a escribir el cuerpo cambiara algo que la palanca no declara, null.
  const json = parsearParaReescribir(cuerpo, codificacion);
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.model !== "string" || !Array.isArray(obj.messages)) return null;
  return obj;
}

/** La huella de un cuerpo ya parseado. Pura. */
export function huellaDe(json: Record<string, unknown>): Huella {
  const sistema = serieDe(json.system);
  const herramientas = serieDe(sinDiferidas(json.tools));
  const lista = Array.isArray(json.messages) ? json.messages.slice(0, MAX_MENSAJES_EN_HUELLA) : [];
  const mensajes: string[] = [];
  const bytes: number[] = [];
  for (const m of lista) {
    const s = serieDe(m);
    mensajes.push(hashDe(s));
    bytes.push(Buffer.byteLength(s, "utf8"));
  }
  return {
    system: hashDe(sistema),
    tools: hashDe(herramientas),
    mensajes,
    bytes,
    bytesFijos: Buffer.byteLength(sistema, "utf8") + Buffer.byteLength(herramientas, "utf8"),
  };
}

/**
 * Qué fracción del cuerpo actual (en bytes) NO estaba en el prefijo que dejó
 * cacheado el turno anterior del hilo. 1 si no hay turno anterior o si
 * cambiaron system o tools (el prefijo se rompe en el primer byte).
 *
 * El turno anterior dejó cacheado hasta su último mensaje; todo lo que en el
 * cuerpo actual va después del primer mensaje que difiere es nuevo.
 */
export function fraccionNueva(anterior: Huella | undefined, actual: Huella): number {
  if (anterior === undefined) return 1;
  if (anterior.system !== actual.system || anterior.tools !== actual.tools) return 1;
  let total = actual.bytesFijos;
  for (const b of actual.bytes) total += b;
  if (total <= 0) return 1;
  let k = 0;
  while (k < anterior.mensajes.length && k < actual.mensajes.length && anterior.mensajes[k] === actual.mensajes[k]) k++;
  let nuevos = 0;
  for (let i = k; i < actual.bytes.length; i++) nuevos += actual.bytes[i] ?? 0;
  return nuevos / total;
}

/**
 * ¿Se rebaja el TTL de ESTA petición? Pura: solo mira qué parte del cuerpo es
 * nueva. Arranque en frío (todo nuevo) → sí. Compactación o historial
 * reescrito (la mayor parte nueva) → sí. Turno encadenado (unos K sobre
 * cientos de K) → NO: ahí la prima es calderilla y el fallo, el prefijo entero.
 */
export function decidirRebaja(entrada: { fraccionNueva: number; umbral?: number }): boolean {
  const { fraccionNueva: fraccion, umbral = UMBRAL_REESCRITURA } = entrada;
  return fraccion >= umbral;
}

/** Rebaja UNA marca `cache_control` y la cuenta. */
function rebajarMarca(marca: Record<string, unknown>, cuenta: { rebajadas: number; yaEran5m: number }): void {
  if (marca.ttl === "1h") {
    marca.ttl = "5m";
    cuenta.rebajadas++;
  } else if (marca.ttl === "5m") {
    cuenta.yaEran5m++;
  }
  // `cache_control` sin `ttl` = 5m implícito: es el defecto de la API. No se
  // toca (ya está en la tarifa barata) pero cuenta como 5m preexistente.
  else if (marca.ttl === undefined) cuenta.yaEran5m++;
}

/** Dónde está una marca `cache_control` dentro de un cuerpo /v1/messages. */
export type SitioDeMarca = "raiz" | "system" | "tools" | "mensaje" | "ultimoMensaje";

const esObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const marcaDe = (nodo: unknown): Record<string, unknown> | null =>
  esObjeto(nodo) && esObjeto(nodo.cache_control) ? nodo.cache_control : null;

/** Profundidad máxima de `content` anidado que se recorre (un tool_result dentro de otro no existe; es un tope, no un caso). */
const MAX_ANIDAMIENTO = 8;

function visitarBloques(
  bloques: unknown,
  sitio: SitioDeMarca,
  visita: (marca: Record<string, unknown>, sitio: SitioDeMarca) => void,
  profundidad: number,
): void {
  if (!Array.isArray(bloques) || profundidad > MAX_ANIDAMIENTO) return;
  for (const bloque of bloques) {
    const marca = marcaDe(bloque);
    if (marca) visita(marca, sitio);
    if (!esObjeto(bloque)) continue;
    if (Array.isArray(bloque.content)) visitarBloques(bloque.content, sitio, visita, profundidad + 1);
    // Un `document` cuya fuente es contenido (`source.type: "content"`): sus
    // bloques de texto e imagen también admiten `cache_control`.
    const fuente = bloque.source;
    if (esObjeto(fuente) && fuente.type === "content" && Array.isArray(fuente.content)) {
      visitarBloques(fuente.content, sitio, visita, profundidad + 1);
    }
  }
}

/**
 * Las marcas `cache_control` de un cuerpo /v1/messages, SOLO donde la API las
 * lee: la raíz (caché automática), cada bloque de `system`, cada herramienta de
 * `tools` y cada bloque de contenido de `messages`, también los anidados en el
 * `content` de un bloque (el de un `tool_result`) y en el `source.content` de un
 * `document` con fuente de contenido.
 *
 * NO entra en el `input` de un `tool_use`, ni en el `input_schema` de una
 * herramienta, ni en ningún otro objeto. Ahí una clave `cache_control` es
 * CONTENIDO del cliente —los argumentos de una herramienta que construye una
 * petición a la API, por ejemplo— y reescribirla sería cambiar lo que el modelo
 * lee. Hasta el 2026-09-27 la rebaja recorría el cuerpo entero y la habría
 * reescrito.
 */
export function visitarMarcasDeCache(
  json: Record<string, unknown>,
  visita: (marca: Record<string, unknown>, sitio: SitioDeMarca) => void,
): void {
  const raiz = marcaDe(json);
  if (raiz) visita(raiz, "raiz");
  visitarBloques(json.system, "system", visita, 0);
  if (Array.isArray(json.tools)) {
    for (const herramienta of json.tools) {
      const marca = marcaDe(herramienta);
      if (marca) visita(marca, "tools");
    }
  }
  if (Array.isArray(json.messages)) {
    const ultimo = json.messages.length - 1;
    json.messages.forEach((mensaje, i) => {
      if (esObjeto(mensaje)) visitarBloques(mensaje.content, i === ultimo ? "ultimoMensaje" : "mensaje", visita, 0);
    });
  }
}

/**
 * Reescribe a 5m los `cache_control.ttl === "1h"` del cuerpo, en los sitios
 * donde la API lee una marca (visitarMarcasDeCache: la raíz, `system`, `tools`
 * y los bloques de `messages`) y en ningún otro. Acepta el
 * cuerpo crudo o ya parseado (el servidor lo parsea una vez para la huella y
 * lo reutiliza aquí; si es un objeto, se modifica en sitio).
 *
 * Devuelve `null` — «no tocar, reenviar intacto» — si:
 *  · el cuerpo llega comprimido (no se construye el camino de recompresión),
 *  · no parsea como JSON o no tiene forma de /v1/messages (model + messages),
 *  · no hay ni una sola marca de 1h que rebajar (no cambiar nada > cambiar
 *    para nada: así la coalescencia y el espía ven el cuerpo original).
 */
export function rebajarTtlDeCache(
  cuerpo: Buffer | Record<string, unknown>,
  codificacion?: string,
): RebajaTtl | null {
  const json = Buffer.isBuffer(cuerpo) ? parsearMensajes(cuerpo, codificacion) : cuerpo;
  if (json === null) return null;
  try {
    const cuenta = { rebajadas: 0, yaEran5m: 0 };
    // La marca de la RAÍZ (caché automática) va con las demás. Si se quedara
    // en 1h con las explícitas ya en 5m, la petición rompería dos reglas de la
    // API: las entradas de TTL más largo van primero, y una marca explícita en
    // el último bloque no puede llevar otro TTL que la de la raíz (un 400 que
    // sin la palanca no habría existido).
    visitarMarcasDeCache(json, (marca) => rebajarMarca(marca, cuenta));
    if (cuenta.rebajadas === 0) return null;
    return {
      cuerpo: Buffer.from(JSON.stringify(json), "utf8"),
      rebajadas: cuenta.rebajadas,
      yaEran5m: cuenta.yaEran5m,
      herramientaDeServidor: declaraHerramientaDeServidor(json),
    };
  } catch {
    return null;
  }
}

/**
 * El DINERO que la rebaja ahorró en esta petición. Aritmética exacta sobre el
 * usage que el proveedor ya declaró: los mismos tokens, dos tarifas públicas.
 *
 * `cacheEscrita5m` son los tokens que el proveedor facturó a 1,25× DESPUÉS de
 * nuestra rebaja; sin ella habrían ido a 2×. La diferencia (0,75× el precio de
 * entrada) es el ahorro, y no hay contrafactual que imaginar.
 *
 * Devuelve 0 —y no miente— cuando la atribución no es limpia: si el cliente ya
 * traía marcas de 5m propias, o declaraba herramientas de servidor (la API
 * escribe sus resultados a 5m por su cuenta), el usage no dice qué bloque
 * escribió qué tokens.
 */
export function ahorroDeRebaja(entrada: {
  cacheEscrita5m: number;
  inputPer1k: number;
  yaEran5m: number;
  herramientaDeServidor?: boolean;
}): number {
  const { cacheEscrita5m, inputPer1k, yaEran5m, herramientaDeServidor = false } = entrada;
  if (yaEran5m > 0 || herramientaDeServidor || cacheEscrita5m <= 0 || inputPer1k <= 0) return 0;
  return (cacheEscrita5m / 1_000) * inputPer1k * (PRIMA_1H - PRIMA_5M);
}

/**
 * La MEMORIA de prefijos: la huella del último turno de cada hilo. Acotada
 * por tamaño —un gateway de escritorio no puede crecer sin techo— y por edad:
 * pasada una hora la caché que describía caducó, y el turno siguiente es un
 * arranque en frío se mire como se mire.
 */
export class MemoriaDePrefijos {
  private readonly visto = new Map<string, { huella: Huella; vistoMs: number }>();

  constructor(
    private readonly maxEntradas = 512,
    private readonly maxEdadMs = 60 * 60 * 1000,
  ) {}

  /** La huella del último turno de este hilo, o undefined si no hay o caducó. */
  ultima(clave: string, ahoraMs: number): Huella | undefined {
    const e = this.visto.get(clave);
    if (e === undefined) return undefined;
    if (ahoraMs - e.vistoMs > this.maxEdadMs) {
      this.visto.delete(clave);
      return undefined;
    }
    return e.huella;
  }

  /** Anota este turno. Reinserta para que el orden del Map sea LRU real. */
  anotar(clave: string, huella: Huella, ahoraMs: number): void {
    this.visto.delete(clave);
    this.visto.set(clave, { huella, vistoMs: ahoraMs });
    while (this.visto.size > this.maxEntradas) {
      const masViejo = this.visto.keys().next();
      if (masViejo.done === true) break;
      this.visto.delete(masViejo.value);
    }
  }

  get tamano(): number {
    return this.visto.size;
  }
}

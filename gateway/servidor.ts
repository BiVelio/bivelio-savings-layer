import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { UsageEmitter, deriveSeatId, detectCi } from "../src/metering/index.js";
import { RevocationPoller, RevocationSnapshot, type LicenseKeyset } from "../src/license/index.js";
import { avisarUnaVez } from "../src/util/warn-once.js";
import {
  ObservadorSse,
  ObservadorResponses,
  ObservadorChatCompletions,
  costeMedido,
  informeMedido,
  informeCoalescido,
  informeSombra,
  usoDeJsonPorRuta,
  tieneDialecto,
  inyectarIncludeUsage,
  pideUsoEnStream,
  modeloDelCuerpo,
  jsonDelCuerpo,
  elisionDeJson,
  isSubscriptionTraffic,
  valorarGemelaPorReferencia,
  sueloDeReferencia,
  respuestaJsonFallida,
  negativaEnJson,
  negativaEnTextoDeRespuesta,
  textoDeRespuestaJson,
  negativaNoCobradaEnJson,
  tierServidoDeRespuesta,
  type Atribucion,
  type ElisionAplicada,
  type InyeccionDeUso,
  type RebajaAplicada,
  type UsoSse,
} from "./medidor.js";
import { CarrilSombra } from "./sombra-vivo.js";
import { CanalComunitario, CanalDeEntitlements, type FuenteDeEntitlements } from "./entitlements.js";
import {
  FORCED_RENEWAL_MIN_INTERVAL_MS,
  LicenseRenewer,
  buildLiveLicense,
  effectivePublicKey,
  isoDay,
  licenseVerdict,
  refusalBody,
  transitionLine,
  verifyGatewayLicense,
  type GatewayLicense,
  type GatewayLicenseState,
  type LiveLicense,
  type Verdict,
  type VerifiedLicense,
} from "./license.js";
import { ajustarDiales, conBetaDeElision } from "./palanca.js";
import { avisoDeBusquedaDeHerramientas, verHerramientas } from "./busqueda-de-herramientas.js";
import { aplicarEsfuerzo, conBetaDeEsfuerzo, esNivel } from "./esfuerzo.js";
import { reescribirModelo, type CambioDeModelo } from "./hermano.js";
import {
  ahorroDeRebajaEnSombra,
  decidirRebaja,
  fraccionNueva,
  huellaDe,
  MemoriaDePrefijos,
  parsearMensajes,
  PRIMA_1H,
  PRIMA_5M,
  rebajarTtlDeCache,
} from "./tarifa.js";
import {
  cerrarTurno,
  costeDeFallo,
  MemoriaDeTurnos,
  perdidosConRebajaAplicada,
  perdidosConRebajaEnSombra,
  type TurnoTtl,
} from "./fallos-ttl.js";
import { Coalescedor, claveDePeticion, esOperacionCoalescible, materialDeCabeceras, MAX_CAPTURA_BYTES, type HuellaDeLaPrimaria } from "./coalescencia.js";
import { esUpstreamOficial } from "./upstream.js";
import { RecuentoDeMedicion, type EstadoDeMedicion } from "./recuento.js";
import {
  BuzonDeInformes,
  CABECERA_ID_DE_PETICION,
  CABECERA_PIDE_INFORME,
  ESQUEMA_ESTADO,
  VigiaDeIdDeRespuesta,
  atenderRutaLocal,
  idDeCuerpoJson,
  origenPublico,
  pideInforme,
  rutaLocal,
} from "./informes-locales.js";
import { BV_SALA_VERSION } from "../src/version.js";

/**
 * El aviso de la licencia Medir en la pasarela (una vez por proceso). En inglés
 * y ASCII, como todo lo que ve el cliente: qué hace y cómo se pasa a pago.
 */
export const AVISO_GATEWAY_MEDIR =
  "[bvsala gateway] Measure license: SHADOW mode. Requests are forwarded to the provider byte for byte " +
  "(no levers, no coalescing, no usage injection) and your usage is measured; what a lever would have " +
  "saved shows on your dashboard as an estimate, never billed. To turn the levers on, upgrade at " +
  "https://savings.bivelio.com/dashboard/account - the gateway picks up the new license by itself.";
import {
  VigiaDeDegradacion,
  degradacionDeCache,
  esTraficoDeClaudeCode,
  lineaDeDegradacion,
  usoConFormaDeDegradacion,
  verMarcasDeCache,
  type TipoDeDegradacion,
} from "./degradacion.js";

/**
 * F1 · EL GATEWAY — un proxy local delante de la API de Anthropic que MIDE.
 *
 * Principios heredados del plan maestro y del catálogo F0
 * (`docs/PASARELA-F0.md`):
 *
 *   · PASSTHROUGH POR DEFECTO. El cuerpo viaja byte a byte en los dos
 *     sentidos; nunca se parsea-y-reconstruye. Lo único que se retira son las
 *     cabeceras de transporte de la respuesta (`content-encoding`,
 *     `content-length`, `transfer-encoding`): el fetch de Node ya descomprime
 *     y reenviarlas rompe el cliente (hallazgo F0 nº1, BrotliDecompressionError).
 *   · AVISAR, NUNCA ROMPER LO QUE ESTÁ EN VUELO (decisión del dueño 2026-08-23,
 *     acotada el 2026-09-24 para cumplir LICENSE §2): ningún estado del
 *     METERING corta el tráfico; la LICENCIA verja el arranque (bin.ts) y cada
 *     petición NUEVA (402), y jamás una en curso. El candado de cobro sigue
 *     siendo el servidor (ingesta y canal), que es imparcheable.
 *   · SOLO MEDIDO. Un registro existe únicamente si el proveedor emitió
 *     `usage` y el modelo está en el catálogo de precios. Sin contador no hay
 *     cifra: nada se estima en el gateway.
 *   · Los prompts, las respuestas y las claves del proveedor nunca llegan a
 *     BiVelio. El metering transporta cuentas, coste, el id del modelo e ids
 *     opacos (asiento, sesión, subagente): la lista exacta es la LICENSE §5 y
 *     test/licencia-alineada.test.ts la ata al cable.
 */

export interface OpcionesGateway {
  /** Puerto local (por defecto 8402). */
  puerto?: number;
  /** Upstream (por defecto https://api.anthropic.com). */
  upstream?: string;
  /** Clave de servicio bvk_… — habilita metering + asiento. Sin ella: solo passthrough. */
  serviceAccountKey?: string;
  /** URL de ingesta (por defecto la de producción). */
  meteringUrl?: string;
  /** Identidad de asiento explícita (BVSALA_SEAT_ID); si falta se deriva. */
  seatId?: string;
  /**
   * F2 · coalescencia de duplicados en vuelo. APAGADA por defecto: se enciende
   * con BVSALA_GATEWAY_COALESCE=1 y solo entrará por defecto cuando el arnés
   * demuestre cero degradación (plan maestro).
   */
  coalescer?: boolean;
  /**
   * Palanca D · el techo de esfuerzo por turno. Nivel (`low`…`max`) o ausente.
   * Es del OPERADOR, no se adivina: la palanca aplica lo que se le declara y
   * solo cambia la VÍA (un mensaje añadido, que no reinicia la caché de
   * prefijo, en vez del campo de la raíz, que sí la reinicia). Y solo si REBAJA
   * el defecto del modelo: un nivel igual o superior deja el cuerpo intacto
   * (`rebajaElDefecto`, gateway/esfuerzo.ts).
   */
  esfuerzo?: string;
  /**
   * S2 · el carril SOMBRA de la elisión (política v0, la ganadora del replay
   * del corpus). APAGADO por defecto: se enciende con BVSALA_GATEWAY_SHADOW=1.
   * No toca un byte del tráfico — calcula en asíncrono qué habría costado el
   * turno con la elisión encendida y lo emite como `basis:"shadow"`.
   */
  sombra?: boolean;
  /**
   * S4a · el CANAL DE ENTITLEMENTS. Existe por defecto (`!== false`) siempre
   * que haya clave de servicio, porque de él cuelgan LAS DOS palancas: los
   * diales de elisión (`context_elision`) y la rebaja de TTL (`cache_ttl_tuning`).
   * `BVSALA_GATEWAY_ELISION=0` sigue siendo el freno de emergencia que las
   * apaga a las dos de golpe.
   *
   * OJO CON EL NOMBRE (2026-09-09): esta bandera NO enciende los diales. Hasta
   * hoy armaba las dos palancas a la vez, y apagar la que pierde apagaba
   * también la que gana. Para los diales, ver `dialesElision`.
   */
  elision?: boolean;
  /**
   * S4a-B · los DIALES de elisión del proveedor, la palanca que inyecta
   * `context_management`. **APAGADA por defecto desde el 2026-09-09**, medida
   * en pérdida por tres vías independientes: el simulador honesto la deja en
   * +49 % de coste, el carril sombra lo confirma en producción los días 08 y
   * 09, y la cadena mide R = 4,05 frente a un umbral R* = 0,0127 en
   * fable-5-1 — 319× por encima. Reescribe el prefijo cacheado, y lo que
   * ahorra en lecturas a 0,025× lo paga en escrituras a 2×.
   *
   * Se enciende solo con `BVSALA_GATEWAY_DIALES_ELISION=1` puesto a mano. El
   * feature `context_elision` de la licencia sigue siendo necesario y sigue
   * siendo fail-closed: esto es un tercer interruptor, no un sustituto.
   */
  dialesElision?: boolean;
  /**
   * Palanca C · el MODELO HERMANO (decisión del dueño, 2026-09-09: «haz el C»).
   * Las peticiones que piden `claude-fable-5` viajan con `claude-fable-5-1`:
   * misma entrada, salida y primas de escritura, lectura de caché a 0,00025
   * en vez de 0,001 por 1K (catálogo). El ahorro se MIDE sin contrafactual —
   * el mismo usage a dos precios de catálogo — y entra en `measured_*`.
   *
   * APAGADA por defecto: cambia el `model` que el cliente ve en la respuesta,
   * así que la enciende el cliente con `BVSALA_GATEWAY_SIBLING_MODEL=1`. El
   * feature `sibling_model_routing` de la licencia sigue siendo necesario y
   * fail-closed por el mismo canal que las otras dos; `BVSALA_GATEWAY_ELISION=0`
   * la apaga junto a ellas. NO la arma el anillo 2: no hay A/B que hacer.
   */
  modeloHermano?: boolean;
  /**
   * La licencia ya verificada al arrancar (recogida con la clave de servicio o
   * el respaldo offline). Con ella se construye la verja de cada petición NUEVA.
   * SIN ella el gateway arranca en MODO COMUNITARIO (open core): todas las
   * palancas locales armadas, cero telemetría y cero red hacia BiVelio — no hay
   * licencia que corte peticiones, y el metering queda apagado al no haber
   * clave de servicio que lo autorice.
   */
  license?: GatewayLicense;
  /** Solo tests: TTL del canal de entitlements (por defecto 300 000). */
  entitlementsTtlMs?: number;
  /**
   * Transiciones de licencia y avisos accionables. Por defecto console.error.
   * bin.ts NO lo silencia en los envoltorios: un corte tiene que verse.
   */
  warn?: (line: string) => void;
  /**
   * Opt-in: añade `stream_options.include_usage` a los POST …/chat/completions
   * en stream que no traen `stream_options` (BVSALA_GATEWAY_USAGE_INJECT=1).
   * APAGADO por defecto: el último chunk de esos streams pasa a llegar con
   * `choices: []`, y el código que lee `choices[0]` sin mirar revienta. Sin él,
   * esos streams se reenvían sin medir y el log lo dice.
   */
  usageInject?: boolean;
  /**
   * Los avisos únicos por consola que acompañan a las líneas «not metered» de
   * un stream o una ruta (sin include_usage, sin usage final, sin dialecto). Por
   * defecto, sí. En modo envoltorio (`bvsala claude|codex|…`) el hijo es un TUI
   * dueño de la terminal y un console.warn se pinta encima de sus palabras:
   * bin.ts los apaga ahí, igual que ya apaga el log por petición. La línea de
   * log de cada petición no depende de esto, y los avisos de modelo ilegible o
   * sin precio siguen como estaban.
   */
  avisosDeNoMedido?: boolean;
  /**
   * Cuánto espera `cerrar()` a las mediciones EN VUELO (una gemela que ya
   * escribió su réplica y espera el `finish` de su cliente para medirse) antes
   * de vaciar el emisor. Vencido, se avisa y se cierra igual: el apagado nunca
   * se cuelga por esto. Por defecto, TOPE_MEDICIONES_AL_CERRAR_MS.
   */
  topeMedicionesAlCerrarMs?: number;
  /** Inyectables para tests. */
  fetchImpl?: typeof fetch;
  log?: (linea: string) => void;
}

export interface GatewayArrancado {
  puerto: number;
  cerrar: () => Promise<void>;
  /** El estado de licencia que decidiría la próxima petición. */
  licenseStatus(): GatewayLicenseState;
  /**
   * Cuántas peticiones de este proceso llegaron DEGRADADAS, por tipo
   * (degradacion.ts). Es local: no viaja en el registro de uso, porque la
   * lista blanca de la ingesta no tiene campo para ello.
   */
  degradaciones(): Readonly<Record<TipoDeDegradacion, number>>;
  /**
   * Cuántas peticiones de inferencia se midieron y cuántas se reenviaron sin
   * medir, por motivo (recuento.ts). Local, como `degradaciones`: los
   * envoltorios lo imprimen al salir porque su log por petición va callado.
   */
  medicion(): EstadoDeMedicion;
}

/**
 * Los avisos de «reenviado pero NO medido», uno por proceso y causa. En inglés:
 * los lee quien usa el gateway, no quien lo mantiene.
 */
const AVISO_CHAT_SIN_INCLUDE_USAGE_BASE =
  "[bvsala gateway] streamed /v1/chat/completions requests without stream_options.include_usage carry no usage, " +
  'so they are forwarded but NOT metered. Add stream_options={"include_usage": True} to the call ' +
  "(Node: stream_options: { include_usage: true }); its last chunk then has an empty choices list.";
const AVISO_CHAT_SIN_INCLUDE_USAGE =
  AVISO_CHAT_SIN_INCLUDE_USAGE_BASE +
  " Or start the gateway with BVSALA_GATEWAY_USAGE_INJECT=1 to add it for clients you cannot change.";
// Con la inyección YA puesta no se puede mandar a ponerla: aquí se dice por qué
// no aplicó a esta petición.
const AVISO_CHAT_SIN_INCLUDE_USAGE_CON_INYECCION =
  AVISO_CHAT_SIN_INCLUDE_USAGE_BASE +
  " BVSALA_GATEWAY_USAGE_INJECT=1 is on, but it only adds the option to an uncompressed request body " +
  "that sends no stream_options of its own.";
const avisoSinUsage = (path: string): string =>
  `[bvsala gateway] POST ${path} answered without the provider's final usage, so it was forwarded but NOT metered. ` +
  "Nothing is estimated in its place.";
const avisoSinDialecto = (path: string): string =>
  `[bvsala gateway] POST ${path} is forwarded but NOT metered: the gateway reads usage from /v1/messages, ` +
  "…/chat/completions and …/responses only.";

/** Qué aviso único acompaña a una línea de «not metered», si alguno. */
type AvisoDeNoMedido = "chat" | "chat-con-inyeccion" | "uso" | "dialecto" | null;

/** Rutas que responden JSON sin facturar nada: ni se miden ni se avisan. */
const RUTA_DE_CONTEO = /\/(count_tokens|input_tokens)$/;

/** Cabeceras de transporte que NO se reenvían (hallazgo F0 nº1). */
const CABECERAS_TRANSPORTE = ["content-encoding", "content-length", "transfer-encoding"];

/**
 * Cabeceras hop-by-hop de la RESPUESTA (RFC 9110 §7.6.1): describen el salto
 * proveedor→gateway, no el de gateway→cliente, y no se reenvían nunca. Antes
 * solo se quitaban las de CABECERAS_TRANSPORTE, así que el `connection:
 * keep-alive` del upstream llegaba al cliente —en la primaria y en la réplica
 * de sus gemelas, que reutiliza las mismas cabeceras— aunque el cliente
 * hubiera pedido `Connection: close`, y Node, al ver una `connection` puesta a
 * mano, mantenía viva la conexión contra lo pedido. La conexión del cliente la
 * gestiona Node con lo que pidió el cliente. Las que nombre la propia
 * `connection` del upstream se descartan también (`sinCabecerasDeSalto`).
 */
const CABECERAS_DE_SALTO_EN_RESPUESTA = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Las cabeceras de una respuesta del upstream sin las hop-by-hop (ni las que su `connection` nombra). */
function sinCabecerasDeSalto(cabeceras: Record<string, string>): Record<string, string> {
  const nombradas = new Set(
    (cabeceras["connection"] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
  const limpias: Record<string, string> = {};
  for (const [k, v] of Object.entries(cabeceras)) {
    const n = k.toLowerCase();
    if (CABECERAS_DE_SALTO_EN_RESPUESTA.has(n) || nombradas.has(n)) continue;
    limpias[k] = v;
  }
  return limpias;
}

/**
 * Tope por defecto de la espera de `cerrar()` a las mediciones en vuelo. Una
 * gemela entregada mide en microsegundos tras su `finish`; 5 s cubre de sobra
 * un sistema cargado sin que un cliente atascado retenga el apagado.
 */
const TOPE_MEDICIONES_AL_CERRAR_MS = 5_000;

/**
 * Cabeceras del SALTO cliente→gateway que no viajan al proveedor: las
 * hop-by-hop de RFC 7230 §6.1 más `expect` y `proxy-connection`. Hasta 0.4.20
 * se copiaban tal cual y undici las rechaza antes de abrir la conexión
 * («expect header not supported», «invalid transfer-encoding header»): el
 * gateway respondía 502 «upstream unreachable · TypeError: fetch failed» —el
 * MISMO texto que un upstream caído— sin que la petición saliera. curl ≥ 8.7
 * añade `Expect: 100-continue` a cualquier cuerpo > 1 MB por defecto, así que
 * un probador con curl lo veía sin hacer nada raro. Las que nombre la propia
 * `Connection` (RFC 7230 §6.1: «connection: keep-alive, x-lo-que-sea») se
 * descartan también, en el bucle que copia.
 */
const CABECERAS_DE_SALTO = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

/**
 * El fallo de un fetch con su CAUSA. undici envuelve TODO en «TypeError: fetch
 * failed» y guarda lo que pasó en `cause`: sin ella, un ECONNREFUSED (el
 * upstream no está), un ENOTFOUND (DNS) y una cabecera que undici se negó a
 * mandar se leen exactamente igual en el 502 y en el log. Un AggregateError
 * (varias direcciones probadas) se abre, porque su String() es solo el nombre.
 */
function describirFallo(err: unknown): string {
  const causa = (err as { cause?: unknown } | null)?.cause;
  if (causa === undefined || causa === null) return String(err);
  const detalle =
    causa instanceof AggregateError && causa.errors.length > 0 ? causa.errors.map((e) => String(e)).join("; ") : String(causa);
  return `${String(err)} · cause: ${detalle}`;
}

/**
 * El servidor no pudo ponerse a escuchar. Lleva el `code` de Node (EADDRINUSE,
 * EACCES…) y el puerto que falló para que bin.ts lo traduzca en una línea del
 * producto; el error crudo queda en `cause` para quien depure. Hasta 0.4.20 la
 * promesa rechazaba con el error de Node tal cual y el proceso moría con su
 * traza («node:net … listen EADDRINUSE: address already in use 127.0.0.1:8402»).
 */
export class ErrorDeEscucha extends Error {
  readonly code: string;
  readonly puerto: number;
  constructor(code: string, puerto: number, causa: unknown) {
    super(
      code === "EADDRINUSE"
        ? `port ${puerto} is already in use: the gateway could not start`
        : code === "EACCES"
          ? `port ${puerto} cannot be opened: permission denied`
          : `could not listen on 127.0.0.1:${puerto} (${code})`,
      { cause: causa },
    );
    this.name = "ErrorDeEscucha";
    this.code = code;
    this.puerto = puerto;
  }
}

/** Parte G · ¿las mismas cabeceras, nombre a nombre y valor a valor? */
function mismasCabeceras(a: Record<string, string>, b: Record<string, string>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/**
 * Parte G · ¿llegó la respuesta ENTERA a su cliente? Se resuelve con `finish`
 * (el último byte se entregó al sistema) o con `close` (true solo si ya había
 * terminado: un `close` sin `finish` es un cliente que cortó a mitad). Tras
 * `res.end()` uno de los dos llega siempre, y si ya llegó lo dicen las banderas.
 */
function entregaCompleta(res: ServerResponse): Promise<boolean> {
  if (res.writableFinished) return Promise.resolve(true);
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const alTerminar = (): void => fin(true);
    const alCerrar = (): void => fin(res.writableFinished);
    const fin = (ok: boolean): void => {
      res.off("finish", alTerminar);
      res.off("close", alCerrar);
      resolve(ok);
    };
    res.once("finish", alTerminar);
    res.once("close", alCerrar);
  });
}

export async function arrancarGateway(opts: OpcionesGateway): Promise<GatewayArrancado> {
  // ── OPEN CORE ─────────────────────────────────────────────────────────────
  // Sin licencia el gateway arranca en MODO COMUNITARIO: el ahorro local entero
  // (rebaja de TTL, modelo hermano, esfuerzo, elisión) sin clave de servicio y
  // sin red hacia BiVelio. Una licencia PRESENTE sigue verificándose aquí: un
  // token CADUCADO se acepta —la verja por petición lo cortará con un 402—; uno
  // que no verifica, no.
  const comunidad = !opts?.license;
  let publicKey: string | LicenseKeyset = "";
  let verificada: VerifiedLicense | null = null;
  if (opts?.license) {
    publicKey = effectivePublicKey(opts.license.publicKey);
    const comprobada = verifyGatewayLicense(opts.license.token, publicKey);
    if (!comprobada.ok) throw new Error(`arrancarGateway: the license token does not verify (${comprobada.reason})`);
    verificada = comprobada.license;
  }

  const upstreamBase = (opts.upstream ?? "https://api.anthropic.com").replace(/\/+$/, "");
  // Parte G · solo el origen oficial deja un contador que esté en una factura
  // a precio de lista (ver esUpstreamOficial). Fijo durante la vida del proceso.
  const upstreamOficial = esUpstreamOficial(upstreamBase);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((l: string) => console.log(l));
  const warn = opts.warn ?? ((l: string) => console.error(l));
  const now = opts.license?.now ?? Date.now;
  const baseLicencias = opts.license?.licenseServerUrl?.replace(/\/+$/, "");

  // ── La licencia EN VIVO ─────────────────────────────────────────────────
  // Un gate vivo (reloj real + snapshot de revocaciones compartido con el
  // poller y el renovador) sobre el token verificado. Es lo ÚNICO que lee la
  // verja por petición, junto al `reason` del canal. En modo comunitario no
  // existe: no hay token que vigilar ni revocación que comprobar.
  const revocation = new RevocationSnapshot();
  let live: LiveLicense | null = verificada
    ? buildLiveLicense(verificada, publicKey, revocation, now)
    : null;
  const planActual = (): string | undefined => live?.license.payload.plan;

  let emisor: UsageEmitter | undefined;
  if (opts.serviceAccountKey) {
    emisor = new UsageEmitter({
      url: opts.meteringUrl ?? "https://savings.bivelio.com/api/metering/usage",
      serviceAccountKey: opts.serviceAccountKey,
      surface: "gateway",
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      onAuthError: (status) =>
        avisarUnaVez(
          "gateway-ingest-auth",
          `[bvsala gateway] the usage ingest is rejecting the credential (${status}). ` +
            "Traffic keeps flowing (warn, never break), but this usage is not reaching your dashboard. " +
            "Check BIVELIO_SERVICE_KEY and your subscription status at savings.bivelio.com.",
        ),
    });
    const ci = detectCi();
    if (opts.seatId) emisor.setSeat(opts.seatId, ci);
    else void deriveSeatId(opts.serviceAccountKey).then((s) => emisor?.setSeat(s, ci)).catch(() => {});
    emisor.start();
  } else if (comunidad) {
    avisarUnaVez(
      "gateway-modo-comunitario",
      "[bvsala gateway] COMMUNITY MODE (open core): no BIVELIO_SERVICE_KEY - every local saving lever is on and " +
        "traffic is metered only in the local report routes (x-bvsala-report). Nothing is sent to BiVelio. " +
        "Add a service key to get the cloud dashboard, org entitlements and team metering.",
    );
  } else {
    // Licencia presente (offline) pero sin clave de servicio: no hay org cuyo
    // metering autorizar ni entitlements que consultar.
    avisarUnaVez(
      "gateway-sin-clave",
      "[bvsala gateway] no BIVELIO_SERVICE_KEY: this in-process gateway forwards traffic but does not meter it " +
        "(a service key is what authorizes metering).",
    );
  }

  const coalescedor = opts.coalescer ? new Coalescedor() : null;
  /**
   * Las mediciones EN VUELO: una gemela que ya hizo `res.end()` de su réplica
   * y espera el `finish` de su cliente para medirse. `cerrar()` las espera
   * antes de vaciar el emisor; antes no, y si el `finish` llegaba después del
   * vaciado, ese registro se quedaba en el búfer de un emisor parado (se
   * infra-medía: el informe dejaba de cuadrar con el uso).
   */
  const medicionesEnVuelo = new Set<Promise<void>>();
  const abrirMedicion = (): (() => void) => {
    let cerrarla!: () => void;
    const p = new Promise<void>((resolve) => (cerrarla = resolve));
    medicionesEnVuelo.add(p);
    return () => {
      medicionesEnVuelo.delete(p);
      cerrarla();
    };
  };
  // El carril sombra solo existe con emisor: sin clave de servicio no hay
  // dónde reportar y simular sería gastar CPU del cliente para nada.
  const carrilSombra = opts.sombra && emisor ? new CarrilSombra() : null;
  // El buzón de informes locales (informes-locales.ts): solo guarda lo que una
  // petición pidió con `x-bvsala-report: 1`; sin esa cabecera no hace nada.
  const buzon = new BuzonDeInformes();

  // S4a · el canal de entitlements existe SIEMPRE que haya clave de servicio (sin
  // clave no hay org que consultar), con independencia de `opts.elision`: por él
  // llega también el bloqueo del control plane (`reason`), y `BVSALA_GATEWAY_ELISION=0`
  // apagaba con el canal la revocación. Ahora =0 solo DESARMA las palancas
  // (`palancasArmadas`). El gate REAL de cada palanca sigue siendo su feature
  // (fail-closed). La URL sale de la base del control plane si viene; si no, del
  // mismo origen que la ingesta (meteringUrl), así que los tests apuntan a su
  // plataforma falsa sin opciones nuevas.
  // La memoria de prefijos que gobierna la rebaja de TTL: vive en el proceso
  // del gateway (no persiste, no viaja, no se mide) y solo responde a una
  // pregunta —«¿qué parte de este cuerpo NO estaba ya cacheada por el turno
  // anterior del hilo?»— para rebajar a 5m solo las escrituras gordas
  // (arranque, compactación) y nunca el turno encadenado, donde la prima es
  // calderilla y el fallo cuesta el prefijo entero.
  const memoria = new MemoriaDePrefijos();
  // Y la de TURNOS: lo que cada turno dejó en riesgo de caducar, para que el
  // turno siguiente RESTE el fallo de caché que la rebaja le provoque. Sin
  // ella el ahorro de la palanca era bruto (fallos-ttl.ts).
  const turnos = new MemoriaDeTurnos();
  // El vigía del tráfico degradado: una línea por sesión y tipo, y un contador.
  const vigia = new VigiaDeDegradacion();
  // Lo medido y lo que no, con su motivo: el resumen de salida de los envoltorios.
  const recuento = new RecuentoDeMedicion();

  // S4a · el canal de entitlements existe SIEMPRE que haya clave de servicio
  // (sin clave no hay org que consultar). En modo comunitario el canal es
  // LOCAL y concede las palancas de la casa (context_elision, cache_ttl_tuning,
  // sibling_model_routing, per_turn_effort): open core = el ahorro entero.
  const canal: FuenteDeEntitlements | null = opts.serviceAccountKey
    ? new CanalDeEntitlements({
        url: baseLicencias
          ? `${baseLicencias}/api/org/entitlements`
          : new URL("/api/org/entitlements", opts.meteringUrl ?? "https://savings.bivelio.com/api/metering/usage").toString(),
        serviceAccountKey: opts.serviceAccountKey,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.entitlementsTtlMs !== undefined ? { ttlMs: opts.entitlementsTtlMs } : {}),
        log,
      })
    : comunidad
      ? new CanalComunitario()
      : null;
  const palancasArmadas = canal !== null && opts.elision !== false;

  // ── La verja por petición y sus transiciones ────────────────────────────
  const veredicto = (): Verdict =>
    comunidad
      ? { serve: true, state: "active" }
      : licenseVerdict(live!.gate, canal?.blockReason() ?? null, live!.license.payload);
  // El último estado ANUNCIADO: una línea por transición, nunca una por petición.
  let anunciado: GatewayLicenseState | null = null;
  if (!comunidad) {
    const inicial = licenseVerdict(live!.gate, null, live!.license.payload);
    if (inicial.serve) anunciado = inicial.state;
  }
  const anunciar = (v: Verdict): void => {
    if (comunidad) return;
    const linea = transitionLine(anunciado, v, live!.license.payload);
    anunciado = v.state;
    if (linea) warn(linea);
  };
  let poller: RevocationPoller | undefined;
  let renovador: LicenseRenewer | undefined;
  let ultimoForzadoMs = Number.NEGATIVE_INFINITY;
  const avisosDeLog = new Set<string>();
  const logUnaVez = (clave: string, linea: string): void => {
    if (avisosDeLog.has(clave)) return;
    avisosDeLog.add(clave);
    log(linea);
  };

  // El endpoint rechazó `stream_options` una vez (400/422 con la inyección
  // puesta y 2xx sin ella): la inyección queda apagada el resto del proceso. Es
  // una propiedad del UPSTREAM, y un gateway habla con uno solo.
  let endpointSinStreamOptions = false;

  /**
   * El observador según el DIALECTO de la ruta: `/v1/messages` habla Anthropic;
   * cualquier `…/responses` (`/v1/responses` con API key, `/backend-api/codex/
   * responses` con ChatGPT) habla la Responses API de OpenAI (Codex CLI); y
   * cualquier `…/chat/completions` habla Chat Completions (los SDK oficiales de
   * OpenAI en cualquier lenguaje, Python incluido). Otras rutas SSE no se miden.
   */
  const observadorPara = (pathname: string): ObservadorSse | ObservadorResponses | ObservadorChatCompletions | null => {
    if (pathname === "/v1/messages") return new ObservadorSse();
    if (pathname.endsWith("/responses")) return new ObservadorResponses();
    if (pathname.endsWith("/chat/completions")) return new ObservadorChatCompletions();
    return null;
  };

  /**
   * La línea de «reenviado pero NO medido», con su motivo, y el aviso único
   * que le toque. Hasta aquí una ruta con dialecto que respondía 2xx sin usage
   * pasaba sin dejar rastro: ni registro ni línea. Nada se estima en su lugar.
   */
  const noMedido = (
    requestId: string,
    metodo: string,
    path: string,
    status: number,
    stream: boolean,
    motivo: string,
    aviso: AvisoDeNoMedido,
  ): void => {
    buzon.noMedido(requestId, motivo);
    log(`[gateway] ${metodo} ${path} → ${status}${stream ? " (stream)" : ""} · not metered: ${motivo}`);
    // Al recuento, solo lo que es API: una ruta con dialecto o bajo `/v1/`. Lo
    // demás que un terminal manda por el base URL (telemetría, sondas) no es
    // inferencia, y contarlo como «no medido» asustaría sin motivo.
    if (tieneDialecto(path) || path.startsWith("/v1/")) recuento.noMedida(motivo);
    if (opts.avisosDeNoMedido === false) return;
    if (aviso === "chat") avisarUnaVez("gateway-chat-sin-include-usage", AVISO_CHAT_SIN_INCLUDE_USAGE);
    if (aviso === "chat-con-inyeccion") {
      avisarUnaVez("gateway-chat-sin-include-usage-con-inyeccion", AVISO_CHAT_SIN_INCLUDE_USAGE_CON_INYECCION);
    }
    if (aviso === "uso") avisarUnaVez(`gateway-sin-usage:${path}`, avisoSinUsage(path));
    if (aviso === "dialecto") avisarUnaVez(`gateway-sin-dialecto:${path}`, avisoSinDialecto(path));
  };

  /**
   * Por qué un stream con dialecto acabó SIN usage, y qué aviso le toca. Chat
   * Completions sin `include_usage` no es un corte: nadie pidió el contador, y
   * se arregla distinto (en la llamada, o con la inyección). `inyeccion` es lo
   * que pasó con la inyección en ESTA petición: null si no estaba puesta o no
   * se intentó (la réplica coalescida no lo sabe y no avisa).
   */
  const porQueSinUsoEnStream = (
    obs: ObservadorSse | ObservadorResponses | ObservadorChatCompletions,
    cuerpo: Buffer,
    codificacion: string | undefined,
    inyeccion: "inyectado" | "rechazada-por-el-upstream" | Exclude<InyeccionDeUso["motivo"], "inyectado"> | null,
  ): { motivo: string; aviso: AvisoDeNoMedido } => {
    // Responses que SÍ llegó a su evento final (incomplete o failed) pero sin
    // usage: el final existe, lo que falta es el contador. Se dice tal cual.
    const finalSinUso = obs instanceof ObservadorResponses ? obs.estadoFinal() : null;
    if (finalSinUso !== null && finalSinUso !== "completed") {
      return { motivo: `the response ended as response.${finalSinUso} without usage`, aviso: "uso" };
    }
    const noLoPidio =
      obs instanceof ObservadorChatCompletions &&
      inyeccion !== "inyectado" &&
      pideUsoEnStream(cuerpo, codificacion) !== true;
    if (!noLoPidio) return { motivo: "the stream ended without the provider's final usage event", aviso: "uso" };
    const motivo = "the request did not ask for usage (stream_options.include_usage)";
    // El upstream ya rechazó la opción: el aviso de entonces lo dijo todo, y
    // pedirla en la llamada tampoco serviría.
    if (inyeccion === "rechazada-por-el-upstream") {
      return { motivo: `${motivo}, and the upstream rejects that option`, aviso: null };
    }
    if (inyeccion === "comprimido") {
      return { motivo: `${motivo}; usage injection skips compressed request bodies`, aviso: "chat-con-inyeccion" };
    }
    if (inyeccion !== null) return { motivo, aviso: "chat-con-inyeccion" };
    return { motivo, aviso: "chat" };
  };

  /** Mide y emite el uso de una respuesta ya servida (o replicada). */
  const medir = (
    requestId: string,
    cuerpo: Buffer,
    uso: ReturnType<ObservadorSse["usage"]>,
    coalescida: boolean,
    path: string,
    codificacion?: string,
    atribucion?: Atribucion,
    elision?: ElisionAplicada | null,
    rebaja?: RebajaAplicada | null,
    /** Instante de INICIO de la petición: la caché de prefijos del proveedor
     *  mide sus TTL desde ahí, no desde el fin de la respuesta. */
    inicioMs?: number,
    /** Palanca C · el modelo que pidió el cliente y el que viajó, si difieren. */
    hermano?: CambioDeModelo | null,
    /** Tráfico de suscripción (marcas de protocolo): se mide, no se acredita ahorro. */
    suscripcion?: boolean,
    /** Parte G · solo en una gemela: lo que su primaria dejó al terminar. */
    primaria?: HuellaDeLaPrimaria | null,
    /**
     * Parte G · solo en una gemela: si su cliente recibió la réplica entera y
     * el tier que la respuesta dice haber servido. Sin esto, no entregada: el
     * lado seguro.
     */
    entrega?: { entregada: boolean; tierServido?: string | undefined },
    /**
     * La respuesta es una negativa que Anthropic documenta como NO cobrada
     * (antes de cualquier salida, en `cyber`, `general_harms` o categoría nula):
     * se mide a coste 0 y no acredita ningún ahorro. En una gemela, la de su
     * primaria (es la misma respuesta).
     */
    sinCobro?: boolean,
    /**
     * Licencia Medir · lo que la rebaja de TTL HABRÍA hecho con este cuerpo
     * (marcas contadas, nada reescrito). Solo alimenta el registro `shadow`.
     */
    rebajaSombra?: RebajaAplicada | null,
    /**
     * El turno de este hilo en la memoria de turnos (fallos-ttl.ts): de él sale
     * el fallo de caché que la rebaja del turno ANTERIOR provocó en este, y en
     * él se anota lo que este deja en riesgo para el siguiente.
     */
    turnoTtl?: TurnoTtl | null,
  ): void => {
    if (!emisor || !uso) {
      buzon.noMedido(
        requestId,
        !emisor ? "metering is off: the gateway has no BIVELIO_SERVICE_KEY" : "the provider reported no usage",
      );
      return;
    }
    const em = emisor;
    const usoFinal: UsoSse = uso;
    const model = modeloDelCuerpo(cuerpo, codificacion);
    // Cada petición que se queda sin medir deja SU línea, no solo la primera:
    // el aviso por consola sale una vez por ruta o por modelo, pero quien lee
    // el log tiene que poder contar cuántas se quedaron fuera y por qué.
    const cabeza = `[gateway] POST ${path}${coalescida ? " · COALESCED (call avoided)" : ""}`;
    if (!model) {
      const motivo = `could not read the model from the request body${codificacion ? ` (content-encoding: ${codificacion})` : ""}`;
      log(`${cabeza} · not metered: ${motivo}`);
      recuento.noMedida(motivo);
      buzon.noMedido(requestId, "could not read the model from the request body");
      avisarUnaVez(
        `gateway-sin-modelo:${path}`,
        `[bvsala gateway] could not read the model from the ${path} request body (content-encoding: ${codificacion ?? "none"}); its usage is forwarded but not metered.`,
      );
      return;
    }
    // Palanca C · `model` es el SOLICITADO (se lee del cuerpo ORIGINAL, no del
    // saliente); el coste real se tarifa al SERVIDO, que es lo que se pagó. En
    // el informe viaja el servido: el desglose por modelo del panel (0022)
    // responde «¿qué modelo costó esto?» y debe cuadrar con la factura del
    // proveedor. El solicitado queda en la línea de log de abajo.
    const servido = !coalescida && hermano ? hermano.servido : model;
    // Al precio del día en que LLEGÓ la petición (la vigencia del catálogo).
    const medido = costeMedido(servido, uso, inicioMs);
    if (medido) {
      // Parte G · una gemela se valora por referencia con el contador de su
      // primaria si la regla lo permite; si no, sigue `estimated` y el log dice
      // por qué. Solo gemelas: una petición que viajó se mide con el suyo.
      const valoracion = coalescida
        ? valorarGemelaPorReferencia(model, medido, primaria, jsonDelCuerpo(cuerpo, codificacion), {
            suscripcion: suscripcion === true,
            entregada: entrega?.entregada === true,
            tierServido: entrega?.tierServido,
          })
        : null;
      // EL NETO de la rebaja de TTL. Con la palanca APLICADA el fallo ocurrió
      // y se observa en este usage; en SOMBRA (Medir) viajó intacto y es el
      // contrafactual del banco. En los dos casos el turno se cierra para que
      // el siguiente sepa qué quedó en riesgo. Una gemela no viajó: ni falla
      // ni deja nada cacheado.
      const enSombraTtl = planActual() === "measure";
      let perdidosTtl = 0;
      if (turnoTtl && !coalescida) {
        perdidosTtl = enSombraTtl
          ? perdidosConRebajaEnSombra(turnoTtl, medido.tokens)
          : perdidosConRebajaAplicada(turnoTtl, medido.tokens);
        cerrarTurno(turnoTtl, medido.tokens, {
          sombra: enSombraTtl,
          // Atribuible = la rebaja de ESTE turno se acredita limpia: sin marcas
          // de 5 min del cliente, sin herramientas de servidor, con factura por
          // tokens a precio de lista. Solo entonces su fallo se resta después.
          atribuible:
            !!rebaja && rebaja.rebajadas > 0 && rebaja.yaEran5m === 0 && !rebaja.herramientaDeServidor &&
            suscripcion !== true && upstreamOficial && sinCobro !== true,
          perdidos: perdidosTtl,
        });
      }
      const falloTtl = !enSombraTtl && perdidosTtl > 0 ? { perdidos: perdidosTtl } : null;
      const informe = coalescida
        ? informeCoalescido(requestId, model, medido, atribucion, valoracion?.ok ? valoracion.credit : null, sinCobro === true)
        : informeMedido(
            requestId, servido, medido, atribucion, elision, rebaja, hermano, suscripcion === true, !upstreamOficial, sinCobro === true,
            falloTtl,
          );
      emisor.record(informe);
      if (coalescida) recuento.replica();
      else recuento.medida();
      // El MISMO objeto que va a la ingesta: el cliente que lo pidió ve los
      // números de su panel, sin recalcular nada.
      buzon.medido(requestId, informe);
      // B2 · el suelo del borrado del proveedor: solo existe si hubo borrado,
      // es atribuible a nuestros diales y el modelo tiene precio de lectura.
      const suelo = informe.cost.eliminatedInputFloorCost;
      log(
        `[gateway] POST ${path} ${coalescida ? "· COALESCED (call avoided)" : ""} · ` +
          `${servido !== model ? `${model}→${servido} (sibling model)` : model} · ` +
          `$${(sinCobro ? 0 : medido.costeUsd).toFixed(6)} (in ${medido.tokens.entrada}, cache↑${medido.tokens.cacheEscrita}` +
          `${medido.tokens.cacheEscrita1h ? ` (1h ${medido.tokens.cacheEscrita1h})` : ""} ` +
          `cache↓${medido.tokens.cacheLeida}, out ${medido.tokens.salida})` +
          // S4a · el borrado que el PROVEEDOR declaró para esta respuesta. El
          // CONTEO viaja por eliminatedInputTokens; el DINERO (B2, 0.4.17) por
          // eliminatedInputFloorCost, a precio de LECTURA de caché y solo cuando
          // el borrado es atribuible a nuestros diales (regla del delta).
          (elision
            ? ` · elision: ${elision.borrados} clear(s), ${elision.tokensLimpiados} tok cleared by the provider` +
              (suelo !== undefined
                ? ` · floor $${suelo.toFixed(6)} (cache read price)`
                : elision.tokensLimpiadosToolUses > 0
                  ? elision.atribuible
                    ? " · no cache read price in the catalog: no floor"
                    : " · your own context_management settings: counted, not credited"
                  : elision.tokensLimpiados > 0
                    ? " · thinking only (your config): counted, not credited"
                    : "")
            : "") +
          // El neto de la rebaja de TTL: este turno reescribió lo que la
          // entrada de 5 min del turno anterior dejó caducar, y se le resta.
          (falloTtl
            ? ` · cache TTL miss: ${falloTtl.perdidos} tok rewritten because the 5m entry expired` +
              ` (net $${informe.cost.netSavingsUsd.toFixed(6)} on this call)`
            : "") +
          (sinCobro ? " · refusal the provider does not bill: measured at $0, no saving credited" : "") +
          (suscripcion && !coalescida && (rebaja || hermano)
            ? " · subscription traffic: lever applied, saving not credited (no per-token invoice)"
            : "") +
          (!upstreamOficial && !suscripcion && !coalescida && (rebaja || hermano || elision?.atribuible)
            ? " · unofficial upstream: lever applied, saving not credited (list prices only hold at the provider's own API)"
            : "") +
          (valoracion
            ? valoracion.ok
              ? ` · by reference: floor $${sueloDeReferencia(valoracion.credit).toFixed(6)} (cache read price` +
                `${valoracion.credit.creditedOutputTokens > 0 ? `, ${valoracion.credit.creditedOutputTokens} output tok at temperature 0` : ", no output credited"})`
              : ` · estimated, not by reference: ${valoracion.reason}`
            : ""),
      );
      // ── S2 · el carril sombra: EN ASÍNCRONO, jamás en el camino de la
      // petición (ya está servida y medida). Solo peticiones que viajaron de
      // verdad (una gemela coalescida repite el prompt de su primaria y
      // duplicaría el turno de la cadena) y solo /v1/messages (la política
      // conoce los bloques de Anthropic). Un fallo aquí no puede romper NADA.
      // B2-4 · donde el proveedor YA borró tool_uses por NUESTROS diales, la
      // sombra no EMITE: simularía elidir los mismos tool_result que el
      // proveedor limpió y el panel enseñaría el mismo borrado dos veces (plan
      // S4 § 5). La cadena de simulación sí AVANZA (observar) — si no, el turno
      // siguiente compararía contra un previo viejo y su cifra saldría inflada.
      const borradoNuestro = elision?.atribuible === true && elision.tokensLimpiadosToolUses > 0;
      // LICENCIA MEDIR: lo que las palancas de precio habrían ahorrado sobre ESTE
      // usage, como UN registro `shadow` (la idempotencia es por requestId). Nada se
      // reescribió: es el hipotético. Solo contra el API oficial y con tráfico
      // facturado por token, que es donde la palanca cobraría. Dos piezas, con la
      // MISMA aritmética que acreditan las palancas de pago:
      //  · el modelo hermano (palanca C): el mismo usage a otro precio de catálogo;
      //  · la rebaja de TTL: los tokens que el proveedor facturó como escritura de
      //    1h, a la prima de 5 min (`ahorroDeRebaja`), al precio del modelo que
      //    habría servido. Solo si la capa HABRÍA rebajado (`rebajaSombra`).
      const enMedicionAhora = planActual() === "measure";
      if (enMedicionAhora && !coalescida && path === "/v1/messages" && !suscripcion && upstreamOficial && sinCobro !== true) {
        try {
          const hipotesis = reescribirModelo(cuerpo, codificacion);
          const alternativo = hipotesis ? costeMedido(hipotesis.cambio.servido, usoFinal, inicioMs) : null;
          const conHermano = hipotesis && alternativo && alternativo.costeUsd < medido.costeUsd ? alternativo : null;
          const base = conHermano ?? medido;
          const ahorroTtl = rebajaSombra
            ? ahorroDeRebajaEnSombra(rebajaSombra, base.tokens.cacheEscrita1h, base.precio.inputPer1k)
            : 0;
          // EL NETO, también en la sombra: lo que este turno leyó y con la
          // rebaja habría tenido que reescribir (la entrada de 5 min del turno
          // anterior ya caducada), a la prima a la que se reescribiría. Un turno
          // así sale MÁS caro con la política que sin ella, y se registra igual:
          // una sombra que solo cuenta los turnos que ganan promete el bruto.
          const falloSombra = costeDeFallo({
            perdidos: perdidosTtl,
            inputPer1k: base.precio.inputPer1k,
            cachedInputPer1k: base.precio.cachedInputPer1k,
            primaEscritura: rebajaSombra ? PRIMA_5M : PRIMA_1H,
          });
          const politica = base.costeUsd - ahorroTtl + falloSombra;
          if (politica !== medido.costeUsd) {
            em.record(informeSombra(`${requestId}:shadow`, model, medido.costeUsd, politica, atribucion));
            log(
              `[gateway] measure (shadow) · ${model} · ` +
                [
                  conHermano && hipotesis ? `sibling model ${hipotesis.cambio.servido}` : null,
                  ahorroTtl > 0 ? `cache TTL 1h→5m on ${base.tokens.cacheEscrita1h} written tok` : null,
                  falloSombra > 0 ? `cache miss the 5m TTL would have caused on ${perdidosTtl} tok (+$${falloSombra.toFixed(6)})` : null,
                ]
                  .filter(Boolean)
                  .join(" + ") +
                ` · this call would have cost $${politica.toFixed(6)} instead of $${medido.costeUsd.toFixed(6)} (not applied)`,
            );
          }
        } catch {
          /* la sombra jamás rompe el gateway ni el metering */
        }
      }
      if (carrilSombra && !enMedicionAhora && !coalescida && path === "/v1/messages") {
        setImmediate(() => {
          try {
            const json = jsonDelCuerpo(cuerpo, codificacion);
            if (!json || typeof json !== "object") return;
            const paso = carrilSombra.observar({
              cuerpo: json as { model?: unknown; messages?: unknown; system?: unknown; tools?: unknown },
              uso: usoFinal,
              model,
              at: inicioMs ?? Date.now(),
              ...(atribucion?.sessionId !== undefined ? { sessionId: atribucion.sessionId } : {}),
              ...(atribucion?.agentId !== undefined ? { agentId: atribucion.agentId } : {}),
            });
            if (!paso) return;
            if (borradoNuestro) {
              log(`[gateway] shadow estimate · ${model} · the provider already cleared context via our settings: chain advances, nothing emitted`);
              return;
            }
            em.record(informeSombra(`${requestId}:shadow`, model, paso.baselineUsd, paso.politicaUsd, atribucion));
            log(
              `[gateway] shadow estimate · ${model} · baseline $${paso.baselineUsd.toFixed(6)} → with elision $${paso.politicaUsd.toFixed(6)}`,
            );
          } catch {
            /* la sombra jamás rompe el gateway ni el metering */
          }
        });
      }
    } else {
      buzon.noMedido(requestId, `model "${servido}" has no list price in the catalog`);
      log(`${cabeza} · not metered: model "${servido}" has no list price in the catalog`);
      recuento.noMedida(`model "${servido}" has no list price in the catalog`);
      avisarUnaVez(
        `gateway-sin-precio:${servido}`,
        `[bvsala gateway] model "${servido}" is not in the price catalog; its usage is forwarded but not metered.`,
      );
    }
  };

  /**
   * La firma de caché de una petición /v1/messages ya servida: el cuerpo del
   * CLIENTE (lo que pidió) contra el usage del PROVEEDOR (lo que pasó). Solo se
   * parsea el cuerpo cuando el usage tiene la forma de una degradación, y un
   * fallo aquí no puede romper nada: la respuesta ya está entregada.
   */
  const vigilarCache = (
    path: string,
    cuerpo: Buffer,
    codificacion: string | undefined,
    uso: UsoSse | null,
    ttlReescrito: boolean,
    sesion: string | undefined,
  ): void => {
    if (path !== "/v1/messages" || uso === null || !usoConFormaDeDegradacion(uso)) return;
    // Las dos firmas exigen marcas: un cuerpo sin comprimir que no dice
    // «cache_control» en ningún sitio no se parsea.
    const sinComprimir = codificacion === undefined || codificacion === "" || codificacion === "identity";
    if (sinComprimir && !cuerpo.includes('"cache_control"')) return;
    try {
      const json = jsonDelCuerpo(cuerpo, codificacion);
      if (json === null || typeof json !== "object" || Array.isArray(json)) return;
      const tipo = degradacionDeCache({
        vista: verMarcasDeCache(json as Record<string, unknown>),
        uso,
        ttlReescritoPorLaCapa: ttlReescrito,
      });
      if (tipo !== null && vigia.anotar(tipo, sesion)) {
        log(
          lineaDeDegradacion(tipo, {
            sesion,
            entrada: uso.input_tokens ?? 0,
            escrita5m: uso.cache_creation?.ephemeral_5m_input_tokens ?? 0,
          }),
        );
      }
    } catch {
      /* el vigía jamás rompe el gateway */
    }
  };

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const inicioMs = Date.now();

    // ── LA VERJA DE LICENCIA (LICENSE §2) ───────────────────────────────────
    // ANTES de leer el cuerpo, de la coalescencia y de cualquier fetch: el ÚNICO
    // punto del camino de una petición que lee la licencia. Una petición que pasa
    // de aquí termina aunque la licencia caduque o se revoque un milisegundo
    // después — jamás se corta lo que está en vuelo; solo las NUEVAS reciben 402.
    // Todas las rutas quedan verjadas; el `upgrade` WebSocket sigue en 426.
    const v = veredicto();
    anunciar(v);
    if (!v.serve) {
      // Un corte fuerza una recogida (≤ 1/min): una licencia reemitida o
      // renovada se adopta sola sin esperar a la vuelta horaria.
      const t = now();
      if (renovador && t - ultimoForzadoMs >= FORCED_RENEWAL_MIN_INTERVAL_MS) {
        ultimoForzadoMs = t;
        void renovador.check({ force: true });
      }
      req.resume();
      res.writeHead(402, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-bvsala-license-status": v.state,
      });
      res.end(req.method === "HEAD" ? undefined : refusalBody(v.state));
      let ruta = "/";
      try {
        ruta = new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        /* una ruta ilegible no puede tumbar el 402: solo es para el log */
      }
      log(`[gateway] ${req.method} ${ruta} → 402 (license ${v.state})`);
      return;
    }

    // ── LA LICENCIA MEDIR · modo sombra ─────────────────────────────────────
    // Con el plan `measure` la pasarela es un PASO LIMPIO: ninguna palanca
    // (diales, modelo hermano, esfuerzo, TTL), ni coalescencia, ni inyección de
    // usage, ni carril de elisión — el cuerpo sale al upstream byte a byte como
    // lo mandó el cliente. Se decide POR PETICIÓN porque la licencia se renueva
    // en caliente: al recoger la de pago, la siguiente petición ya las arma.
    const enMedicion = planActual() === "measure";
    if (enMedicion) avisarUnaVez("gateway-licencia-medir", AVISO_GATEWAY_MEDIR);

    // ── LAS RUTAS LOCALES (/_bvsala/v1/…) · informes-locales.ts ─────────────
    // Detrás de la verja de licencia, como todo, y jamás hacia el upstream.
    const local = rutaLocal(req.url);
    if (local !== null) {
      await atenderRutaLocal(req, res, local, {
        buzon,
        estado: () => ({
          schema: ESQUEMA_ESTADO,
          gateway: "bvsala",
          version: BV_SALA_VERSION,
          upstream: origenPublico(upstreamBase),
          license: comunidad
            ? { state: "active", plan: "community", expiresAt: null }
            : {
                state: v.state,
                plan: planActual() ?? null,
                expiresAt: live ? isoDay(live.license.payload.expires_at) : null,
              },
          metering: emisor !== undefined,
          reports: { requestHeader: CABECERA_PIDE_INFORME, responseHeader: CABECERA_ID_DE_PETICION, capacity: buzon.limite },
        }),
      });
      return;
    }
    // ¿Pidió esta petición su informe? Solo entonces se abre buzón, se lee el id
    // de la respuesta y se añade `x-bvsala-request-id`. Sin la cabecera, nada.
    const conInforme = pideInforme(req.headers[CABECERA_PIDE_INFORME]);
    const vigiaId = conInforme ? new VigiaDeIdDeRespuesta() : null;
    if (conInforme) {
      let ruta = "/";
      try {
        ruta = new URL(req.url ?? "/", "http://x").pathname;
      } catch {
        /* una ruta ilegible se guarda como "/" */
      }
      buzon.abrir(requestId, ruta);
    }
    const conId = (cabeceras: Record<string, string | string[] | number | undefined>) =>
      conInforme ? { ...cabeceras, [CABECERA_ID_DE_PETICION]: requestId } : cabeceras;
    // El estado que respondió el upstream, para el motivo de un informe que nada cerró.
    let estadoUpstream: number | null = null;
    // La petición está viva solo mientras el cliente la escucha. Si se va —Esc en
    // Claude Code, cierra la pestaña— se ABORTA el upstream: antes seguía
    // generando la completion entera y facturándola sin que nadie la leyera. El
    // guard `writableEnded` distingue «el cliente se fue» del `close` normal que
    // llega tras un res.end() correcto.
    const ac = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });

    let captura: ReturnType<Coalescedor["registrar"]> = null;
    let url = new URL(req.url ?? "/", upstreamBase);
    // Fuera del try: si el cliente cierra la conexión ANTES de que el upstream
    // termine (Codex CLI lo hace nada más recibir `response.completed`), la
    // medición del camino normal no se alcanza, pero el usage YA observado es
    // del proveedor y se mide igual — el corte del cliente no lo desdice.
    let observador: ObservadorSse | ObservadorResponses | ObservadorChatCompletions | null = null;
    let cuerpoPeticion: Buffer = Buffer.alloc(0);
    let medida = false;
    // El upstream respondió 2xx: un corte del cliente antes del usage final solo
    // es «no medido» si había algo que medir (un error del proveedor no factura).
    let respuestaOk = false;
    // B2 · ¿un borrado que declare el proveedor será ATRIBUIBLE a nuestros
    // diales? La regla del delta (plan § 2.4) en dos mitades: (1) la palanca
    // cambió el clear_tool_uses que traía el cliente, y (2) los diales que
    // traía NO habrían disparado por sí solos sobre el prompt ORIGINAL — la
    // entrada que el proveedor midió MÁS lo que borró, contra su trigger
    // efectivo. Si habrían disparado, el ahorro es suyo: se cuenta, no se
    // acredita. Fuera del try: el camino del cliente que cierra a mitad
    // (catch) también mide, y también acredita.
    let diales: { nuestros: boolean; triggerDelCliente: number | null } | null = null;
    // Palanca C · fuera del try para que la ruta abortada (el cliente cerró tras
    // el usage final) también tarife al modelo que de verdad viajó.
    let hermano: CambioDeModelo | null = null;
    // Con las cabeceras ORIGINALES del cliente (antes de que las palancas añadan
    // betas). Fuera del try por la misma razón que `hermano`.
    let suscripcion = false;
    // ¿La palanca de TTL reescribió lo que viajó? El vigía lo necesita también en
    // la ruta abortada (catch), donde `rebaja` ya no está a la vista.
    let ttlReescrito = false;
    const atribuir = (
      e: ElisionAplicada | null,
      uso: ReturnType<ObservadorSse["usage"]>,
    ): ElisionAplicada | null => {
      if (e === null || diales === null || !diales.nuestros) return e;
      // La escritura de caché como la lee costeMedido: el total manda y, si
      // faltara, se reconstruye del desglose por TTL (quedarse corto aquí
      // sobre-acreditaría: la entrada parecería menor que el trigger del cliente).
      const desglose = uso?.cache_creation;
      const cacheEscrita =
        uso?.cache_creation_input_tokens ??
        (desglose?.ephemeral_5m_input_tokens ?? 0) + (desglose?.ephemeral_1h_input_tokens ?? 0);
      const entradaAntes = (uso?.input_tokens ?? 0) + (uso?.cache_read_input_tokens ?? 0) + cacheEscrita + e.tokensLimpiados;
      const suyo = diales.triggerDelCliente !== null && entradaAntes >= diales.triggerDelCliente;
      return { ...e, atribuible: !suyo };
    };
    const ce = req.headers["content-encoding"];
    const codificacion = Array.isArray(ce) ? ce[0] : ce;
    // Atribución de sesión/subagente: Claude Code manda x-claude-code-session-id
    // (y agent-id en subagentes). Solo pasan identidades que la verja del ingest
    // aceptaría — un valor raro aquí tiraría el LOTE entero con un 400. Son ids
    // opacos de sesión, jamás de usuario (la doc de Anthropic lo prohíbe).
    const idSeguro = (v: string | string[] | undefined): string | undefined => {
      const s = Array.isArray(v) ? v[0] : v;
      return s !== undefined && /^[A-Za-z0-9._:/-]{1,128}$/.test(s) ? s : undefined;
    };
    const sesionId = idSeguro(req.headers["x-claude-code-session-id"]);
    const agenteId = idSeguro(req.headers["x-claude-code-agent-id"]);
    const atribucion: Atribucion | undefined =
      sesionId !== undefined || agenteId !== undefined
        ? { ...(sesionId !== undefined ? { sessionId: sesionId } : {}), ...(agenteId !== undefined ? { agentId: agenteId } : {}) }
        : undefined;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const cuerpo = Buffer.concat(chunks);
      cuerpoPeticion = cuerpo;
      url = new URL(req.url ?? "/", upstreamBase);

      // ── F2 · coalescencia (solo bajo bandera e inferencia de lectura) ──
      const coalescible =
        coalescedor !== null &&
        !enMedicion &&
        cuerpo.length > 0 &&
        esOperacionCoalescible(req.method ?? "", url.pathname);
      // La clave lleva ahora las cabeceras de identidad (credencial, versión,
      // betas): sin ellas, una gemela con OTRA credencial recibía la respuesta
      // de la primaria.
      const material = materialDeCabeceras((n) => {
        const v = req.headers[n];
        return Array.isArray(v) ? v.join(", ") : v;
      });
      const clave = coalescible ? claveDePeticion("POST", url.pathname + url.search, cuerpo, material) : "";
      if (coalescible) {
        if (coalescedor.tieneEnVuelo(clave)) {
          const replica = await coalescedor.esperar(clave);
          if (replica) {
            // Desde aquí hasta medirse, esta gemela es una medición en vuelo que
            // `cerrar()` espera (ver `medicionesEnVuelo`).
            const medicionCerrada = abrirMedicion();
            try {
              // La gemela recibe la réplica íntegra de la primaria — cero viaje.
              // Parte G · si su cliente ya se fue mientras esperaba (el watchdog
              // de un terminal, un Esc), la réplica no llega a nadie: se observa
              // igual para decir lo mismo en el log, pero no se escribe.
              const seFueAntes = ac.signal.aborted || res.destroyed;
              if (!seFueAntes) res.writeHead(replica.status, conId(replica.headers));
              estadoUpstream = replica.status;
              const obs = observadorPara(url.pathname) ?? new ObservadorSse();
              for (const ch of replica.chunks) {
                if (!seFueAntes) res.write(ch);
                obs.observar(ch);
                vigiaId?.observar(ch);
              }
              // El id de la respuesta: del stream si lo es, si no del JSON (stream:false).
              if (vigiaId) buzon.anotarRespuesta(requestId, vigiaId.valor() ?? idDeCuerpoJson(Buffer.concat(replica.chunks)));
              if (!seFueAntes) res.end();
              // ¿Llegó ENTERA? `finish` = el último byte se entregó al sistema;
              // un `close` sin `finish` = el cliente cortó a mitad. Una llamada
              // evitada que su cliente no recibió no se valora por referencia.
              const entregada = seFueAntes ? false : await entregaCompleta(res);
              // Una réplica JSON (stream:false) trae el usage en el cuerpo, no en
              // eventos — mismo hueco que el camino primario (S0.2 del plan). La
              // MISMA verja de DIALECTO que la primaria: cada ruta se lee con su
              // forma de usage, y una ruta sin dialecto no se lee (sin ella, un
              // `usage` de otra forma emitía un registro fantasma de 0 tokens). Y
              // el usage FINAL, como la primaria: un stream cortado no es medida.
              const usoReplica = obs.usageFinal() ?? usoDeJsonPorRuta(url.pathname, Buffer.concat(replica.chunks));
              if (usoReplica === null) {
                // La primaria ya dijo lo suyo (línea y aviso): la gemela deja su
                // línea y nada más. count_tokens no factura: ni línea.
                if (emisor && !RUTA_DE_CONTEO.test(url.pathname)) {
                  const esStreamReplica = String(replica.headers["content-type"] ?? "").includes("text/event-stream");
                  noMedido(
                    requestId,
                    req.method ?? "POST",
                    url.pathname,
                    replica.status,
                    esStreamReplica,
                    !tieneDialecto(url.pathname)
                      ? "no usage dialect for this route"
                      : esStreamReplica
                        ? porQueSinUsoEnStream(obs, cuerpo, codificacion, null).motivo
                        : "the response carried no usage",
                    null,
                  );
                }
                return;
              }
              // Sin `hermano` A PROPÓSITO (revisión del 10-09): una llamada
              // EVITADA se valora al precio del modelo SOLICITADO, que es lo que
              // el cliente habría pagado sin la capa; su coste real es 0. Tarifarla
              // al servido restaría a la baseline el ahorro de C sobre una
              // petición que C no tocó porque nunca viajó.
              //
              // Parte G · la suscripción de la GEMELA se mira con sus propias
              // cabeceras (la clave ya iguala las de identidad, pero la regla no
              // puede depender de eso), y la huella de la primaria viaja con la
              // réplica: sin ella no hay referencia.
              const betaGemela = req.headers["anthropic-beta"];
              const suscripcionGemela = isSubscriptionTraffic(
                url.pathname,
                Array.isArray(betaGemela) ? betaGemela.join(", ") : betaGemela,
                upstreamBase,
              );
              medir(
                requestId,
                cuerpo,
                usoReplica,
                true,
                url.pathname,
                codificacion,
                atribucion,
                null,
                null,
                inicioMs,
                null,
                suscripcionGemela,
                replica.primaria ?? null,
                { entregada, tierServido: tierServidoDeRespuesta(url.pathname, Buffer.concat(replica.chunks)) },
                // La réplica ES la respuesta de la primaria: si esa negativa no se
                // cobró, la llamada que la gemela evitó valía 0 $.
                url.pathname === "/v1/messages" &&
                  ((obs instanceof ObservadorSse && obs.negativaNoCobrada()) ||
                    negativaNoCobradaEnJson(url.pathname, Buffer.concat(replica.chunks))),
              );
              return;
            } finally {
              medicionCerrada();
            }
          }
          // Primaria fallida o desbordada: la gemela viaja por su cuenta.
        } else {
          captura = coalescedor.registrar(clave);
        }
      }

      // Las que nombra `Connection` son hop-by-hop por declaración del cliente
      // (RFC 7230 §6.1); Node ya entrega los nombres en minúsculas.
      const conexion = req.headers["connection"];
      const nombradasEnConnection = new Set(
        (Array.isArray(conexion) ? conexion.join(",") : (conexion ?? ""))
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s !== ""),
      );
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host" || k === "content-length" || v === undefined) continue;
        if (CABECERAS_DE_SALTO.has(k) || nombradasEnConnection.has(k)) continue;
        // La cabecera del informe es del GATEWAY: no viaja al proveedor.
        if (k === CABECERA_PIDE_INFORME) continue;
        h[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      // Foto de las cabeceras ANTES de que las palancas las toquen: el
      // reintento intacto de C (abajo) reenvía exactamente lo que mandó el cliente.
      const cabecerasOriginales: Record<string, string> = { ...h };
      suscripcion = isSubscriptionTraffic(url.pathname, cabecerasOriginales["anthropic-beta"], upstreamBase);

      // ── S4a · la palanca de diales (doble opt-in, passthrough ante la duda) ──
      // Se ajusta SOLO context_management + la beta; la MEDICIÓN (los medir()
      // de abajo) y la clave de coalescencia siguen usando el cuerpo ORIGINAL
      // del cliente. Tres interruptores: la bandera local (palancas armadas),
      // el feature per-org (fail-closed), y este try — cualquier anomalía
      // reenvía el cuerpo intacto, jamás un error.
      let cuerpoSaliente = cuerpo;
      if (
        palancasArmadas &&
        !enMedicion &&
        // 2026-09-09 · cuarto interruptor, y el que manda: los diales quedan
        // APAGADOS salvo que alguien los arme a mano. Ver `dialesElision`.
        opts.dialesElision === true &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canal!.tiene("context_elision")
      ) {
        try {
          const ajustado = ajustarDiales(cuerpo, codificacion);
          if (ajustado !== null) {
            cuerpoSaliente = ajustado.cuerpo;
            diales = { nuestros: ajustado.nuestros, triggerDelCliente: ajustado.triggerDelCliente };
            h["anthropic-beta"] = conBetaDeElision(h["anthropic-beta"]);
          }
        } catch {
          /* passthrough */
        }
      }

      // ── PALANCA C · el modelo hermano (fable-5 → fable-5-1) ─────────────
      // Misma disciplina que los diales: bandera local EXPLÍCITA (`modeloHermano`,
      // porque cambia el `model` que el cliente ve), feature per-org fail-closed
      // y un try que ante cualquier anomalía reenvía lo que ya llevara
      // `cuerpoSaliente`. Reescribe SOLO `model`, también en count_tokens —
      // esa ruta no se mide (esJsonMedible), pero el cliente debe estimar
      // contra el modelo que de verdad va a responderle. La MEDICIÓN sigue
      // leyendo el modelo SOLICITADO del cuerpo original; el servido viaja en
      // `hermano` y el ahorro es la resta de dos precios de catálogo sobre el
      // mismo usage (ver construirInforme).
      // EL CATÁLOGO DE HERRAMIENTAS, DICHO EN VOZ ALTA UNA VEZ. No cambia la
      // petición: solo avisa de que el cliente manda su catálogo entero pudiendo
      // no hacerlo. Se mira sobre el cuerpo ORIGINAL y solo si viene sin
      // comprimir, que es como viaja el tráfico de Claude Code.
      if (req.method === "POST" && url.pathname === "/v1/messages" && (codificacion ?? "") === "") {
        try {
          const vista = verHerramientas(cuerpo.toString("utf8"));
          const aviso = avisoDeBusquedaDeHerramientas(vista);
          if (aviso) {
            avisarUnaVez("gateway-busqueda-herramientas", aviso);
            // Y como tráfico degradado, pero SOLO el de Claude Code: es el
            // cliente que la apaga al ver un proxy delante (este incluido). Un
            // agente con 40 herramientas que nunca usó tool search no está
            // «degradado». Contada siempre, dicha una vez por sesión.
            if (esTraficoDeClaudeCode(req.headers) && vigia.anotar("busquedaApagada", sesionId)) {
              log(lineaDeDegradacion("busquedaApagada", { sesion: sesionId, definiciones: vista.definiciones }));
            }
          }
        } catch {
          /* un aviso jamás puede tumbar una petición */
        }
      }

      const quiereHermano =
        palancasArmadas &&
        !enMedicion &&
        opts.modeloHermano === true &&
        req.method === "POST" &&
        (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens");
      // La bandera puesta y la licencia sin el feature se dice UNA vez: sin
      // esto, quien paga y enciende C ve pasar el cuerpo intacto en silencio.
      if (quiereHermano && !canal!.tiene("sibling_model_routing")) {
        avisarUnaVez(
          "gateway-hermano-sin-feature",
          "[bvsala gateway] sibling model routing: the flag is set but your org's license does not include " +
            "sibling_model_routing; the request is forwarded unchanged (fail-closed).",
        );
      }
      if (quiereHermano && canal!.tiene("sibling_model_routing")) {
        try {
          // Si los diales ya reescribieron, `cuerpoSaliente` es JSON plano.
          const cod = cuerpoSaliente === cuerpo ? codificacion : "identity";
          const reescrito = reescribirModelo(cuerpoSaliente, cod, { betas: h["anthropic-beta"] });
          if (reescrito !== null) {
            cuerpoSaliente = reescrito.cuerpo;
            hermano = reescrito.cambio;
          }
        } catch {
          /* passthrough */
        }
      }

      // ── PALANCA D · EL ESFUERZO POR TURNO ───────────────────────────────
      // La primera que llega a la SALIDA, que es lo único que paga precio de
      // lista ($486,06 de $3.959,73) y donde el pensamiento es el 37,7 %.
      //
      // Y la primera que NO paga peaje de caché, que es su razón de ser: el dial
      // se AÑADE al final de `messages` en vez de cambiar `output_config` en la
      // raíz. Un cambio en la raíz invalida la caché de mensajes —la trampa que
      // mató a la poda, a la elisión y al patrón de context-mode—; un mensaje
      // añadido no reescribe nada anterior, así que el prefijo sigue casando y
      // los bloques de pensamiento anteriores siguen siendo válidos.
      //
      // Misma disciplina triple que C: nivel declarado por el operador, feature
      // per-org fail-closed, canal S4a, y un try que ante cualquier anomalía
      // reenvía lo que ya llevara `cuerpoSaliente`.
      let esfuerzoPuesto = false;
      if (
        palancasArmadas &&
        !enMedicion &&
        esNivel(opts.esfuerzo) &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canal!.tiene("per_turn_effort")
      ) {
        try {
          const cod = cuerpoSaliente === cuerpo ? codificacion : "identity";
          const puesto = aplicarEsfuerzo(cuerpoSaliente, opts.esfuerzo, cod);
          if (puesto !== null) {
            cuerpoSaliente = puesto.cuerpo;
            h["anthropic-beta"] = conBetaDeEsfuerzo(h["anthropic-beta"]);
            esfuerzoPuesto = true;
          }
        } catch {
          /* passthrough */
        }
      }

      // ── LA PALANCA DE TARIFA · TTL de escritura 1h → 5m ─────────────────
      // Misma disciplina que la de arriba: bandera local implícita (palancas armadas),
      // feature per-org fail-closed, y un try que ante cualquier anomalía
      // reenvía lo que ya llevara `cuerpoSaliente`. Se aplica DESPUÉS de los
      // diales para que ambas palancas compongan sin pisarse: la de diales
      // añade `context_management`, esta reescribe `cache_control.ttl`.
      //
      // Y va sobre `cuerpoSaliente`, no sobre `cuerpo`: la MEDICIÓN y la clave
      // de coalescencia siguen usando el cuerpo original del cliente.
      let rebaja: RebajaAplicada | null = null;
      let turnoTtl: TurnoTtl | null = null;
      if (
        palancasArmadas &&
        !enMedicion &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canal!.tiene("cache_ttl_tuning")
      ) {
        try {
          // La rebaja solo sabe leer cuerpos SIN comprimir; si los diales ya
          // reescribieron, `cuerpoSaliente` es JSON plano y `codificacion`
          // dejó de describirlo — de ahí el "identity" en ese caso.
          const cod = cuerpoSaliente === cuerpo ? codificacion : "identity";
          const json = parsearMensajes(cuerpoSaliente, cod);
          if (json !== null) {
            const huella = huellaDe(json);
            // Sesión + system: el agente principal y sus subagentes comparten
            // el id de sesión de Claude Code pero no el prefijo — cada uno es
            // su propio hilo de caché.
            const clave = `${atribucion?.sessionId ?? "sin-sesion"}:${huella.system}`;
            const ahoraMs = Date.now();
            const anterior = memoria.ultima(clave, ahoraMs);
            memoria.anotar(clave, huella, ahoraMs);
            // Se abre SIEMPRE, se rebaje o no: el turno que sufre el fallo de
            // la rebaja anterior casi nunca va rebajado (es un turno encadenado).
            turnoTtl = turnos.abrir(clave, huella, ahoraMs, false);
            if (decidirRebaja({ fraccionNueva: fraccionNueva(anterior, huella) })) {
              const rebajado = rebajarTtlDeCache(json);
              if (rebajado !== null) {
                turnoTtl.rebajado = true;
                cuerpoSaliente = rebajado.cuerpo;
                // Con herramientas de servidor la palanca se aplica igual (el
                // cliente paga menos) pero no se acredita: parte de la escritura
                // a 5 min puede ser la que la API hace sola tras una de ellas.
                rebaja = {
                  rebajadas: rebajado.rebajadas,
                  yaEran5m: rebajado.yaEran5m,
                  herramientaDeServidor: rebajado.herramientaDeServidor,
                };
                ttlReescrito = true;
              }
            }
          }
        } catch {
          /* passthrough */
        }
      }

      // ── LA REBAJA DE TTL EN SOMBRA (licencia Medir) ─────────────────────
      // La MISMA decisión que la palanca de arriba (memoria de prefijos por
      // hilo, fracción nueva, marcas de 1h que se rebajarían), sobre el cuerpo
      // del cliente y SIN reescribir nada: `cuerpoSaliente` no se toca y
      // `ttlReescrito` sigue en false. Solo anota QUÉ habría hecho la capa; el
      // dinero lo pone medir() con el usage medido (`rebajaSombra`), como
      // registro `shadow` — nunca aplicado, nunca cobrable. Sin mirar el canal
      // de features: la Medir no trae ninguna, y la pregunta es qué haría la
      // capa de pago, que lleva la rebaja encendida por defecto en Anthropic.
      let rebajaSombra: RebajaAplicada | null = null;
      if (enMedicion && opts.elision !== false && req.method === "POST" && url.pathname === "/v1/messages") {
        try {
          const json = parsearMensajes(cuerpo, codificacion);
          if (json !== null) {
            const huella = huellaDe(json);
            const clave = `${atribucion?.sessionId ?? "sin-sesion"}:${huella.system}`;
            const ahoraMs = Date.now();
            const anterior = memoria.ultima(clave, ahoraMs);
            memoria.anotar(clave, huella, ahoraMs);
            turnoTtl = turnos.abrir(clave, huella, ahoraMs, false);
            if (decidirRebaja({ fraccionNueva: fraccionNueva(anterior, huella) })) {
              // `json` es una copia parseada del Buffer: marcarla no toca lo que viaja.
              const hipotesis = rebajarTtlDeCache(json);
              if (hipotesis !== null) {
                turnoTtl.rebajado = true;
                rebajaSombra = {
                  rebajadas: hipotesis.rebajadas,
                  yaEran5m: hipotesis.yaEran5m,
                  herramientaDeServidor: hipotesis.herramientaDeServidor,
                };
              }
            }
          }
        } catch {
          /* la sombra jamás rompe el gateway */
        }
      }

      // ── EL USAGE DE CHAT COMPLETIONS EN STREAM (opt-in) ────────────────
      // Un stream de Chat Completions solo trae usage si la petición lo pide
      // (`stream_options.include_usage`). Con BVSALA_GATEWAY_USAGE_INJECT=1 el
      // gateway lo pide por el cliente que no puede cambiarse: inserción
      // TEXTUAL tras la `{` inicial, sin reserializar. Apagado por defecto: el
      // último chunk de esos streams llega con `choices: []`, y el código que
      // lee `choices[0]` sin mirar revienta. La MEDICIÓN y la clave de
      // coalescencia siguen usando `cuerpo`, el original.
      let inyectado = false;
      // Qué pasó con la inyección en ESTA petición, para que la línea de «not
      // metered» diga por qué no aplicó en vez de mandar a poner una variable
      // que ya está puesta. null: la inyección no estaba puesta.
      let inyeccion: Parameters<typeof porQueSinUsoEnStream>[3] = null;
      const esChat = req.method === "POST" && url.pathname.endsWith("/chat/completions");
      if (esChat && emisor && opts.usageInject === true && !enMedicion) {
        if (endpointSinStreamOptions) {
          inyeccion = "rechazada-por-el-upstream";
        } else {
          try {
            const r = inyectarIncludeUsage(cuerpo, codificacion);
            inyeccion = r.motivo;
            if (r.cuerpo) {
              cuerpoSaliente = r.cuerpo;
              inyectado = true;
            }
          } catch {
            /* passthrough */
          }
        }
      }

      let upstream: Response;
      // Parte G · lo que de verdad viajó, para la huella de la primaria. El
      // reintento intacto de abajo lo vuelve a poner en el cuerpo y las
      // cabeceras del cliente.
      let cuerpoEnviado: Buffer = cuerpoSaliente;
      let cabecerasEnviadas: Record<string, string> = h;
      try {
        upstream = await fetchImpl(url, {
          method: req.method,
          headers: h,
          body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : cuerpoSaliente,
          redirect: "manual",
          signal: ac.signal,
        });
      } catch (err) {
        // El upstream ni siquiera respondió (DNS/conexión) — distinto de un
        // corte a mitad de stream, que cae en el catch de fuera.
        captura?.abortar();
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bvsala gateway: upstream unreachable", detail: describirFallo(err) }));
        }
        log(`[gateway] ${req.method} ${url.pathname} → upstream unreachable: ${describirFallo(err)}`);
        return;
      }

      // ── EL REINTENTO INTACTO ──────────────────────────────────────────
      // Un 400 tras tocar el cuerpo puede ser culpa nuestra. Con la palanca C,
      // porque fable-5-1 rechaza cosas que fable-5 acepta. Con la D, porque la
      // beta del esfuerzo por turno estaba abierta como beta limitada y una org
      // sin acceso recibe un 400 de una petición que sin nosotros iba bien. Con
      // la de TTL o los diales, por una regla de la API que no hayamos previsto
      // (el orden de los TTL, por ejemplo). Se reenvía UNA vez el cuerpo y las
      // cabeceras ORIGINALES del cliente — sin C, sin diales, sin rebaja — y se
      // mide lo que de verdad viajó. Si el 400 era del cliente, ve el mismo 400
      // que habría visto sin la capa; cuesta un viaje extra en una petición que
      // ya iba a fallar. Nunca en streaming a medias: aquí no se ha escrito ni
      // una cabecera al cliente todavía.
      //
      // La condición es ESTRUCTURAL, no una lista de banderas: si lo que viajó
      // no es el cuerpo y las cabeceras del cliente, un 400 se reintenta intacto.
      // Una palanca futura queda cubierta sin tener que acordarse de añadirse.
      //
      // La inyección de include_usage usa el MISMO reintento, y además ante un
      // 422: hay endpoints compatibles que validan el esquema y rechazan un
      // campo que no conocen con 422. El rechazo llega antes de generar nada,
      // así que el reintento no paga tokens.
      const tocadaPorLaCapa = cuerpoEnviado !== cuerpo || !mismasCabeceras(cabecerasEnviadas, cabecerasOriginales);
      const rechazoDeNuestroCambio =
        (tocadaPorLaCapa && upstream.status === 400) || (inyectado && (upstream.status === 400 || upstream.status === 422));
      if (rechazoDeNuestroCambio && !ac.signal.aborted) {
        let motivo = "";
        try {
          motivo = (await upstream.text()).slice(0, 300).replace(/\s+/g, " ");
        } catch {
          /* el motivo es solo para el log */
        }
        const eraInyeccion = inyectado;
        log(
          eraInyeccion
            ? `[gateway] the upstream rejected (${upstream.status}) the request with stream_options.include_usage added; ` +
                `forwarding it unchanged · ${motivo}`
            : `[gateway] the upstream rejected (400) the rewritten request` +
                `${hermano ? ` to ${hermano.servido}` : ""}${esfuerzoPuesto ? " (per-turn effort)" : ""}` +
                `${rebaja ? " (cache TTL)" : ""}${diales ? " (context editing dials)" : ""}` +
                `; forwarding it unchanged · ${motivo}`,
        );
        hermano = null;
        esfuerzoPuesto = false;
        rebaja = null;
        // Viaja intacta: este turno ya no deja nada a 5 min.
        if (turnoTtl && ttlReescrito) turnoTtl.rebajado = false;
        ttlReescrito = false;
        diales = null;
        inyectado = false;
        if (eraInyeccion) inyeccion = "rechazada-por-el-upstream";
        cuerpoEnviado = cuerpo;
        cabecerasEnviadas = cabecerasOriginales;
        try {
          upstream = await fetchImpl(url, {
            method: req.method,
            headers: cabecerasOriginales,
            body: cuerpo,
            redirect: "manual",
            signal: ac.signal,
          });
        } catch (err) {
          captura?.abortar();
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "bvsala gateway: upstream unreachable", detail: describirFallo(err) }));
          }
          log(`[gateway] ${req.method} ${url.pathname} → upstream unreachable on retry: ${describirFallo(err)}`);
          return;
        }
        // Sin la inyección pasó: el endpoint no admite `stream_options`, y
        // pedírselo en cada petición sería pagar dos viajes por una. Se apaga
        // para el resto del proceso y se dice una vez.
        if (eraInyeccion && upstream.ok) {
          endpointSinStreamOptions = true;
          avisarUnaVez(
            "gateway-sin-stream-options",
            "[bvsala gateway] the upstream rejects stream_options, so usage injection is off for the rest of this process: " +
              "streamed /v1/chat/completions answers from it are forwarded but NOT metered (stream=false answers still are).",
          );
        }
      }

      // Sin las hop-by-hop del salto proveedor→gateway (RFC 9110 §7.6.1): ni
      // la primaria ni la réplica de sus gemelas (que reutiliza este objeto)
      // las reenvían.
      const cabeceras = sinCabecerasDeSalto(Object.fromEntries(upstream.headers.entries()));
      for (const c of CABECERAS_TRANSPORTE) delete cabeceras[c];
      // `cabeceras` queda INTACTO (la réplica de una gemela lo reutiliza): el id
      // de esta petición va solo en lo que se escribe a su cliente.
      res.writeHead(upstream.status, conId(cabeceras));
      estadoUpstream = upstream.status;

      // chatgpt.com/backend-api/codex (Codex con auth ChatGPT) sirve el SSE SIN
      // cabecera content-type (validado en mano el 30-08): en una ruta con
      // dialecto conocido, sin content-type se asume SSE — si no lo fuera, el
      // observador no vería eventos y no se mediría nada (nunca de más). Solo
      // en los dos dialectos donde se ha visto: Chat Completions no se asume.
      const tipo = upstream.headers.get("content-type") ?? "";
      const esSse =
        tipo.includes("text/event-stream") ||
        (tipo === "" && upstream.ok && observadorPara(url.pathname) !== null && !url.pathname.endsWith("/chat/completions"));
      observador = esSse ? observadorPara(url.pathname) : null;
      respuestaOk = upstream.ok;
      // stream:false — el usage viene en el JSON del cuerpo, no en eventos SSE.
      // Solo rutas con dialecto de usage (count_tokens también responde JSON
      // pero no factura), solo con emisor (sin clave no hay nada que medir: ni
      // bufferizar ni parsear), y con el mismo tope de captura que la
      // coalescencia — un upstream configurable con un cuerpo desmesurado no
      // puede comerse el heap.
      const esJsonMedible =
        !esSse &&
        upstream.ok &&
        emisor !== undefined &&
        req.method === "POST" &&
        tieneDialecto(url.pathname) &&
        (upstream.headers.get("content-type") ?? "").includes("application/json");
      let cuerpoJson: Buffer[] | null = esJsonMedible ? [] : null;
      let cuerpoJsonBytes = 0;
      // Pasado el tope se deja de guardar (el heap manda), pero se recuerda: una
      // respuesta que no se pudo leer entera no se mide, y la línea lo dice.
      let jsonDesbordado = false;

      if (upstream.body) {
        for await (const chunk of upstream.body) {
          const b = Buffer.from(chunk);
          res.write(b);
          observador?.observar(b);
          vigiaId?.observar(b);
          if (cuerpoJson) {
            cuerpoJsonBytes += b.length;
            if (cuerpoJsonBytes > MAX_CAPTURA_BYTES) {
              cuerpoJson = null;
              jsonDesbordado = true;
            } else cuerpoJson.push(b);
          }
          captura?.capturar(b);
        }
      }
      res.end();
      if (vigiaId) buzon.anotarRespuesta(requestId, vigiaId.valor() ?? (cuerpoJson ? idDeCuerpoJson(Buffer.concat(cuerpoJson)) : null));
      // Parte G · la huella que leen las gemelas para valorarse por referencia.
      // INTACTA = ninguna palanca tocó lo que viajó: ni el modelo (C), ni el
      // cuerpo o las betas (diales, esfuerzo), ni `stream_options` (inyección),
      // ni `cache_control.ttl` (rebaja de TTL). Sin excepciones: lo publicado al
      // cliente es «byte-identical, untouched by the layer», y la rebaja cambia
      // bytes aunque no cambie tokens. Y, además de las banderas, la red
      // ESTRUCTURAL: el cuerpo que viajó tiene que ser EL MISMO objeto que llegó
      // del cliente y las cabeceras las mismas, así que una palanca futura que
      // olvide su bandera cae aquí del lado seguro. Tras el reintento intacto,
      // todas las banderas ya están a cero y lo enviado es lo del cliente.
      // Una palanca nueva que cambie cuerpo, cabeceras o modelo SE AÑADE AQUÍ.
      if (captura) {
        const intacta =
          hermano === null &&
          !esfuerzoPuesto &&
          diales === null &&
          !inyectado &&
          rebaja === null &&
          cuerpoEnviado === cuerpo &&
          mismasCabeceras(cabecerasEnviadas, cabecerasOriginales);
        // El contador FINAL de la primaria, en su propia respuesta: el mismo que
        // leen las ramas de medición de abajo. Sin él no hay registro medido al
        // que la gemela pueda apuntar.
        const respuestaJson = cuerpoJson ? Buffer.concat(cuerpoJson) : null;
        const conContador =
          upstream.ok &&
          (observador ? observador.usageFinal() !== null : respuestaJson !== null && usoDeJsonPorRuta(url.pathname, respuestaJson) !== null);
        const fallida =
          (observador instanceof ObservadorResponses && observador.estadoFinal() === "failed") ||
          (respuestaJson !== null && respuestaJsonFallida(url.pathname, respuestaJson));
        // E7 · una negativa se mide, pero su gemela no se valora por referencia.
        // Los tres observadores la ven (Mensajes, Chat Completions y, desde el
        // 2026-09-28, la parte `refusal` de la Responses API).
        const negativa =
          (observador !== null && observador.negativa()) ||
          (respuestaJson !== null && negativaEnJson(url.pathname, respuestaJson));
        // E7-quater · y la que el modelo escribe como TEXTO, sin señal del API:
        // la misma heurística que el SDK, sobre el inicio del texto servido.
        const negativaEscrita =
          !negativa &&
          negativaEnTextoDeRespuesta(
            observador !== null
              ? observador.textoInicial()
              : respuestaJson !== null
                ? textoDeRespuestaJson(url.pathname, respuestaJson)
                : "",
          );
        captura.terminar(upstream.status, cabeceras, {
          requestId,
          at: Date.now(),
          intacta,
          proveedorOficial: upstreamOficial,
          conContador,
          suscripcion,
          fallida,
          ...(negativa ? { negativa } : {}),
          ...(negativaEscrita ? { negativaEnTexto: true } : {}),
        });
      }

      // Medición tras servir la respuesta — jamás en el camino caliente.
      if (observador && upstream.ok) {
        medida = true;
        // El usage FINAL (message_delta, response.completed, el chunk de uso o
        // [DONE]): el de message_start trae output_tokens:1 de marcador, y un
        // stream que se corta antes de su evento final no es una medida.
        const uso = observador.usageFinal();
        if (uso === null && emisor) {
          // Chat Completions sin include_usage no es un corte: es que nadie
          // pidió el contador. Se dice distinto porque se arregla distinto.
          const porQue = porQueSinUsoEnStream(observador, cuerpo, codificacion, inyectado ? "inyectado" : inyeccion);
          noMedido(requestId, req.method ?? "POST", url.pathname, upstream.status, true, porQue.motivo, porQue.aviso);
        } else {
          const elision = atribuir(observador instanceof ObservadorSse ? observador.elision() : null, uso);
          const sinCobro = url.pathname === "/v1/messages" && observador instanceof ObservadorSse && observador.negativaNoCobrada();
          medir(
            requestId, cuerpo, uso, false, url.pathname, codificacion, atribucion, elision, rebaja, inicioMs, hermano, suscripcion,
            undefined, undefined, sinCobro, rebajaSombra, turnoTtl,
          );
          vigilarCache(url.pathname, cuerpo, codificacion, uso, ttlReescrito, sesionId);
        }
        // SIN clave no hay emisor y medir() vuelve en silencio: hasta 0.4.20
        // una petición en streaming servida con 200 no dejaba NINGUNA línea,
        // mientras `bvsala doctor` mandaba al probador a buscar justo esta
        // («[gateway] POST /v1/messages …»). Claude Code, Codex, Goose y Qwen
        // van SIEMPRE en streaming: sin esta línea, quien no tiene clave (o la
        // exportó mal) no puede confirmar que su terminal pasa por el gateway.
        // Con clave, la línea la pone medir() y aquí no se toca nada.
        if (!emisor) {
          log(`[gateway] ${req.method} ${url.pathname} → ${upstream.status} (stream) · not metered: no BIVELIO_SERVICE_KEY`);
        }
      } else if (cuerpoJson) {
        const respuesta = Buffer.concat(cuerpoJson);
        const uso = usoDeJsonPorRuta(url.pathname, respuesta);
        if (uso === null) {
          noMedido(requestId, req.method ?? "POST", url.pathname, upstream.status, false, "the response carried no usage", "uso");
        } else {
          // La elisión del proveedor (context_management) solo existe en Anthropic.
          const elision = url.pathname === "/v1/messages" ? elisionDeJson(respuesta) : null;
          medir(
            requestId, cuerpo, uso, false, url.pathname, codificacion, atribucion, atribuir(elision, uso), rebaja, inicioMs, hermano, suscripcion,
            undefined, undefined, negativaNoCobradaEnJson(url.pathname, respuesta), rebajaSombra, turnoTtl,
          );
          vigilarCache(url.pathname, cuerpo, codificacion, uso, ttlReescrito, sesionId);
        }
      } else if (jsonDesbordado) {
        noMedido(requestId, req.method ?? "POST", url.pathname, upstream.status, false, "the response was too large to read its usage", null);
      } else if (emisor && req.method === "POST" && upstream.ok && tieneDialecto(url.pathname)) {
        // Una ruta con dialecto que no respondió ni SSE ni JSON (sin
        // content-type en chat/completions, que no se asume SSE, o un tipo
        // raro): no hay dónde leer el usage, y se dice.
        noMedido(
          requestId,
          req.method,
          url.pathname,
          upstream.status,
          false,
          `the response is neither JSON nor an event stream (content-type: ${tipo === "" ? "none" : tipo.slice(0, 80)})`,
          null,
        );
      } else if (
        emisor &&
        req.method === "POST" &&
        upstream.ok &&
        !tieneDialecto(url.pathname) &&
        !RUTA_DE_CONTEO.test(url.pathname)
      ) {
        // Una ruta sin dialecto de usage (embeddings, imágenes, audio…): se
        // reenvía y se dice que no se mide. El aviso, solo en el espacio de la
        // API (`/v1/…`): lo demás que un terminal manda por el base URL
        // (telemetría, sondas) no es inferencia y avisarlo sería ruido encima
        // de su TUI.
        noMedido(
          requestId,
          req.method,
          url.pathname,
          upstream.status,
          esSse,
          "no usage dialect for this route",
          url.pathname.startsWith("/v1/") ? "dialecto" : null,
        );
      } else {
        // Todo lo demás que no se mide se dice igual: JSON sin emisor, errores
        // del proveedor, y también un SSE con estado de error.
        log(`[gateway] ${req.method} ${url.pathname} → ${upstream.status}${esSse ? " (stream)" : ""}`);
      }
    } catch (err) {
      // UN CORTE A MITAD DE STREAM YA NO TUMBA EL PROCESO. Antes, un reset del
      // upstream (o del cliente subiendo el cuerpo) escapaba del handler async
      // como rechazo no manejado y mataba TODO el gateway — y con coalescencia,
      // la clave quedaba en vuelo para siempre colgando a las gemelas. Se libera
      // la captura SIEMPRE y se cierra la respuesta como se pueda.
      captura?.abortar();
      if (ac.signal.aborted) {
        // Solo con el usage FINAL del proveedor (message_delta / response.completed):
        // el de message_start trae output_tokens:1 de marcador, y un Esc a mitad
        // de generación no puede convertirse en un registro «medido».
        const uso = !medida && observador ? observador.usageFinal() : null;
        if (uso) {
          log(`[gateway] ${req.method} ${url.pathname} → client closed after the final usage; metered anyway`);
          const elision = atribuir(observador instanceof ObservadorSse ? observador.elision() : null, uso);
          // Sin rebaja (la atribución de A exige el camino completo) pero CON el
          // hermano: el precio del modelo servido se pagó igual aunque el
          // cliente cerrara.
          const sinCobro = url.pathname === "/v1/messages" && observador instanceof ObservadorSse && observador.negativaNoCobrada();
          medir(
            requestId, cuerpoPeticion, uso, false, url.pathname, codificacion, atribucion, elision, undefined, inicioMs, hermano, suscripcion,
            undefined, undefined, sinCobro,
          );
          vigilarCache(url.pathname, cuerpoPeticion, codificacion, uso, ttlReescrito, sesionId);
        } else {
          log(`[gateway] ${req.method} ${url.pathname} → client aborted; upstream cancelled`);
          // Un stream con dialecto cortado antes del usage final: el proveedor
          // puede facturar lo que ya generó, y aquí no queda contador.
          if (observador && respuestaOk && !medida) {
            recuento.noMedida("the client closed the stream before the provider's final usage");
          }
        }
      } else {
        log(`[gateway] ${req.method} ${url.pathname} → error while serving: ${describirFallo(err)}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bvsala gateway: stream interrupted", detail: describirFallo(err) }));
          return;
        }
      }
      if (!res.writableEnded) res.end();
    } finally {
      // Un informe que ninguna rama cerró (error del proveedor, count_tokens,
      // upstream inalcanzable, cliente que se fue) se cierra aquí, con su motivo.
      // Nunca pisa uno ya cerrado: el primer cierre manda.
      if (conInforme) {
        buzon.noMedido(
          requestId,
          ac.signal.aborted
            ? "the client closed the connection before the provider's final usage"
            : estadoUpstream === null
              ? "the request did not get an answer from the provider"
              : `no usage was read from the provider's answer (HTTP ${estadoUpstream})`,
        );
      }
    }
  });

  // Codex CLI intenta WebSocket en CADA sesión (supports_websockets está
  // hardcodeado en su proveedor integrado y no se apaga por config). Sin este
  // listener, el handshake entraba en el handler normal, undici fallaba con
  // «invalid connection header» y respondíamos 502 — que Codex trata como error
  // genérico y quema reintentos visibles («Reconnecting…»). Un 426 fuerza el
  // fallback a HTTP+SSE inmediato, silencioso y pegajoso por sesión (test
  // websocket_fallback.rs de codex). El passthrough sirve el SSE como siempre.
  server.on("upgrade", (req, socket) => {
    log(`[gateway] ${req.method} ${new URL(req.url ?? "/", "http://x").pathname} → 426 (WebSocket not supported; the client falls back to HTTP)`);
    // Node retira SUS manejadores del socket antes de emitir 'upgrade': un RST
    // del cliente (tokio suelta el TcpStream con bytes sin leer) llegaría como
    // 'error' sin oyente y tumbaría el proceso entero. Y el socket es
    // allowHalfOpen: tras el end() hay que destruirlo, o queda medio abierto y
    // fuera del rastreo de server.close(). Es lo que hace ws.abortHandshake.
    socket.once("error", () => {});
    socket.once("finish", () => socket.destroy());
    socket.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });

  const puertoPedido = opts.puerto ?? 8402;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(puertoPedido, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    // El proceso va a morir en bin.ts, pero quien nos llame desde código (los
    // tests, un arnés) no puede quedarse con un emisor con timer vivo: se para
    // (con el búfer vacío, parar es no-op). El error se devuelve tipado para
    // que bin.ts hable del puerto y no de node:net.
    emisor?.stop();
    const code = (err as { code?: unknown } | null)?.code;
    throw new ErrorDeEscucha(typeof code === "string" ? code : "EUNKNOWN", puertoPedido, err);
  }
  // El puerto REAL: con `puerto: 0` el SO asigna uno aleatorio (así corren los
  // tests en paralelo sin pisarse) y devolver el pedido mentiría.
  const puerto = (server.address() as { port: number }).port;

  // ── Los procesos de fondo de la licencia, DESPUÉS de listen: si escuchar
  // falla no queda ningún timer vivo. Sin base del control plane (solo tests,
  // o modo comunitario), cero llamadas de licencia.
  if (baseLicencias && live && opts.license) {
    // Revocación por jti: la lista firmada, pública, contra la MISMA clave
    // pública. Sus avisos en consola se callan (el gateway habla por su `log`) y
    // un rechazo se dice una vez por causa.
    poller = new RevocationPoller({
      url: `${baseLicencias}/licenses/revocations`,
      publicKeyPem: publicKey,
      snapshot: revocation,
      getRefreshAfter: () => live?.gate.refreshAfter?.(),
      nowSeconds: () => Math.floor(now() / 1000),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      silenceWarnings: true,
      onEvent: (e) => {
        if (e.type === "rejected") {
          logUnaVez(`poller:${e.reason}`, `[gateway] revocation list rejected (${e.reason}); known revocations still apply`);
        }
      },
      ...(opts.license.revocations ?? {}),
    });
    poller.start();
    if (opts.serviceAccountKey) {
      renovador = new LicenseRenewer({
        licenseServerUrl: baseLicencias,
        serviceAccountKey: opts.serviceAccountKey,
        publicKey,
        revocation,
        current: () => live!.license,
        onAdopt: (l: VerifiedLicense) => {
          live = buildLiveLicense(l, publicKey, revocation, now);
          log(`[gateway] renewed license adopted (expires ${isoDay(l.payload.expires_at)})`);
          anunciar(veredicto());
        },
        onWarning: warn,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
        ...(opts.license.renewal ?? {}),
      });
      renovador.start({ checkNow: opts.license.checkOnStart === true });
    }
  }

  return {
    puerto,
    cerrar: async () => {
      renovador?.stop();
      poller?.stop();
      // Las gemelas que ya sirvieron su réplica y esperan su `finish` se miden
      // ANTES de vaciar el emisor: tras el vaciado su registro se perdía. Con
      // tope: vencido, se avisa (con cuántas quedaron) y se cierra igual.
      if (medicionesEnVuelo.size > 0) {
        const pendientes = [...medicionesEnVuelo];
        log(`[gateway] closing: waiting for ${pendientes.length} in-flight measurement(s) before draining usage`);
        const tope = opts.topeMedicionesAlCerrarMs ?? TOPE_MEDICIONES_AL_CERRAR_MS;
        let temporizador: ReturnType<typeof setTimeout> | undefined;
        const vencido = new Promise<"vencido">((resolve) => {
          temporizador = setTimeout(() => resolve("vencido"), tope);
          temporizador.unref?.();
        });
        const r = await Promise.race([Promise.all(pendientes).then(() => "ok" as const), vencido]);
        clearTimeout(temporizador);
        if (r === "vencido") {
          warn(
            `[bvsala gateway] shutting down with ${medicionesEnVuelo.size} measurement(s) still in flight after ${tope} ms: ` +
              "that usage will not reach your dashboard.",
          );
        }
      }
      // Se DRENA el uso antes de cerrar y ANTES del process.exit() de bin.ts:
      // stop() disparaba el flush sin esperarlo y el último lote de cada sesión
      // de `bvsala claude` se perdía (caza del 27-08).
      await emisor?.stopAndDrain();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    licenseStatus: () => veredicto().state,
    degradaciones: () => vigia.contadores(),
    medicion: () => recuento.estado(),
  };
}

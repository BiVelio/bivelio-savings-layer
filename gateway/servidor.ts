import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { UsageEmitter, deriveSeatId, detectCi } from "../src/metering/index.js";
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
  type Atribucion,
  type ElisionAplicada,
  type RebajaAplicada,
  type UsoSse,
} from "./medidor.js";
import { CarrilSombra } from "./sombra-vivo.js";
import { CanalDeEntitlements } from "./entitlements.js";
import { ajustarDiales, conBetaDeElision } from "./palanca.js";
import { avisoDeBusquedaDeHerramientas, verHerramientas } from "./busqueda-de-herramientas.js";
import { aplicarEsfuerzo, conBetaDeEsfuerzo, esNivel } from "./esfuerzo.js";
import { reescribirModelo, type CambioDeModelo } from "./hermano.js";
import { decidirRebaja, fraccionNueva, huellaDe, MemoriaDePrefijos, parsearMensajes, rebajarTtlDeCache } from "./tarifa.js";
import { Coalescedor, claveDePeticion, materialDeCabeceras, MAX_CAPTURA_BYTES } from "./coalescencia.js";

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
 *   · AVISAR, NUNCA ROMPER (decisión del dueño 2026-08-23): ningún estado de
 *     licencia o metering corta el tráfico. Sin clave de servicio, o con el
 *     ingest rechazando (401/402), el gateway sigue reenviando y avisa una
 *     sola vez. El candado de facturación es el servidor de ingesta, que es
 *     imparcheable — no este proceso, que corre en la máquina del cliente.
 *   · SOLO MEDIDO. Un registro existe únicamente si el proveedor emitió
 *     `usage` y el modelo está en el catálogo de precios. Sin contador no hay
 *     cifra: nada se estima en el gateway.
 *   · Los prompts no salen de la máquina: el metering transporta SOLO cuentas
 *     y coste (misma garantía que el SDK).
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
   * prefijo, en vez del campo de la raíz, que sí la reinicia).
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
   * así que la enciende el cliente con `BVSALA_GATEWAY_MODELO_HERMANO=1`. El
   * feature `sibling_model_routing` de la licencia sigue siendo necesario y
   * fail-closed por el mismo canal que las otras dos; `BVSALA_GATEWAY_ELISION=0`
   * la apaga junto a ellas. NO la arma el anillo 2: no hay A/B que hacer.
   */
  modeloHermano?: boolean;
  /**
   * Opt-in: añade `stream_options.include_usage` a los POST …/chat/completions
   * en stream que no traen `stream_options` (BVSALA_GATEWAY_USAGE_INJECT=1).
   * APAGADO por defecto: el último chunk de esos streams pasa a llegar con
   * `choices: []`, y el código que lee `choices[0]` sin mirar revienta. Sin él,
   * esos streams se reenvían sin medir y el log lo dice.
   */
  usageInject?: boolean;
  /** Inyectables para tests. */
  fetchImpl?: typeof fetch;
  log?: (linea: string) => void;
}

export interface GatewayArrancado {
  puerto: number;
  cerrar: () => Promise<void>;
}

/**
 * Los avisos de «reenviado pero NO medido», uno por proceso y causa. En inglés:
 * los lee quien usa el gateway, no quien lo mantiene.
 */
const AVISO_CHAT_SIN_INCLUDE_USAGE =
  "[bvsala gateway] streamed /v1/chat/completions requests without stream_options.include_usage carry no usage, " +
  'so they are forwarded but NOT metered. Add stream_options={"include_usage": True} to the call ' +
  "(Node: stream_options: { include_usage: true }); its last chunk then has an empty choices list. " +
  "Or start the gateway with BVSALA_GATEWAY_USAGE_INJECT=1 to add it for clients you cannot change.";
const avisoSinUsage = (path: string): string =>
  `[bvsala gateway] POST ${path} answered without the provider's final usage, so it was forwarded but NOT metered. ` +
  "Nothing is estimated in its place.";
const avisoSinDialecto = (path: string): string =>
  `[bvsala gateway] POST ${path} is forwarded but NOT metered: the gateway reads usage from /v1/messages, ` +
  "…/chat/completions and …/responses only.";

/** Rutas que responden JSON sin facturar nada: ni se miden ni se avisan. */
const RUTA_DE_CONTEO = /\/(count_tokens|input_tokens)$/;

/** Cabeceras de transporte que NO se reenvían (hallazgo F0 nº1). */
const CABECERAS_TRANSPORTE = ["content-encoding", "content-length", "transfer-encoding"];

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

export async function arrancarGateway(opts: OpcionesGateway = {}): Promise<GatewayArrancado> {
  const upstreamBase = (opts.upstream ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((l: string) => console.log(l));

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
  } else {
    avisarUnaVez(
      "gateway-sin-clave",
      "[bvsala gateway] no BIVELIO_SERVICE_KEY: the gateway forwards traffic but does not meter it. " +
        "Get your key at savings.bivelio.com/dashboard/install to see your spend in the dashboard.",
    );
  }

  const coalescedor = opts.coalescer ? new Coalescedor() : null;
  // El carril sombra solo existe con emisor: sin clave de servicio no hay
  // dónde reportar y simular sería gastar CPU del cliente para nada.
  const carrilSombra = opts.sombra && emisor ? new CarrilSombra() : null;

  // S4a · el canal de entitlements existe por defecto (`elision !== false`) siempre
  // que haya clave de servicio: sin clave no hay org que consultar. El gate REAL es
  // el feature `context_elision` (fail-closed), no la bandera — que solo APAGA
  // (`opts.elision === false`, desde `BVSALA_GATEWAY_ELISION=0`). La URL sale del mismo
  // origen que la ingesta (meteringUrl), así que dev y tests apuntan a su plataforma
  // falsa sin opciones nuevas.
  // La memoria de prefijos que gobierna la rebaja de TTL: vive en el proceso
  // del gateway (no persiste, no viaja, no se mide) y solo responde a una
  // pregunta —«¿qué parte de este cuerpo NO estaba ya cacheada por el turno
  // anterior del hilo?»— para rebajar a 5m solo las escrituras gordas
  // (arranque, compactación) y nunca el turno encadenado, donde la prima es
  // calderilla y el fallo cuesta el prefijo entero.
  const memoria = new MemoriaDePrefijos();

  const canalElision =
    opts.elision !== false && opts.serviceAccountKey
      ? new CanalDeEntitlements({
          url: new URL(
            "/api/org/entitlements",
            opts.meteringUrl ?? "https://savings.bivelio.com/api/metering/usage",
          ).toString(),
          serviceAccountKey: opts.serviceAccountKey,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          log,
        })
      : null;

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
    metodo: string,
    path: string,
    status: number,
    stream: boolean,
    motivo: string,
    aviso: "chat" | "uso" | "dialecto" | null,
  ): void => {
    log(`[gateway] ${metodo} ${path} → ${status}${stream ? " (stream)" : ""} · not metered: ${motivo}`);
    if (aviso === "chat") avisarUnaVez("gateway-chat-sin-include-usage", AVISO_CHAT_SIN_INCLUDE_USAGE);
    if (aviso === "uso") avisarUnaVez(`gateway-sin-usage:${path}`, avisoSinUsage(path));
    if (aviso === "dialecto") avisarUnaVez(`gateway-sin-dialecto:${path}`, avisoSinDialecto(path));
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
  ): void => {
    if (!emisor || !uso) return;
    const em = emisor;
    const usoFinal: UsoSse = uso;
    const model = modeloDelCuerpo(cuerpo, codificacion);
    if (!model) {
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
    const medido = costeMedido(servido, uso);
    if (medido) {
      const informe = coalescida
        ? informeCoalescido(requestId, model, medido, atribucion)
        : informeMedido(requestId, servido, medido, atribucion, elision, rebaja, hermano);
      emisor.record(informe);
      // B2 · el suelo del borrado del proveedor: solo existe si hubo borrado,
      // es atribuible a nuestros diales y el modelo tiene precio de lectura.
      const suelo = informe.cost.eliminatedInputFloorCost;
      log(
        `[gateway] POST ${path} ${coalescida ? "· COALESCED (call avoided)" : ""} · ` +
          `${servido !== model ? `${model}→${servido} (sibling model)` : model} · ` +
          `$${medido.costeUsd.toFixed(6)} (in ${medido.tokens.entrada}, cache↑${medido.tokens.cacheEscrita}` +
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
      if (carrilSombra && !coalescida && path === "/v1/messages") {
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
      avisarUnaVez(
        `gateway-sin-precio:${model}`,
        `[bvsala gateway] model "${model}" is not in the price catalog; its usage is forwarded but not metered.`,
      );
    }
  };

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const inicioMs = Date.now();
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

      // ── F2 · coalescencia (solo bajo bandera, solo POST con cuerpo) ──
      const coalescible = coalescedor !== null && req.method === "POST" && cuerpo.length > 0;
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
            // La gemela recibe la réplica íntegra de la primaria — cero viaje.
            res.writeHead(replica.status, replica.headers);
            const obs = observadorPara(url.pathname) ?? new ObservadorSse();
            for (const ch of replica.chunks) {
              res.write(ch);
              obs.observar(ch);
            }
            res.end();
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
                const tipoReplica = String(replica.headers["content-type"] ?? "");
                noMedido(
                  req.method ?? "POST",
                  url.pathname,
                  replica.status,
                  tipoReplica.includes("text/event-stream"),
                  !tieneDialecto(url.pathname)
                    ? "no usage dialect for this route"
                    : tipoReplica.includes("text/event-stream")
                      ? "the stream ended without the provider's final usage event"
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
            medir(requestId, cuerpo, usoReplica, true, url.pathname, codificacion, atribucion);
            return;
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
        h[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      // Foto de las cabeceras ANTES de que las palancas las toquen: el
      // reintento intacto de C (abajo) reenvía exactamente lo que mandó el cliente.
      const cabecerasOriginales: Record<string, string> = { ...h };

      // ── S4a · la palanca de diales (doble opt-in, passthrough ante la duda) ──
      // Se ajusta SOLO context_management + la beta; la MEDICIÓN (los medir()
      // de abajo) y la clave de coalescencia siguen usando el cuerpo ORIGINAL
      // del cliente. Tres interruptores: la bandera local (canalElision existe),
      // el feature per-org (fail-closed), y este try — cualquier anomalía
      // reenvía el cuerpo intacto, jamás un error.
      let cuerpoSaliente = cuerpo;
      if (
        canalElision !== null &&
        // 2026-09-09 · cuarto interruptor, y el que manda: los diales quedan
        // APAGADOS salvo que alguien los arme a mano. Ver `dialesElision`.
        opts.dialesElision === true &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canalElision.tiene("context_elision")
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
          const aviso = avisoDeBusquedaDeHerramientas(verHerramientas(cuerpo.toString("utf8")));
          if (aviso) avisarUnaVez("gateway-busqueda-herramientas", aviso);
        } catch {
          /* un aviso jamás puede tumbar una petición */
        }
      }

      const quiereHermano =
        canalElision !== null &&
        opts.modeloHermano === true &&
        req.method === "POST" &&
        (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens");
      // La bandera puesta y la licencia sin el feature se dice UNA vez: sin
      // esto, quien paga y enciende C ve pasar el cuerpo intacto en silencio.
      if (quiereHermano && !canalElision!.tiene("sibling_model_routing")) {
        avisarUnaVez(
          "gateway-hermano-sin-feature",
          "[bvsala gateway] sibling model routing: the flag is set but your org's license does not include " +
            "sibling_model_routing; the request is forwarded unchanged (fail-closed).",
        );
      }
      if (quiereHermano && canalElision!.tiene("sibling_model_routing")) {
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
        canalElision !== null &&
        esNivel(opts.esfuerzo) &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canalElision.tiene("per_turn_effort")
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
      // Misma disciplina que la de arriba: bandera local implícita (hay canal),
      // feature per-org fail-closed, y un try que ante cualquier anomalía
      // reenvía lo que ya llevara `cuerpoSaliente`. Se aplica DESPUÉS de los
      // diales para que ambas palancas compongan sin pisarse: la de diales
      // añade `context_management`, esta reescribe `cache_control.ttl`.
      //
      // Y va sobre `cuerpoSaliente`, no sobre `cuerpo`: la MEDICIÓN y la clave
      // de coalescencia siguen usando el cuerpo original del cliente.
      let rebaja: { rebajadas: number; yaEran5m: number } | null = null;
      if (
        canalElision !== null &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canalElision.tiene("cache_ttl_tuning")
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
            if (decidirRebaja({ fraccionNueva: fraccionNueva(anterior, huella) })) {
              const rebajado = rebajarTtlDeCache(json);
              if (rebajado !== null) {
                cuerpoSaliente = rebajado.cuerpo;
                rebaja = { rebajadas: rebajado.rebajadas, yaEran5m: rebajado.yaEran5m };
              }
            }
          }
        } catch {
          /* passthrough */
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
      const esChat = req.method === "POST" && url.pathname.endsWith("/chat/completions");
      if (esChat && emisor && opts.usageInject === true && !endpointSinStreamOptions) {
        try {
          const r = inyectarIncludeUsage(cuerpo, codificacion);
          if (r.cuerpo) {
            cuerpoSaliente = r.cuerpo;
            inyectado = true;
          }
        } catch {
          /* passthrough */
        }
      }

      let upstream: Response;
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

      // ── Palanca C · el REINTENTO INTACTO ──────────────────────────────
      // Un 400 tras tocar el cuerpo puede ser culpa nuestra. Con la palanca C,
      // porque fable-5-1 rechaza cosas que fable-5 acepta. Con la D, porque la
      // beta del esfuerzo por turno estaba abierta como beta limitada y una org
      // sin acceso recibe un 400 de una petición que sin nosotros iba bien. Se reenvía
      // UNA vez el cuerpo y las cabeceras ORIGINALES del cliente — sin C, sin
      // diales, sin rebaja — y se mide lo que de verdad viajó. Si el 400 era
      // del cliente, ve el mismo 400 que habría visto sin la capa; cuesta un
      // viaje extra en una petición que ya iba a fallar. Nunca en streaming a
      // medias: aquí no se ha escrito ni una cabecera al cliente todavía.
      //
      // La inyección de include_usage usa el MISMO reintento, y además ante un
      // 422: hay endpoints compatibles que validan el esquema y rechazan un
      // campo que no conocen con 422. El rechazo llega antes de generar nada,
      // así que el reintento no paga tokens.
      const rechazoDeNuestroCambio =
        ((hermano !== null || esfuerzoPuesto) && upstream.status === 400) ||
        (inyectado && (upstream.status === 400 || upstream.status === 422));
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
                `; forwarding it unchanged · ${motivo}`,
        );
        hermano = null;
        esfuerzoPuesto = false;
        rebaja = null;
        diales = null;
        inyectado = false;
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

      const cabeceras = Object.fromEntries(upstream.headers.entries());
      for (const c of CABECERAS_TRANSPORTE) delete cabeceras[c];
      res.writeHead(upstream.status, cabeceras);

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

      if (upstream.body) {
        for await (const chunk of upstream.body) {
          const b = Buffer.from(chunk);
          res.write(b);
          observador?.observar(b);
          if (cuerpoJson) {
            cuerpoJsonBytes += b.length;
            if (cuerpoJsonBytes > MAX_CAPTURA_BYTES) cuerpoJson = null;
            else cuerpoJson.push(b);
          }
          captura?.capturar(b);
        }
      }
      res.end();
      captura?.terminar(upstream.status, cabeceras);

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
          const noLoPidio =
            observador instanceof ObservadorChatCompletions &&
            !(inyectado || pideUsoEnStream(cuerpo, codificacion) === true);
          noMedido(
            req.method ?? "POST",
            url.pathname,
            upstream.status,
            true,
            noLoPidio
              ? "the request did not ask for usage (stream_options.include_usage)"
              : "the stream ended without the provider's final usage event",
            noLoPidio ? "chat" : "uso",
          );
        } else {
          const elision = atribuir(observador instanceof ObservadorSse ? observador.elision() : null, uso);
          medir(requestId, cuerpo, uso, false, url.pathname, codificacion, atribucion, elision, rebaja, inicioMs, hermano);
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
          noMedido(req.method ?? "POST", url.pathname, upstream.status, false, "the response carried no usage", "uso");
        } else {
          // La elisión del proveedor (context_management) solo existe en Anthropic.
          const elision = url.pathname === "/v1/messages" ? elisionDeJson(respuesta) : null;
          medir(requestId, cuerpo, uso, false, url.pathname, codificacion, atribucion, atribuir(elision, uso), rebaja, inicioMs, hermano);
        }
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
          medir(requestId, cuerpoPeticion, uso, false, url.pathname, codificacion, atribucion, elision, undefined, inicioMs, hermano);
        } else {
          log(`[gateway] ${req.method} ${url.pathname} → client aborted; upstream cancelled`);
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

  return {
    puerto,
    cerrar: async () => {
      // Se DRENA el uso antes de cerrar y ANTES del process.exit() de bin.ts:
      // stop() disparaba el flush sin esperarlo y el último lote de cada sesión
      // de `bvsala claude` se perdía (caza del 27-08).
      await emisor?.stopAndDrain();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

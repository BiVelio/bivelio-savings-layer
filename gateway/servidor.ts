import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { UsageEmitter, deriveSeatId, detectCi } from "../src/metering/index.js";
import { avisarUnaVez } from "../src/util/warn-once.js";
import {
  ObservadorSse,
  ObservadorResponses,
  costeMedido,
  informeMedido,
  informeCoalescido,
  informeSombra,
  usoDeJson,
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
import { decidirRebaja, rebajarTtlDeCache, RitmoDeSesiones } from "./tarifa.js";
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
   * S2 · el carril SOMBRA de la elisión (política v0, la ganadora del replay
   * del corpus). APAGADO por defecto: se enciende con BVSALA_GATEWAY_SHADOW=1.
   * No toca un byte del tráfico — calcula en asíncrono qué habría costado el
   * turno con la elisión encendida y lo emite como `basis:"shadow"`.
   */
  sombra?: boolean;
  /**
   * S4a · la PALANCA de diales del proveedor. APAGADA por defecto: el
   * encendido efectivo es un doble opt-in — esta bandera local
   * (BVSALA_GATEWAY_ELISION=1) Y el feature `context_elision` en la licencia
   * de la org, consultado por el canal de entitlements (fail-closed a
   * apagado). Ante cualquier duda la petición viaja intacta.
   */
  elision?: boolean;
  /** Inyectables para tests. */
  fetchImpl?: typeof fetch;
  log?: (linea: string) => void;
}

export interface GatewayArrancado {
  puerto: number;
  cerrar: () => Promise<void>;
}

/** Cabeceras de transporte que NO se reenvían (hallazgo F0 nº1). */
const CABECERAS_TRANSPORTE = ["content-encoding", "content-length", "transfer-encoding"];

export async function arrancarGateway(opts: OpcionesGateway = {}): Promise<GatewayArrancado> {
  const upstreamBase = (opts.upstream ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((l: string) => console.log(l));

  let emisor: UsageEmitter | undefined;
  if (opts.serviceAccountKey) {
    emisor = new UsageEmitter({
      url: opts.meteringUrl ?? "https://savings.bivelio.com/api/metering/usage",
      serviceAccountKey: opts.serviceAccountKey,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      onAuthError: (status) =>
        avisarUnaVez(
          "gateway-ingest-auth",
          `[bvsala gateway] la ingesta de uso rechaza la credencial (${status}). ` +
            "El tráfico sigue fluyendo (avisar, nunca romper), pero este uso no está llegando al panel. " +
            "Revisa BIVELIO_SERVICE_KEY y el estado de la suscripción en savings.bivelio.com.",
        ),
    });
    const ci = detectCi();
    if (opts.seatId) emisor.setSeat(opts.seatId, ci);
    else void deriveSeatId(opts.serviceAccountKey).then((s) => emisor?.setSeat(s, ci)).catch(() => {});
    emisor.start();
  } else {
    avisarUnaVez(
      "gateway-sin-clave",
      "[bvsala gateway] sin BIVELIO_SERVICE_KEY: el gateway reenvía el tráfico pero NO mide. " +
        "Consigue tu clave en savings.bivelio.com/dashboard/install para ver el gasto en tu panel.",
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
  // El ritmo por sesión que gobierna la rebaja de TTL: vive en el proceso del
  // gateway (no persiste, no viaja, no se mide) y solo responde a una pregunta
  // —«¿cuándo se vio el turno anterior de esta sesión?»— para no rebajar a 5m
  // una sesión que ya demostró enfriarse.
  const ritmo = new RitmoDeSesiones();

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

  /**
   * El observador según el DIALECTO de la ruta: `/v1/messages` habla Anthropic;
   * cualquier `…/responses` (`/v1/responses` con API key, `/backend-api/codex/
   * responses` con ChatGPT) habla la Responses API de OpenAI (Codex CLI). Otras
   * rutas SSE no se miden.
   */
  const observadorPara = (pathname: string): ObservadorSse | ObservadorResponses | null => {
    if (pathname === "/v1/messages") return new ObservadorSse();
    if (pathname.endsWith("/responses")) return new ObservadorResponses();
    return null;
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
  ): void => {
    if (!emisor || !uso) return;
    const em = emisor;
    const usoFinal: UsoSse = uso;
    const model = modeloDelCuerpo(cuerpo, codificacion);
    if (!model) {
      avisarUnaVez(
        `gateway-sin-modelo:${path}`,
        `[bvsala gateway] no se pudo leer el modelo del cuerpo de ${path} (content-encoding: ${codificacion ?? "ninguno"}); su uso se reenvía pero no se mide.`,
      );
      return;
    }
    const medido = costeMedido(model, uso);
    if (medido) {
      emisor.record(
        coalescida
          ? informeCoalescido(requestId, model, medido, atribucion)
          : informeMedido(requestId, model, medido, atribucion, elision, rebaja),
      );
      log(
        `[gateway] POST ${path} ${coalescida ? "· COALESCIDA (llamada evitada)" : ""} · ${model} · ` +
          `$${medido.costeUsd.toFixed(6)} (in ${medido.tokens.entrada}, cache↑${medido.tokens.cacheEscrita}` +
          `${medido.tokens.cacheEscrita1h ? ` (1h ${medido.tokens.cacheEscrita1h})` : ""} ` +
          `cache↓${medido.tokens.cacheLeida}, out ${medido.tokens.salida})` +
          // S4a · el borrado que el PROVEEDOR declaró para esta respuesta. El
          // CONTEO de tokensLimpiados ya viaja al panel por eliminatedInput (campo
          // wire eliminatedInputTokens, ya en la lista blanca — sin migración). El
          // conteo de borrados y el DINERO de la elisión llegarán en Fase 2 con la
          // regla servidor-primero (el ingest tira el lote ante un campo nuevo).
          (elision ? ` · elisión: ${elision.borrados} borrado(s), ${elision.tokensLimpiados} tok limpiados por el proveedor` : ""),
      );
      // ── S2 · el carril sombra: EN ASÍNCRONO, jamás en el camino de la
      // petición (ya está servida y medida). Solo peticiones que viajaron de
      // verdad (una gemela coalescida repite el prompt de su primaria y
      // duplicaría el turno de la cadena) y solo /v1/messages (la política
      // conoce los bloques de Anthropic). Un fallo aquí no puede romper NADA.
      if (carrilSombra && !coalescida && path === "/v1/messages") {
        setImmediate(() => {
          try {
            const json = jsonDelCuerpo(cuerpo, codificacion);
            if (!json || typeof json !== "object") return;
            const paso = carrilSombra.observar({
              cuerpo: json as { model?: unknown; messages?: unknown; system?: unknown; tools?: unknown },
              uso: usoFinal,
              model,
              at: Date.now(),
              ...(atribucion?.sessionId !== undefined ? { sessionId: atribucion.sessionId } : {}),
              ...(atribucion?.agentId !== undefined ? { agentId: atribucion.agentId } : {}),
            });
            if (!paso) return;
            em.record(informeSombra(`${requestId}:shadow`, model, paso.baselineUsd, paso.politicaUsd, atribucion));
            log(
              `[gateway] sombra · ${model} · baseline $${paso.baselineUsd.toFixed(6)} → v0 $${paso.politicaUsd.toFixed(6)}`,
            );
          } catch {
            /* la sombra jamás rompe el gateway ni el metering */
          }
        });
      }
    } else {
      avisarUnaVez(
        `gateway-sin-precio:${model}`,
        `[bvsala gateway] el modelo "${model}" no está en el catálogo de precios; su uso se reenvía pero no se mide.`,
      );
    }
  };

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
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
    let observador: ObservadorSse | ObservadorResponses | null = null;
    let cuerpoPeticion: Buffer = Buffer.alloc(0);
    let medida = false;
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
            // MISMA verja de ruta que la primaria: sin ella, cualquier réplica
            // JSON con una clave `usage` de otra forma (p.ej. /v1/chat/completions,
            // prompt_tokens) emitía un registro fantasma de 0 tokens.
            const usoReplica =
              obs.usage() ?? (url.pathname === "/v1/messages" ? usoDeJson(Buffer.concat(replica.chunks)) : null);
            medir(requestId, cuerpo, usoReplica, true, url.pathname, codificacion, atribucion);
            return;
          }
          // Primaria fallida o desbordada: la gemela viaja por su cuenta.
        } else {
          captura = coalescedor.registrar(clave);
        }
      }

      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host" || k === "content-length" || v === undefined) continue;
        h[k] = Array.isArray(v) ? v.join(", ") : v;
      }

      // ── S4a · la palanca de diales (doble opt-in, passthrough ante la duda) ──
      // Se ajusta SOLO context_management + la beta; la MEDICIÓN (los medir()
      // de abajo) y la clave de coalescencia siguen usando el cuerpo ORIGINAL
      // del cliente. Tres interruptores: la bandera local (canalElision existe),
      // el feature per-org (fail-closed), y este try — cualquier anomalía
      // reenvía el cuerpo intacto, jamás un error.
      let cuerpoSaliente = cuerpo;
      if (
        canalElision !== null &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
        canalElision.tiene("context_elision")
      ) {
        try {
          const ajustado = ajustarDiales(cuerpo, codificacion);
          if (ajustado !== null) {
            cuerpoSaliente = ajustado;
            h["anthropic-beta"] = conBetaDeElision(h["anthropic-beta"]);
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
          const clave = atribucion?.sessionId ?? "sin-sesion";
          const ahoraMs = Date.now();
          const anterior = ritmo.ultimo(clave, ahoraMs);
          ritmo.anotar(clave, ahoraMs);
          const decision = decidirRebaja(anterior === undefined ? { ahoraMs } : { ultimoTurnoMs: anterior, ahoraMs });
          if (decision) {
            // La rebaja solo sabe leer cuerpos SIN comprimir; si los diales ya
            // reescribieron, `cuerpoSaliente` es JSON plano y `codificacion`
            // dejó de describirlo — de ahí el "identity" en ese caso.
            const cod = cuerpoSaliente === cuerpo ? codificacion : "identity";
            const rebajado = rebajarTtlDeCache(cuerpoSaliente, cod);
            if (rebajado !== null) {
              cuerpoSaliente = rebajado.cuerpo;
              rebaja = { rebajadas: rebajado.rebajadas, yaEran5m: rebajado.yaEran5m };
            }
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
          res.end(JSON.stringify({ error: "bvsala gateway: upstream unreachable", detail: String(err) }));
        }
        log(`[gateway] ${req.method} ${url.pathname} → upstream inalcanzable: ${String(err)}`);
        return;
      }

      const cabeceras = Object.fromEntries(upstream.headers.entries());
      for (const c of CABECERAS_TRANSPORTE) delete cabeceras[c];
      res.writeHead(upstream.status, cabeceras);

      // chatgpt.com/backend-api/codex (Codex con auth ChatGPT) sirve el SSE SIN
      // cabecera content-type (validado en mano el 30-08): en una ruta con
      // dialecto conocido, sin content-type se asume SSE — si no lo fuera, el
      // observador no vería eventos y no se mediría nada (nunca de más).
      const tipo = upstream.headers.get("content-type") ?? "";
      const esSse = tipo.includes("text/event-stream") || (tipo === "" && upstream.ok && observadorPara(url.pathname) !== null);
      observador = esSse ? observadorPara(url.pathname) : null;
      // stream:false — el usage viene en el JSON del cuerpo, no en eventos SSE.
      // Solo /v1/messages (count_tokens también responde JSON pero no factura),
      // solo con emisor (sin clave no hay nada que medir: ni bufferizar ni
      // parsear), y con el mismo tope de captura que la coalescencia — un
      // upstream configurable con un cuerpo desmesurado no puede comerse el heap.
      const esJsonMedible =
        !esSse &&
        upstream.ok &&
        emisor !== undefined &&
        req.method === "POST" &&
        url.pathname === "/v1/messages" &&
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
        const elision = observador instanceof ObservadorSse ? observador.elision() : null;
        medir(requestId, cuerpo, observador.usage(), false, url.pathname, codificacion, atribucion, elision, rebaja);
      } else if (cuerpoJson) {
        const respuesta = Buffer.concat(cuerpoJson);
        medir(requestId, cuerpo, usoDeJson(respuesta), false, url.pathname, codificacion, atribucion, elisionDeJson(respuesta), rebaja);
      } else if (!esSse) {
        log(`[gateway] ${req.method} ${url.pathname} → ${upstream.status}`);
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
          log(`[gateway] ${req.method} ${url.pathname} → el cliente cerró tras el usage final; se mide igual`);
          const elision = observador instanceof ObservadorSse ? observador.elision() : null;
          medir(requestId, cuerpoPeticion, uso, false, url.pathname, codificacion, atribucion, elision);
        } else {
          log(`[gateway] ${req.method} ${url.pathname} → el cliente abortó; upstream cancelado`);
        }
      } else {
        log(`[gateway] ${req.method} ${url.pathname} → error sirviendo: ${String(err)}`);
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bvsala gateway: stream interrupted", detail: String(err) }));
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
    log(`[gateway] ${req.method} ${new URL(req.url ?? "/", "http://x").pathname} → 426 (WebSocket no soportado; el cliente cae a HTTP)`);
    // Node retira SUS manejadores del socket antes de emitir 'upgrade': un RST
    // del cliente (tokio suelta el TcpStream con bytes sin leer) llegaría como
    // 'error' sin oyente y tumbaría el proceso entero. Y el socket es
    // allowHalfOpen: tras el end() hay que destruirlo, o queda medio abierto y
    // fuera del rastreo de server.close(). Es lo que hace ws.abortHandshake.
    socket.once("error", () => {});
    socket.once("finish", () => socket.destroy());
    socket.end("HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.puerto ?? 8402, "127.0.0.1", () => resolve());
  });
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

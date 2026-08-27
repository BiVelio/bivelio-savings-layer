import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { UsageEmitter, deriveSeatId, detectCi } from "../src/metering/index.js";
import { avisarUnaVez } from "../src/util/warn-once.js";
import { ObservadorSse, costeMedido, informeMedido, informeCoalescido } from "./medidor.js";
import { Coalescedor, claveDePeticion } from "./coalescencia.js";

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

  /** Mide y emite el uso de una respuesta ya servida (o replicada). */
  const medir = (requestId: string, cuerpo: Buffer, uso: ReturnType<ObservadorSse["usage"]>, coalescida: boolean, path: string): void => {
    if (!emisor || !uso) return;
    let model = "";
    try {
      model = (JSON.parse(cuerpo.toString("utf8")) as { model?: string }).model ?? "";
    } catch {}
    const medido = model ? costeMedido(model, uso) : null;
    if (medido) {
      emisor.record(coalescida ? informeCoalescido(requestId, model, medido) : informeMedido(requestId, model, medido));
      log(
        `[gateway] POST ${path} ${coalescida ? "· COALESCIDA (llamada evitada)" : ""} · ${model} · ` +
          `$${medido.costeUsd.toFixed(6)} (in ${medido.tokens.entrada}, cache↑${medido.tokens.cacheEscrita} ` +
          `cache↓${medido.tokens.cacheLeida}, out ${medido.tokens.salida})`,
      );
    } else if (model) {
      avisarUnaVez(
        `gateway-sin-precio:${model}`,
        `[bvsala gateway] el modelo "${model}" no está en el catálogo de precios; su uso se reenvía pero no se mide.`,
      );
    }
  };

  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const cuerpo = Buffer.concat(chunks);

    const url = new URL(req.url ?? "/", upstreamBase);

    // ── F2 · coalescencia (solo bajo bandera, solo POST con cuerpo) ──
    const coalescible = coalescedor !== null && req.method === "POST" && cuerpo.length > 0;
    const clave = coalescible ? claveDePeticion("POST", url.pathname + url.search, cuerpo) : "";
    let captura: ReturnType<Coalescedor["registrar"]> = null;
    if (coalescible) {
      if (coalescedor.tieneEnVuelo(clave)) {
        const replica = await coalescedor.esperar(clave);
        if (replica) {
          // La gemela recibe la réplica íntegra de la primaria — cero viaje.
          res.writeHead(replica.status, replica.headers);
          const obs = new ObservadorSse();
          for (const ch of replica.chunks) {
            res.write(ch);
            obs.observar(ch);
          }
          res.end();
          medir(requestId, cuerpo, obs.usage(), true, url.pathname);
          return;
        }
        // Primaria fallida o desbordada: la gemela viaja por su cuenta.
      } else {
        captura = coalescedor.registrar(clave);
      }
    }

    let upstream: Response;
    try {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === "host" || k === "content-length" || v === undefined) continue;
        h[k] = Array.isArray(v) ? v.join(", ") : v;
      }
      upstream = await fetchImpl(url, {
        method: req.method,
        headers: h,
        body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : cuerpo,
        redirect: "manual",
      });
    } catch (err) {
      captura?.abortar();
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bvsala gateway: upstream unreachable", detail: String(err) }));
      log(`[gateway] ${req.method} ${url.pathname} → upstream inalcanzable: ${String(err)}`);
      return;
    }

    const cabeceras = Object.fromEntries(upstream.headers.entries());
    for (const c of CABECERAS_TRANSPORTE) delete cabeceras[c];
    res.writeHead(upstream.status, cabeceras);

    const esSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    const observador = esSse ? new ObservadorSse() : null;

    if (upstream.body) {
      for await (const chunk of upstream.body) {
        const b = Buffer.from(chunk);
        res.write(b);
        observador?.observar(b);
        captura?.capturar(b);
      }
    }
    res.end();
    captura?.terminar(upstream.status, cabeceras);

    // Medición tras servir la respuesta — jamás en el camino caliente.
    if (observador && upstream.ok) {
      medir(requestId, cuerpo, observador.usage(), false, url.pathname);
    } else if (!esSse) {
      log(`[gateway] ${req.method} ${url.pathname} → ${upstream.status}`);
    }
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

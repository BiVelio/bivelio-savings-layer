/**
 * POR DÓNDE HABLA EL BANCO CON EL PROVEEDOR, y por qué esto es un módulo aparte.
 * ---------------------------------------------------------------------------
 * `makeProvider()` vivía dentro de `ab-live.ts`, leía el entorno por su cuenta e
 * instanciaba SIEMPRE `OpenAICompatibleProvider`. Consecuencia medida el
 * 2026-08-16: el escenario `Anthropic stable-prefix agent turn` reportó 0 tokens
 * cacheados en los DOS brazos sobre un prefijo de 7.287 tokens, y ese cero se
 * publicó como si alguien hubiera medido un fracaso. No lo era: `cache_control`
 * —lo ÚNICO que hace cachear a Anthropic, porque no cachea sola— no cabe en el
 * protocolo de OpenAI, así que la palanca del PR #71 nunca llegó a ejecutarse.
 *
 * Un fichero que arranca su propio `main()` al importarse no se puede probar, y
 * un fallo que sólo se ve en una tirada de pago tiene que poder probarse SIN
 * pagarla. Así que la decisión vive aquí: sin entorno, sin red y sin efectos —
 * se le pasa la configuración y devuelve el adaptador. La verja
 * `test/transporte-del-banco.test.ts` comprueba con un `fetch` de mentira que lo
 * que sale por el cable es el dialecto correcto y que `cache_control` viaja.
 */
import {
  AnthropicProvider,
  createMockProvider,
  OpenAICompatibleProvider,
  type Provider,
} from "../src/index.js";
import type { ProviderRequest } from "../src/providers/types.js";
import { conAjustesNativos, type PlanNativo } from "./nativo.js";
import { familiaDeModelo, type TransporteDelBanco } from "./scenarios.js";

/**
 * Lo que el banco sabe de sus endpoints. Se construye UNA vez desde el entorno,
 * en `ab-live.ts`, y viaja como dato: aquí dentro no se lee `process.env`.
 */
export interface ConfigDeTransporte {
  /** Endpoint que habla el protocolo de OpenAI. Ausente = tirada MOCK. */
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  /** Conservar el prefijo `proveedor/` del id del modelo (lo piden las pasarelas). */
  keepPrefix?: boolean | undefined;
  /**
   * Endpoint NATIVO de Anthropic (API de Mensajes). Opcional y aparte del
   * principal, porque no es intercambiable con él: son dos dialectos, y sólo uno
   * de los dos tiene `cache_control`.
   */
  anthropicBaseUrl?: string | undefined;
  anthropicApiKey?: string | undefined;
  /**
   * ENDPOINTS DIRECTOS POR FAMILIA, opcionales (OpenAI y Google hablan el
   * protocolo de OpenAI). Dos razones para tenerlos aparte de la pasarela: un
   * tercero que reproduzca el banco tendrá claves de SUS proveedores, no las
   * nuestras; y una pasarela puede no reenviar `prompt_cache_options` ni
   * devolver `cache_write_tokens`, que es justo lo que mide el brazo B2. Por un
   * endpoint directo el id del modelo viaja SIEMPRE sin el prefijo `proveedor/`.
   */
  openaiBaseUrl?: string | undefined;
  openaiApiKey?: string | undefined;
  /** Gemini por su endpoint OpenAI-compatible (`…/v1beta/openai`). */
  googleBaseUrl?: string | undefined;
  googleApiKey?: string | undefined;
  /**
   * `fetch` inyectable. Sólo lo usa la verja, y es la única forma de comprobar
   * QUÉ sale por el cable sin gastar una llamada de pago.
   */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * UN TEXTO DE ERROR SIN NADA QUE SE PAREZCA A UNA CLAVE. Algunos proveedores
 * devuelven la clave rechazada enmascarada (`Incorrect API key provided:
 * sk-…abcd`) y el banco guarda los errores en sus artefactos y los imprime.
 * Se quita cualquier token con forma de clave (prefijos `sk-`, `pk-`, `AIza`,
 * `Bearer …`) y cualquier `usuario:contraseña@` de una URL.
 */
export function sinSecretos(texto: string): string {
  return texto
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9*_-]{4,}/g, "[redacted]")
    .replace(/\bAIza[A-Za-z0-9_*-]{8,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._*-]+/gi, "Bearer [redacted]")
    .replace(/\/\/[^\s/@:]+:[^\s/@]+@/g, "//[redacted]@");
}

/** ¿Declara esta configuración ALGÚN endpoint? Sin ninguno, la tirada es MOCK. */
export function hayEndpoints(cfg: ConfigDeTransporte): boolean {
  return !!(cfg.baseUrl || cfg.anthropicBaseUrl || cfg.openaiBaseUrl || cfg.googleBaseUrl);
}

/** Por dónde sale un modelo: el dialecto, la URL, la clave y si se le quita el prefijo. */
export interface EndpointDeModelo {
  transporte: TransporteDelBanco;
  baseUrl?: string;
  apiKey?: string;
  /** Quitar `proveedor/` del id: siempre en un endpoint directo; en la pasarela, salvo KEEP_PREFIX. */
  quitarPrefijo: boolean;
  /** Solo el nombre del host (nunca la URL entera): es lo que se publica. `null` en MOCK. */
  host: string | null;
}

function hostDe(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid url)";
  }
}

/**
 * El endpoint que le toca a ESTE modelo, por este orden: el nativo de Anthropic
 * (si el modelo es de esa familia), el directo de su familia, la pasarela. Sin
 * ningún endpoint declarado la tirada es MOCK; con alguno pero ninguno para
 * esta familia, `null` — y el prevuelo aborta antes de gastar (o, sin modelo
 * forzado, el escenario se declara no medible).
 *
 * La familia la decide el id del modelo y no el escenario: un
 * `BVSALA_DEMO_MODELS` con un `claude-…` dentro fuerza TODOS los escenarios
 * contra ese modelo, y todos ellos tienen que salir por el adaptador que habla
 * su protocolo — no sólo el que mide `cache_control`.
 */
export function endpointDeModelo(model: string | null, cfg: ConfigDeTransporte): EndpointDeModelo | null {
  if (!hayEndpoints(cfg)) return { transporte: "mock", quitarPrefijo: false, host: null };
  const familia = model ? familiaDeModelo(model) : null;
  const directo = (transporte: TransporteDelBanco, baseUrl: string, apiKey: string | undefined): EndpointDeModelo => ({
    transporte,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    quitarPrefijo: true,
    host: hostDe(baseUrl),
  });
  if (familia === "anthropic" && cfg.anthropicBaseUrl) {
    return directo("anthropic-nativo", cfg.anthropicBaseUrl, cfg.anthropicApiKey);
  }
  if (familia === "openai" && cfg.openaiBaseUrl) return directo("openai-compatible", cfg.openaiBaseUrl, cfg.openaiApiKey);
  if (familia === "google" && cfg.googleBaseUrl) return directo("openai-compatible", cfg.googleBaseUrl, cfg.googleApiKey);
  if (cfg.baseUrl) {
    return {
      transporte: "openai-compatible",
      baseUrl: cfg.baseUrl,
      ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      quitarPrefijo: !cfg.keepPrefix,
      host: hostDe(cfg.baseUrl),
    };
  }
  return null;
}

/**
 * El transporte que le toca a ESTE modelo (ver `endpointDeModelo`). Sin
 * endpoint para su familia es un error de programación: quien llama tiene que
 * haberlo descartado antes (prevuelo o `repartirEscenarios`).
 */
export function transporteDeModelo(model: string | null, cfg: ConfigDeTransporte): TransporteDelBanco {
  const e = endpointDeModelo(model, cfg);
  if (!e) throw new Error(`no endpoint declared for ${model ?? "(per-scenario model)"}`);
  return e.transporte;
}

/**
 * El proveedor crudo de una tirada. El brazo A lo llama directo (saltándose la
 * capa) y el brazo B lo recibe dentro de ella, así que los dos brazos comparten
 * dialecto por construcción — que es lo que hace comparable un A/B pareado.
 *
 * `requireUsage: true` en los dos adaptadores de red: sin `usage` no hay coste
 * medible, y un contador ausente coerced a 0 es un ahorro del 100% inventado.
 */
export function proveedorDelBanco(model: string | null, cfg: ConfigDeTransporte): Provider {
  const e = endpointDeModelo(model, cfg);
  if (!e) throw new Error(`no endpoint declared for ${model ?? "(per-scenario model)"}`);
  switch (e.transporte) {
    case "mock":
      return createMockProvider();
    case "anthropic-nativo":
      return proveedorAnthropicNativo(e, cfg);
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        baseUrl: e.baseUrl!,
        ...(e.apiKey ? { apiKey: e.apiKey } : {}),
        stripProviderPrefix: e.quitarPrefijo,
        requireUsage: true,
        // La verja inyecta su fetch de mentira; en red, SIEMPRE con plazo.
        fetchImpl: cfg.fetchImpl ?? fetchConPlazo(),
      });
  }
}

/**
 * EL PROVEEDOR DEL BRAZO B2: el mismo adaptador que los demás brazos, con un
 * `fetch` que aplica los ajustes nativos del plan al cuerpo que ese adaptador
 * arma (benchmarks/nativo.ts). El plan se calcula POR PETICIÓN porque depende
 * de ella (el breakpoint va donde acaba SU prefijo estable).
 *
 * El `fetch` de los ajustes envuelve SIEMPRE el `fetch` con plazo del banco (o
 * el espía de la verja): nunca lo sustituye. Y va con `conReintentos`, como
 * todos los proveedores de la tirada.
 */
export function proveedorDelBrazoNativo(
  model: string,
  cfg: ConfigDeTransporte,
  planPara: (req: ProviderRequest) => PlanNativo,
): Provider {
  const base = proveedorDelBanco(model, cfg);
  return conReintentos({
    id: base.id,
    generate(req) {
      const plan = planPara(req);
      const conAjustes = proveedorDelBanco(model, {
        ...cfg,
        fetchImpl: conAjustesNativos(plan, cfg.fetchImpl ?? fetchConPlazo()),
      });
      return conAjustes.generate(req);
    },
  });
}

/**
 * REINTENTOS ANTE FALLOS TRANSITORIOS DE RED — y solo ante esos.
 *
 * El incidente que cierra (2026-08-24): una llamada a gemini-3.7-flash se
 * quedó >5 minutos sin cabeceras (`UND_ERR_HEADERS_TIMEOUT` de undici), la
 * excepción subió hasta `main()` y mató la tirada ENTERA en el cuarto modelo
 * de cuatro — con ~2 horas de llamadas pagadas y los artefactos sin escribir,
 * porque se escriben al final. Un banco que gasta dinero real no puede morir
 * por un estornudo de red.
 *
 * Solo se reintenta lo que se LANZÓ sin respuesta (fetch failed, timeouts,
 * conexión cortada): ahí no hay `usage`, así que no hay doble conteo posible.
 * Una respuesta HTTP con error NO se reintenta aquí: el adaptador ya la
 * convirtió en su propio error tipado, y reintentar una llamada que pudo
 * facturarse es una decisión del banco, no de la fontanería.
 */
const PAUSAS_DE_REINTENTO_MS: readonly number[] = [2_000, 8_000];

function esFalloTransitorioDeRed(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    // `String(...)`: el `code` de una DOMException es un NÚMERO (TimeoutError
    // trae 23) y `startsWith` sobre él revienta — cazado por la propia verja.
    const code = String((e as { code?: unknown }).code ?? "");
    if (code.startsWith("UND_ERR")) return true;
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"].includes(code)) return true;
    // El TimeoutError de `fetchConPlazo`: la petición se cortó SIN respuesta,
    // así que reintentarla no puede contar nada dos veces.
    if ((e as { name?: string }).name === "TimeoutError") return true;
    const msg = e instanceof Error ? e.message : "";
    if (/fetch failed|socket hang up|headers timeout/i.test(msg)) return true;
  }
  return false;
}

/**
 * EL PLAZO DURO POR PETICIÓN — el agujero que los reintentos no tapan.
 *
 * Segundo incidente del 2026-08-24: una petición a gemini se quedó COLGADA sin
 * socket abierto, sin CPU y sin error — 23 minutos parada hasta que se mató el
 * proceso a mano, con tres modelos medidos y sin escribir. `conReintentos` no
 * pudo hacer nada: no reintenta un `await` que nunca resuelve.
 *
 * `AbortSignal.timeout` corta la petición ENTERA (cabeceras y cuerpo) y el
 * `TimeoutError` resultante es transitorio-de-red para los reintentos. 300s por
 * llamada: el peor escenario legítimo del banco responde en <2 min.
 */
export function fetchConPlazo(plazoMs = 300_000, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const plazo = AbortSignal.timeout(plazoMs);
    const señal = init?.signal ? AbortSignal.any([init.signal, plazo]) : plazo;
    return base(input, { ...init, signal: señal });
  };
}

export function conReintentos(
  p: Provider,
  pausasMs: readonly number[] = PAUSAS_DE_REINTENTO_MS,
  dormir: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Provider {
  return {
    id: p.id,
    async generate(req) {
      for (let intento = 0; ; intento++) {
        try {
          return await p.generate(req);
        } catch (err) {
          if (intento >= pausasMs.length || !esFalloTransitorioDeRed(err)) throw err;
          console.error(
            `[banco] fallo transitorio de red con ${req.model}: ${err instanceof Error ? err.message : String(err)}` +
              ` — reintento ${intento + 1}/${pausasMs.length} en ${pausasMs[intento]! / 1000}s`,
          );
          await dormir(pausasMs[intento]!);
        }
      }
    },
  };
}

/**
 * El adaptador nativo, con el prefijo de proveedor quitado SIEMPRE.
 *
 * `BVSALA_DEMO_KEEP_PREFIX` es una propiedad de la PASARELA —que enruta por
 * `anthropic/claude-…`— y no del endpoint nativo, donde ese mismo id es un 404.
 * Los escenarios llevan el prefijo puesto porque el banco se escribió contra la
 * pasarela, así que se quita aquí en vez de mantener dos catálogos de ids que
 * tienen que decir lo mismo.
 */
function proveedorAnthropicNativo(e: EndpointDeModelo, cfg: ConfigDeTransporte): Provider {
  const nativo = new AnthropicProvider({
    baseUrl: e.baseUrl!,
    ...(e.apiKey ? { apiKey: e.apiKey } : {}),
    requireUsage: true,
    fetchImpl: cfg.fetchImpl ?? fetchConPlazo(),
  });
  return {
    id: nativo.id,
    generate: (r) => nativo.generate({ ...r, model: r.model.replace(/^[^/]+\//, "") }),
  };
}

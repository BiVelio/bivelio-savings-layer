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
   * `fetch` inyectable. Sólo lo usa la verja, y es la única forma de comprobar
   * QUÉ sale por el cable sin gastar una llamada de pago.
   */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * El transporte que le toca a ESTE modelo.
 *
 * La familia la decide el id del modelo y no el escenario: un
 * `BVSALA_DEMO_MODELS` con un `claude-…` dentro fuerza TODOS los escenarios
 * contra ese modelo, y todos ellos tienen que salir por el adaptador que habla
 * su protocolo — no sólo el que mide `cache_control`.
 *
 * Sin endpoint principal no hay red: la tirada es MOCK y lo dice.
 */
export function transporteDeModelo(
  model: string | null,
  cfg: ConfigDeTransporte,
): TransporteDelBanco {
  if (!cfg.baseUrl) return "mock";
  if (cfg.anthropicBaseUrl && model && familiaDeModelo(model) === "anthropic") {
    return "anthropic-nativo";
  }
  return "openai-compatible";
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
  switch (transporteDeModelo(model, cfg)) {
    case "mock":
      return createMockProvider();
    case "anthropic-nativo":
      return proveedorAnthropicNativo(cfg);
    case "openai-compatible":
      return new OpenAICompatibleProvider({
        baseUrl: cfg.baseUrl!,
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        stripProviderPrefix: !cfg.keepPrefix,
        requireUsage: true,
        ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
      });
  }
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
function proveedorAnthropicNativo(cfg: ConfigDeTransporte): Provider {
  const nativo = new AnthropicProvider({
    baseUrl: cfg.anthropicBaseUrl!,
    ...(cfg.anthropicApiKey ? { apiKey: cfg.anthropicApiKey } : {}),
    requireUsage: true,
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  });
  return {
    id: nativo.id,
    generate: (r) => nativo.generate({ ...r, model: r.model.replace(/^[^/]+\//, "") }),
  };
}

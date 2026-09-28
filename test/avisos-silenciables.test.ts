import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { MockProvider } from "../src/providers/mock.js";
import { RevocationPoller } from "../src/license/poller.js";
import { RevocationSnapshot } from "../src/license/revocation.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { Provider, ProviderRequest } from "../src/providers/types.js";
import type { JsonSchema, ToolDescriptor } from "../src/contracts/types.js";

/**
 * `silenceWarnings` CALLA TODOS LOS AVISOS, Y CADA UNO SALE UNA SOLA VEZ.
 *
 * #359 dio a los avisos del bucle de herramientas de Anthropic un portero que
 * mira el interruptor de la capa. Los avisos ANTERIORES de los adaptadores —el
 * contrato que choca con una herramienta del cliente, `strict`, el tier
 * diferible, la degradación de `response_format` y de `stream_options`— seguían
 * llamando a `avisarUnaVez` a pelo: una vez, sí, pero sordos al interruptor. Y en
 * `create.ts` dos más: el `licenseGate` ignorado (ni una vez ni callable) y la
 * clave de servicio sin servidor (callable, pero uno por capa creada). Más el
 * «sin fetch» del sondeo de revocaciones, que el JSDoc de `silenceWarnings`
 * promete callar y no callaba.
 *
 * Cada causa se prueba por las dos caras: sin interruptor sale EXACTAMENTE una
 * vez aunque se dispare dos veces (y con dos instancias), y con él no sale nada.
 * Un test que solo comprobara el silencio pasaría también si el aviso no
 * existiera.
 */

let avisos: string[];
beforeEach(() => {
  avisos = [];
  reiniciarAvisos();
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    avisos.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Los cuerpos falsos ───────────────────────────────────────────────────────

const json = (cuerpo: unknown, status = 200): Response =>
  new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

const RESPUESTA_ANTHROPIC = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2 },
};
const RESPUESTA_OPENAI = {
  choices: [{ message: { content: '{"a":"x"}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
};
const sse = (...trozos: unknown[]): string => trozos.map((t) => `data: ${JSON.stringify(t)}\n\n`).join("") + "data: [DONE]\n\n";
const STREAM_OPENAI = sse(
  { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
);

/** Cumple `strict`: todas las claves requeridas y `additionalProperties: false`. */
const ESTRICTO: JsonSchema = {
  type: "object",
  properties: { a: { type: "string" } },
  required: ["a"],
  additionalProperties: false,
};
/** No lo cumple: `b` es opcional. */
const NO_ESTRICTO: JsonSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] };

const herramienta = (id: string): ToolDescriptor => ({
  id,
  intents: ["x"],
  risk: "read",
  description: "una herramienta del cliente",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
});

const pregunta = (extra: Partial<ProviderRequest> = {}): ProviderRequest =>
  ({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hola" }], ...extra }) as ProviderRequest;

async function consumir(p: Provider, req: ProviderRequest): Promise<void> {
  for await (const _ of p.generateStream!(req)) {
    /* solo se consume */
  }
}

// ── Las causas, una a una ────────────────────────────────────────────────────

interface Causa {
  nombre: string;
  /** Reconoce el aviso entre todo lo que llegue a la consola. */
  texto: RegExp;
  proveedor: () => Provider;
  disparar: (p: Provider) => Promise<unknown>;
}

const anthropic = (): Provider => new AnthropicProvider({ fetchImpl: (async () => json(RESPUESTA_ANTHROPIC)) as unknown as typeof fetch });

/** Rechaza con un 400 la opción `opcion` si viaja en el cuerpo; si no, contesta con `ok()`. */
function openai(opcion: string, ok: () => Response): Provider {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const cuerpo = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (opcion in cuerpo) {
      return json({ error: { message: `Unrecognized request argument supplied: ${opcion}` } }, 400);
    }
    return ok();
  }) as unknown as typeof fetch;
  return new OpenAICompatibleProvider({ baseUrl: "https://compatible.example/v1", fetchImpl });
}

const CAUSAS: Causa[] = [
  {
    nombre: "Anthropic · el contrato choca con una herramienta del cliente llamada `bvsala_contract`",
    texto: /already named `bvsala_contract`/,
    proveedor: anthropic,
    disparar: (p) => p.generate(pregunta({ schema: ESTRICTO, tools: [herramienta("bvsala_contract")] })),
  },
  {
    nombre: "Anthropic · el contrato no cumple `strict`",
    texto: /does not meet `strict` mode/,
    proveedor: anthropic,
    disparar: (p) => p.generate(pregunta({ schema: NO_ESTRICTO })),
  },
  {
    nombre: "Anthropic · contrato y herramientas en la misma petición",
    texto: /carries BOTH your tools and an output contract/,
    proveedor: anthropic,
    disparar: (p) => p.generate(pregunta({ schema: ESTRICTO, tools: [herramienta("get_weather")] })),
  },
  {
    nombre: "Anthropic · petición diferible sin tier barato síncrono",
    texto: /NO cheaper synchronous tier/,
    proveedor: anthropic,
    disparar: (p) => p.generate(pregunta({ deferrable: true })),
  },
  {
    nombre: "OpenAI-compatible · el contrato no cumple `strict`",
    texto: /does not meet OpenAI's `strict` mode/,
    proveedor: () => openai("sin-rechazo", () => json(RESPUESTA_OPENAI)),
    disparar: (p) => p.generate(pregunta({ model: "gpt-4o-mini", schema: NO_ESTRICTO })),
  },
  {
    nombre: "OpenAI-compatible · el modelo rechaza `response_format`",
    texto: /rejects `response_format` with a 400/,
    proveedor: () => openai("response_format", () => json(RESPUESTA_OPENAI)),
    disparar: (p) => p.generate(pregunta({ model: "modelo-sin-formato", schema: ESTRICTO })),
  },
  {
    nombre: "OpenAI-compatible · el endpoint rechaza `stream_options`",
    texto: /rejects `stream_options`/,
    proveedor: () =>
      openai("stream_options", () => new Response(STREAM_OPENAI, { status: 200, headers: { "content-type": "text/event-stream" } })),
    disparar: (p) => consumir(p, pregunta({ model: "gpt-4o-mini" })),
  },
];

describe("los avisos de los adaptadores obedecen `silenceWarnings` y salen una vez por causa", () => {
  for (const causa of CAUSAS) {
    describe(causa.nombre, () => {
      it("sin el interruptor, sale UNA vez aunque se dispare cuatro (dos instancias, dos veces cada una)", async () => {
        for (let i = 0; i < 2; i++) {
          const p = causa.proveedor();
          createSavingsLayer({ provider: p, devUnlicensed: true });
          await causa.disparar(p);
          await causa.disparar(p);
        }
        expect(avisos.filter((a) => causa.texto.test(a))).toHaveLength(1);
      });

      it("⛔ con `silenceWarnings: true` no sale NINGÚN aviso", async () => {
        const p = causa.proveedor();
        createSavingsLayer({ provider: p, devUnlicensed: true, silenceWarnings: true });
        await causa.disparar(p);
        await causa.disparar(p);
        expect(avisos).toEqual([]);
      });

      it("y callar un adaptador no gasta el aviso de otro que nadie calló", async () => {
        const callado = causa.proveedor();
        createSavingsLayer({ provider: callado, devUnlicensed: true, silenceWarnings: true });
        await causa.disparar(callado);
        const otro = causa.proveedor();
        createSavingsLayer({ provider: otro, devUnlicensed: true });
        await causa.disparar(otro);
        expect(avisos.filter((a) => causa.texto.test(a))).toHaveLength(1);
      });
    });
  }
});

// ── Los de `createSavingsLayer` ──────────────────────────────────────────────

describe("los avisos de `createSavingsLayer`", () => {
  const SIN_SERVIDOR = /`serviceAccountKey` is set but there is no `licenseServerUrl`/;

  it("clave de servicio sin servidor: una vez por proceso, no una por capa", () => {
    for (let i = 0; i < 3; i++) {
      createSavingsLayer({ provider: new MockProvider(), devUnlicensed: true, serviceAccountKey: "bvk_placeholder" });
    }
    expect(avisos.filter((a) => SIN_SERVIDOR.test(a))).toHaveLength(1);
  });

  it("⛔ clave de servicio sin servidor: callado con `silenceWarnings`", () => {
    createSavingsLayer({
      provider: new MockProvider(),
      devUnlicensed: true,
      serviceAccountKey: "bvk_placeholder",
      silenceWarnings: true,
    });
    expect(avisos).toEqual([]);
  });

  // El `licenseGate` inyectado solo se descarta en el paquete PUBLICADO, donde
  // tsup compila `__BV_SALA_ALLOW_DEV_OPEN__` a `false`. Desde el fuente es una
  // global sin definir, así que se fija a mano para recorrer esa rama.
  const IGNORADO = /Ignoring the injected `licenseGate`/;
  const GATE = { isActive: () => true, isEntitled: () => true };

  it("`licenseGate` ignorado en el paquete publicado: una vez por proceso", () => {
    vi.stubGlobal("__BV_SALA_ALLOW_DEV_OPEN__", false);
    for (let i = 0; i < 3; i++) {
      createSavingsLayer({ provider: new MockProvider(), licenseGate: GATE } as never);
    }
    expect(avisos.filter((a) => IGNORADO.test(a))).toHaveLength(1);
  });

  it("⛔ `licenseGate` ignorado: callado con `silenceWarnings`", () => {
    vi.stubGlobal("__BV_SALA_ALLOW_DEV_OPEN__", false);
    createSavingsLayer({ provider: new MockProvider(), licenseGate: GATE, silenceWarnings: true } as never);
    expect(avisos).toEqual([]);
  });
});

// ── El sondeo de revocaciones sin `fetch` ────────────────────────────────────

describe("el sondeo de revocaciones sin `fetch` disponible", () => {
  const CLAVE = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWBiklf0kmDIVmM7nMiCxwiEAkwQIiqWGuRiRDJonsFY=
-----END PUBLIC KEY-----`;
  const sondeo = (extra: Record<string, unknown> = {}) =>
    new RevocationPoller({
      url: "https://savings.bivelio.com/licenses/revocations",
      publicKeyPem: CLAVE,
      snapshot: new RevocationSnapshot(),
      nowSeconds: () => 1_800_000_000,
      ...extra,
    });
  const SIN_FETCH = /no global fetch available/;

  it("avisa una vez aunque sondee varias veces", async () => {
    vi.stubGlobal("fetch", undefined);
    const p = sondeo();
    await p.pollOnce();
    await p.pollOnce();
    await sondeo().pollOnce();
    expect(avisos.filter((a) => SIN_FETCH.test(a))).toHaveLength(1);
  });

  it("⛔ callado con `silenceWarnings`, como promete su JSDoc", async () => {
    vi.stubGlobal("fetch", undefined);
    const p = sondeo({ silenceWarnings: true });
    await p.pollOnce();
    await p.pollOnce();
    expect(avisos).toEqual([]);
  });
});

// ── La verja: que no vuelva a aparecer uno suelto ────────────────────────────

describe("⛔ ningún aviso suelto en los adaptadores ni en `create.ts`", () => {
  /**
   * Los tests de arriba cubren los avisos que existen HOY; esto cubre los que
   * alguien añada mañana. `avisarUnaVez` a pelo respeta el «una vez» pero no el
   * interruptor, y `console.warn` ni lo uno ni lo otro: las dos cosas reabren el
   * agujero. (El pipeline ya tiene su verja en `reparos-de-la-revision.test.ts`.)
   */
  const leer = (ruta: string): string => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
  const sueltos = (fuente: string, portero: RegExp): string[] =>
    fuente
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => (/\bconsole\.warn\s*\(/.test(l) || /(?<!\.)\bavisarUnaVez\s*\(/.test(l)) && !portero.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);

  it("src/providers/*: todos pasan por `avisarDelProveedor`", () => {
    const dir = fileURLToPath(new URL("../src/providers/", import.meta.url));
    const hallados = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) =>
        sueltos(leer(`../src/providers/${f}`), /^\s*avisarUnaVez\(clave, mensaje\);$/).map((l) => `${f}:${l}`),
      );
    expect(hallados).toEqual([]);
  });

  it("src/pipeline/create.ts: todos pasan por su portero", () => {
    expect(
      sueltos(leer("../src/pipeline/create.ts"), /^\s*if \(config\.silenceWarnings !== true\) avisarUnaVez\(clave, mensaje\);$/),
    ).toEqual([]);
  });
});

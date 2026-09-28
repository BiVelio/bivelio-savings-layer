import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSavingsLayer } from "../src/pipeline/create.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { MockProvider } from "../src/providers/mock.js";
import { RevocationPoller } from "../src/license/poller.js";
import { RevocationSnapshot } from "../src/license/revocation.js";
import { LicenseRefresher } from "../src/license/refresher.js";
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

// ── La excepción: la credencial de renovación rechazada ─────────────────────

/**
 * EL ÚNICO AVISO QUE `silenceWarnings` NO CALLA.
 *
 * #366 dejó abierta la pregunta y el dueño la cerró: cuando la recogida del
 * token renovado devuelve 401/403/404, el SDK va a dejar de funcionar al acabar
 * la gracia, y el fallo ocurre dentro del SDK, donde la observabilidad del
 * cliente no llega. Callarlo sería dejar que el cliente se entere por el
 * LicenseError del día ~45. Sale igualmente, una vez por causa y por capa —no
 * en cada vuelta del renovador— y sin la clave dentro.
 */
describe("⛔ la credencial de renovación rechazada NO se calla con `silenceWarnings`", () => {
  const DIA = 86400;
  const EMITIDO = 1_800_000_000;
  const par = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const cabeza = b64(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const cuerpo = b64(
    JSON.stringify({
      plan: "pro",
      seats: 1,
      features: ["semantic_cache"],
      grace_days: 14,
      jti: "v",
      org_id: "org-1",
      issued_at: EMITIDO,
      expires_at: EMITIDO + 30 * DIA,
    }),
  );
  // Día 40: el token está en gracia, así que el renovador sale a buscar.
  const TOKEN = `${cabeza}.${cuerpo}.${b64(sign(null, Buffer.from(`${cabeza}.${cuerpo}`), par.privateKey))}`;
  const AHORA_MS = (EMITIDO + 40 * DIA) * 1000;
  // Una clave con pinta de real (inventada para el test): es lo que NO puede
  // aparecer en el aviso, ni entera ni a trozos.
  const CLAVE_SERVICIO = "bvk_live_Q7xK2mP9vR4tW8zN3bJ6hF1cY5";
  const CREDENCIAL = /automatic pickup of the renewed license is failing with HTTP/;

  const cp = (status: number) =>
    vi.fn(async (url: string) =>
      String(url).includes("/api/license/current")
        ? json({}, status)
        : json({}, 503), // revocaciones: el sondeo conserva su snapshot, sin aviso al primer fallo
    ) as unknown as typeof fetch;
  const llamadasDeRecogida = (f: typeof fetch): number =>
    (f as unknown as { mock: { calls: [string][] } }).mock.calls.filter(([u]) => String(u).includes("/api/license/current"))
      .length;

  const renovador = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    new LicenseRefresher({
      url: "https://cp.test/api/license/current",
      serviceAccountKey: CLAVE_SERVICIO,
      publicKey: par.publicKey,
      initialToken: TOKEN,
      onNewToken: () => {},
      fetchImpl,
      now: () => AHORA_MS,
      ...extra,
    } as never);

  /** La capa entera, con un renovador que da una vuelta cada 5 ms. */
  const capa = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
    createSavingsLayer({
      provider: new MockProvider(),
      licenseKey: TOKEN,
      licensePublicKey: par.publicKey,
      licenseServerUrl: "https://cp.test",
      serviceAccountKey: CLAVE_SERVICIO,
      metering: { enabled: false },
      licenseFetch: fetchImpl,
      licenseRefresh: { intervalMs: 5 },
      licenseRevocation: { maxStalenessSeconds: 365 * DIA },
      now: () => AHORA_MS,
      // Un aviso callable más en la misma capa: la verificación con una tasa
      // imposible. Prueba que el interruptor sigue callando todo lo demás.
      verification: { sampleRate: 5 },
      ...extra,
    });

  it("por la vía pública: con `silenceWarnings: true` sale igualmente, UNA vez en varias renovaciones, y lo demás calla", async () => {
    const f = cp(401);
    const c = capa(f, { silenceWarnings: true });
    try {
      await vi.waitFor(() => expect(llamadasDeRecogida(f)).toBeGreaterThanOrEqual(4));
    } finally {
      c.close();
    }
    expect(avisos.filter((a) => CREDENCIAL.test(a))).toHaveLength(1);
    // Y NADA más: el aviso de la verificación inválida sí obedece al interruptor.
    expect(avisos).toHaveLength(1);
  });

  it("control: sin el interruptor, el aviso callable de la misma capa SÍ sale (el test de arriba no pasa por vacío)", async () => {
    const f = cp(401);
    const c = capa(f);
    try {
      await vi.waitFor(() => expect(llamadasDeRecogida(f)).toBeGreaterThanOrEqual(4));
    } finally {
      c.close();
    }
    expect(avisos.filter((a) => CREDENCIAL.test(a))).toHaveLength(1);
    expect(avisos.length).toBeGreaterThan(1);
  });

  it("el renovador suelto: ni pasándole `silenceWarnings` a la fuerza se calla, y sale una vez en cinco vueltas", async () => {
    const f = cp(401);
    const r = renovador(f, { silenceWarnings: true, silenciarAvisos: true });
    for (let i = 0; i < 5; i++) await r.checkNow();
    expect(llamadasDeRecogida(f)).toBe(5);
    expect(avisos.filter((a) => CREDENCIAL.test(a))).toHaveLength(1);
    expect(avisos[0]).toContain("HTTP 401");
  });

  it("una vez por CAUSA: 401 y 403 son dos avisos, repetir cualquiera de los dos no añade ninguno", async () => {
    let status = 401;
    const f = vi.fn(async () => json({}, status)) as unknown as typeof fetch;
    const r = renovador(f);
    for (const s of [401, 401, 403, 403, 401, 403]) {
      status = s;
      await r.checkNow();
    }
    expect(avisos.filter((a) => CREDENCIAL.test(a))).toHaveLength(2);
    expect(avisos.some((a) => a.includes("HTTP 401"))).toBe(true);
    expect(avisos.some((a) => a.includes("HTTP 403"))).toBe(true);
  });

  it("un 5xx NO es credencial rechazada: se cura solo y no avisa", async () => {
    const r = renovador(cp(503));
    for (let i = 0; i < 3; i++) await r.checkNow();
    expect(avisos).toEqual([]);
  });

  it("⛔ el texto no contiene la clave de servicio, ni entera ni ningún trozo de 6 caracteres", async () => {
    const r = renovador(vi.fn(async () => json({}, 401)) as unknown as typeof fetch);
    await r.checkNow();
    expect(avisos).toHaveLength(1);
    const [aviso] = avisos;
    // La parte secreta: todo lo que va detrás del prefijo público `bvk_live_`.
    const secreto = CLAVE_SERVICIO.slice("bvk_live_".length);
    const trozos: string[] = [];
    for (let i = 0; i + 6 <= secreto.length; i++) trozos.push(secreto.slice(i, i + 6));
    expect(aviso).not.toContain(CLAVE_SERVICIO);
    expect(trozos.filter((t) => aviso!.includes(t))).toEqual([]);
    expect(aviso).not.toMatch(/Bearer/i);
  });

  it("⛔ verja: nadie cablea el interruptor al renovador", () => {
    const leer = (ruta: string): string => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
    const renov = leer("../src/license/refresher.ts");
    // Ni opción en su interfaz ni lectura en el código (en los comentarios sí se nombra).
    expect(renov).not.toMatch(/^\s*(silenceWarnings|silenciarAvisos)\??\s*:/m);
    expect(renov).not.toMatch(/\.(silenceWarnings|silenciarAvisos)\b/);
    const create = leer("../src/pipeline/create.ts");
    const inicio = create.indexOf("new LicenseRefresher(");
    expect(inicio).toBeGreaterThan(-1);
    const bloque = create.slice(inicio, create.indexOf("refresher.start()", inicio));
    expect(bloque).not.toMatch(/silenceWarnings|silenciarAvisos/);
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

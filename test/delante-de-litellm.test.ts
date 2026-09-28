import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  MODELOS_DE_LA_RECETA,
  arrancarDobleDeLiteLLM,
  coalescerConElGateway,
  rebajarTtlConElGateway,
  repetirConElSdk,
  reprPython,
  respuestaDeChatComoLiteLLM,
  versionAdmiteReferencia,
  type DobleDeLiteLLM,
} from "../benchmarks/delante-de-litellm/nucleo.js";
import { arrancarUpstreamFalso, type UpstreamFalso } from "../benchmarks/latencia-gateways/upstream-falso.js";
import { CATALOGO } from "../src/pricing/catalogo.js";

/**
 * E6 · BV-SALA DELANTE DE LITELLM, en CI: sin Python ni red.
 *
 * La prueba con LiteLLM 1.102.1 de verdad es `pnpm litellm:e2e` y su evidencia
 * fechada está en benchmarks/evidencia/delante-de-litellm-2026-09-27.json. Aquí
 * el proxy es el DOBLE de `benchmarks/delante-de-litellm/nucleo.ts`, atado a lo
 * que esa evidencia vio (primer bloque), y los escenarios son los mismos
 * (`repetirConElSdk`, `coalescerConElGateway`, `rebajarTtlConElGateway`).
 *
 * Qué queda demostrado:
 *   (a) una repetición idéntica detrás del proxy sale `reference`, en Chat
 *       Completions y en Messages;
 *   (b) en el GATEWAY, la gemela coalescida detrás del proxy sigue `estimated`
 *       (`unofficial-upstream`): sin comisión.
 *
 * Y tres HUECOS, fijados tal como se comporta hoy el código para que el día que
 * el dueño decida cambiarlos el test lo diga (no cambian facturación en este PR):
 *   1. el SDK no sabe que habla con un proxy: su repetición `reference` entra en
 *      la base de la comisión a precio de lista;
 *   2. CERRADO el 2026-09-28 por decisión del dueño: la palanca de TTL del
 *      gateway acreditaba su ahorro `measured` a precio de lista aunque el
 *      upstream fuera el proxy; ahora detrás de un upstream no oficial el
 *      gateway mide y no acredita (ni TTL, ni hermano, ni suelo de elisión);
 *   3. un acierto de la caché del proxy llega al SDK como una llamada normal con
 *      el `usage` original y se reporta `measured`.
 */

const EVIDENCIA = JSON.parse(
  readFileSync(new URL("../benchmarks/evidencia/delante-de-litellm-2026-09-27.json", import.meta.url), "utf8"),
) as { cabecerasObservadas: { chat: string[]; messages: string[]; chatAciertoDeCache: string[] } };

const PLAZO = 30_000;

let upstreams: UpstreamFalso[] = [];
let dobles: DobleDeLiteLLM[] = [];
let servidores: Server[] = [];
afterEach(async () => {
  for (const d of dobles) await d.cerrar();
  for (const u of upstreams) await u.cerrar();
  for (const s of servidores) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  dobles = [];
  upstreams = [];
  servidores = [];
});

async function montar(opts: { cache?: boolean; retardoMs?: number } = {}) {
  const upstream = await arrancarUpstreamFalso({ retardoMs: opts.retardoMs ?? 0 });
  upstreams.push(upstream);
  const doble = await arrancarDobleDeLiteLLM({ upstream: `http://127.0.0.1:${upstream.puerto}`, cache: opts.cache ?? false });
  dobles.push(doble);
  return { upstream, doble };
}

const nombres = (h: Headers): string[] => [...h.keys()].filter((k) => k.startsWith("x-litellm-")).sort();

describe("el doble se porta como el LiteLLM 1.102.1 que se midió", () => {
  it("repr() de Python para el coste de la cabecera", () => {
    expect(reprPython(1.14e-5)).toBe("1.14e-05");
    expect(reprPython(40 * 1e-6)).toBe("3.9999999999999996e-05");
    expect(reprPython(0.0001)).toBe("0.0001");
    expect(reprPython(0.00123)).toBe("0.00123");
    expect(reprPython(0)).toBe("0.0");
    expect(reprPython(1)).toBe("1.0");
    expect(reprPython(1.215e-5)).toBe("1.215e-05");
  });

  it("los alias del doble son los de litellm.yaml", () => {
    const yaml = readFileSync(new URL("../benchmarks/delante-de-litellm/litellm.yaml", import.meta.url), "utf8");
    const alias = [...yaml.matchAll(/model_name:\s*(\S+)/g)].map((m) => m[1]);
    expect(alias.sort()).toEqual(Object.keys(MODELOS_DE_LA_RECETA).sort());
    for (const [a, m] of Object.entries(MODELOS_DE_LA_RECETA)) {
      expect(yaml).toMatch(new RegExp(`model_name: ${a}\\s+litellm_params:\\s+model: ${m.modelo.replace("/", "\\/")}`));
    }
  });

  it("mismas cabeceras x-litellm-* que la evidencia, en Chat Completions, en Messages y en un acierto de su caché", async () => {
    const { doble } = await montar({ cache: true });
    const chat = () =>
      fetch(`${doble.origen}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hola" }] }),
      });
    const primera = await chat();
    const segunda = await chat();
    const messages = await fetch(`${doble.origen}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 16, messages: [{ role: "user", content: "hola" }] }),
    });
    expect(nombres(primera.headers)).toEqual(EVIDENCIA.cabecerasObservadas.chat);
    expect(nombres(segunda.headers)).toEqual(EVIDENCIA.cabecerasObservadas.chatAciertoDeCache);
    expect(nombres(messages.headers)).toEqual(EVIDENCIA.cabecerasObservadas.messages);
    // El acierto repite el coste de la original y no llama al upstream.
    expect(segunda.headers.get("x-litellm-response-cost")).toBe(primera.headers.get("x-litellm-response-cost"));
    expect(doble.reenviadas()).toBe(2);
  });

  it("la respuesta de Chat Completions: el alias en `model`, provider_specific_fields y sin logprobs", () => {
    const r = respuestaDeChatComoLiteLLM(
      {
        id: "chatcmpl-1",
        created: 1,
        model: "gpt-4o-mini",
        system_fingerprint: "fp",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Paris" }, logprobs: null, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      "equipo-rapido",
    );
    expect(JSON.stringify(r)).toBe(
      '{"id":"chatcmpl-1","created":1,"model":"equipo-rapido","object":"chat.completion","system_fingerprint":"fp",' +
        '"choices":[{"finish_reason":"stop","index":0,"message":{"content":"Paris","role":"assistant","provider_specific_fields":{"refusal":null}},"provider_specific_fields":{}}],' +
        '"usage":{"completion_tokens":2,"prompt_tokens":10,"total_tokens":12}}',
    );
  });
});

describe("(a) el SDK delante del proxy: la repetición idéntica sale `reference`", () => {
  it(
    "Chat Completions (`openai/gpt-4o-mini`, `stripProviderPrefix`): measured y luego reference, con un solo viaje",
    async () => {
      const { upstream, doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "openai/gpt-4o-mini" });
      expect(r.primera.basis).toBe("measured");
      expect(r.primera.cacheResult).toBe("miss");
      expect(r.segunda.basis).toBe("reference");
      expect(r.segunda.cacheResult).toBe("exact");
      expect(r.segunda.referenceRequestId).toBe(r.primera.requestId);
      expect(r.segunda.actualUsd).toBe(0);
      // El suelo: la entrada a precio de LECTURA de caché, nunca la cifra halagüeña.
      expect(r.segunda.baselineUsd).toBeGreaterThan(0);
      expect(r.segunda.baselineUsd).toBeLessThan(r.primera.actualUsd);
      expect(upstream.recuento()["chat"]).toBe(1);
      expect(doble.reenviadas()).toBe(1);
      // El SDK vio la cabecera de coste del proxy y no la usa: su cifra sale del
      // contador del proveedor y de su catálogo.
      expect(r.cabecerasDelProxy[0]!["x-litellm-response-cost"]).toBeDefined();
    },
    PLAZO,
  );

  it(
    "Messages (el paso de Anthropic, `/v1/messages`): measured y luego reference",
    async () => {
      const { upstream, doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "anthropic", base: `${doble.origen}/v1`, modelo: "anthropic/claude-haiku-4-5" });
      expect(r.primera.basis).toBe("measured");
      expect(r.segunda.basis).toBe("reference");
      expect(r.segunda.referenceRequestId).toBe(r.primera.requestId);
      expect(upstream.recuento()["messages"]).toBe(1);
    },
    PLAZO,
  );

  it(
    "un alias propio del proxy sin precio de lista: la repetición queda `estimated` (no-cached-price) y fuera de la base",
    async () => {
      const { doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "equipo-rapido" });
      expect(r.segunda.cacheResult).toBe("exact");
      expect(r.segunda.basis).toBe("estimated");
      expect(r.segunda.referenceRejected).toBe("no-cached-price");
      expect(r.veredictos.every((v) => !v.enLaBase)).toBe(true);
    },
    PLAZO,
  );
});

describe("(b) el GATEWAY delante del proxy: sin comisión", () => {
  it(
    "la gemela coalescida sale `estimated`, motivo unofficial-upstream, y el servidor la deja fuera de la base",
    async () => {
      const { upstream, doble } = await montar({ retardoMs: 250 });
      const r = await coalescerConElGateway({ upstream: doble.origen });
      expect(r.estados).toEqual([200, 200]);
      expect(upstream.recuento()["chat"]).toBe(1);
      const gemela = r.veredictos.find((v) => v.cacheResult === "singleflight")!;
      expect(gemela.basisEmitido).toBe("estimated");
      expect(gemela.enLaBase).toBe(false);
      expect(r.lineas.join("\n")).toContain("estimated, not by reference: unofficial-upstream");
      // Y la primaria, medida pero sin ahorro: nada que comisionar.
      expect(r.veredictos.filter((v) => v.enLaBase)).toEqual([]);
    },
    PLAZO,
  );
});

describe("HUECOS · comportamiento de hoy que contradice (b) y decide el dueño", () => {
  it(
    "HUECO 1 · SDK: la repetición detrás del proxy entra en la base de la comisión a precio de lista",
    async () => {
      // El SDK decide el origen oficial por el host SOLO para el tier y la
      // caché explícita; la regla de la referencia (src/pipeline/referencia.ts)
      // no lo mira, y el registro no dice a quién se habló. El gateway sí
      // (`esUpstreamOficial`, gateway/upstream.ts). Si el dueño alinea el SDK
      // con el gateway, esta repetición pasa a `estimated` y este test cambia.
      const { doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "openai/gpt-4o-mini" });
      const repeticion = r.veredictos.find((v) => v.requestId === r.segunda.requestId)!;
      expect(r.lotes.every((l) => versionAdmiteReferencia(l.version))).toBe(true);
      expect(repeticion.basisIngerido).toBe("reference");
      expect(repeticion.enLaBase).toBe(true);
      expect(repeticion.ahorroUsd).toBeGreaterThan(0);
      // Lo mismo con un alias al que el cliente le declara precio propio.
      const conPrecio = await repetirConElSdk({
        protocolo: "openai",
        base: `${doble.origen}/v1`,
        modelo: "equipo-rapido",
        costModels: { "equipo-rapido": { ...CATALOGO["gpt-4o-mini"]! } },
      });
      expect(conPrecio.veredictos.find((v) => v.requestId === conPrecio.segunda.requestId)!.enLaBase).toBe(true);
    },
    PLAZO,
  );

  it(
    "CERRADO 2 · gateway: la rebaja de TTL cruza el proxy, pero detrás de un upstream no oficial su ahorro NO se acredita (dueño, 2026-09-28)",
    async () => {
      // Un upstream que declara escrituras de caché a 5 min, como haría
      // Anthropic tras la rebaja. El proxy lo reenvía tal cual.
      const recibidos: string[] = [];
      const escritor = createServer(async (req, res) => {
        const trozos: Buffer[] = [];
        for await (const t of req) trozos.push(t as Buffer);
        recibidos.push(Buffer.concat(trozos).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "Paris" }],
            stop_reason: "end_turn",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              cache_creation_input_tokens: 50_000,
              cache_read_input_tokens: 0,
              cache_creation: { ephemeral_5m_input_tokens: 50_000, ephemeral_1h_input_tokens: 0 },
            },
          }),
        );
      });
      servidores.push(escritor);
      const puerto = await new Promise<number>((r) => escritor.listen(0, "127.0.0.1", () => r((escritor.address() as { port: number }).port)));
      const doble = await arrancarDobleDeLiteLLM({ upstream: `http://127.0.0.1:${puerto}` });
      dobles.push(doble);

      const r = await rebajarTtlConElGateway({ upstream: doble.origen });
      expect(r.estados).toEqual([200]);
      // La palanca actuó y su TTL cruzó el proxy.
      expect((JSON.parse(recibidos[0]!) as { system: { cache_control: { ttl: string } }[] }).system[0]!.cache_control.ttl).toBe("5m");
      const v = r.veredictos[0]!;
      // Se mide el coste, como siempre…
      expect(v.basisEmitido).toBe("measured");
      // …pero la prima evitada es una resta entre precios de LISTA, y detrás del
      // proxy no hay factura de lista que la respalde: baseline == actual.
      // Antes: 50.000 × entrada de haiku-4-5 × 0,75 acreditados y en la base.
      expect(v.ahorroUsd).toBe(0);
      expect(v.enLaBase).toBe(false);
    },
    PLAZO,
  );

  it(
    "HUECO 3 · un acierto de la caché del proxy llega al SDK como llamada normal y sale `measured`",
    async () => {
      // Dos instancias de la aplicación (dos capas: la caché exacta del SDK es
      // de cada proceso) detrás de un proxy con caché de respuestas.
      const { upstream, doble } = await montar({ cache: true });
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "openai/gpt-4o-mini", capas: 2 });
      expect(upstream.recuento()["chat"]).toBe(1);
      expect(r.cabecerasDelProxy[1]!["x-litellm-cache-key"]).toBeDefined();
      expect(r.segunda.cacheResult).toBe("miss");
      expect(r.segunda.basis).toBe("measured");
      // El proveedor no cobró esta llamada; el `actual` repite el de la primera.
      expect(r.segunda.actualUsd).toBe(r.primera.actualUsd);
      expect(r.segunda.actualUsd).toBeGreaterThan(0);
    },
    PLAZO,
  );
});

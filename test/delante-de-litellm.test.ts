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
import { compararVersiones } from "../apps/web/lib/version/semver.js";
import { BV_SALA_VERSION, VERSION_MINIMA_REFERENCIA } from "../src/version.js";

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
 *   (a) una repetición idéntica detrás del proxy se sirve desde el SDK sin
 *       llegar al proxy, en Chat Completions y en Messages. Salía `reference`
 *       hasta el 2026-09-28; desde entonces sale `estimated` (ver CERRADO 1);
 *   (b) detrás del proxy no hay comisión por una llamada evitada: ni en el SDK
 *       (la llamada que corre no deja registro de referencia,
 *       `unofficial-origin`) ni en el GATEWAY (la gemela coalescida sigue
 *       `estimated`, `unofficial-upstream`).
 *
 * Y tres HUECOS, fijados tal como se comporta el código para que el día que
 * el dueño decida cambiarlos el test lo diga:
 *   1. CERRADO el 2026-09-28 por decisión del dueño (alinear el SDK con el
 *      gateway): el SDK no sabía que hablaba con un proxy y su repetición
 *      `reference` entraba en la base de la comisión a precio de lista; ahora
 *      sus adaptadores atestiguan el origen por su `baseUrl`, y detrás de un
 *      origen no oficial la llamada que corre no deja registro (E0-bis de
 *      src/pipeline/referencia.ts): la repetición sale `estimated`;
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

describe("(a) el SDK delante del proxy: la repetición idéntica se sirve sin llamar, y sale `estimated` (unofficial-origin)", () => {
  it(
    "Chat Completions (`openai/gpt-4o-mini`, `stripProviderPrefix`): measured y luego una repetición estimated, con un solo viaje",
    async () => {
      const { upstream, doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "openai/gpt-4o-mini" });
      expect(r.primera.basis).toBe("measured");
      expect(r.primera.cacheResult).toBe("miss");
      // E0-bis: el adaptador atestigua que habla con un origen no oficial, y la
      // llamada que corrió no deja registro de referencia.
      expect(r.primera.referenceNotWritten).toBe("unofficial-origin");
      expect(r.segunda.cacheResult).toBe("exact");
      expect(r.segunda.basis).toBe("estimated");
      expect(r.segunda.referenceRejected).toBe("absent");
      expect(r.segunda.referenceRequestId).toBeUndefined();
      expect(r.segunda.actualUsd).toBe(0);
      expect(upstream.recuento()["chat"]).toBe(1);
      expect(doble.reenviadas()).toBe(1);
      // El SDK vio la cabecera de coste del proxy y no la usa: su cifra sale del
      // contador del proveedor y de su catálogo.
      expect(r.cabecerasDelProxy[0]!["x-litellm-response-cost"]).toBeDefined();
      // Y la verja REAL del ingest la deja fuera de la base.
      const repeticion = r.veredictos.find((v) => v.requestId === r.segunda.requestId)!;
      expect(repeticion.basisIngerido).toBe("estimated");
      expect(repeticion.enLaBase).toBe(false);
      expect(r.veredictos.filter((v) => v.enLaBase)).toEqual([]);
    },
    PLAZO,
  );

  it(
    "Messages (el paso de Anthropic, `/v1/messages`): measured y luego una repetición estimated",
    async () => {
      const { upstream, doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "anthropic", base: `${doble.origen}/v1`, modelo: "anthropic/claude-haiku-4-5" });
      expect(r.primera.basis).toBe("measured");
      expect(r.primera.referenceNotWritten).toBe("unofficial-origin");
      expect(r.segunda.cacheResult).toBe("exact");
      expect(r.segunda.basis).toBe("estimated");
      expect(r.segunda.referenceRejected).toBe("absent");
      expect(upstream.recuento()["messages"]).toBe(1);
      const repeticion = r.veredictos.find((v) => v.requestId === r.segunda.requestId)!;
      expect(repeticion.basisIngerido).toBe("estimated");
      expect(repeticion.enLaBase).toBe(false);
    },
    PLAZO,
  );

  it(
    "un alias propio del proxy sin precio de lista: la repetición queda `estimated` y fuera de la base",
    async () => {
      const { doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "equipo-rapido" });
      // Antes lo paraba la lectura (`no-cached-price`); ahora ni se escribe.
      expect(r.primera.referenceNotWritten).toBe("unofficial-origin");
      expect(r.segunda.cacheResult).toBe("exact");
      expect(r.segunda.basis).toBe("estimated");
      expect(r.segunda.referenceRejected).toBe("absent");
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

describe("HUECOS · los que contradecían (b): dos cerrados por el dueño (2026-09-28) y uno abierto", () => {
  it(
    "CERRADO 1 · SDK: la repetición detrás del proxy ya NO entra en la base de la comisión (dueño, 2026-09-28)",
    async () => {
      // El SDK decidía el origen oficial por el host SOLO para el tier y la
      // caché explícita, y la regla de la referencia no lo miraba. Ahora el
      // adaptador lo atestigua y la E0-bis (src/pipeline/referencia.ts) lo mira,
      // como el gateway (`esUpstreamOficial`, gateway/upstream.ts): la llamada
      // que corre detrás del proxy no deja registro, y su repetición sale
      // `estimated`. Sin cambiar la versión de la regla ni la mínima del ingest.
      const { doble } = await montar();
      const r = await repetirConElSdk({ protocolo: "openai", base: `${doble.origen}/v1`, modelo: "openai/gpt-4o-mini" });
      const repeticion = r.veredictos.find((v) => v.requestId === r.segunda.requestId)!;
      // Lo que falta es el registro, no la versión: el propio SDK ya lo emite
      // `estimated` (basisEmitido), antes de la verja de versión del ingest, que
      // hasta el PR de release de la mínima (0.4.32) también degradaría lo que
      // declara `sdk/${BV_SALA_VERSION}`.
      expect(r.lotes.every((l) => l.version === `sdk/${BV_SALA_VERSION}`)).toBe(true);
      expect(r.primera.referenceNotWritten).toBe("unofficial-origin");
      expect(repeticion.basisEmitido).toBe("estimated");
      expect(repeticion.basisIngerido).toBe("estimated");
      expect(repeticion.enLaBase).toBe(false);
      // Lo mismo con un alias al que el cliente le declara precio propio: su
      // precio no cambia a quién se habló.
      const conPrecio = await repetirConElSdk({
        protocolo: "openai",
        base: `${doble.origen}/v1`,
        modelo: "equipo-rapido",
        costModels: { "equipo-rapido": { ...CATALOGO["gpt-4o-mini"]! } },
      });
      expect(conPrecio.primera.referenceNotWritten).toBe("unofficial-origin");
      expect(conPrecio.segunda.basis).toBe("estimated");
      expect(conPrecio.veredictos.find((v) => v.requestId === conPrecio.segunda.requestId)!.enLaBase).toBe(false);
      expect(conPrecio.veredictos.filter((v) => v.enLaBase)).toEqual([]);
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
      // Y la línea de log lo dice: es lo que la prueba con LiteLLM de verdad
      // (e2e.ts, S8) comprueba, porque allí el upstream no declara escrituras.
      expect(r.lineas.some((l) => l.includes("unofficial upstream: lever applied, saving not credited"))).toBe(true);
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
      // Lo que sí cambió con CERRADO 1: ese contador copiado ya no deja un
      // registro de referencia contra el que valorar repeticiones.
      expect(r.segunda.referenceNotWritten).toBe("unofficial-origin");
    },
    PLAZO,
  );
});

/**
 * La mínima del ingest, vista desde el SDK (el espejo del banco usa la
 * constante de src/version.ts; la web la ata por texto en version.test.ts).
 * 0.4.24-0.4.28 podían repetir una negativa del proveedor como referencia:
 * #356 cerró `content_filter`/`refusal` en la 0.4.27 y #367 la de salidas
 * estructuradas de OpenAI en la 0.4.29 (BITACORA-2026-09-26 §8). Y hasta la
 * 0.4.30 la que el modelo escribe como TEXTO, sin señal del API: #384, en la
 * 0.4.31 (dueño, 2026-09-28). Y hasta la 0.4.31 el `content_filter: OTHER` de
 * Gemini, las negativas que #384 no veía y los temas sensibles: #393, #401 y
 * #402, en la 0.4.32 (dueño, 2026-09-29).
 */
describe("VERSION_MINIMA_REFERENCIA — 0.4.32, la primera que no repite ninguna negativa", () => {
  it("una referencia de 0.4.24-0.4.31 ya no es comisionable; de 0.4.32 en adelante sí", () => {
    for (const no of ["sdk/0.4.24", "sdk/0.4.25", "sdk/0.4.26", "sdk/0.4.27", "sdk/0.4.28", "sdk/0.4.29", "sdk/0.4.30", "sdk/0.4.31"]) {
      expect(versionAdmiteReferencia(no), no).toBe(false);
    }
    for (const si of ["sdk/0.4.32", "sdk/0.4.33", "sdk/0.5.0"]) {
      expect(versionAdmiteReferencia(si), si).toBe(true);
    }
  });

  it("controles: el gateway, una preliminar de la mínima y «sin versión» siguen fuera", () => {
    for (const no of ["gateway/0.4.32", "sdk/0.4.32-rc.1", null]) {
      expect(versionAdmiteReferencia(no), String(no)).toBe(false);
    }
  });

  it("BV_SALA_VERSION: o ya alcanza la mínima (y entra), o la mínima es su siguiente parche", () => {
    // La mínima va por DELANTE de BV_SALA_VERSION hasta el PR de release que la
    // publique (src/version.ts): mientras tanto lo que emite este código entra
    // como estimado, que es el lado seguro. Pero nunca más allá del siguiente
    // parche: una errata degradaría para siempre.
    if (compararVersiones(BV_SALA_VERSION, VERSION_MINIMA_REFERENCIA) >= 0) {
      expect(versionAdmiteReferencia(`sdk/${BV_SALA_VERSION}`)).toBe(true);
    } else {
      const [a, b, c] = BV_SALA_VERSION.split(".").map(Number) as [number, number, number];
      expect(VERSION_MINIMA_REFERENCIA).toBe(`${a}.${b}.${c + 1}`);
      expect(versionAdmiteReferencia(`sdk/${BV_SALA_VERSION}`)).toBe(false);
    }
  });
});

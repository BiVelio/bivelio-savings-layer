import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { UPSTREAM_ALIASES, urlHaciaElUpstream } from "../gateway/upstream.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";

/**
 * LO QUE LA PRUEBA DE EXTREMO A EXTREMO DEL TARBALL 1.2.4 ENCONTRÓ EN EL README.
 *
 * Se instaló el tarball exacto como lo haría un visitante de Product Hunt, sin
 * clave y con proveedores falsos, y se siguió el README al pie de la letra. Cada
 * frase que se arregló se comprobó antes contra el código o ejecutándola; estas
 * pruebas atan la frase a lo que la sostiene, para que no vuelva a derivar:
 *
 *   · la receta del SDK de OpenAI decía `/v1` para qwen, glm, gemini y
 *     openrouter, y el gateway reenvía la ruta TAL CUAL a un origen pelado: el
 *     cliente acababa en https://dashscope.aliyuncs.com/v1/… (y Cline aparecía
 *     en esa receta, cuando su guía usa el gateway de Anthropic);
 *   · «simultaneous requests are not paid twice»: un stream nunca lidera, así
 *     que dos streams idénticos a la vez se pagan los dos (y Mastra no comparte
 *     nada en vuelo). El comportamiento lo fija test/pipeline-stream.test.ts;
 *   · «traffic that never repeats saves about 0 %»: sin clave, en Anthropic, un
 *     `system` largo que cambia en cada petición se marca siempre y sale ~20 %
 *     más caro que sin capa. Las dos salidas que da el README se prueban aquí;
 *   · `BVSALA_SEAT_ID=…` sin `export` no llega al proceso que se lanza después.
 */

const RAIZ = new URL("..", import.meta.url).pathname;
const leer = (ruta: string): string => readFileSync(join(RAIZ, ruta), "utf8");
const plano = (s: string): string => s.replace(/\s+/g, " ");
const readme = leer("README.md");

/** El prefijo de ruta de la API compatible con OpenAI de cada alias que NO usa `/v1`. */
const RUTA_PROPIA: Readonly<Record<string, string>> = {
  qwen: "/compatible-mode/v1",
  glm: "/api/paas/v4",
  gemini: "/v1beta/openai",
  openrouter: "/api/v1",
};

describe("la receta «Any OpenAI SDK» del README da la ruta que cada upstream necesita", () => {
  const lineas = readme.split("\n");
  const arranque = lineas.find((l) => l.includes("gateway --upstream openai --port 8403") && l.includes("# or:"));
  const conV1 = (arranque ?? "").split("# or:")[1]?.split("|").map((a) => a.trim()) ?? [];
  const i = lineas.findIndex((l) => /^#\s+qwen \| glm \| gemini \| openrouter:/.test(l));
  const nombrados = (lineas[i] ?? "").replace(/^#\s+/, "").split(":")[0]!.split("|").map((a) => a.trim());
  const rutas = (lineas[i + 1] ?? "")
    .replace(/^#\s+/, "")
    .split("|")
    .map((r) => r.trim().replace(/^http:\/\/127\.0\.0\.1:8403/, ""));

  it("los alias con `/v1` y los de ruta propia, sin solaparse, cubren todos los alias compatibles con OpenAI", () => {
    expect(arranque, "falta la línea `gateway --upstream openai --port 8403 # or: …`").toBeDefined();
    expect(i, "falta la línea de los alias con ruta propia").toBeGreaterThan(0);
    for (const a of [...conV1, ...nombrados]) expect(UPSTREAM_ALIASES, a).toHaveProperty(a);
    expect(conV1.filter((a) => a in RUTA_PROPIA)).toEqual([]);
    const cubiertos = new Set(["openai", ...conV1, ...nombrados]);
    const compatibles = Object.keys(UPSTREAM_ALIASES).filter((a) => a !== "anthropic");
    expect([...cubiertos].sort()).toEqual(compatibles.sort());
  });

  it("cada alias de ruta propia lleva SU prefijo, en el mismo orden", () => {
    expect(Object.fromEntries(nombrados.map((a, j) => [a, rutas[j]]))).toEqual(RUTA_PROPIA);
  });

  it("el gateway conserva la ruta: con la receta, la petición llega al endpoint compatible del proveedor", () => {
    for (const [alias, ruta] of [...conV1.map((a) => [a, "/v1"] as const), ...Object.entries(RUTA_PROPIA)]) {
      const origen = UPSTREAM_ALIASES[alias]!;
      expect(urlHaciaElUpstream(`${ruta}/chat/completions`, origen)?.href, alias).toBe(`${origen}${ruta}/chat/completions`);
    }
    // Y por eso `/v1` no valía para los cuatro: el origen no lleva prefijo.
    for (const alias of Object.keys(RUTA_PROPIA)) {
      expect(urlHaciaElUpstream("/v1/chat/completions", UPSTREAM_ALIASES[alias]!)?.href).toBe(`${UPSTREAM_ALIASES[alias]}/v1/chat/completions`);
    }
  });

  it("Cline no va en la receta de OpenAI: usa el gateway de Anthropic, como su guía", () => {
    const receta = lineas.find((l) => l.startsWith("# 1 · Any OpenAI SDK")) ?? "";
    expect(receta).not.toContain("Cline");
    expect(readme).toContain("Cline uses the Anthropic gateway (:8402)");
    expect(leer("docs/terminales/cline.md")).toContain("http://127.0.0.1:8402/v1");
  });
});

describe("lo que el README promete de las peticiones simultáneas", () => {
  const r = plano(readme);

  it("dice que detrás de un stream no se comparte nada, en el resumen, en streaming y en los adaptadores", () => {
    expect(r).toContain("(identical requests, or simultaneous ones when the first is not streamed)");
    expect(r).toContain("neither are simultaneous ones unless the first is streamed (then each one is paid)");
    expect(r).toContain("but nothing joins a stream: an identical request started while it runs is paid again");
    expect(r).toContain("an identical request already in flight (not in Mastra, nor when that one is a stream)");
    expect(r).not.toContain("Identical or simultaneous requests are not paid twice");
  });
});

describe("«about 0 %» va siempre con la excepción de Anthropic, y las dos salidas funcionan", () => {
  it("cada párrafo del README que dice «about 0 %» nombra el caso de Anthropic que cuesta más", () => {
    const parrafos = readme.split(/\n\s*\n/).filter((p) => p.includes("about 0 %"));
    expect(parrafos.length).toBeGreaterThanOrEqual(3);
    for (const p of parrafos) expect(plano(p), p.slice(0, 80)).toMatch(/Anthropic[^.]*costs (about 20 % )?more/);
    expect(plano(readme)).toContain("pass `maxCacheBreakpoints: 0` to `AnthropicProvider`");
    // El ratio puede ser negativo: el comentario del ejemplo ya no dice «0..1».
    expect(readme).not.toContain("0..1 ratio");
  });

  /**
   * Una API de Mensajes falsa con la caché de prefijo de Anthropic reducida a lo
   * que importa aquí: si el cuerpo lleva `cache_control`, el `system` se ESCRIBE
   * (1,25×) la primera vez y se LEE las siguientes; sin marca, todo es entrada.
   */
  function apiFalsa() {
    const vistos = new Set<string>();
    let marcadas = 0;
    const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
      const cuerpo = JSON.parse(String(init?.body)) as { system?: unknown; messages: unknown };
      const texto = JSON.stringify(cuerpo.system ?? "");
      const sistema = Math.ceil(texto.length / 4);
      const resto = Math.ceil(JSON.stringify(cuerpo.messages).length / 4);
      const marcada = JSON.stringify(cuerpo).includes("cache_control");
      if (marcada) marcadas += 1;
      const leida = marcada && vistos.has(texto);
      if (marcada) vistos.add(texto);
      const usage = {
        input_tokens: marcada ? resto : sistema + resto,
        output_tokens: 20,
        cache_creation_input_tokens: marcada && !leida ? sistema : 0,
        cache_read_input_tokens: leida ? sistema : 0,
      };
      return new Response(
        JSON.stringify({
          id: `msg_${marcadas}_${vistos.size}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "A widget is a small mechanical part." }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { fetchImpl, marcadas: () => marcadas };
  }

  const MANUAL = "Follow the handbook policies carefully and answer briefly. ".repeat(150);
  const N = 12;
  const hora = (i: number) => `2026-11-22T10:${String(i).padStart(2, "0")}:00Z`;

  async function correr(opciones: { maxCacheBreakpoints?: number }, disposicion: "cambiante" | "estable") {
    const api = apiFalsa();
    const layer = createSavingsLayer({
      provider: new AnthropicProvider({ apiKey: "falsa", fetchImpl: api.fetchImpl, ...opciones }),
      silenceWarnings: true,
    });
    const ratios: number[] = [];
    let nativo = 0;
    for (let i = 0; i < N; i++) {
      const system = disposicion === "cambiante" ? `Today is ${hora(i)}. User id u-${i}. ${MANUAL}` : MANUAL;
      const user = disposicion === "cambiante" ? `Question ${i}: what is a widget?` : `Today is ${hora(i)}. User id u-${i}.\nQuestion ${i}: what is a widget?`;
      const { report } = await layer.generate({
        model: "anthropic/claude-sonnet-4-5",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      ratios.push(report.cost.netSavingsRatio);
      nativo += report.nativeSavings?.netUsd ?? 0;
    }
    return { marcadas: api.marcadas(), ratios, nativo };
  }

  it("por defecto, un `system` que cambia en cada petición se marca siempre y cada petición cuesta más que sin capa", async () => {
    const r = await correr({}, "cambiante");
    expect(r.marcadas).toBe(N);
    for (const x of r.ratios) expect(x).toBeLessThan(0);
    expect(r.nativo).toBeLessThan(0);
  });

  it("con `maxCacheBreakpoints: 0` no sale ninguna marca y el coste es el de sin capa (ratio 0)", async () => {
    const r = await correr({ maxCacheBreakpoints: 0 }, "cambiante");
    expect(r.marcadas).toBe(0);
    for (const x of r.ratios) expect(x).toBe(0);
    expect(r.nativo).toBe(0);
  });

  it("con el `system` idéntico y lo que cambia en el mensaje del usuario, la caché del proveedor ahorra", async () => {
    const r = await correr({}, "estable");
    expect(r.marcadas).toBe(N);
    expect(r.nativo).toBeGreaterThan(0);
  });
});

describe("los detalles de la prueba de extremo a extremo", () => {
  it("BVSALA_SEAT_ID se exporta: una asignación suelta no llega al proceso que se lanza después", () => {
    expect(readme).toMatch(/^export BVSALA_SEAT_ID=worker-03 /m);
    expect(readme).not.toMatch(/^BVSALA_SEAT_ID=/m);
  });

  it("el aviso de `--legacy-peer-deps` está a la vista, junto al primer `npm i`", () => {
    const primerBloque = readme.indexOf("npm i @bivelio/savings-layer");
    const aviso = readme.indexOf("--legacy-peer-deps");
    expect(primerBloque).toBeGreaterThan(0);
    expect(aviso).toBeGreaterThan(primerBloque);
    // Antes del primer desplegable: el único sitio donde estaba era dentro de uno.
    expect(aviso).toBeLessThan(readme.indexOf("<details>"));
  });

  it("la documentación de `savings.semanticCache` nombra la opción que existe y no pide licencia", () => {
    const tipos = leer("src/contracts/types.ts");
    const doc = tipos.slice(tipos.indexOf("export interface SavingsToggles"), tipos.indexOf("semanticCache?:"));
    expect(doc).toContain("createSavingsLayer({ semanticCacheStore })");
    expect(doc).not.toContain("createSavingsLayer({ semanticCache })");
    expect(doc).not.toMatch(/license that includes it/);
    expect(doc).toContain("Free, with no key.");
  });

  it("NOTICE dice «cloud metering», como LICENSE-CLOUD.md: la medición local es gratis y no es de la nube", () => {
    expect(plano(leer("NOTICE"))).toContain("(dashboard, cloud metering, organization entitlements, license management)");
    expect(plano(leer("LICENSE-CLOUD.md"))).toContain("the BiVelio dashboard, cloud metering, organization entitlements");
  });

  it("la entrada 1.2.4 del CHANGELOG dice lo que imprime `python -m bvsala status` contra un gateway sin clave", () => {
    const ch = leer("CHANGELOG.md");
    const entrada = ch.slice(ch.indexOf("## 1.2.4"), ch.indexOf("\n## ", ch.indexOf("## 1.2.4") + 1));
    expect(plano(entrada)).not.toContain("prints `metering: off`");
    expect(plano(entrada)).toContain("it prints `metering: on`");
    // Lo que lo sostiene: el estado del gateway dice siempre `metering: true`, y el cliente imprime «on».
    expect(leer("gateway/servidor.ts")).toMatch(/metering: true\b/);
    expect(leer("packages/python/src/bvsala/__main__.py")).toMatch(/metering: \{'on' if st\.metering/);
  });
});

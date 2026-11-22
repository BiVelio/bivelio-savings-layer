import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { doctor, PREFIJO_OPENAI_POR_UPSTREAM } from "../gateway/doctor.js";
import { arrancarGateway, type GatewayArrancado } from "../gateway/servidor.js";
import { UPSTREAM_ALIASES, urlHaciaElUpstream } from "../gateway/upstream.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";

/**
 * e2e 1.2.4 (bloqueante) · las recetas del SDK de OpenAI decían «qwen, glm,
 * moonshot, minimax y openrouter funcionan igual» con un base_url …/v1. El
 * gateway cambia solo el ORIGEN y reenvía la ruta tal cual a un origen pelado,
 * así que qwen acababa en dashscope.aliyuncs.com/v1/chat/completions (y glm,
 * gemini y openrouter igual): un 404 del proveedor, sin medir.
 *
 * Aquí se fija, para cada alias de la tabla:
 *   · que el prefijo que enseñan el doctor, docs/terminales/README.md y
 *     cursor.md, más `/chat/completions`, llega a la URL que documenta el
 *     proveedor para su SDK de OpenAI;
 *   · que el gateway reenvía ESA ruta y mide la respuesta (con un modelo con
 *     precio de lista), con la línea de log que dicen las guías.
 */

/**
 * Adonde llega el gateway con cada alias; la RUTA es la que documenta cada
 * proveedor para su SDK de OpenAI (consultado el 2026-11-22).
 */
const ENDPOINT_DEL_PROVEEDOR: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  moonshot: "https://api.moonshot.cn/v1/chat/completions",
  minimax: "https://api.minimaxi.com/v1/chat/completions",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  ollama: "http://localhost:11434/v1/chat/completions",
  vllm: "http://localhost:8000/v1/chat/completions",
  lmstudio: "http://localhost:1234/v1/chat/completions",
};

/** Un modelo con fila en el catálogo, para ver la medición; los demás solo se reenvían. */
const MODELO_CON_PRECIO: Record<string, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-flash",
  qwen: "qwen3.8-flash",
  glm: "glm-5.3-flash",
  gemini: "gemini-2.5-flash",
};

const leer = (ruta: string): string => readFileSync(new URL(`../${ruta}`, import.meta.url), "utf8");

describe("el base_url de un SDK de OpenAI lleva la ruta de SU proveedor", () => {
  it("la tabla cubre todos los alias de --upstream menos anthropic", () => {
    const enLaTabla = PREFIJO_OPENAI_POR_UPSTREAM.map(([alias]) => alias).sort();
    const alias = Object.keys(UPSTREAM_ALIASES).filter((a) => a !== "anthropic").sort();
    expect(enLaTabla).toEqual(alias);
  });

  it("prefijo + /chat/completions, a través del gateway, es el endpoint que documenta el proveedor", () => {
    for (const [alias, prefijo] of PREFIJO_OPENAI_POR_UPSTREAM) {
      const url = urlHaciaElUpstream(`${prefijo}/chat/completions`, UPSTREAM_ALIASES[alias]!);
      expect(url?.href, alias).toBe(ENDPOINT_DEL_PROVEEDOR[alias]);
    }
  });

  it("⛔ el doctor ya no dice que qwen, glm, moonshot, minimax u openrouter van «igual» con …/v1", async () => {
    const { texto } = await doctor(8403, { home: "/casa", path: "", existe: () => false, enPath: () => false });
    expect(texto).not.toMatch(/work the same/);
    const bloque = texto.split(/^» /m).find((t) => t.startsWith("openai-compat-cn:"))!;
    for (const [alias, prefijo] of PREFIJO_OPENAI_POR_UPSTREAM) {
      if (["openai", "ollama", "vllm", "lmstudio"].includes(alias)) continue;
      expect(bloque, alias).toMatch(new RegExp(`^ +${alias} +→ http://127\\.0\\.0\\.1:8403${prefijo.replace(/\//g, "\\/")}$`, "m"));
    }
    expect(bloque).toContain('OpenAI(base_url="http://127.0.0.1:8403/compatible-mode/v1"');
  });

  it("docs/terminales/README.md enseña la misma tabla, y ya no mete qwen|glm… detrás de «Claude Code with DeepSeek»", () => {
    const guia = leer("docs/terminales/README.md");
    for (const [alias, prefijo] of PREFIJO_OPENAI_POR_UPSTREAM) {
      const origen = UPSTREAM_ALIASES[alias]!;
      const fila = guia.split("\n").find((l) => l.startsWith(`| \`${alias}\``));
      if (["vllm", "lmstudio"].includes(alias)) {
        // Comparten la fila de Ollama.
        expect(guia).toContain(`| \`ollama\` · \`vllm\` · \`lmstudio\` |`);
        continue;
      }
      expect(fila, alias).toBeDefined();
      expect(fila, alias).toContain(`\`http://127.0.0.1:8403${prefijo}\``);
      if (alias !== "ollama") {
        expect(fila, alias).toContain(`\`${origen}\``);
        expect(fila, alias).toContain(`\`${ENDPOINT_DEL_PROVEEDOR[alias]!.replace(/\/chat\/completions$/, "")}\``);
      }
    }
    expect(guia).not.toMatch(/Claude Code with DeepSeek; qwen\|glm/);
  });

  it("cursor.md da la ruta de cada upstream y ya no dice «deepseek, qwen, glm, moonshot, ollama… too»", () => {
    const cursor = leer("docs/terminales/cursor.md").replace(/\s+/g, " ");
    expect(cursor).not.toMatch(/deepseek, qwen, glm, moonshot, ollama… too/);
    expect(cursor).toContain("`http://127.0.0.1:8402/compatible-mode/v1` for `qwen`");
    expect(cursor).toContain("`…/api/paas/v4` for `glm`");
    expect(cursor).toContain("`…/v1beta/openai` for `gemini`");
    expect(cursor).toContain("`…/api/v1` for `openrouter`");
    expect(cursor).toContain("no path for `deepseek`");
  });
});

describe("el gateway reenvía la ruta de la receta y la mide (upstream falso, sin red)", () => {
  let recursos: (Server | GatewayArrancado)[] = [];
  let warn: MockInstance<(...args: unknown[]) => void>;
  beforeEach(() => {
    reiniciarAvisos();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    warn.mockRestore();
    for (const r of recursos) {
      if ("cerrar" in r) await r.cerrar();
      else await new Promise((res) => r.close(res));
    }
    recursos = [];
  });

  /** Un upstream falso que contesta Chat Completions en JSON con usage, y anota la ruta. */
  function upstreamFalso(): Promise<{ puerto: number; rutas: string[] }> {
    const rutas: string[] = [];
    return new Promise((resolve) => {
      const s = createServer(async (req, res) => {
        const trozos: Buffer[] = [];
        for await (const c of req) trozos.push(c as Buffer);
        rutas.push(req.url ?? "");
        const { model } = JSON.parse(Buffer.concat(trozos).toString("utf8")) as { model: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 },
          }),
        );
      });
      recursos.push(s);
      s.listen(0, "127.0.0.1", () => resolve({ puerto: (s.address() as { port: number }).port, rutas }));
    });
  }

  for (const [alias, prefijo] of PREFIJO_OPENAI_POR_UPSTREAM) {
    it(`--upstream ${alias}: POST ${prefijo}/chat/completions llega a ${ENDPOINT_DEL_PROVEEDOR[alias]}`, async () => {
      const up = await upstreamFalso();
      const origen = UPSTREAM_ALIASES[alias]!;
      // El origen del alias, con el fetch redirigido al falso local: nada sale a la red.
      const vistas: string[] = [];
      const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (u.origin === new URL(origen).origin) {
          vistas.push(u.href);
          return fetch(`http://127.0.0.1:${up.puerto}${u.pathname}${u.search}`, init);
        }
        return fetch(input, init);
      }) as typeof fetch;
      const lineas: string[] = [];
      // Modo comunitario, como lo arranca `bvsala gateway --upstream <alias>` sin claves.
      const gw = await arrancarGateway({ puerto: 0, upstream: origen, fetchImpl, log: (l) => lineas.push(l), warn: () => {} });
      recursos.push(gw);
      const modelo = MODELO_CON_PRECIO[alias] ?? "modelo-sin-precio";
      const res = await fetch(`http://127.0.0.1:${gw.puerto}${prefijo}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer clave-falsa" },
        body: JSON.stringify({ model: modelo, messages: [{ role: "user", content: "hola" }] }),
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(vistas).toEqual([ENDPOINT_DEL_PROVEEDOR[alias]]);
      expect(up.rutas).toEqual([`${prefijo}/chat/completions`]);
      const t0 = Date.now();
      while (lineas.filter((l) => l.startsWith("[gateway] POST")).length === 0 && Date.now() - t0 < 3000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const linea = lineas.find((l) => l.startsWith("[gateway] POST"));
      expect(linea, alias).toContain(`POST ${prefijo}/chat/completions`);
      if (MODELO_CON_PRECIO[alias] !== undefined) {
        expect(gw.medicion().medidas, alias).toBe(1);
        expect(linea, alias).toMatch(/\$\d+\.\d{6}/);
      } else {
        expect(linea, alias).toContain(`not metered: model "${modelo}" has no list price in the catalog`);
      }
    });
  }
});

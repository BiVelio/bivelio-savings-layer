import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COMMIT_FIJADO,
  REVISADAS,
  SHA256_FIJADO,
  alarmas,
  buscarEnLiteLLM,
  contrastar,
  filasPropias,
  iguales,
  informeEnTexto,
  precioDeLiteLLM,
  urlDeLaTabla,
  type TablaLiteLLM,
} from "../scripts/contraste-catalogo.js";
import { CATALOGO } from "../src/pricing/catalogo.js";
import { TARIFAS_DE_TIER } from "../src/pricing/tarifas-de-tier.js";

/**
 * E4 · EL CONTRASTE DEL CATÁLOGO, sin red: una tabla de LiteLLM pequeña
 * (test/fixtures/litellm-precios-mini.json) con un caso de cada: coincide,
 * difiere, difiere ya revisado, solo lo publica LiteLLM, la entrada de otro
 * proveedor con el mismo nombre (Vertex, Bedrock) y la instantánea con fecha.
 *
 * Lo que no se negocia: la tabla de LiteLLM es una ALARMA, nunca una fuente.
 * El contraste no toca el catálogo ni propone cifras para pegar.
 */

const TABLA = JSON.parse(
  readFileSync(new URL("./fixtures/litellm-precios-mini.json", import.meta.url), "utf8"),
) as TablaLiteLLM;
const DIA = "2026-09-27";

const fila = (inf: ReturnType<typeof contrastar>, clave: string, tramo = "estandar") =>
  inf.filas.find((f) => f.clave === clave && f.tramo === tramo)!;

describe("buscarEnLiteLLM: la entrada del MISMO proveedor", () => {
  it("la clave tal cual, si es del proveedor", () => {
    expect(buscarEnLiteLLM(TABLA, "gpt-4o-mini", "openai")?.clave).toBe("gpt-4o-mini");
  });

  it("Gemini: la de `gemini/…` (el API de Google), nunca la de Vertex con el mismo nombre", () => {
    expect(buscarEnLiteLLM(TABLA, "gemini-3.8-flash", "google")?.clave).toBe("gemini/gemini-3.8-flash");
  });

  it("sin clave desnuda, la instantánea con fecha MÁS RECIENTE", () => {
    expect(buscarEnLiteLLM(TABLA, "claude-3-haiku", "anthropic")?.clave).toBe("claude-3-haiku-20240307");
    expect(buscarEnLiteLLM(TABLA, "claude-3-5-sonnet", "anthropic")?.clave).toBe("claude-3-5-sonnet-20241022");
  });

  it("solo en Bedrock → null: el precio de Bedrock no es la factura del API de Anthropic", () => {
    expect(buscarEnLiteLLM(TABLA, "claude-opus-4", "anthropic")).toBeNull();
  });

  it("no confunde una versión menor con una instantánea (`claude-opus-4-5` no es `claude-opus-4`)", () => {
    const t = { "claude-opus-4-5": { litellm_provider: "anthropic", input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 } };
    expect(buscarEnLiteLLM(t, "claude-opus-4", "anthropic")).toBeNull();
  });
});

describe("precioDeLiteLLM: por token → por 1K, y el tramo por su sufijo", () => {
  it("estándar, con escrituras a 5 min y a 1 h", () => {
    const p = precioDeLiteLLM(TABLA["claude-haiku-4-5"] as Record<string, unknown>, "estandar");
    expect(p.entrada).toBeCloseTo(0.001, 12);
    expect(p.salida).toBeCloseTo(0.005, 12);
    expect(p.lectura).toBeCloseTo(0.0001, 12);
    expect(p.escritura).toBeCloseTo(0.00125, 12);
    expect(p.escritura1h).toBeCloseTo(0.002, 12);
  });

  it("flex lee `_flex` y batch `_batches`; un campo que no está, no está", () => {
    const flex = precioDeLiteLLM(TABLA["o4-mini"] as Record<string, unknown>, "flex");
    expect(flex).toEqual({ entrada: expect.closeTo(0.00055, 12), salida: expect.closeTo(0.0022, 12), lectura: expect.closeTo(0.0001375, 12) });
    const batch = precioDeLiteLLM(TABLA["gpt-4o-mini"] as Record<string, unknown>, "batch");
    expect(Object.keys(batch).sort()).toEqual(["entrada", "salida"]);
  });

  it("`iguales` absorbe el ruido de multiplicar por mil, no una diferencia de verdad", () => {
    expect(iguales(1.5e-7 * 1000, 0.00015)).toBe(true);
    expect(iguales(1.375e-7 * 1000, 0.000138)).toBe(false);
  });
});

describe("contrastar", () => {
  const inf = contrastar(TABLA, { dia: DIA });

  it("coincide donde las dos tablas dicen lo mismo, también en el tramo batch y con la prima de escritura", () => {
    expect(fila(inf, "gpt-4o-mini").estado).toBe("coincide");
    expect(fila(inf, "gpt-4o-mini", "batch").estado).toBe("coincide");
    expect(fila(inf, "claude-haiku-4-5").estado).toBe("coincide");
    expect(fila(inf, "claude-haiku-4-5", "batch").estado).toBe("coincide");
    expect(fila(inf, "gemini-3.8-flash").estado).toBe("coincide");
  });

  it("⛔ una diferencia sin revisar es ALARMA (la escritura de Haiku 3 y una salida cambiada)", () => {
    const haiku3 = fila(inf, "claude-3-haiku");
    expect(haiku3.estado).toBe("difiere");
    expect(haiku3.diferencias).toEqual([
      { campo: "escritura", tipo: "difiere", nuestro: expect.closeTo(0.0003125, 12), suyo: expect.closeTo(0.0003, 12) },
    ]);
    const al = alarmas(inf).map(({ fila: f, diferencia: d }) => `${f.clave}/${f.tramo}/${d.campo}`);
    expect(al.sort()).toEqual(["claude-3-haiku/estandar/escritura", "claude-sonnet-5/estandar/salida"]);
    expect(inf.resumen.alarmas).toBe(2);
  });

  it("una diferencia ya contrastada con la página oficial no es alarma… mientras LiteLLM diga lo mismo", () => {
    const o4 = fila(inf, "o4-mini", "flex");
    expect(o4.estado).toBe("difiere");
    expect(o4.diferencias[0]!.revision?.veredicto).toBe("nosotros");
    expect(inf.resumen.revisadas).toBe(1);

    // LiteLLM cambia su cifra: la revisión ya no la cubre y vuelve la alarma.
    const cambiada = structuredClone(TABLA) as Record<string, Record<string, unknown>>;
    cambiada["o4-mini"]!["cache_read_input_token_cost_flex"] = 1.36e-7;
    const otra = contrastar(cambiada, { dia: DIA });
    expect(fila(otra, "o4-mini", "flex").diferencias[0]!.revision).toBeUndefined();
    expect(alarmas(otra).some(({ fila: f }) => f.clave === "o4-mini")).toBe(true);
  });

  it("lo que solo publica LiteLLM es informativo (o3-pro sin lectura de caché a propósito)", () => {
    expect(fila(inf, "o3-pro").diferencias).toEqual([{ campo: "lectura", tipo: "solo-suyo", suyo: expect.closeTo(0.005, 12) }]);
    expect(fila(inf, "o3-pro").estado).toBe("coincide");
  });

  it("sin entrada del proveedor → sin referencia, nunca comparado con la de otro", () => {
    expect(fila(inf, "claude-opus-4").estado).toBe("sin-referencia");
    expect(fila(inf, "claude-opus-4").claveLiteLLM).toBeNull();
  });

  it("recorre TODO el catálogo y cada tier vigente", () => {
    const estandar = inf.filas.filter((f) => f.tramo === "estandar").map((f) => f.clave);
    expect(estandar.sort()).toEqual(Object.keys(CATALOGO).sort());
    const tiers = Object.values(TARIFAS_DE_TIER).flatMap((porTier) => Object.values(porTier).flatMap((filas) => Object.keys(filas)));
    expect(inf.filas.filter((f) => f.tramo !== "estandar")).toHaveLength(tiers.length);
  });
});

describe("⛔ ALARMA, nunca fuente", () => {
  it("contrastar no toca el catálogo ni las tarifas de tier", () => {
    const antes = JSON.stringify([CATALOGO, TARIFAS_DE_TIER]);
    const cambiada = structuredClone(TABLA) as Record<string, Record<string, unknown>>;
    cambiada["gpt-4o-mini"]!["input_cost_per_token"] = 9e-6;
    contrastar(cambiada, { dia: DIA });
    expect(JSON.stringify([CATALOGO, TARIFAS_DE_TIER])).toBe(antes);
  });

  it("el informe dice ALARMA y no ofrece cifras para pegar en el catálogo", () => {
    const texto = informeEnTexto(contrastar(TABLA, { dia: DIA }), "fixture");
    expect(texto).toContain("ALARMA");
    expect(texto).toContain("⛔ claude-3-haiku [estandar] escritura");
    expect(texto).toContain("es una alarma, no una fuente");
    expect(texto).not.toMatch(/inputPer1k|línea lista|outputPer1k/);
  });

  it("el script no escribe en src/: solo en la evidencia o donde diga --salida", () => {
    const fuente = readFileSync(new URL("../scripts/contraste-catalogo.ts", import.meta.url), "utf8");
    const escrituras = [...fuente.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1]);
    expect(escrituras).toEqual(["d"]);
    expect(fuente).toContain('join(dirname(fileURLToPath(import.meta.url)), "..", "benchmarks", "evidencia"');
  });
});

describe("lo revisado y lo fijado", () => {
  it("cada revisión cita una URL oficial y una fecha, y apunta a una fila, tramo y campo nuestros", () => {
    const propias = filasPropias(DIA);
    for (const r of REVISADAS) {
      expect(r.fuente).toMatch(/^https:\/\/(developers\.openai\.com|platform\.claude\.com|ai\.google\.dev)\//);
      expect(r.consultado).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.nota.length).toBeGreaterThan(20);
      const p = propias.find((f) => f.clave === r.clave && f.tramo === r.tramo);
      expect(p?.precio[r.campo], `${r.clave}/${r.tramo}/${r.campo}`).toBeDefined();
      // Revisada = sigue siendo distinta de la nuestra; si no, sobra.
      expect(iguales(p!.precio[r.campo]!, r.suyo)).toBe(false);
    }
  });

  it("la referencia está fijada a un commit y una suma, y la evidencia del día es de ese commit", () => {
    expect(COMMIT_FIJADO).toMatch(/^[0-9a-f]{40}$/);
    expect(SHA256_FIJADO).toMatch(/^[0-9a-f]{64}$/);
    expect(urlDeLaTabla(COMMIT_FIJADO)).toBe(
      `https://raw.githubusercontent.com/BerriAI/litellm/${COMMIT_FIJADO}/model_prices_and_context_window.json`,
    );
    const evidencia = JSON.parse(
      readFileSync(new URL("../benchmarks/evidencia/contraste-catalogo-2026-09-27.json", import.meta.url), "utf8"),
    ) as { referencia: { commit: string; sha256: string }; resumen: { alarmas: number } };
    expect(evidencia.referencia.commit).toBe(COMMIT_FIJADO);
    expect(evidencia.referencia.sha256).toBe(SHA256_FIJADO);
    expect(evidencia.resumen.alarmas).toBe(0);
  });
});

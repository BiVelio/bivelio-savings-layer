import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveVerdict } from "@/app/[locale]/dashboard/derive";
import { agregarPorModelo } from "@/app/[locale]/dashboard/explorer-datos";

import { BANCO_EN_VIVO } from "./banco-en-vivo";
import {
  PANEL_DEL_BANCO,
  capturaDisponible,
  filasDiariasDelBanco,
  filasPorModeloDelBanco,
  huellaDelPanel,
  pieDelTitular,
  ahorroPorModeloDelBanco,
} from "./panel-del-banco";

/**
 * LA CAPTURA DEL HÉROE ENSEÑA SOLO EL BANCO PÚBLICO (2026-10-03).
 *
 * La imagen del héroe es el panel de verdad alimentado con
 * `panel-del-banco.ts`. Esta verja exige que:
 *   · cada número de esas filas salga de los JSON de los informes del banco
 *     (los mismos que sostienen `BANCO_EN_VIVO`), sin elegir modelos: entran
 *     TODOS los que esos informes midieron, y ninguno más;
 *   · lo que la captura pinta (titular, peticiones y ahorro por modelo) sea lo
 *     que el panel deriva de esas filas, y cuadre con las cifras publicadas;
 *   · la imagen se haya capturado con ESTAS cifras (la huella);
 *   · la ruta de la captura no exista fuera de desarrollo.
 */

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const RAIZ = join(WEB, "..", "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const informe = (ruta: string): J => JSON.parse(readFileSync(join(RAIZ, ruta), "utf8"));
const P = PANEL_DEL_BANCO;
/** La fracción de repeticiones exactas del flujo, en cada informe del panel. */
const informes0 = () => [...new Set(P.modelos.map((m) => m.informe))].map((r) => informe(r).flujo.fraccionRepeticiones as number);
const cerca = (a: number, b: number, msg: string) => expect(Math.abs(a - b), `${msg}: ${a} vs ${b}`).toBeLessThan(1e-9);

describe("el panel del héroe, contra los informes del banco", () => {
  const informes = [...new Set(P.modelos.map((m) => m.informe))];

  it("los informes son las tiradas EN VIVO de GSM8K de BANCO_EN_VIVO, de ese día, con su flujo con repeticiones", () => {
    expect(informes.sort()).toEqual([BANCO_EN_VIVO.anthropic.informe, BANCO_EN_VIVO.openai.informe].sort());
    for (const ruta of informes) {
      const inf = informe(ruta);
      expect(inf.modo, ruta).toBe("LIVE");
      expect(inf.bateria, ruta).toBe("gsm8k");
      expect(inf.fecha, ruta).toBe(P.dia);
      expect(inf.flujo.fraccionRepeticiones, ruta).toBe(BANCO_EN_VIVO.repeticiones);
      expect(inf.procedencia.version, ruta).toBe(P.versionSdk);
    }
  });

  it("entran TODOS los modelos medidos de esos informes, y ninguno más", () => {
    const medidos = informes.flatMap((r) => (informe(r).modelos as J[]).filter((m) => m.estado === "medido").map((m) => m.modelo));
    expect(P.modelos.map((m) => m.modelo).sort()).toEqual(medidos.sort());
  });

  for (const m of P.modelos) {
    it(`${m.modelo}: cada número es el del informe`, () => {
      const x = (informe(m.informe).modelos as J[]).find((y) => y.modelo === m.modelo);
      expect(x.estado).toBe("medido");
      const A = x.resumen.brazos.A;
      const B = x.resumen.brazos.B;
      expect(m.nombre).toBe(m.modelo.split("/")[1]);
      expect(m.peticiones).toBe(B.peticiones);
      expect(m.llamadasAlProveedor).toBe(B.llamadasAlProveedor);
      expect(m.servidasDesdeCache).toBe(B.fuentes.exact_cache);
      expect(m.llamadasAlProveedor + m.servidasDesdeCache).toBe(m.peticiones);
      expect(B.errores).toBe(0);
      cerca(m.costeA, A.costeUsd, "coste A");
      cerca(m.costeB, B.costeUsd, "coste B");
      const desglose = (x.desglose as J[] | undefined)?.find((d) => d.brazo === "B");
      cerca(m.prefijoDelProveedor, desglose?.prefijoNetoUsd ?? 0, "caché de prefijo del proveedor");
      expect(m.tokensA).toEqual({ entrada: A.tokens.entrada, salida: A.tokens.salida });
      expect(m.tokensB).toEqual({ entrada: B.tokens.entrada, salida: B.tokens.salida, cacheada: B.tokens.cacheada });
      // El ahorro del informe (B frente a A) es el de las filas, antes de apartar al proveedor.
      const cmp = (x.resumen.comparaciones as J[]).find((c) => c.brazo === "B");
      cerca(1 - m.costeB / m.costeA, cmp.ahorroMedido.point, "ahorro medido");
    });
  }
});

describe("lo que la captura pinta es lo que el panel deriva de esas filas", () => {
  const usage = filasDiariasDelBanco();
  const porModelo = filasPorModeloDelBanco();
  const v = deriveVerdict(usage);

  it("el titular: medido entero, positivo, y sin la caché de prefijo del proveedor", () => {
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    const A = P.modelos.reduce((n, m) => n + m.costeA, 0);
    const B = P.modelos.reduce((n, m) => n + m.costeB, 0);
    const prefijo = P.modelos.reduce((n, m) => n + m.prefijoDelProveedor, 0);
    cerca(v.net, 1 - (B + prefijo) / A, "titular");
    cerca(v.saved, A - B - prefijo, "importe");
    expect(v.share).toBe(1);
    expect(v.total).toBeNull();
    expect(v.byReference).toBeNull();
    // Lo que se lee en la imagen: «32.7%» (el importe, $0.27, no se enseña: es un banco de céntimos).
    expect((v.net * 100).toFixed(1)).toBe("32.7");
    expect(v.saved.toFixed(2)).toBe("0.27");
    // Conservador: por debajo del ahorro total del A/B, que incluye al proveedor.
    expect(v.net).toBeLessThan(1 - B / A);
  });

  it("por modelo: el ahorro neto de cada uno, todos positivos, y ninguno inventado", () => {
    const barras = agregarPorModelo(porModelo, "neto");
    expect(barras.map((b) => b.model)).toEqual(["claude-sonnet-5", "claude-haiku-4-5", "gpt-5.4-mini", "gpt-4o-mini"]);
    expect(barras.map((b) => b.valor.toFixed(2))).toEqual(["0.11", "0.08", "0.07", "0.01"]);
    for (const b of barras) expect(b.valor).toBeGreaterThan(0);
    expect(porModelo.every((r) => r.day === P.dia)).toBe(true);
  });

  it("cuadra con lo que la portada publica: gpt-4o-mini es el −31,5 % y Claude Sonnet 5 es el 75,1 % menos el 41 % del proveedor", () => {
    const fila = (n: string) => porModelo.find((r) => r.model === n)!;
    const ahorro = (n: string) => 1 - fila(n).actualCost / fila(n).baselineCost;
    expect(Math.round(ahorro("gpt-4o-mini") * 1000) / 1000).toBe(BANCO_EN_VIVO.openai.ahorro.point);
    const sonnet = BANCO_EN_VIVO.anthropic;
    expect(Math.abs(ahorro("claude-sonnet-5") - (sonnet.ahorro.point - sonnet.prefijoDelProveedor))).toBeLessThan(0.01);
  });

  it("los dos libros que la batería no puede mover van a 0 por construcción, y los tokens son los del informe", () => {
    const d = usage[0]!;
    expect(usage).toHaveLength(1);
    expect(d.eliminatedInputTokens).toBe(0);
    expect(d.compressedInputTokens).toBe(0);
    expect(d.avoidedLlm + d.actualLlm).toBe(d.requests);
    expect(d.requests).toBe(P.modelos.reduce((n, m) => n + m.peticiones, 0));
  });
});

describe("la imagen y la ruta que la produce", () => {
  it("las dos imágenes se capturaron con ESTAS cifras (si cambian, `node scripts/captura-panel.ts`)", () => {
    const meta = JSON.parse(readFileSync(join(WEB, "assets", "portada", "panel-del-banco.json"), "utf8"));
    expect(meta.huella).toBe(huellaDelPanel());
    expect(meta.ruta).toBe("/es/captura-panel");
    for (const [fichero, densidad] of [["panel-del-banco.png", 2], ["panel-del-banco-movil.png", 3]] as const) {
      // Las dimensiones del PNG (cabecera IHDR) son las que dice su ficha.
      const png = readFileSync(join(WEB, "assets", "portada", fichero));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], fichero).toEqual([meta[fichero].ancho, meta[fichero].alto]);
      expect(meta[fichero].densidad, fichero).toBe(densidad);
      expect(png.length, fichero).toBeLessThan(250 * 1024);
    }
  });

  it("los rótulos de la captura dicen lo que es: un día del banco, demo, sin «tu», sin «30 días», sin «live»", () => {
    const R = P.rotulos;
    const todos = Object.values(R).join(" | ");
    expect(todos).not.toMatch(/\btu\b|\btus\b|30 días|últimos|live|en directo/i);
    expect(R.pastilla).toMatch(/demo/i);
    expect(R.antetitulo).toContain(P.dia);
    expect(R.antetitulo).toContain(P.bateria);
    expect(R.tituloPagina).toMatch(/banco público/);
    // El pie no lleva dólares: los recuentos salen de las filas.
    const pie = pieDelTitular();
    expect(pie).not.toMatch(/\$/);
    const d = filasDiariasDelBanco()[0]!;
    expect(pie).toContain(`${d.requests} peticiones`);
    expect(pie).toContain(`${d.avoidedLlm} respondidas sin llamar al proveedor`);
    // El titular solo vale para un flujo que repite así: la condición va al lado de la cifra.
    expect(BANCO_EN_VIVO.repeticiones).toBe(0.3);
    for (const r of informes0()) expect(r).toBe(BANCO_EN_VIVO.repeticiones);
    expect(pie).toMatch(/^menos factura · en un flujo con un 30\s%\sde peticiones repetidas · /);
  });

  it("el ahorro de cada modelo es el de las filas (sin el proveedor) y cuadra con el informe", () => {
    const a = ahorroPorModeloDelBanco();
    expect(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, (v * 100).toFixed(1)]))).toEqual({
      "gpt-4o-mini": "31.5",
      "gpt-5.4-mini": "31.7",
      "claude-haiku-4-5": "32.2",
      "claude-sonnet-5": "34.0",
    });
    for (const r of filasPorModeloDelBanco()) cerca(a[r.model]!, 1 - r.actualCost / r.baselineCost, r.model);
  });

  it("el panel de los clientes no pasa los rótulos ni la presentación de la captura", () => {
    const panel = readFileSync(join(WEB, "app", "[locale]", "dashboard", "page.tsx"), "utf8");
    expect(panel).not.toMatch(/rotulos=|presentacion=/);
    const captura = readFileSync(join(WEB, "app", "[locale]", "captura-panel", "page.tsx"), "utf8");
    expect(captura).toMatch(/rotulos=\{\{ antetitulo: R\.antetitulo, pastilla: R\.pastilla, pie: pieDelTitular\(\) \}\}/);
    expect(captura).toContain('metrica: "peticiones"');
    expect(captura).toContain("sinControles: true");
  });

  it("la ruta de la captura solo existe en desarrollo, y pinta solo estas filas", () => {
    expect(capturaDisponible("development")).toBe(true);
    for (const e of ["production", "test", undefined]) expect(capturaDisponible(e)).toBe(false);
    const src = readFileSync(join(WEB, "app", "[locale]", "captura-panel", "page.tsx"), "utf8");
    const cuerpo = src.slice(src.indexOf("export default"));
    expect(cuerpo.indexOf("if (!capturaDisponible()) notFound();")).toBeGreaterThan(-1);
    expect(cuerpo.indexOf("if (!capturaDisponible()) notFound();")).toBeLessThan(cuerpo.indexOf("await params"));
    expect(src).toContain("const usage = filasDiariasDelBanco();");
    expect(src).toContain("const porModelo = filasPorModeloDelBanco();");
    expect(src).not.toMatch(/loadDashboard|createReadOnlyClient|supabase/);
    expect(src).toMatch(/orgName=\{PANEL_DEL_BANCO\.organizacion\}/);
    expect(P.organizacion).toMatch(/demo/);
  });
});

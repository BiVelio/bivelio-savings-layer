import { describe, it, expect } from "vitest";

import { ToolSelector } from "../src/router/tool-selector.js";
import type { ToolDescriptor } from "../src/contracts/types.js";

/**
 * En una ruta TOOL_ACTION, una herramienta de ESCRITURA no se poda por
 * desajuste léxico de intents.
 *
 * POR QUÉ. El selector podaba TODA herramienta con score 0, writes incluidas,
 * incluso cuando el router ya había clasificado la petición como «imperativo +
 * hay una write». El intent de una write casa con el verbo del usuario pocas
 * veces (`intents:["facturación saliente"]` contra «envía la factura» da 0), así
 * que se descartaba: el proveedor no veía la capacidad, el modelo contestaba
 * «claro, la envío» y NADA se enviaba — y encima el libro 2 acreditaba sus tokens
 * como ahorro. Es el «peor fallo posible» que el repo ya cerró en otras dos
 * puertas. Aquí se fija la tercera.
 */

const write = (id: string, intents: string[]): ToolDescriptor => ({ id, intents, risk: "write" });
const read = (id: string, intents: string[]): ToolDescriptor => ({ id, intents, risk: "read" });

describe("ToolSelector — writes en TOOL_ACTION", () => {
  it("conserva la write aunque su intent no case léxicamente, y NO la acredita como ahorro", () => {
    const sel = new ToolSelector();
    const tools = [write("send_invoice", ["facturación saliente"])];
    const r = sel.select("envía la factura de hoy al cliente", tools, "TOOL_ACTION");

    expect(r.tools.map((t) => t.id)).toContain("send_invoice");
    // Y como deja de estar en droppedIds, la etapa 6 ya no la contabiliza como
    // tokens eliminados: el arreglo de contabilidad sale gratis.
    expect(r.droppedIds).not.toContain("send_invoice");
  });

  it("una write con intent que SÍ casa también entra (no rompe el camino feliz)", () => {
    const sel = new ToolSelector();
    const r = sel.select("envía la factura", [write("send_invoice", ["enviar factura"])], "TOOL_ACTION");
    expect(r.tools.map((t) => t.id)).toEqual(["send_invoice"]);
  });

  it("con `maxTools`, las de LECTURA sí se podan por relevancia (solo las writes son incondicionales)", () => {
    const sel = new ToolSelector({ maxTools: 8 });
    const tools = [
      write("send_invoice", ["facturación saliente"]),
      read("weather_lookup", ["el tiempo meteorológico"]),
    ];
    const r = sel.select("envía la factura de hoy", tools, "TOOL_ACTION");
    // La write se queda; la read irrelevante se poda (ahorro legítimo).
    expect(r.tools.map((t) => t.id)).toEqual(["send_invoice"]);
    expect(r.droppedIds).toContain("weather_lookup");
    expect(r.droppedIds).not.toContain("send_invoice");
  });

  it("fuera de TOOL_ACTION, una write ni siquiera es elegible (aislamiento intacto)", () => {
    const sel = new ToolSelector();
    const tools = [write("delete_account", ["borrar cuenta"])];
    const r = sel.select("borra la cuenta", tools, "SINGLE_RETRIEVAL");
    expect(r.tools).toHaveLength(0);
    expect(r.droppedIds).toContain("delete_account");
  });

  it("bajo presión de presupuesto, la write gana el hueco a una read que sí casaba", () => {
    const sel = new ToolSelector({ maxTools: 1 });
    const tools = [
      read("search_docs", ["buscar documentos"]),
      write("send_invoice", ["facturación saliente"]),
    ];
    const r = sel.select("busca documentos y envía la factura", tools, "TOOL_ACTION");
    // maxTools=1: la write (la acción) ocupa el único hueco; la read cae aunque
    // su intent casara. Nunca se sacrifica la capacidad de actuar.
    expect(r.tools.map((t) => t.id)).toEqual(["send_invoice"]);
    expect(r.droppedIds).toContain("search_docs");
  });

  // ── LA REGRESIÓN QUE EL ARREGLO ORIGINAL SE DEJABA ────────────────────────
  // El primer intento de este arreglo (PR #94) hacía `writes.slice(0, maxTools)`
  // en ORDEN DE DECLARACIÓN. Con más writes que presupuesto, eso descarta justo
  // la que sí casaba: el mismo fallo silencioso que la función viene a cerrar,
  // reaparecido en la frontera del presupuesto — y ahí era PEOR que no arreglar
  // nada, porque el `main` de entonces sí acertaba en este caso.
  it("con más writes que presupuesto, entra la que CASA, no la primera declarada", () => {
    const sel = new ToolSelector({ maxTools: 2 });
    const tools = [
      write("archivar_lote", ["archivado masivo nocturno"]),
      write("purgar_temporales", ["limpieza de temporales"]),
      write("send_invoice", ["envía la factura"]),
    ];
    const r = sel.select("envía la factura de hoy al cliente", tools, "TOOL_ACTION");
    expect(r.tools.map((t) => t.id)).toContain("send_invoice");
    expect(r.droppedIds).not.toContain("send_invoice");
    expect(r.tools).toHaveLength(2);
  });

  it("a igual puntuación manda el orden del llamante: el resultado es determinista", () => {
    const sel = new ToolSelector({ maxTools: 2 });
    const tools = [
      write("primera", ["intent que no casa nada"]),
      write("segunda", ["otro intent que tampoco"]),
      write("tercera", ["ni este"]),
    ];
    const a = sel.select("haz algo", tools, "TOOL_ACTION");
    const b = sel.select("haz algo", tools, "TOOL_ACTION");
    expect(a.tools.map((t) => t.id)).toEqual(b.tools.map((t) => t.id));
    // `sort` es estable, así que con todas a 0 sobreviven las dos primeras.
    expect(a.tools.map((t) => t.id)).toEqual(["primera", "segunda"]);
  });
});

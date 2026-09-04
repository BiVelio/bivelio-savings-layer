import { describe, it, expect } from "vitest";

import { bootstrapDiferencia, construirPeticion } from "../benchmarks/anillo1/arnes.js";
import {
  ejecutarHerramienta,
  tareasDelAnillo1,
  type EstadoDeTarea,
} from "../benchmarks/anillo1/tareas.js";
import { BETA_CONTEXT_MANAGEMENT, DIAL_TRIGGER_INPUT_TOKENS } from "../gateway/diales.js";

/**
 * Verjas del anillo 1 — todo SIN red:
 *  · los mundos son deterministas (dos construcciones, bytes idénticos);
 *  · cada verificador acepta la solución correcta y rechaza una incorrecta;
 *  · el brazo B lleva EXACTAMENTE lo que la palanca S4a inyecta y el A nada;
 *  · la sal de frío es el primer byte del system y separa brazos y reps;
 *  · los tool_results son lo bastante gordos para cruzar el dial (30K tokens).
 */

const tareas = tareasDelAnillo1();

describe("el corpus del anillo 1", () => {
  it("tiene al menos las 10–15 tareas del plan, con las tres clases", () => {
    expect(tareas.length).toBeGreaterThanOrEqual(10);
    expect(tareas.length).toBeLessThanOrEqual(15);
    const clases = new Set(tareas.map((t) => t.clase));
    for (const c of ["log", "codigo", "otro"]) expect(clases.has(c as never)).toBe(true);
  });

  it("los mundos son deterministas: dos construcciones byte-idénticas", () => {
    for (const t of tareas) {
      const x = t.construir();
      const y = t.construir();
      expect([...x.ficheros.keys()].sort()).toEqual([...y.ficheros.keys()].sort());
      for (const [ruta, contenido] of x.ficheros) expect(y.ficheros.get(ruta)).toBe(contenido);
    }
  });

  it("hay masa de verdad: el corpus cruza el dial de disparo con pocas lecturas", () => {
    // ~4 bytes/token: el dial son 30K tokens ≈ 120KB. Las tareas de log llevan
    // ficheros de ≥60KB: dos lecturas cruzan el umbral.
    const gordos = tareas.filter((t) => {
      const e = t.construir();
      return Math.max(...[...e.ficheros.values()].map((c) => c.length)) >= 60_000;
    });
    expect(gordos.length).toBeGreaterThanOrEqual(4);
    void DIAL_TRIGGER_INPUT_TOKENS;
  });

  it("cada verificador rechaza la respuesta vacía sobre el mundo intacto (salvo que el estado ya valga)", () => {
    for (const t of tareas) {
      const e = t.construir();
      expect(t.verificar(e, ""), t.id).toBe(false);
    }
  });
});

describe("verificadores — aceptan lo correcto, rechazan lo incorrecto", () => {
  const porId = (id: string) => tareas.find((t) => t.id === id)!;

  it("log-aguja-500: exige el rid exacto", () => {
    const t = porId("log-aguja-500");
    const e = t.construir();
    const linea = [...e.ficheros.values()][0]!.split("\n").find((l) => l.includes("status=500"))!;
    const rid = /rid=(req_[0-9a-f]+)/.exec(linea)![1]!;
    expect(t.verificar(e, `el culpable es ${rid}`)).toBe(true);
    expect(t.verificar(e, "el culpable es req_ffffffff")).toBe(false);
  });

  it("codigo-off-by-one: los tests simulados mandan", () => {
    const t = porId("codigo-off-by-one");
    const e = t.construir();
    expect(t.tests!(e).verde).toBe(false);
    const antes = e.ficheros.get("src/paginacion.ts")!;
    ejecutarHerramienta(t, e, {
      nombre: "escribir_fichero",
      entrada: { ruta: "src/paginacion.ts", contenido: antes.replace("let i = 1;", "let i = 0;") },
    });
    expect(t.tests!(e).verde).toBe(true);
    expect(t.verificar(e, "arreglado")).toBe(true);
  });

  it("codigo-renombrar: no vale a medias", () => {
    const t = porId("codigo-renombrar");
    const e = t.construir();
    for (const [ruta, c] of e.ficheros) e.ficheros.set(ruta, c.replaceAll("calcularTotal", "calcularImporte"));
    expect(t.verificar(e, "hecho")).toBe(true);
    const primera = [...e.ficheros.keys()][0]!;
    e.ficheros.set(primera, e.ficheros.get(primera)!.replaceAll("calcularImporte", "calcularTotal"));
    expect(t.verificar(e, "hecho")).toBe(false);
  });

  it("mixta-migrar-json: exige valores exactos en céntimos", () => {
    const t = porId("mixta-migrar-json");
    const e = t.construir();
    for (const [ruta, c] of e.ficheros) {
      const filas = (JSON.parse(c) as { concepto: string; precio: number }[]).map((f) => ({
        concepto: f.concepto,
        precio_centimos: Math.round(f.precio * 100),
      }));
      e.ficheros.set(ruta, JSON.stringify(filas, null, 2) + "\n");
    }
    expect(t.verificar(e, "migrado")).toBe(true);
    const alguna = [...e.ficheros.keys()][0]!;
    const filas = JSON.parse(e.ficheros.get(alguna)!) as { precio_centimos: number }[];
    filas[0]!.precio_centimos += 1;
    e.ficheros.set(alguna, JSON.stringify(filas, null, 2) + "\n");
    expect(t.verificar(e, "migrado")).toBe(false);
  });

  it("otro-top-margen: el orden importa", () => {
    const t = porId("otro-top-margen");
    const e = t.construir();
    const productos = JSON.parse(e.ficheros.get("datos/productos.json")!) as {
      sku: string;
      costeEur: number;
      precioEur: number;
    }[];
    const orden = [...productos].sort((a, b) => b.precioEur - b.costeEur - (a.precioEur - a.costeEur)).map((p) => p.sku);
    ejecutarHerramienta(t, e, {
      nombre: "escribir_fichero",
      entrada: { ruta: "informes/resumen.md", contenido: orden.slice(0, 3).join("\n") },
    });
    expect(t.verificar(e, "escrito")).toBe(true);
    ejecutarHerramienta(t, e, {
      nombre: "escribir_fichero",
      entrada: { ruta: "informes/resumen.md", contenido: orden.slice(0, 3).reverse().join("\n") },
    });
    expect(t.verificar(e, "escrito")).toBe(false);
  });
});

describe("herramientas simuladas", () => {
  const t = tareas[0]!;
  const estado = (): EstadoDeTarea => t.construir();

  it("leer/listar/buscar responden y escribir muta", () => {
    const e = estado();
    expect(ejecutarHerramienta(t, e, { nombre: "listar", entrada: {} }).contenido).toContain("logs/app.log");
    expect(ejecutarHerramienta(t, e, { nombre: "leer_fichero", entrada: { ruta: "no/existe" } }).esError).toBe(true);
    const b = ejecutarHerramienta(t, e, { nombre: "buscar", entrada: { patron: "status=500" } });
    expect(b.contenido).toContain("logs/app.log:");
    ejecutarHerramienta(t, e, { nombre: "escribir_fichero", entrada: { ruta: "x.txt", contenido: "hola" } });
    expect(e.ficheros.get("x.txt")).toBe("hola");
  });

  it("entregar termina con la respuesta", () => {
    const e = estado();
    const r = ejecutarHerramienta(t, e, { nombre: "entregar", entrada: { respuesta: "req_123" } });
    expect(r.entrega).toBe("req_123");
  });
});

describe("construirPeticion — los brazos son EXACTAMENTE la palanca y su ausencia", () => {
  const base = { tarea: tareas[0]!, sal: "tirada-x-A-0", modelo: "claude-sonnet-4-5", mensajes: [], apiKey: "sk-test" };

  it("brazo B lleva los diales y la beta; brazo A ni una cosa ni la otra", () => {
    const a = construirPeticion({ ...base, brazo: "A" });
    const b = construirPeticion({ ...base, brazo: "B" });
    expect(a.cuerpo.context_management).toBeUndefined();
    expect(a.cabeceras["anthropic-beta"]).toBeUndefined();
    const cm = b.cuerpo.context_management as { edits: { trigger: { value: number } }[] };
    expect(cm.edits[0]!.trigger.value).toBe(DIAL_TRIGGER_INPUT_TOKENS);
    expect(b.cabeceras["anthropic-beta"]).toBe(BETA_CONTEXT_MANAGEMENT);
  });

  it("la sal es el PRIMER byte del system y distingue brazos y reps", () => {
    const a = construirPeticion({ ...base, brazo: "A" });
    const b = construirPeticion({ ...base, brazo: "B", sal: "tirada-x-B-0" });
    expect(String(a.cuerpo.system).startsWith("[medicion-fria tirada-x-A-0]")).toBe(true);
    expect(String(a.cuerpo.system)).not.toBe(String(b.cuerpo.system));
  });
});

describe("bootstrapDiferencia", () => {
  it("con B siempre mejor, el CI queda por encima de cero", () => {
    const pares = Array.from({ length: 40 }, () => ({ a: 0, b: 1 }));
    const ci = bootstrapDiferencia(pares, 2000);
    expect(ci.inferior).toBeGreaterThan(0);
  });
  it("con brazos idénticos, el CI abraza el cero", () => {
    const pares = Array.from({ length: 40 }, (_, i) => ({ a: i % 2, b: i % 2 }));
    const ci = bootstrapDiferencia(pares, 2000);
    expect(ci.inferior).toBeLessThanOrEqual(0);
    expect(ci.superior).toBeGreaterThanOrEqual(0);
  });
});

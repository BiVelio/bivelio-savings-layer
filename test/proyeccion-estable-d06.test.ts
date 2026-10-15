import { createHash } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  crearEjecutorDeRecuperacion,
  ejecutarConRecuperacion,
  ErrorDeProyeccion,
  ESQUEMA_DE_RECUPERACION,
  HERRAMIENTA_DE_RECUPERACION,
  ProyectorEstable,
  vistaPrevia,
  type OpcionesDeProyeccion,
} from "../src/compression/proyeccion-estable.js";
import { AlmacenRecuperableEnMemoria } from "../src/retrieval/almacen-recuperable.js";
import { AlmacenDeEleccionesEnMemoria } from "../src/retrieval/elecciones-persistidas.js";

/**
 * D06 · proyección estable en la ruta piloto (Anthropic Messages sin stream).
 *
 * Los oráculos son de valor: bytes que salen comparados con bytes que entraron
 * (JSON.stringify de lo enviado), sha256 de `node:crypto` sobre el original,
 * y el cuerpo que de verdad llega al `fetch` del SDK oficial.
 */

type Registro = Record<string, unknown>;

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const ambito = { tenantId: "acme", projectId: "facturacion", sessionId: "ses-1", branchId: "main" };

/** Un log de tests de ~40 KB con un fallo en medio y el resumen al final. */
function logDeTests(lineas = 800, relleno = "ok"): string {
  const salida: string[] = ["> vitest run", ""];
  for (let i = 1; i <= lineas; i++) {
    if (i === 413) salida.push(`FAIL  test/factura.test.ts > total con IVA: expected 121.00 to be 121.01`);
    else salida.push(`  ✓ test/caso-${String(i).padStart(4, "0")}.test.ts (${(i * 7) % 97} ms) ${relleno}`);
  }
  salida.push("", "Test Files  1 failed | 799 passed (800)", "exit code 1");
  return salida.join("\n");
}

const LOG = logDeTests();

function turno1(contenido: unknown = LOG): Registro {
  return {
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system: [{ type: "text", text: "Eres un agente de CI.", cache_control: { type: "ephemeral" } }],
    tools: [
      {
        name: "bash",
        description: "Run a command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      { role: "user", content: "Corre los tests y dime qué falla." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hay que correr vitest.", signature: "c2lnLWZpcm1hZGE=" },
          { type: "tool_use", id: "toolu_01", name: "bash", input: { cmd: "pnpm vitest run" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: contenido, cache_control: { type: "ephemeral" } }],
      },
    ],
  };
}

function turno2(base: Registro = turno1()): Registro {
  return {
    ...base,
    messages: [
      ...(base.messages as unknown[]),
      { role: "assistant", content: [{ type: "text", text: "Falla factura.test.ts." }] },
      { role: "user", content: "¿Y cuántos pasaron?" },
    ],
  };
}

function entorno(extra: Partial<OpcionesDeProyeccion> = {}) {
  const almacen = new AlmacenRecuperableEnMemoria();
  const elecciones = new AlmacenDeEleccionesEnMemoria();
  const ejecutor = crearEjecutorDeRecuperacion(almacen);
  const opciones = (mas: Partial<OpcionesDeProyeccion> = {}): OpcionesDeProyeccion => ({
    modo: "recoverable",
    ambito,
    politica: "pol-v1",
    elecciones,
    almacen,
    ejecutor,
    ...extra,
    ...mas,
  });
  return { almacen, elecciones, ejecutor, opciones, proyector: (mas: Partial<OpcionesDeProyeccion> = {}) => new ProyectorEstable(opciones(mas)) };
}

function resultadoDe(cuerpo: Registro, indice = 2): Registro {
  const m = (cuerpo.messages as Registro[])[indice]!;
  return (m.content as Registro[])[0]!;
}

function handleEn(texto: string): string {
  const m = /"handle":"(bvr1_[A-Za-z0-9_-]{32})"/.exec(texto);
  if (!m) throw new Error("no hay handle en la vista previa");
  return m[1]!;
}

function congelar<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v as object).forEach(congelar);
    Object.freeze(v);
  }
  return v;
}

describe("modo off (por defecto)", () => {
  it("devuelve el MISMO objeto y no toca ningún almacén", async () => {
    const e = entorno();
    const cuerpo = turno1();
    const p = await new ProyectorEstable({ ambito, politica: "pol-v1", elecciones: e.elecciones, almacen: e.almacen, ejecutor: e.ejecutor }).proyectar(cuerpo);
    expect(p.cuerpo).toBe(cuerpo);
    expect(p.informe.mode).toBe("off");
    expect(p.ejecutar).toBeUndefined();
    expect(e.almacen.size).toBe(0);
    expect(e.elecciones.size).toBe(0);
  });
});

describe("modo recuperable con ejecutor", () => {
  it("manda una vista previa con handle, guarda el original exacto y no toca nada más", async () => {
    const e = entorno();
    const cuerpo = turno1();
    const antes = JSON.stringify(cuerpo);
    const p = await e.proyector().proyectar(cuerpo);
    expect(JSON.stringify(cuerpo)).toBe(antes);

    const r = resultadoDe(p.cuerpo);
    expect(r.tool_use_id).toBe("toolu_01");
    expect(r.cache_control).toEqual({ type: "ephemeral" });
    const previa = r.content as string;
    expect(previa.length).toBeLessThan(LOG.length / 4);
    // El fallo de en medio y el resumen del final siguen a la vista.
    expect(previa).toContain("FAIL  test/factura.test.ts > total con IVA");
    expect(previa).toContain("Test Files  1 failed | 799 passed (800)");
    expect(previa).toContain("exit code 1");

    // Fuera del content del tool_result, todo idéntico.
    const enviado = p.cuerpo.messages as Registro[];
    const original = cuerpo.messages as Registro[];
    expect(JSON.stringify(enviado.slice(0, 2))).toBe(JSON.stringify(original.slice(0, 2)));
    expect(p.cuerpo.system).toEqual(cuerpo.system);
    const tools = p.cuerpo.tools as Registro[];
    expect(tools.slice(0, -1)).toEqual(cuerpo.tools);
    expect(tools.at(-1)!.name).toBe(HERRAMIENTA_DE_RECUPERACION);
    expect(p.informe.recoveryToolInjected).toBe(true);
    expect(p.informe.estimate.basis).toBe("estimated");
    expect(p.informe.estimate.overheadTokens).toBeGreaterThan(0);
    expect(p.informe.segments[0]).toMatchObject({ status: "applied", reason: "recoverable", recoverable: true });
    // El informe no lleva el handle.
    expect(JSON.stringify(p.informe)).not.toContain(handleEn(previa));

    const recuperado = await p.ejecutar!({ handle: handleEn(previa) });
    expect(recuperado.is_error).toBe(false);
    expect(sha(recuperado.content)).toBe(sha(LOG));
    expect(e.almacen.size).toBe(1);
  });

  it("segundo turno: los mismos bytes y el mismo hash del prefijo, también desde otra instancia", async () => {
    const e = entorno();
    const p1 = await e.proyector().proyectar(turno1());
    // Otra instancia (otro proceso con el mismo almacén compartido).
    const p2 = await e.proyector().proyectar(turno2());
    const prefijo1 = JSON.stringify(p1.cuerpo.messages);
    const prefijo2 = JSON.stringify((p2.cuerpo.messages as unknown[]).slice(0, 3));
    expect(sha(prefijo2)).toBe(sha(prefijo1));
    expect(JSON.stringify(p2.cuerpo.tools)).toBe(JSON.stringify(p1.cuerpo.tools));
    expect(JSON.stringify(p2.cuerpo.system)).toBe(JSON.stringify(p1.cuerpo.system));
    expect(p2.informe.epoch).toBe(0);
    expect(p2.informe.epochOpened).toBeUndefined();
    expect(p2.informe.segments[0]).toMatchObject({ status: "reused", recoverable: true });
    expect(e.almacen.size).toBe(1);
  });

  it("dos escritores a la vez convergen en los mismos bytes y dejan un solo original", async () => {
    const e = entorno();
    const [a, b] = await Promise.all([e.proyector().proyectar(turno1()), e.proyector().proyectar(turno1())]);
    expect(JSON.stringify(a.cuerpo)).toBe(JSON.stringify(b.cuerpo));
    const estados = [a.informe.segments[0]!.status, b.informe.segments[0]!.status].sort();
    expect(estados).toEqual(["applied", "reused"]);
    expect(e.almacen.size).toBe(1);
    expect(e.elecciones.size).toBe(1);
    const r = await b.ejecutar!({ handle: handleEn(resultadoDe(b.cuerpo).content as string) });
    expect(sha(r.content)).toBe(sha(LOG));
  });

  it("recupera exacto un original con multibyte que cruza páginas (más de 64 KiB)", async () => {
    const e = entorno();
    const texto = logDeTests(1200, "ñandú € 😀 漢字");
    expect(new TextEncoder().encode(texto).length).toBeGreaterThan(64 * 1024);
    const p = await e.proyector().proyectar(turno1(texto));
    const r = await p.ejecutar!({ handle: handleEn(resultadoDe(p.cuerpo).content as string) });
    expect(sha(r.content)).toBe(sha(texto));
    const rango = await p.ejecutar!({ handle: handleEn(resultadoDe(p.cuerpo).content as string), start_line: 415, end_line: 415 });
    expect(rango.content).toBe(texto.split("\n")[414]);
    expect(rango.content).toContain("FAIL");
  });

  it("un tool_result con content en bloque conserva la forma y el cache_control interior", async () => {
    const e = entorno();
    const p = await e.proyector().proyectar(turno1([{ type: "text", text: LOG, cache_control: { type: "ephemeral" } }]));
    const content = resultadoDe(p.cuerpo).content as Registro[];
    expect(content).toHaveLength(1);
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(content[0]!.text).toContain("[bvsala: shortened tool result");
  });

  it("un JSON grande nunca se omite: solo el compacto sin pérdida, mismos valores", async () => {
    const e = entorno();
    const filas = Array.from({ length: 400 }, (_, i) => ({ id: 9007199254740993 + i, importe: "1.10", nota: null, nombre: `café ${i}` }));
    const json = JSON.stringify(filas, null, 2).replace(/"id": (\d+)/g, (_m, d) => `"id": ${d}`);
    const p = await e.proyector().proyectar(turno1(json));
    const enviado = resultadoDe(p.cuerpo).content as string;
    expect(p.informe.segments[0]).toMatchObject({ transformId: "json-lossless", recoverable: false });
    expect(enviado).not.toContain("bvsala");
    expect(enviado.replace(/\s/g, "")).toBe(json.replace(/\s/g, ""));
    expect(e.almacen.size).toBe(0);
  });

  it("la vista de un fichero no se toca (regla de D03): ni vista previa ni compacto", async () => {
    const e = entorno();
    const c = turno1();
    const tu = ((c.messages as Registro[])[1]!.content as Registro[])[1]!;
    tu.input = { file_path: "logs/ci.txt" };
    const p = await e.proyector().proyectar(c);
    expect(resultadoDe(p.cuerpo).content).toBe(LOG);
    expect(p.informe.segments[0]).toMatchObject({ status: "bypassed", reason: "protected" });
    expect(e.almacen.size).toBe(0);
  });

  it("un JSON grande con una clave duplicada tampoco se omite: va el original", async () => {
    const e = entorno();
    const filas = Array.from({ length: 600 }, (_, i) => `  {"id": ${i}, "estado": "abierto"${i === 300 ? ', "estado": "cerrado"' : ""}}`);
    const json = `[\n${filas.join(",\n")}\n]`;
    expect(new TextEncoder().encode(json).length).toBeGreaterThan(16 * 1024);
    const p = await e.proyector().proyectar(turno1(json));
    expect(resultadoDe(p.cuerpo).content).toBe(json);
    expect(p.informe.segments[0]).toMatchObject({ reason: "duplicate_keys", recoverable: false });
    expect(e.almacen.size).toBe(0);
  });

  it("un log que empieza por [INFO] no es JSON: sí va en vista previa", async () => {
    const e = entorno();
    const log = LOG.split("\n").map((l) => `[INFO] ${l}`).join("\n");
    const p = await e.proyector().proyectar(turno1(log));
    expect(p.informe.segments[0]).toMatchObject({ reason: "recoverable", recoverable: true });
  });

  it("un tool_result con is_error no se toca", async () => {
    const e = entorno();
    const c = turno1();
    (resultadoDe(c) as Registro).is_error = true;
    const p = await e.proyector().proyectar(c);
    expect(resultadoDe(p.cuerpo).content).toBe(LOG);
    expect(p.informe.segments[0]).toMatchObject({ status: "bypassed", reason: "is_error" });
  });
});

describe("sin recuperación comprobada no hay omisiones", () => {
  it("sin ejecutor: ni vista previa ni herramienta, y nada al almacén", async () => {
    const e = entorno();
    const p = await e.proyector({ ejecutor: undefined }).proyectar(turno1());
    expect(resultadoDe(p.cuerpo).content).toBe(LOG);
    expect(JSON.stringify(p.cuerpo.tools)).toBe(JSON.stringify(turno1().tools));
    expect(JSON.stringify(p.cuerpo)).not.toContain(HERRAMIENTA_DE_RECUPERACION);
    expect(p.ejecutar).toBeUndefined();
    expect(p.informe.recoveryAvailable).toBe(false);
    expect(p.informe.segments[0]).toMatchObject({ reason: "recovery_unavailable", recoverable: false });
    expect(e.almacen.size).toBe(0);
  });

  it("con tool_choice none tampoco", async () => {
    const e = entorno();
    const p = await e.proyector().proyectar({ ...turno1(), tool_choice: { type: "none" } });
    expect(resultadoDe(p.cuerpo).content).toBe(LOG);
    expect(JSON.stringify(p.cuerpo)).not.toContain(HERRAMIENTA_DE_RECUPERACION);
  });

  it("con el almacén lleno: el original, sin handle", async () => {
    const e = entorno({ almacen: new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 1024 }) });
    const p = await e.proyector().proyectar(turno1());
    expect(resultadoDe(p.cuerpo).content).toBe(LOG);
    expect(p.informe.segments[0]).toMatchObject({ reason: "store_rejected", recoverable: false });
  });

  it("si el handle de un turno anterior ya no se puede leer, se reconstruye en época nueva sin él", async () => {
    let t = 1_000_000;
    const almacen = new AlmacenRecuperableEnMemoria({ now: () => t });
    const e = entorno({ almacen, ejecutor: crearEjecutorDeRecuperacion(almacen), now: () => t, leaseMs: 0 });
    const p1 = await e.proyector().proyectar(turno1());
    const viejo = handleEn(resultadoDe(p1.cuerpo).content as string);
    t += 25 * 60 * 60 * 1000; // caducado
    const p2 = await e.proyector().proyectar(turno2());
    expect(p2.informe.epochOpened).toBe("recovery_unavailable");
    expect(resultadoDe(p2.cuerpo).content).toBe(LOG);
    expect(JSON.stringify(p2.cuerpo)).not.toContain(viejo);
  });
});

describe("ámbito, política y épocas", () => {
  it("recuperar desde otro ámbito da not_found", async () => {
    const e = entorno();
    const p = await e.proyector().proyectar(turno1());
    const handle = handleEn(resultadoDe(p.cuerpo).content as string);
    for (const otro of [
      { ...ambito, tenantId: "otra", epoch: 0 },
      { ...ambito, projectId: "otro", epoch: 0 },
      { ...ambito, sessionId: "ses-2", epoch: 0 },
      { ...ambito, branchId: "fork", epoch: 0 },
      { ...ambito, epoch: 1 },
    ]) {
      const r = await e.ejecutor.recuperar(otro, "pol-v1", { handle });
      expect(r).toEqual({ content: JSON.stringify({ error: "not_found" }), is_error: true });
    }
  });

  it("política cambiada: época nueva, y los bytes viejos no se reenvían", async () => {
    const e = entorno();
    const p1 = await e.proyector().proyectar(turno1());
    const previaVieja = resultadoDe(p1.cuerpo).content as string;
    const p2 = await e.proyector({ politica: "pol-v2" }).proyectar(turno2());
    expect(p2.informe.epochOpened).toBe("policy_changed");
    expect(p2.informe.epoch).toBe(1);
    expect(JSON.stringify(p2.cuerpo)).not.toContain(handleEn(previaVieja));
    expect(resultadoDe(p2.cuerpo).content).toBe(LOG);
    // El handle viejo tampoco se lee bajo la política nueva.
    const r = await e.ejecutor.recuperar({ ...ambito, epoch: 0 }, "pol-v2", { handle: handleEn(previaVieja) });
    expect(r.is_error).toBe(true);
  });

  it("política cambiada con alCambiarPolitica: denegar → no hay proyección", async () => {
    const e = entorno();
    await e.proyector().proyectar(turno1());
    const p = e.proyector({ politica: "pol-v2", alCambiarPolitica: "denegar" }).proyectar(turno2());
    await expect(p).rejects.toBeInstanceOf(ErrorDeProyeccion);
    await expect(p).rejects.toMatchObject({ code: "policy_changed" });
  });

  it("append conserva la época; editar la historia abre otra y la manda como la trae el llamante", async () => {
    const e = entorno();
    await e.proyector().proyectar(turno1());
    const p2 = await e.proyector().proyectar(turno2());
    expect(p2.informe.epoch).toBe(0);
    const editado = turno2();
    (editado.messages as Registro[])[0] = { role: "user", content: "Corre SOLO los tests de factura." };
    const p3 = await e.proyector().proyectar(editado);
    expect(p3.informe.epochOpened).toBe("history_rewritten");
    expect(p3.informe.epoch).toBe(1);
    expect(resultadoDe(p3.cuerpo).content).toBe(LOG);
    expect(p3.informe.segments[0]).toMatchObject({ reason: "born_before" });
  });

  it("actualizar la revisión del adaptador no reescribe la historia: la nueva queda en sombra", async () => {
    const e = entorno();
    const p1 = await e.proyector().proyectar(turno1());
    const p2 = await e.proyector({ adapterRevision: "anthropic-messages/proyeccion-2" }).proyectar(turno2());
    expect(JSON.stringify((p2.cuerpo.messages as unknown[]).slice(0, 3))).toBe(JSON.stringify(p1.cuerpo.messages));
    expect(p2.informe.segments[0]).toMatchObject({ status: "reused", shadowRecorded: true });
    const sombras = await e.elecciones.sombras({ ...ambito, epoch: 0, segmentId: "toolu_01", sourceHash: sha(LOG) });
    expect(sombras.map((s) => s.adapterRevision)).toEqual(["anthropic-messages/proyeccion-2"]);
    const vigente = await e.elecciones.vigente({ ...ambito, epoch: 0, segmentId: "toolu_01", sourceHash: sha(LOG) });
    expect(vigente!.adapterRevision).toBe("anthropic-messages/proyeccion-1");
  });

  it("la historia del llamante nunca se muta (entrada congelada)", async () => {
    const e = entorno();
    const c1 = congelar(turno1());
    const c2 = congelar(turno2(turno1()));
    const fotos = [JSON.stringify(c1), JSON.stringify(c2)];
    await e.proyector().proyectar(c1);
    await e.proyector().proyectar(c2);
    expect([JSON.stringify(c1), JSON.stringify(c2)]).toEqual(fotos);
  });

  it("idempotencia: misma clave y mismo cuerpo vale; con otro cuerpo, conflicto y nada escrito", async () => {
    const e = entorno();
    const a = await e.proyector().proyectar(turno1(), { idempotencyKey: "req-1" });
    const b = await e.proyector().proyectar(turno1(), { idempotencyKey: "req-1" });
    expect(JSON.stringify(a.cuerpo)).toBe(JSON.stringify(b.cuerpo));
    const tamano = e.almacen.size;
    const otro = turno1(logDeTests(900));
    await expect(e.proyector().proyectar(otro, { idempotencyKey: "req-1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(e.almacen.size).toBe(tamano);
  });

  it("sin ámbito o sin política no hay proyección (ni bypass)", async () => {
    const e = entorno();
    await expect(e.proyector({ politica: "" }).proyectar(turno1())).rejects.toMatchObject({ code: "invalid_request" });
    await expect(e.proyector({ ambito: { ...ambito, tenantId: "" } }).proyectar(turno1())).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("modo record y rutas fuera del piloto", () => {
  it("record: manda el cuerpo original y no escribe nada", async () => {
    const e = entorno({ modo: "record" });
    const cuerpo = turno1();
    const p = await e.proyector().proyectar(cuerpo);
    expect(p.cuerpo).toBe(cuerpo);
    expect(p.informe.reason).toBe("record_only");
    expect(p.informe.segments[0]).toMatchObject({ status: "recorded", reason: "would_recover" });
    expect(p.informe.estimate.inputAfter).toBeLessThan(p.informe.estimate.inputBefore);
    expect(e.almacen.size).toBe(0);
    expect(e.elecciones.size).toBe(0);
  });

  it("stream: passthrough", async () => {
    const e = entorno();
    const cuerpo = { ...turno1(), stream: true };
    const p = await e.proyector().proyectar(cuerpo);
    expect(p.cuerpo).toBe(cuerpo);
    expect(p.informe.reason).toBe("unsupported_route");
  });

  it("la vista previa es determinista: mismo texto y handle, mismos bytes", () => {
    const h = "bvr1_" + "A".repeat(32);
    expect(vistaPrevia(LOG, h)).toBe(vistaPrevia(LOG, h));
    expect(vistaPrevia(LOG, h)).not.toBe(vistaPrevia(LOG, "bvr1_" + "B".repeat(32)));
  });
});

describe("el bucle con el SDK oficial de Anthropic", () => {
  it("el modelo pide recuperar, el bucle ejecuta contra el almacén y el original exacto llega al proveedor", async () => {
    const e = entorno();
    const enviados: Registro[] = [];
    let handle = "";
    const fetchFalso = async (_url: unknown, init?: { body?: unknown }) => {
      const cuerpo = JSON.parse(String(init?.body)) as Registro;
      enviados.push(cuerpo);
      const respuesta =
        enviados.length === 1
          ? (() => {
              handle = handleEn(resultadoDe(cuerpo).content as string);
              return {
                content: [{ type: "tool_use", id: "toolu_r1", name: HERRAMIENTA_DE_RECUPERACION, input: { handle } }],
                stop_reason: "tool_use",
              };
            })()
          : { content: [{ type: "text", text: "799 pasaron." }], stop_reason: "end_turn" };
      return new Response(
        JSON.stringify({
          id: `msg_${enviados.length}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
          ...respuesta,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const cliente = new Anthropic({ apiKey: "no-es-una-clave", fetch: fetchFalso as unknown as typeof fetch, maxRetries: 0 });
    const r = await ejecutarConRecuperacion({
      cuerpo: turno1(),
      proyector: e.proyector(),
      crear: (b) => cliente.messages.create(b as never) as never,
    });
    expect(r.rondas).toBe(2);
    expect(r.recuperaciones).toBe(1);
    expect(r.usos).toHaveLength(2);
    expect((r.mensaje.content[0] as Registro).text).toBe("799 pasaron.");
    const segundo = enviados[1]!;
    const msgs = segundo.messages as Registro[];
    // El prefijo del segundo envío es el primero, byte a byte.
    expect(JSON.stringify(msgs.slice(0, 3))).toBe(JSON.stringify(enviados[0]!.messages));
    const devuelto = (msgs[4]!.content as Registro[])[0]!;
    expect(devuelto.tool_use_id).toBe("toolu_r1");
    expect(sha(devuelto.content as string)).toBe(sha(LOG));
    expect((segundo.tools as Registro[]).at(-1)).toEqual(ESQUEMA_DE_RECUPERACION);
    expect(r.informes[1]!.epoch).toBe(0);
  });

  it("sin ejecutor el bucle no ofrece la herramienta y devuelve a la primera", async () => {
    const e = entorno({ ejecutor: undefined });
    const enviados: Registro[] = [];
    const r = await ejecutarConRecuperacion({
      cuerpo: turno1(),
      proyector: e.proyector(),
      crear: async (b) => {
        enviados.push(b);
        return { content: [{ type: "text", text: "listo" }] };
      },
    });
    expect(r.rondas).toBe(1);
    expect(JSON.stringify(enviados[0])).toBe(JSON.stringify(turno1()));
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { SidecarCaveman } from "../gateway/sidecar-caveman.js";
import {
  ErrorDePrivacidad,
  recuperarEntero,
  resultadoDeBypass,
  type OptimizeRequest,
  type Scope,
  type Segment,
  type SavingsTransformer,
} from "../src/transformador/contrato.js";
import { MetricasTransformador, percentil } from "../src/transformador/metricas.js";
import {
  CONFIG_APAGADA,
  configDesdeEntorno,
  gobernadoDesdeEntorno,
  TransformadorGobernado,
  type ConfigOperacion,
} from "../src/transformador/operacion.js";
import { binarioFalso, SidecarFalso } from "./helpers/sidecar-caveman-falso.js";

/**
 * D09 · operación y marcha atrás del transformador.
 *
 * Lo que se prueba es lo que el plan exige del rollback (p. 15): apagar o
 * revertir detiene las transformaciones NUEVAS y NO pierde fuentes ni
 * representaciones vivas; y un sidecar degradado nunca retiene una petición
 * más allá de su plazo. Oráculos: bytes recuperados contra los originales,
 * peticiones contadas en cada sidecar falso, y tiempos de reloj.
 */

const utf8 = new TextEncoder();
const hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const POLITICA = "privacy-v1";
const JSON_GRANDE = JSON.stringify({ filas: Array.from({ length: 40 }, (_, i) => ({ id: i, nombre: `fila ${i}` })) });

const ambito = (extra: Partial<Scope> = {}): Scope => ({
  tenantId: "acme",
  projectId: "facturas",
  sessionId: "ses-1",
  branchId: "main",
  epoch: "0",
  ...extra,
});

function segmento(id: string, texto = JSON_GRANDE): Segment {
  const b = utf8.encode(texto);
  return {
    id,
    sourceId: `src-${id}`,
    kind: "tool_result",
    toolCallId: `toolu_${id}`,
    utf8: b,
    sha256: hex(b),
    contentType: "application/json",
    protected: false,
    privacyPolicyHash: POLITICA,
  };
}

function peticion(scope: Scope, segments: Segment[] = [segmento("a")]): OptimizeRequest {
  return {
    schemaVersion: 1,
    requestId: "req-1",
    idempotencyKey: "idem-1",
    scope,
    sequence: 1,
    historyManifestHash: "c".repeat(64),
    endpoint: { provider: "anthropic", route: "/v1/messages", model: "claude-sonnet-5-5", streaming: false, providerState: "none" },
    mode: "recoverable",
    policyVersion: "pol-1",
    allowedTransforms: ["caveman.json"],
    segments,
    deadlineAtMs: Date.now() + 60_000,
    recoveryBinding: { executorId: "runner-1", bindingDigest: "d".repeat(64) },
  };
}

const senal = () => new AbortController().signal;
const ctx = { privacyPolicyHash: POLITICA };

let dir: string;
let bin: { ruta: string; sha256: string };
let f1: SidecarFalso;
let f2: SidecarFalso;
const abiertos: SidecarCaveman[] = [];

function sidecarPara(f: SidecarFalso, version: string, extra: Partial<ConstructorParameters<typeof SidecarCaveman>[0]> = {}) {
  const s = new SidecarCaveman({
    endpoint: f.endpoint,
    binario: { ruta: bin.ruta, sha256Esperado: bin.sha256, versionFijada: version },
    timeoutMs: 2_000,
    ...extra,
  });
  abiertos.push(s);
  return s;
}

const cfg = (c: Partial<ConfigOperacion>): ConfigOperacion => ({
  encendido: true,
  versionActiva: "v1",
  versionesRetiradas: new Set(),
  proyectosApagados: new Set(),
  ...c,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bv-d09-"));
  bin = await binarioFalso(dir);
  f1 = await new SidecarFalso().iniciar();
  f2 = await new SidecarFalso().iniciar();
  f1.runtimeBuild = "4.0.1";
  f2.runtimeBuild = "4.0.2";
});
afterAll(async () => {
  await f1.cerrar();
  await f2.cerrar();
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  for (const f of [f1, f2]) {
    f.peticiones.length = 0;
    f.alOptimizar = undefined;
    f.alRecuperar = undefined;
    f.retener = false;
  }
  for (const s of abiertos.splice(0)) s.cerrar();
});

describe("configuración desde el entorno: falla cerrado", () => {
  it("por defecto, apagado; encendido exige versión válida", () => {
    expect(configDesdeEntorno({}).config).toBe(CONFIG_APAGADA);
    expect(configDesdeEntorno({ BVSALA_TRANSFORMADOR: "off" }).config.encendido).toBe(false);
    const ok = configDesdeEntorno({
      BVSALA_TRANSFORMADOR: "on",
      BVSALA_TRANSFORMADOR_VERSION: "caveman-4.0.1",
      BVSALA_TRANSFORMADOR_RETIRADAS: "caveman-4.0.0, caveman-3.2.0",
      BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS: "facturas,legal",
    });
    expect(ok.avisos).toEqual([]);
    expect(ok.config.encendido).toBe(true);
    expect(ok.config.versionActiva).toBe("caveman-4.0.1");
    expect([...ok.config.versionesRetiradas]).toEqual(["caveman-4.0.0", "caveman-3.2.0"]);
    expect(ok.config.proyectosApagados.has("legal")).toBe(true);
  });

  it.each([
    [{ BVSALA_TRANSFORMADOR: "sí" }],
    [{ BVSALA_TRANSFORMADOR: "on" }],
    [{ BVSALA_TRANSFORMADOR: "on", BVSALA_TRANSFORMADOR_VERSION: "../../bin" }],
    [{ BVSALA_TRANSFORMADOR: "on", BVSALA_TRANSFORMADOR_VERSION: "v1", BVSALA_TRANSFORMADOR_RETIRADAS: "v0,,v2" }],
    [{ BVSALA_TRANSFORMADOR: "on", BVSALA_TRANSFORMADOR_VERSION: "v1", BVSALA_TRANSFORMADOR_PROYECTOS_APAGADOS: "a b" }],
  ])("valor ininteligible %j → apagado, con aviso", (env) => {
    const r = configDesdeEntorno(env);
    expect(r.config.encendido).toBe(false);
    expect(r.avisos.length).toBe(1);
  });

  it("un getter de configuración que lanza = apagado (passthrough), no un error", async () => {
    const s = sidecarPara(f1, "4.0.1");
    const g = new TransformadorGobernado({
      versiones: { v1: s },
      config: () => {
        throw new Error("config rota");
      },
    });
    expect((await g.optimize(peticion(ambito()), senal())).reason).toBe("disabled");
    expect(f1.peticiones).toHaveLength(0);
  });
});

describe("interruptor por proyecto y global", () => {
  it("apagar detiene lo NUEVO pero los handles vivos se siguen recuperando, byte a byte", async () => {
    let config = cfg({});
    const g = new TransformadorGobernado({ versiones: { v1: sidecarPara(f1, "4.0.1") }, config: () => config });
    const res = await g.optimize(peticion(ambito()), senal());
    expect(res.status).toBe("applied");
    const r = res.replacements[0]!;

    config = cfg({ proyectosApagados: new Set(["facturas"]) });
    f1.peticiones.length = 0;
    expect((await g.optimize(peticion(ambito()), senal())).reason).toBe("disabled");
    expect(f1.optimizaciones).toHaveLength(0);
    // Otro proyecto sigue transformando.
    expect((await g.optimize(peticion(ambito({ projectId: "otro" })), senal())).status).toBe("applied");
    // El handle del proyecto apagado se recupera entero.
    const original = await recuperarEntero(g, ambito(), r.handle!, ctx, r.originalSha256);
    expect(Buffer.from(original).toString()).toBe(JSON_GRANDE);

    config = CONFIG_APAGADA; // apagado general
    expect((await g.optimize(peticion(ambito({ projectId: "otro" })), senal())).reason).toBe("disabled");
    const otraVez = await recuperarEntero(g, ambito(), r.handle!, ctx, r.originalSha256);
    expect(hex(otraVez)).toBe(hex(JSON_GRANDE));
  });

  it("con el cortacircuitos ABIERTO la recuperación sigue funcionando (no pasa por él)", async () => {
    let t = 0;
    const s = sidecarPara(f1, "4.0.1", { ahoraMonotono: () => t });
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => cfg({}) });
    const r = (await g.optimize(peticion(ambito()), senal())).replacements[0]!;
    f1.alOptimizar = () => ({ status: 503, cuerpo: { schema_version: 1, error: { code: "runtime_unavailable" } } });
    for (let i = 0; i < 5; i++) await g.optimize(peticion(ambito()), senal());
    expect(s.estadoCortacircuitos).toBe("open");
    const pag = await g.retrieve(ambito(), r.handle!, undefined, ctx);
    expect(Buffer.from(pag.utf8).toString()).toBe(JSON_GRANDE);
    t += 1;
  });
});

describe("recuperación caída: no se emiten omisiones nuevas", () => {
  it("3 retrieves caídos seguidos cortan las omisiones de esa versión; a los 30 s un retrieve bueno las reabre", async () => {
    let t = 0;
    const s = sidecarPara(f1, "4.0.1");
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => cfg({}), ahora: () => t });
    const r = (await g.optimize(peticion(ambito()), senal())).replacements[0]!;
    f1.alRecuperar = () => ({ status: 503, cuerpo: { schema_version: 1, error: { code: "recovery_unavailable" } }, cabeceras: { "retry-after": "1" } });
    // Un handle ajeno no cuenta como caída.
    for (let i = 0; i < 5; i++) await expect(g.retrieve(ambito({ epoch: "9" }), r.handle!, undefined, ctx)).rejects.toThrow();
    expect((await g.optimize(peticion(ambito()), senal())).status).toBe("applied");
    for (let i = 0; i < 3; i++) {
      await expect(g.retrieve(ambito(), r.handle!, undefined, ctx)).rejects.toMatchObject({ codigo: "recovery_unavailable" });
    }
    f1.peticiones.length = 0;
    const res = await g.optimize(peticion(ambito()), senal());
    expect(res).toMatchObject({ status: "bypassed", reason: "recovery_unavailable", replacements: [] });
    expect(f1.optimizaciones).toHaveLength(0);
    // El retrieve sigue intentándose aunque el corte esté abierto (nunca se bloquea).
    f1.alRecuperar = undefined;
    expect(Buffer.from((await g.retrieve(ambito(), r.handle!, undefined, ctx)).utf8).toString()).toBe(JSON_GRANDE);
    expect((await g.optimize(peticion(ambito()), senal())).reason).toBe("recovery_unavailable");
    t += 30_000;
    // Medio abierto: el siguiente retrieve es la sonda; bueno, cierra.
    await g.retrieve(ambito(), r.handle!, undefined, ctx);
    expect((await g.optimize(peticion(ambito()), senal())).status).toBe("applied");
  });
});

describe("versión activa y marcha atrás", () => {
  it("cada época conserva su versión; revertir retira la nueva sin perder sus handles", async () => {
    const v1 = sidecarPara(f1, "4.0.1");
    const v2 = sidecarPara(f2, "4.0.2");
    let config = cfg({ versionActiva: "v1" });
    const g = new TransformadorGobernado({ versiones: { v1, v2 }, config: () => config });

    // Época E1 nace en v1.
    const e1 = ambito({ epoch: "1" });
    const r1 = (await g.optimize(peticion(e1), senal())).replacements[0]!;
    expect(f1.optimizaciones).toHaveLength(1);

    // Despliegue de v2: E1 sigue en v1; una época nueva E2 va a v2.
    config = cfg({ versionActiva: "v2" });
    const e2 = ambito({ epoch: "2" });
    expect((await g.optimize(peticion(e1, [segmento("a"), segmento("b", JSON_GRANDE + " ")]), senal())).status).toBe("applied");
    expect(f1.optimizaciones).toHaveLength(2);
    expect(f2.optimizaciones).toHaveLength(0);
    const r2 = (await g.optimize(peticion(e2), senal())).replacements[0]!;
    expect(f2.optimizaciones).toHaveLength(1);

    // Marcha atrás: v1 vuelve a ser la activa y v2 queda retirada.
    config = cfg({ versionActiva: "v1", versionesRetiradas: new Set(["v2"]) });
    f1.peticiones.length = 0;
    f2.peticiones.length = 0;
    // E2 (de v2) ya no transforma nada nuevo, ni con v1: viaja el original.
    const enE2 = await g.optimize(peticion(e2), senal());
    expect(enE2).toMatchObject({ status: "bypassed", reason: "version_retired", replacements: [] });
    expect(f1.optimizaciones).toHaveLength(0);
    expect(f2.optimizaciones).toHaveLength(0);
    // …pero sus handles se siguen recuperando A TRAVÉS de v2.
    const o2 = await recuperarEntero(g, e2, r2.handle!, ctx, r2.originalSha256);
    expect(Buffer.from(o2).toString()).toBe(JSON_GRANDE);
    expect(f2.peticiones.some((p) => p.ruta.endsWith("/retrieve"))).toBe(true);
    // E1 nunca cambió de versión, y una época nueva E3 nace en v1.
    expect((await g.optimize(peticion(e1), senal())).status).toBe("applied");
    expect((await g.optimize(peticion(ambito({ epoch: "3" })), senal())).status).toBe("applied");
    expect(f1.optimizaciones).toHaveLength(2);
    expect(f2.optimizaciones).toHaveLength(0);
    const o1 = await recuperarEntero(g, e1, r1.handle!, ctx, r1.originalSha256);
    expect(Buffer.from(o1).toString()).toBe(JSON_GRANDE);
  });

  it("versión activa desconocida → passthrough; release llega a TODAS las versiones", async () => {
    const v1 = sidecarPara(f1, "4.0.1");
    const v2 = sidecarPara(f2, "4.0.2");
    const g = new TransformadorGobernado({ versiones: { v1, v2 }, config: () => cfg({ versionActiva: "v9" }) });
    expect((await g.optimize(peticion(ambito()), senal())).reason).toBe("disabled");
    expect(await g.release(ambito())).toEqual({ revoked: true });
    expect(f1.peticiones.some((p) => p.ruta.endsWith("/sessions/delete"))).toBe(true);
    expect(f2.peticiones.some((p) => p.ruta.endsWith("/sessions/delete"))).toBe(true);
  });

  it("release olvida las épocas de la sesión: sus handles dejan de servirse", async () => {
    const g = new TransformadorGobernado({ versiones: { v1: sidecarPara(f1, "4.0.1") }, config: () => cfg({}) });
    const r = (await g.optimize(peticion(ambito({ epoch: "7" })), senal())).replacements[0]!;
    await g.release(ambito());
    await expect(g.retrieve(ambito({ epoch: "7" }), r.handle!, undefined, ctx)).rejects.toMatchObject({ codigo: "not_found" });
  });
});

describe("un sidecar degradado nunca retiene la petición más allá del plazo", () => {
  it("colgado: cada llamada vuelve en ~100 ms y, abierto el circuito, al instante", async () => {
    let t = 0;
    const s = sidecarPara(f1, "4.0.1", { timeoutMs: 100, ahoraMonotono: () => t });
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => cfg({}) });
    await g.optimize(peticion(ambito()), senal()); // capacidades en caché
    f1.alOptimizar = (_c, d) => ({ cuerpo: d(), demoraMs: 10_000 });
    const tiempos: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      const res = await g.optimize(peticion(ambito()), senal());
      tiempos.push(performance.now() - t0);
      expect(res.status).toBe("bypassed");
    }
    expect(Math.max(...tiempos)).toBeLessThan(400);
    expect(s.estadoCortacircuitos).toBe("open");
    // Tras abrirse, sin esperar al plazo.
    expect(Math.max(...tiempos.slice(5))).toBeLessThan(50);
    t += 1;
  });

  it("colgado y en ráfaga: 25 a la vez (4 en vuelo, 16 en cola, el resto fuera) acaban todas dentro del plazo", async () => {
    const s = sidecarPara(f1, "4.0.1", { timeoutMs: 100 });
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => cfg({}) });
    await g.optimize(peticion(ambito()), senal());
    f1.alOptimizar = (_c, d) => ({ cuerpo: d(), demoraMs: 10_000 });
    const t0 = performance.now();
    const res = await Promise.all(
      Array.from({ length: 25 }, (_, i) => g.optimize(peticion(ambito({ tenantId: `t${i % 5}` })), senal())),
    );
    expect(performance.now() - t0).toBeLessThan(400);
    expect(res.every((r) => r.status === "bypassed")).toBe(true);
    const motivos = new Set(res.map((r) => r.reason));
    expect([...motivos].every((m) => m === "deadline" || m === "capacity" || m === "circuit_open")).toBe(true);
  });

  it("caído (puerto cerrado): bypass rápido; liveness no toca la red y readiness lo dice", async () => {
    const muerto = await new SidecarFalso().iniciar();
    const endpoint = muerto.endpoint;
    await muerto.cerrar();
    const s = new SidecarCaveman({ endpoint, binario: { ruta: bin.ruta, sha256Esperado: bin.sha256, versionFijada: "4.0.1" }, timeoutMs: 100 });
    abiertos.push(s);
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => cfg({}) });
    const t0 = performance.now();
    expect((await g.optimize(peticion(ambito()), senal())).reason).toBe("runtime_unavailable");
    expect(performance.now() - t0).toBeLessThan(200);
    expect(g.vivo()).toMatchObject({ vivo: true, encendido: true, versionActiva: "v1" });
    expect(await g.listo()).toMatchObject({ listo: false, motivo: "runtime_unavailable", version: "v1" });
  });

  it("un motor que LANZA algo inesperado → bypass; uno que lanza Privacy → se propaga", async () => {
    const roto: SavingsTransformer = {
      optimize: async () => {
        throw new TypeError("bug del motor");
      },
      retrieve: async () => {
        throw new Error("x");
      },
      release: async () => ({ revoked: true }),
    };
    const g = new TransformadorGobernado({ versiones: { v1: roto }, config: () => cfg({}) });
    expect((await g.optimize(peticion(ambito()), senal())).reason).toBe("runtime_unavailable");
    const estricto: SavingsTransformer = {
      ...roto,
      optimize: async () => {
        throw new ErrorDePrivacidad("privacy_unbound", "x");
      },
    };
    const g2 = new TransformadorGobernado({ versiones: { v1: estricto }, config: () => cfg({}) });
    await expect(g2.optimize(peticion(ambito()), senal())).rejects.toBeInstanceOf(ErrorDePrivacidad);
  });
});

describe("readiness y liveness", () => {
  it("vivo() no hace E/S; listo() comprueba versión y dependencia mínima sin optimizar", async () => {
    const s = sidecarPara(f1, "4.0.1");
    let config = cfg({});
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => config });
    expect(g.vivo().vivo).toBe(true);
    expect(f1.peticiones).toHaveLength(0);
    expect(await g.listo()).toEqual({ listo: true, motivo: "ready", version: "v1", runtimeBuild: "4.0.1" });
    expect(f1.optimizaciones).toHaveLength(0);
    config = CONFIG_APAGADA;
    expect(await g.listo()).toEqual({ listo: true, motivo: "disabled" });
    config = cfg({ versionActiva: "v3" });
    expect(await g.listo()).toEqual({ listo: false, motivo: "version_unknown" });
    config = cfg({ versionesRetiradas: new Set(["v1"]) });
    expect((await g.listo()).motivo).toBe("version_retired");
    // Versión equivocada en el runtime: no listo.
    const otra = sidecarPara(f2, "4.0.1"); // f2 anuncia 4.0.2
    const g2 = new TransformadorGobernado({ versiones: { v1: otra }, config: () => cfg({}) });
    expect(await g2.listo()).toMatchObject({ listo: false, motivo: "version_mismatch" });
  });

  it("gobernadoDesdeEntorno: sin variables, apagado y sin ninguna E/S", async () => {
    const { gobernado, avisos } = gobernadoDesdeEntorno({}, { v1: sidecarPara(f1, "4.0.1") });
    expect(avisos).toEqual([]);
    expect((await gobernado.optimize(peticion(ambito()), senal())).reason).toBe("disabled");
    expect(f1.peticiones).toHaveLength(0);
  });
});

describe("métricas: acotadas y sin contenido", () => {
  it("percentiles por rango más cercano (oráculo 1..100)", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([percentil(xs, 50), percentil(xs, 95), percentil(xs, 99)]).toEqual([50, 95, 99]);
    expect(percentil([], 50)).toBeNull();
    const m = new MetricasTransformador();
    for (const x of [...xs].reverse()) m.latencia(100, x);
    for (let i = 0; i < 10; i++) m.latencia(2 * 1024 * 1024, 7);
    const i = m.instantanea().latenciaMs;
    expect(i.lt_4k).toMatchObject({ muestras: 100, p50: 50, p95: 95, p99: 99 });
    expect(i.ge_1m).toMatchObject({ muestras: 10, p50: 7 });
    expect(i.lt_64k.p50).toBeNull();
  });

  it("la ventana es fija: con 4 muestras por cubo sólo cuentan las 4 últimas", () => {
    const m = new MetricasTransformador({ muestrasPorCubo: 4 });
    for (const x of [1000, 1000, 1000, 1, 2, 3, 4]) m.latencia(10, x);
    expect(m.instantanea().latenciaMs.lt_4k).toMatchObject({ muestras: 4, total: 7, p99: 4 });
  });

  it("motivos fuera del catálogo → `other`; más de N proyectos → `_otros`", () => {
    const m = new MetricasTransformador({ maxProyectos: 2 });
    m.decision("deadline", false, "p1");
    m.decision("motivo-inventado-por-un-motor-con-id-de-usuario-42", false, "p2");
    m.decision("applied", true, "p3");
    m.decision("applied", true, "p4");
    const i = m.instantanea();
    expect(i.decisiones.deadline).toBe(1);
    expect(i.decisiones.other).toBe(1);
    expect(Object.keys(i.decisiones)).not.toContain("motivo-inventado-por-un-motor-con-id-de-usuario-42");
    expect(Object.keys(i.decisionesPorProyecto).sort()).toEqual(["_otros", "p1", "p2"]);
    expect(i.decisionesPorProyecto["_otros"]).toEqual({ applied: 2, bypassed: 0 });
  });

  it("de punta a punta: bypass por motivo, cortacircuitos, recuperaciones e integridad — y ni un handle ni contenido en el texto", async () => {
    let t = 0;
    const metricas = new MetricasTransformador();
    const s = sidecarPara(f1, "4.0.1", { ahoraMonotono: () => t });
    const g = new TransformadorGobernado({ versiones: { v1: s }, config: () => cfg({}), metricas });
    const r = (await g.optimize(peticion(ambito()), senal())).replacements[0]!;
    await g.retrieve(ambito(), r.handle!, undefined, ctx);
    await expect(g.retrieve(ambito({ tenantId: "otra" }), r.handle!, undefined, ctx)).rejects.toThrow();
    f1.alRecuperar = (_c, d) => {
      const x = d();
      (x.cuerpo as any).original_sha256 = "0".repeat(64);
      return x;
    };
    await expect(g.retrieve(ambito(), r.handle!, undefined, ctx)).rejects.toMatchObject({ codigo: "integrity_failure" });
    f1.alOptimizar = (_c, d) => {
      const p: any = d();
      p.replacements[0].segment_id = "fantasma";
      return { cuerpo: p };
    };
    await g.optimize(peticion(ambito()), senal());
    f1.alOptimizar = () => ({ status: 503, cuerpo: { schema_version: 1, error: { code: "runtime_unavailable" } } });
    for (let i = 0; i < 4; i++) await g.optimize(peticion(ambito()), senal());

    const i = metricas.instantanea();
    expect(i.decisiones.applied).toBe(1);
    expect(i.decisiones.invalid_plan).toBe(1);
    expect(i.decisiones.runtime_unavailable).toBe(4);
    expect(i.planesInvalidos).toBe(1);
    expect(i.recuperaciones).toMatchObject({ ok: 1, not_found: 1, integrity_failure: 1 });
    expect(i.fallosDeIntegridad).toBe(1);
    // 1 plan inválido + 4 caídas = 5 seguidos; la recuperación (un integrity_failure) sigue cerrada.
    expect(i.cortacircuitos).toEqual({ v1: "open", "v1/recuperacion": "closed" });
    expect(i.latenciaMs.lt_4k.total).toBe(6);

    const texto = metricas.aTextoPrometheus();
    expect(texto).toContain('bvsala_transformador_cortacircuitos{version="v1",estado="open"} 1');
    expect(texto).toContain('bvsala_transformador_decisiones_total{motivo="invalid_plan"} 1');
    expect(texto).not.toContain(r.handle!);
    expect(texto).not.toContain("fila 1");
    expect(texto).not.toContain("acme");
    expect(texto).not.toContain("ses-1");
    t += 1;
  });

  it("resultadoDeBypass da un motivo del catálogo para cada segmento", () => {
    const r = resultadoDeBypass(peticion(ambito()), "disabled");
    expect(r.skipped).toEqual([{ id: "a", reason: "disabled" }]);
  });
});

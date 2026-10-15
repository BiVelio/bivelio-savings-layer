import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarPlan,
  ErrorDePrivacidad,
  ErrorDeRecuperacion,
  PeticionInvalida,
  recuperarEntero,
  validarPlan,
  type OptimizeRequest,
  type OptimizeResult,
  type Scope,
  type Segment,
} from "../src/transformador/contrato.js";
import { ColaJusta, Cortacircuitos } from "../src/transformador/guardas.js";
import { endpointLoopback, SidecarCaveman, type OpcionesSidecarCaveman } from "../gateway/sidecar-caveman.js";
import { binarioFalso, SidecarFalso } from "./helpers/sidecar-caveman-falso.js";

/**
 * D05 · el motor opcional detrás del contrato `SavingsTransformer`.
 *
 * Los oráculos son de valor y de comportamiento, no del código: los bytes que
 * salen se comparan con los que entraron (o con lo que el sidecar falso dijo
 * que producía), las huellas con `node:crypto`, y «no salió nada» se comprueba
 * contando las peticiones que de verdad recibió el sidecar.
 */

const utf8 = new TextEncoder();
const hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const MiB = 1024 * 1024;

const ambito: Scope = { tenantId: "acme", projectId: "facturas", sessionId: "ses-1", branchId: "main", epoch: "0" };
const POLITICA = "privacy-v1";

function segmento(id: string, texto: string, extra: Partial<Segment> = {}): Segment {
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
    ...extra,
  };
}

const JSON_GRANDE = JSON.stringify({ filas: Array.from({ length: 40 }, (_, i) => ({ id: i, nombre: `fila ${i}`, ñ: "€" })) });

function peticion(segments: Segment[], extra: Partial<OptimizeRequest> = {}): OptimizeRequest {
  return {
    schemaVersion: 1,
    requestId: "req-1",
    idempotencyKey: "idem-1",
    scope: ambito,
    sequence: 3,
    historyManifestHash: "c".repeat(64),
    endpoint: { provider: "anthropic", route: "/v1/messages", model: "claude-sonnet-5-5", streaming: false, providerState: "none" },
    mode: "recoverable",
    policyVersion: "pol-7",
    allowedTransforms: ["caveman.json"],
    segments,
    deadlineAtMs: Date.now() + 60_000,
    recoveryBinding: { executorId: "runner-1", bindingDigest: "d".repeat(64), overheadText: "caveman_retrieve(handle)" },
    ...extra,
  };
}

const nuncaAbortada = () => new AbortController().signal;

let dir: string;
let bin: { ruta: string; sha256: string };
let falso: SidecarFalso;
const abiertos: SidecarCaveman[] = [];

function sidecar(o: Partial<OpcionesSidecarCaveman> = {}): SidecarCaveman {
  const s = new SidecarCaveman({
    endpoint: falso.endpoint,
    binario: { ruta: bin.ruta, sha256Esperado: bin.sha256, versionFijada: "4.0.1" },
    credencial: () => "token-del-runtime-de-prueba",
    timeoutMs: 2_000,
    ...o,
  });
  abiertos.push(s);
  return s;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bv-d05-"));
  bin = await binarioFalso(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("contrato · validarPlan y aplicarPlan (sin motor)", () => {
  const a = segmento("a", JSON_GRANDE);
  const p = segmento("p", "firmado: no tocar", { protected: true });
  const req = peticion([a, p]);
  const corto = utf8.encode("[resumen]");
  const buena = (extra: Partial<OptimizeResult["replacements"][number]> = {}): OptimizeResult => ({
    status: "applied",
    reason: "applied",
    replacements: [
      { segmentId: "a", originalSha256: a.sha256, utf8: corto, replacementSha256: hex(corto), transformId: "caveman.json", version: "1", handle: "h1", ...extra },
    ],
    skipped: [],
    estimate: { tokenizer: "x", basis: "estimated", overheadTokens: 0 },
    runtimeBuild: "t",
    policyVersion: "pol-7",
    decisionId: "d",
  });

  it("un plan bueno se aplica a una COPIA: el original no cambia, ids y tool_use_id intactos, el protegido idéntico", () => {
    const antes = Buffer.from(a.utf8);
    const salida = aplicarPlan(req, buena());
    expect(Buffer.from(salida[0]!.utf8).toString()).toBe("[resumen]");
    expect(salida[0]!.toolCallId).toBe("toolu_a");
    expect(Buffer.from(a.utf8).equals(antes)).toBe(true);
    expect(req.segments[0]!.utf8).toBe(a.utf8);
    expect(hex(salida[1]!.utf8)).toBe(hex("firmado: no tocar"));
    expect(salida[1]!.utf8).not.toBe(p.utf8); // también copia
  });

  it.each([
    ["sustitución de un segmento no declarado", { segmentId: "fantasma" }, "undeclared_segment"],
    ["sustitución de un segmento protegido", { segmentId: "p", originalSha256: p.sha256 }, "protected_segment"],
    ["original con otra huella", { originalSha256: "0".repeat(64) }, "original_hash_mismatch"],
    ["bytes que no son los de su huella", { replacementSha256: "0".repeat(64) }, "replacement_hash_mismatch"],
    ["transformación no permitida", { transformId: "caveman.toon" }, "transform_not_allowed"],
    ["sin handle en modo recuperable", { handle: undefined }, "missing_handle"],
  ])("%s → el plan entero se rechaza", (_n, extra, motivo) => {
    const v = validarPlan(req, buena(extra as never));
    expect(v).toMatchObject({ ok: false, motivo });
    expect(() => aplicarPlan(req, buena(extra as never))).toThrow(/plan inválido/);
  });

  it("una sola sustitución mala tumba también las buenas", () => {
    const b = segmento("b", JSON_GRANDE + " ");
    const r2 = peticion([a, b]);
    const res = buena();
    res.replacements.push({ ...res.replacements[0]!, segmentId: "b", originalSha256: "f".repeat(64) });
    expect(validarPlan(r2, res).ok).toBe(false);
    expect(() => aplicarPlan(r2, res)).toThrow();
  });

  it("no más pequeña → rechazada; en lossless un handle delata una omisión", () => {
    const largo = utf8.encode(JSON_GRANDE + "!");
    expect(validarPlan(req, buena({ utf8: largo, replacementSha256: hex(largo) }))).toMatchObject({ motivo: "not_smaller" });
    const sinPerdida = peticion([a], { mode: "lossless" });
    expect(validarPlan(sinPerdida, buena())).toMatchObject({ motivo: "unexpected_handle" });
    expect(validarPlan(peticion([a], { recoveryBinding: undefined }), buena())).toMatchObject({ motivo: "recovery_unbound" });
    expect(validarPlan(peticion([a], { mode: "record" }), buena())).toMatchObject({ motivo: "mode_forbids_replacement" });
  });
});

describe("SidecarCaveman contra un sidecar falso", () => {
  beforeAll(async () => {
    falso = await new SidecarFalso().iniciar();
  });
  afterAll(async () => {
    await falso.cerrar();
  });
  afterEach(() => {
    falso.peticiones.length = 0;
    falso.alOptimizar = undefined;
    falso.alRecuperar = undefined;
    falso.alCapacidades = undefined;
    falso.retener = false;
    falso.runtimeBuild = "4.0.1";
    falso.limites.page_bytes = 262_144;
    for (const s of abiertos.splice(0)) s.cerrar();
  });

  it("camino bueno: sustituye, apunta el handle y recupera el original EXACTO por páginas", async () => {
    falso.limites.page_bytes = 64; // muchas páginas, y con «€» de 3 bytes por medio
    const s = sidecar();
    const a = segmento("a", JSON_GRANDE);
    const p = segmento("p", "no tocar", { protected: true });
    const req = peticion([a, p]);
    const res = await s.optimize(req, nuncaAbortada());
    expect(res.status).toBe("applied");
    expect(res.replacements).toHaveLength(1);
    const r = res.replacements[0]!;
    expect(r.segmentId).toBe("a");
    expect(r.originalSha256).toBe(hex(JSON_GRANDE));
    expect(r.replacementSha256).toBe(hex(r.utf8));
    expect(r.utf8.length).toBeLessThan(a.utf8.length);
    expect(res.skipped).toContainEqual({ id: "p", reason: "protected" });
    expect(res.estimate.basis).toBe("estimated");
    // El protegido no viajó al sidecar.
    const enviado = falso.optimizaciones[0]!.cuerpo;
    expect(enviado.segments.map((x: { id: string }) => x.id)).toEqual(["a"]);
    expect(enviado.segments[0].content).toBe(JSON_GRANDE);
    // La credencial va en la cabecera, la del runtime, y nada más.
    expect(falso.optimizaciones[0]!.cabeceras.authorization).toBe("Bearer token-del-runtime-de-prueba");
    // El plan se aplica a la copia y se recupera el original byte a byte.
    expect(aplicarPlan(req, res)[0]!.utf8).toEqual(r.utf8);
    const original = await recuperarEntero(s, ambito, r.handle!, { privacyPolicyHash: POLITICA }, r.originalSha256);
    expect(Buffer.from(original).toString("utf8")).toBe(JSON_GRANDE);
    expect(falso.peticiones.filter((x) => x.ruta.endsWith("/retrieve")).length).toBeGreaterThan(3);
  });

  it("un segmento sin huella de política DETIENE (lanza), no hace bypass, y no sale nada", async () => {
    const s = sidecar();
    const a = segmento("a", JSON_GRANDE, { privacyPolicyHash: "" });
    await expect(s.optimize(peticion([a]), nuncaAbortada())).rejects.toBeInstanceOf(ErrorDePrivacidad);
    const malHash = { ...segmento("a", JSON_GRANDE), sha256: "0".repeat(64) };
    await expect(s.optimize(peticion([malHash]), nuncaAbortada())).rejects.toBeInstanceOf(PeticionInvalida);
    expect(falso.peticiones).toHaveLength(0);
  });

  it("binario con otra sha256 → engine_unverified y ni una petición al sidecar", async () => {
    const s = sidecar({ binario: { ruta: bin.ruta, sha256Esperado: "e".repeat(64), versionFijada: "4.0.1" } });
    const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    expect(res).toMatchObject({ status: "bypassed", reason: "engine_unverified", replacements: [] });
    expect(falso.peticiones).toHaveLength(0);
    expect((await s.listo()).motivo).toBe("engine_unverified");
  });

  it("sin sha256 esperada, con ruta relativa o con binario escribible por otros → rechazado", async () => {
    for (const binario of [
      { ruta: bin.ruta, sha256Esperado: "", versionFijada: "4.0.1" },
      { ruta: "caveman-proxy", sha256Esperado: bin.sha256, versionFijada: "4.0.1" },
    ]) {
      const res = await sidecar({ binario }).optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
      expect(res.reason).toBe("engine_unverified");
    }
    const otro = await binarioFalso(await mkdtemp(join(tmpdir(), "bv-d05-w-")));
    await chmod(otro.ruta, 0o777);
    const res = await sidecar({ binario: { ruta: otro.ruta, sha256Esperado: otro.sha256, versionFijada: "4.0.1" } }).optimize(
      peticion([segmento("a", JSON_GRANDE)]),
      nuncaAbortada(),
    );
    expect(res.reason).toBe("engine_unverified");
    expect(falso.peticiones).toHaveLength(0);
  });

  it("el runtime anuncia otra versión → version_mismatch, sin optimize", async () => {
    falso.runtimeBuild = "4.0.2-dev";
    const res = await sidecar().optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    expect(res.reason).toBe("version_mismatch");
    expect(falso.optimizaciones).toHaveLength(0);
  });

  it("sólo loopback literal: localhost, https, otra IP o un prefijo con '..' no valen, y no hay E/S", async () => {
    for (const e of ["http://localhost:1", "https://127.0.0.1:1", "http://10.0.0.1:1", "http://127.0.0.1:1/a/../b", "http://127.0.0.1:099"]) {
      expect(endpointLoopback(e)).toBeNull();
      const res = await sidecar({ endpoint: e }).optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
      expect(res.reason).toBe("invalid_endpoint");
    }
    expect(endpointLoopback("http://[::1]:8787/pre")).toEqual({ host: "::1", port: 8787, prefijo: "/pre" });
    expect(falso.peticiones).toHaveLength(0);
  });

  it("plazo de 100 ms: un sidecar que tarda 1 s da bypass `deadline` sin pasar mucho del plazo", async () => {
    const s = sidecar({ timeoutMs: 100 });
    await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada()); // capacidades en caché
    falso.alOptimizar = (_c, d) => ({ cuerpo: d(), demoraMs: 1_000 });
    const t0 = performance.now();
    const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    const dt = performance.now() - t0;
    expect(res).toMatchObject({ status: "bypassed", reason: "deadline", replacements: [] });
    expect(dt).toBeLessThan(400);
  });

  it("cancelación del llamante: bypass `cancelled` enseguida, y NO cuenta para el cortacircuitos", async () => {
    let t = 0;
    const s = sidecar({ ahoraMonotono: () => t });
    falso.alOptimizar = (_c, d) => ({ cuerpo: d(), demoraMs: 1_000 });
    for (let i = 0; i < 7; i++) {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 20);
      const t0 = performance.now();
      const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), ac.signal);
      expect(res.reason).toBe("cancelled");
      expect(performance.now() - t0).toBeLessThan(500);
    }
    expect(s.estadoCortacircuitos).toBe("closed");
    t += 1;
  });

  it("cortacircuitos: 5 fallos seguidos lo abren; abierto no hay E/S; a los 30 s UNA sonda; buena, cierra", async () => {
    let t = 1_000;
    const s = sidecar({ ahoraMonotono: () => t });
    falso.alOptimizar = () => ({ status: 503, cuerpo: { schema_version: 1, error: { code: "runtime_unavailable" } } });
    for (let i = 0; i < 5; i++) {
      expect((await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada())).reason).toBe("runtime_unavailable");
    }
    expect(s.estadoCortacircuitos).toBe("open");
    const antes = falso.peticiones.length;
    expect((await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada())).reason).toBe("circuit_open");
    expect(falso.peticiones.length).toBe(antes);

    t += 29_999;
    expect((await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada())).reason).toBe("circuit_open");
    t += 1;
    expect(s.estadoCortacircuitos).toBe("half_open");
    // Sonda mala: reabre.
    expect((await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada())).reason).toBe("runtime_unavailable");
    expect(s.estadoCortacircuitos).toBe("open");
    t += 30_000;
    // Sonda buena, retenida: mientras vuela, la siguiente no entra.
    falso.alOptimizar = undefined;
    falso.retener = true;
    const sonda = s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    while (falso.retenidosAhora === 0) await new Promise((r) => setTimeout(r, 5));
    expect((await s.optimize(peticion([segmento("b", JSON_GRANDE)]), nuncaAbortada())).reason).toBe("circuit_open");
    falso.soltarUno();
    expect((await sonda).status).toBe("applied");
    expect(s.estadoCortacircuitos).toBe("closed");
  });

  it("`no_candidate` y demás decisiones locales no cuentan: 20 sin candidato + 4 fallos → sigue cerrado", async () => {
    const s = sidecar();
    for (let i = 0; i < 20; i++) {
      const res = await s.optimize(peticion([segmento("p", "x", { protected: true })]), nuncaAbortada());
      expect(res.reason).toBe("no_candidate");
    }
    expect(falso.peticiones).toHaveLength(0);
    falso.alOptimizar = () => ({ status: 500, cuerpo: "no json" });
    for (let i = 0; i < 4; i++) await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    expect(s.estadoCortacircuitos).toBe("closed");
  });

  it("tamaños: >1 MiB se omite (no se trunca); por encima de 8 MiB por petición se omiten los que no caben", async () => {
    const s = sidecar({ timeoutMs: 10_000 });
    const enorme = segmento("enorme", "x".repeat(MiB + 1));
    const normal = segmento("normal", JSON_GRANDE);
    const res = await s.optimize(peticion([enorme, normal]), nuncaAbortada());
    expect(res.skipped).toContainEqual({ id: "enorme", reason: "payload_budget" });
    const ids = falso.optimizaciones[0]!.cuerpo.segments.map((x: { id: string }) => x.id);
    expect(ids).toEqual(["normal"]);
    expect(res.replacements.map((r) => r.segmentId)).toEqual(["normal"]);

    falso.peticiones.length = 0;
    const casiUnMiB = Array.from({ length: 9 }, (_, i) => segmento(`m${i}`, String(i).repeat(MiB - 1024)));
    const res2 = await s.optimize(peticion(casiUnMiB), nuncaAbortada());
    const enviada = falso.optimizaciones[0]!;
    expect(enviada.bytes).toBeLessThanOrEqual(8 * MiB);
    // Ninguno truncado: lo que viajó es el contenido entero.
    for (const x of enviada.cuerpo.segments) expect(x.content.length).toBe(MiB - 1024);
    const omitidos = res2.skipped.filter((k) => k.reason === "payload_budget").map((k) => k.id);
    expect(omitidos.length).toBeGreaterThan(0);
    expect(enviada.cuerpo.segments.length + omitidos.length).toBe(9);
  });

  it.each([
    ["no es JSON", { cuerpo: "<html>" }],
    ["claves duplicadas", { cuerpo: '{"schema_version":1,"schema_version":1}' }],
    ["UTF-8 inválido", { cuerpo: Buffer.from([0x7b, 0xff, 0x7d]) }],
    ["una redirección", { status: 302, cabeceras: { location: "http://example.com/" } }],
  ])("respuesta rota (%s) → bypass y fallo para el cortacircuitos", async (_n, r) => {
    let t = 0;
    const s = sidecar({ ahoraMonotono: () => t });
    falso.alOptimizar = () => r;
    for (let i = 0; i < 5; i++) {
      const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
      expect(res.status).toBe("bypassed");
      expect(res.replacements).toEqual([]);
    }
    expect(s.estadoCortacircuitos).toBe("open");
    t += 1;
  });

  type Torcer = (plan: any, cuerpo: any) => void;
  it.each<[string, Torcer]>([
    ["sustitución para un segmento NO declarado", (p) => (p.replacements[0].segment_id = "fantasma")],
    ["sustitución para el segmento PROTEGIDO (que ni se envió)", (p) => (p.replacements[0].segment_id = "p")],
    ["otra huella del original", (p) => (p.replacements[0].original_sha256 = "0".repeat(64))],
    ["sha256 que no es la del texto", (p) => (p.replacements[0].sha256 = "0".repeat(64))],
    ["texto sin el prefijo de recuperación", (p) => (p.replacements[0].text = "corto")],
    ["handle con otra forma", (p) => (p.replacements[0].recovery_handle = "cmw_xyz")],
    ["transformación que no se pidió", (p) => (p.replacements[0].transform_id = "caveman.toon")],
    ["dos sustituciones para el mismo segmento", (p) => p.replacements.push(p.replacements[0])],
    ["no más pequeño", (p, c) => {
      const h = p.replacements[0].recovery_handle;
      const t = `[caveman: shortened; exact original via caveman_retrieve handle=${h}]\n` + c.segments[0].content;
      p.replacements[0].text = t;
      p.replacements[0].sha256 = hex(t);
    }],
  ])("plan con %s → `invalid_plan`, ninguna sustitución (tampoco la buena)", async (_n, torcer) => {
    const s = sidecar();
    falso.alOptimizar = (c, d) => {
      const plan: any = d();
      torcer(plan, c);
      return { cuerpo: plan };
    };
    const req = peticion([segmento("a", JSON_GRANDE), segmento("b", JSON_GRANDE + " "), segmento("p", "no tocar", { protected: true })]);
    const res = await s.optimize(req, nuncaAbortada());
    expect(res).toMatchObject({ status: "bypassed", reason: "invalid_plan", replacements: [] });
  });

  it("modos: off, lossless y recoverable sin binding pasan sin E/S; record pregunta pero nunca sustituye", async () => {
    const s = sidecar();
    const a = segmento("a", JSON_GRANDE);
    expect((await s.optimize(peticion([a], { mode: "off" }), nuncaAbortada())).reason).toBe("off");
    expect((await s.optimize(peticion([a], { mode: "lossless" }), nuncaAbortada())).reason).toBe("unknown_capability");
    expect((await s.optimize(peticion([a], { recoveryBinding: undefined }), nuncaAbortada())).reason).toBe("recovery_unbound");
    expect(falso.peticiones).toHaveLength(0);
    const rec = await s.optimize(peticion([a], { mode: "record" }), nuncaAbortada());
    expect(rec).toMatchObject({ status: "bypassed", reason: "record", replacements: [] });
    expect(falso.optimizaciones[0]!.cuerpo.mode).toBe("record");
  });

  it("piloto: streaming, otro proveedor o estado retenido → unsupported_route sin E/S", async () => {
    const s = sidecar();
    const a = segmento("a", JSON_GRANDE);
    const ep = peticion([a]).endpoint;
    for (const endpoint of [
      { ...ep, streaming: true },
      { ...ep, provider: "openai", route: "/v1/chat/completions" },
      { ...ep, providerState: "retained" as const },
    ]) {
      expect((await s.optimize(peticion([a], { endpoint }), nuncaAbortada())).reason).toBe("unsupported_route");
    }
    expect(falso.peticiones).toHaveLength(0);
  });

  it("concurrencia 4 + cola 16: la 21.ª pasa al momento con `capacity`; la cola es justa entre tenants", async () => {
    const s = sidecar({ timeoutMs: 10_000 });
    await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada()); // capacidades en caché
    falso.peticiones.length = 0;
    falso.retener = true;
    const enVuelo: Promise<OptimizeResult>[] = [];
    for (let i = 0; i < 20; i++) {
      const tenant = i < 12 ? "ruidoso" : `t${i}`;
      enVuelo.push(s.optimize(peticion([segmento("a", JSON_GRANDE)], { scope: { ...ambito, tenantId: tenant } }), nuncaAbortada()));
    }
    while (falso.retenidosAhora < 4) await new Promise((r) => setTimeout(r, 5));
    // 4 en vuelo (ruidoso) + 8 del ruidoso en cola (su tope) + 8 de otros: lleno.
    const t0 = performance.now();
    const extra = await s.optimize(peticion([segmento("a", JSON_GRANDE)], { scope: { ...ambito, tenantId: "otro" } }), nuncaAbortada());
    expect(extra.reason).toBe("capacity");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(falso.retenidosAhora).toBe(4);
    falso.retener = false;
    while (falso.soltarUno());
    const res = await Promise.all(enVuelo);
    expect(res.every((r) => r.status === "applied")).toBe(true);
    // Tras los 4 primeros (todos del ruidoso), la rueda alterna: no salen 8 del ruidoso seguidos.
    const orden = falso.optimizaciones.map((p) => p.cuerpo.scope.namespace);
    const tras = orden.slice(4, 12);
    expect(tras.filter((n: string) => n.startsWith("ruidoso")).length).toBeLessThanOrEqual(4);
  });

  it("retrieve: política cambiada → DETIENE; ámbito ajeno o handle inventado → not_found sin E/S", async () => {
    const s = sidecar();
    const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    const h = res.replacements[0]!.handle!;
    falso.peticiones.length = 0;
    await expect(s.retrieve(ambito, h, undefined, { privacyPolicyHash: "privacy-v2" })).rejects.toMatchObject({
      name: "ErrorDePrivacidad",
      codigo: "policy_changed",
    });
    await expect(s.retrieve(ambito, h)).rejects.toMatchObject({ codigo: "policy_unverified" });
    for (const otro of [{ ...ambito, tenantId: "otra" }, { ...ambito, branchId: "fork" }, { ...ambito, epoch: "1" }]) {
      await expect(s.retrieve(otro, h, undefined, { privacyPolicyHash: POLITICA })).rejects.toMatchObject({ codigo: "not_found" });
    }
    await expect(s.retrieve(ambito, "cmw_" + "0".repeat(48), undefined, { privacyPolicyHash: POLITICA })).rejects.toMatchObject({
      codigo: "not_found",
    });
    expect(falso.peticiones).toHaveLength(0);
  });

  it("retrieve: huella distinta del original → integrity_failure; un extracto no es el original", async () => {
    const s = sidecar();
    const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    const h = res.replacements[0]!.handle!;
    falso.alRecuperar = (_c, d) => {
      const r = d();
      (r.cuerpo as any).original_sha256 = "0".repeat(64);
      return r;
    };
    await expect(s.retrieve(ambito, h, undefined, { privacyPolicyHash: POLITICA })).rejects.toMatchObject({ codigo: "integrity_failure" });
    falso.alRecuperar = (_c, d) => {
      const r = d();
      (r.cuerpo as any).kind = "excerpt";
      return r;
    };
    await expect(s.retrieve(ambito, h, undefined, { privacyPolicyHash: POLITICA })).rejects.toBeInstanceOf(ErrorDeRecuperacion);
    // Y si las páginas mienten sobre el contenido, el reensamblado lo caza.
    falso.alRecuperar = (_c, d) => {
      const r = d();
      (r.cuerpo as any).text = "otra cosa";
      return r;
    };
    await expect(
      recuperarEntero(s, ambito, h, { privacyPolicyHash: POLITICA }, res.replacements[0]!.originalSha256),
    ).rejects.toMatchObject({ codigo: "integrity_failure" });
  });

  it("retrieve tiene su propia cola: con el optimizador saturado se sigue recuperando", async () => {
    const s = sidecar({ timeoutMs: 10_000 });
    const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    const h = res.replacements[0]!.handle!;
    falso.retener = true;
    const saturan = Array.from({ length: 20 }, () => s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada()));
    while (falso.retenidosAhora < 4) await new Promise((r) => setTimeout(r, 5));
    const pag = await s.retrieve(ambito, h, undefined, { privacyPolicyHash: POLITICA });
    expect(Buffer.from(pag.utf8).toString()).toBe(JSON_GRANDE);
    falso.retener = false;
    while (falso.soltarUno());
    await Promise.all(saturan);
  });

  it("release borra en el sidecar y aquí: el handle deja de servirse aunque el sidecar lo guardara", async () => {
    const s = sidecar();
    const res = await s.optimize(peticion([segmento("a", JSON_GRANDE)]), nuncaAbortada());
    const h = res.replacements[0]!.handle!;
    expect(await s.release(ambito)).toEqual({ revoked: true });
    expect(falso.peticiones.some((p) => p.ruta.endsWith("/sessions/delete"))).toBe(true);
    await expect(s.retrieve(ambito, h, undefined, { privacyPolicyHash: POLITICA })).rejects.toMatchObject({ codigo: "not_found" });
  });

  it("la credencial del runtime no sale en JSON.stringify ni en inspect", () => {
    const s = sidecar();
    expect(JSON.stringify(s)).not.toContain("token-del-runtime");
    expect(inspect(s, { depth: 5, showHidden: true })).not.toContain("token-del-runtime");
  });
});

describe("guardas sueltas", () => {
  it("Cortacircuitos: un éxito corta la racha; half-open admite exactamente una sonda", () => {
    let t = 0;
    const c = new Cortacircuitos({ ahora: () => t });
    for (let i = 0; i < 4; i++) c.registrar("fallo", false);
    c.registrar("exito", false);
    for (let i = 0; i < 4; i++) c.registrar("fallo", false);
    expect(c.estado).toBe("closed");
    c.registrar("fallo", false);
    expect(c.estado).toBe("open");
    t = 30_000;
    const a = c.admitir();
    expect(a).toEqual({ ok: true, sonda: true });
    expect(c.admitir()).toEqual({ ok: false });
    c.liberar(true); // la sonda se canceló: la siguiente puede probar
    expect(c.admitir()).toEqual({ ok: true, sonda: true });
  });

  it("ColaJusta: reparte por turnos entre tenants y una espera cancelada no consume hueco", async () => {
    const q = new ColaJusta({ concurrencia: 1, cola: 16 });
    const orden: string[] = [];
    const primero = await q.turno("A");
    if (!primero.ok) throw new Error("debía entrar");
    const esperas = ["A", "A", "A", "B"].map((t) =>
      q.turno(t).then((r) => {
        if (!r.ok) throw new Error("debía entrar");
        orden.push(t);
        r.liberar(); // al soltarlo entra el siguiente de la rueda
      }),
    );
    const ac = new AbortController();
    const cancelada = q.turno("C", ac.signal);
    ac.abort();
    expect(await cancelada).toEqual({ ok: false, motivo: "cancelled" });
    primero.liberar();
    await Promise.all(esperas);
    expect(orden).toEqual(["A", "B", "A", "A"]);
    expect(q.estadisticas).toEqual({ enVuelo: 0, enCola: 0 });
  });
});

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, expect, vi } from "vitest";

import {
  LicenseRenewer,
  licenseVerdict,
  refusalBody,
  resolveStartupLicense,
  transitionLine,
  verifyGatewayLicense,
  isoDay,
  type GatewayLicenseState,
  type StartupInput,
  type StartupResult,
  type VerifiedLicense,
} from "../gateway/license.js";
import { isSubscriptionTraffic } from "../gateway/medidor.js";
import { RevocationSnapshot, type LicenseStatus, type LicenseTokenPayload } from "../src/license/index.js";
import { TEST_KEYS, fakeGate, signLicense, signRevocationList, testPayload } from "./helpers/test-license.js";

/**
 * LA LICENCIA DEL GATEWAY, en unidades (LICENSE §2). Sin servidores: el fetch es
 * un doble. Lo que se fija aquí es el CONTRATO que ve el cliente — qué código,
 * qué texto exacto, qué URL — y las dos reglas que no se negocian: el arranque
 * recoge SIEMPRE la licencia online con la `bvk_` (el respaldo offline solo si
 * no hay red), y ningún texto lleva jamás el valor de la clave ni del token.
 */

const DIA = 86_400;
const CP = "http://cp.test";
const CLAVE = "bvk_test";

const atacante = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

type LlamadaFetch = [string, RequestInit | undefined];

/** Un fetch doble que responde `status` con `cuerpo` y registra las llamadas. */
function responde(status: number, cuerpo: unknown = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(cuerpo), { status }));
}
const conToken = (token: string) => responde(200, { token });
/** Un fetch que nunca resuelve, pero que respeta el `signal` (como el de verdad). */
const colgado = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
const llamadas = (f: unknown): LlamadaFetch[] => (f as { mock: { calls: LlamadaFetch[] } }).mock.calls;

/** Todos los textos que un resultado enseña al cliente. */
function textos(r: StartupResult): string[] {
  return r.ok ? [r.line, ...r.warnings] : [r.message];
}

/** Registro de todo lo que se ha enseñado, para las dos reglas transversales. */
const enseñado: { texto: string; secretos: string[] }[] = [];
async function arrancar(over: Partial<StartupInput>): Promise<StartupResult> {
  const input: StartupInput = {
    serviceAccountKey: CLAVE,
    licenseServerUrl: CP,
    publicKey: TEST_KEYS.publicKey,
    ...over,
  };
  const r = await resolveStartupLicense(input);
  const secretos = [input.serviceAccountKey, input.licenseKey].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 6,
  );
  for (const t of textos(r)) enseñado.push({ texto: t, secretos: secretos.map((s) => s.trim()) });
  return r;
}

const activo = (over: Record<string, unknown> = {}) => signLicense(testPayload(over));
const enGracia = (over: Record<string, unknown> = {}) => {
  const ahora = Math.floor(Date.now() / 1000);
  return signLicense(testPayload({ expires_at: ahora - 2 * DIA, grace_days: 14, ...over }));
};
const caducado = (over: Record<string, unknown> = {}) => {
  const ahora = Math.floor(Date.now() / 1000);
  return signLicense(testPayload({ expires_at: ahora - 40 * DIA, grace_days: 14, ...over }));
};
const payloadDe = (token: string): LicenseTokenPayload =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as LicenseTokenPayload;

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveStartupLicense — el arranque, en orden estricto", () => {
  it("E0 · sin clave pública (corriendo desde el fuente) → no-public-key, sin red", async () => {
    const f = responde(200);
    const r = await arrancar({ publicKey: "", fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "no-public-key" });
    expect(llamadas(f)).toHaveLength(0);
    const keysetVacio = await arrancar({ publicKey: { keys: {}, defaultKid: "k" }, fetchImpl: f as unknown as typeof fetch });
    expect(keysetVacio).toMatchObject({ ok: false, code: "no-public-key" });
  });

  it("E1 · sin clave de servicio ni licenseKey → modo comunitario, sin red; una clave presente pero mala sigue cerrando", async () => {
    for (const serviceAccountKey of [undefined, "", "   "]) {
      const f = responde(200);
      const r = await arrancar({ serviceAccountKey, fetchImpl: f as unknown as typeof fetch });
      expect(r).toMatchObject({ ok: true, source: "community", license: null, status: "active" });
      expect(r.ok && r.line).toContain("COMMUNITY MODE");
      expect(llamadas(f)).toHaveLength(0);
    }
    // El fail-closed que queda: una clave PRESENTE pero inválida.
    const malo = await arrancar({ licenseKey: "no-es-una-clave", fetchImpl: responde(200) as unknown as typeof fetch });
    expect(malo).toMatchObject({ ok: false, code: "license-invalid" });
  });

  it("E1 · una clave que no es bvk_ → service-key-malformed; si es un token de licencia, lo dice", async () => {
    const f = responde(200);
    const r = await arrancar({ serviceAccountKey: "sk-ant-abc", fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "service-key-malformed" });
    expect(!r.ok && r.message).toContain("start with bvk_");
    expect(!r.ok && r.message).not.toContain("BIVELIO_LICENSE_KEY");
    const cruzada = await arrancar({ serviceAccountKey: activo(), fetchImpl: f as unknown as typeof fetch });
    expect(cruzada).toMatchObject({ ok: false, code: "service-key-malformed" });
    expect(!cruzada.ok && cruzada.message).toContain("BIVELIO_LICENSE_KEY");
    expect(llamadas(f)).toHaveLength(0);
  });

  it("E3 · 200 con licencia activa → online, active, y la línea dice de dónde salió", async () => {
    const token = activo();
    const f = conToken(token);
    const r = await arrancar({ fetchImpl: f as unknown as typeof fetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe("online");
    expect(r.status).toBe("active");
    expect(r.lineIsWarning).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.line).toContain("license: PRO");
    expect(r.line).toContain(`active until ${isoDay(payloadDe(token).expires_at)}`);
    expect(r.line).toContain("collected with your service key");
    expect(r.line).toContain("(+14 days grace)");
    expect(llamadas(f)).toHaveLength(1);
    const [url, init] = llamadas(f)[0]!;
    expect(url).toBe("http://cp.test/api/license/current");
    expect(init?.headers).toEqual({ authorization: "Bearer bvk_test", accept: "application/json" });
  });

  it("la barra final de la URL base no duplica la ruta", async () => {
    const f = conToken(activo());
    await arrancar({ licenseServerUrl: "http://cp.test/", fetchImpl: f as unknown as typeof fetch });
    expect(llamadas(f)[0]![0]).toBe("http://cp.test/api/license/current");
  });

  it("200 en gracia → grace, línea de aviso con IN GRACE y la URL de Cuenta", async () => {
    const r = await arrancar({ fetchImpl: conToken(enGracia()) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, status: "grace", lineIsWarning: true });
    expect(r.ok && r.line).toContain("IN GRACE");
    expect(r.ok && r.line).toContain("/dashboard/account");
  });

  it("200 caducado → license-expired con las dos fechas y la URL de Cuenta", async () => {
    const token = caducado();
    const p = payloadDe(token);
    const r = await arrancar({ fetchImpl: conToken(token) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "license-expired" });
    if (r.ok) return;
    expect(r.message).toContain(isoDay(p.expires_at));
    expect(r.message).toContain(isoDay(p.expires_at + p.grace_days * DIA));
    expect(r.message).toMatch(/\d{4}-\d{2}-\d{2}.*\d{4}-\d{2}-\d{2}/);
    expect(r.message).toContain("/dashboard/account");
  });

  it("200 firmado por un atacante → license-invalid: no verifica, actualiza el paquete", async () => {
    const r = await arrancar({ fetchImpl: conToken(signLicense(testPayload(), atacante.privateKey)) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "license-invalid" });
    expect(!r.ok && r.message).toContain("does not verify");
    expect(!r.ok && r.message).toContain("Update @bivelio/savings-layer");
  });

  it("⛔ 200 con una LISTA DE REVOCACIONES firmada por la clave buena → no es una licencia (separación de dominio)", async () => {
    const lista = signRevocationList({ seq: 1, asOf: Math.floor(Date.now() / 1000), revoked: [] });
    const r = await arrancar({ fetchImpl: conToken(lista) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "license-invalid" });
    expect(!r.ok && r.message).toContain("not a license token");
  });

  it("200 con un payload de tipos incorrectos → license-invalid", async () => {
    const r = await arrancar({ fetchImpl: conToken(activo({ features: 5 })) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "license-invalid" });
    expect(!r.ok && r.message).toContain("wrong field types");
  });

  it("200 sin `token` → unreachable, con el respaldo explicado", async () => {
    const r = await arrancar({ fetchImpl: responde(200, { plan: "pro" }) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
    expect(!r.ok && r.message).toContain("could not collect your license");
    expect(!r.ok && r.message).toContain("BIVELIO_LICENSE_KEY");
  });

  it("401 → service-key-not-recognised; 404 → no-license (solo la licencia Medir es gratis)", async () => {
    const r401 = await arrancar({ fetchImpl: responde(401) as unknown as typeof fetch });
    expect(r401).toMatchObject({ ok: false, code: "service-key-not-recognised" });
    expect(!r401.ok && r401.message).toContain("HTTP 401");
    expect(!r401.ok && r401.message).toContain("/dashboard/install");
    const r404 = await arrancar({ fetchImpl: responde(404) as unknown as typeof fetch });
    expect(r404).toMatchObject({ ok: false, code: "no-license" });
    expect(!r404.ok && r404.message).toContain("free Measure license");
    expect(!r404.ok && r404.message).toContain("/dashboard/install");
    expect(!r404.ok && r404.message).toContain("https://savings.bivelio.com/dashboard/account");
  });

  it("403, 501, 503, fallo de red y timeout → unreachable, cada uno con SU causa", async () => {
    for (const [status, causa] of [
      [403, "HTTP 403"],
      [501, "HTTP 501"],
      [503, "HTTP 503"],
    ] as const) {
      const r = await arrancar({ fetchImpl: responde(status) as unknown as typeof fetch });
      expect(r).toMatchObject({ ok: false, code: "unreachable" });
      expect(!r.ok && r.message).toContain(causa);
    }
    const red = await arrancar({
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(red).toMatchObject({ ok: false, code: "unreachable" });
    expect(!red.ok && red.message).toContain("network error");
    const tiempo = await arrancar({ fetchImpl: colgado() as unknown as typeof fetch, timeoutMs: 50 });
    expect(tiempo).toMatchObject({ ok: false, code: "unreachable" });
    expect(!tiempo.ok && tiempo.message).toContain("timed out");
  });

  it("offline válido + online de la MISMA org → online, sin avisos", async () => {
    const r = await arrancar({ licenseKey: activo(), fetchImpl: conToken(activo()) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, source: "online", warnings: [] });
  });

  it("⛔ offline de OTRA org + online → manda la org de la bvk_ y se avisa de que el offline se ignora", async () => {
    const r = await arrancar({
      licenseKey: activo({ org_id: "org-ajena" }),
      fetchImpl: conToken(activo()) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: true, source: "online" });
    if (!r.ok) return;
    expect(r.license).not.toBeNull();
    expect(r.license!.payload.org_id).toBe("org-test");
    expect(r.warnings[0]).toContain("different organization");
  });

  it("offline válido + online inalcanzable → offline, línea de aviso con el origen y la causa", async () => {
    const r = await arrancar({
      licenseKey: activo(),
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: true, source: "offline", lineIsWarning: true });
    expect(r.ok && r.line).toContain("from BIVELIO_LICENSE_KEY");
    expect(r.ok && r.line).toContain("network error");
  });

  it("el timeout efectivo: 3 s con un respaldo que concede, 10 s sin él (temporizadores falsos)", async () => {
    vi.useFakeTimers();
    let resuelto: StartupResult | null = null;
    void resolveStartupLicense({
      serviceAccountKey: CLAVE,
      licenseKey: activo(),
      licenseServerUrl: CP,
      publicKey: TEST_KEYS.publicKey,
      fetchImpl: colgado() as unknown as typeof fetch,
    }).then((r) => (resuelto = r));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(resuelto).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(resuelto).toMatchObject({ ok: true, source: "offline" });

    let sinRespaldo: StartupResult | null = null;
    void resolveStartupLicense({
      serviceAccountKey: CLAVE,
      licenseServerUrl: CP,
      publicKey: TEST_KEYS.publicKey,
      fetchImpl: colgado() as unknown as typeof fetch,
    }).then((r) => (sinRespaldo = r));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(sinRespaldo).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(sinRespaldo).toMatchObject({ ok: false, code: "unreachable" });
    expect((sinRespaldo as unknown as { message: string }).message).toContain("timed out after 10 s");
  });

  it("⛔ 404 y 401 fallan AUNQUE haya un respaldo offline válido (el online manda)", async () => {
    const r404 = await arrancar({ licenseKey: activo(), fetchImpl: responde(404) as unknown as typeof fetch });
    expect(r404).toMatchObject({ ok: false, code: "no-license" });
    const r401 = await arrancar({ licenseKey: activo(), fetchImpl: responde(401) as unknown as typeof fetch });
    expect(r401).toMatchObject({ ok: false, code: "service-key-not-recognised" });
  });

  it("offline CADUCADO + online inalcanzable → license-expired con las fechas del offline y las dos causas", async () => {
    const offline = caducado();
    const p = payloadDe(offline);
    const r = await arrancar({ licenseKey: offline, fetchImpl: responde(503) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "license-expired" });
    if (r.ok) return;
    expect(r.message).toContain(isoDay(p.expires_at));
    expect(r.message).toContain("could not be reached");
    expect(r.message).toContain("HTTP 503");
  });

  it("offline caducado + online activo → online", async () => {
    const r = await arrancar({ licenseKey: caducado(), fetchImpl: conToken(activo()) as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, source: "online", status: "active" });
  });

  it("⛔ BIVELIO_LICENSE_KEY con la bvk_ pegada → license-invalid con la pista, SIN red", async () => {
    const f = responde(200);
    const r = await arrancar({ licenseKey: "bvk_abc", fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, code: "license-invalid" });
    expect(!r.ok && r.message).toContain("Did you paste the bvk_");
    expect(llamadas(f)).toHaveLength(0);
  });

  it("⛔ BIVELIO_LICENSE_KEY firmada por un atacante → license-invalid, SIN red", async () => {
    const f = responde(200);
    const r = await arrancar({
      licenseKey: signLicense(testPayload(), atacante.privateKey),
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, code: "license-invalid" });
    expect(!r.ok && r.message).toContain("does not verify against this build");
    expect(llamadas(f)).toHaveLength(0);
  });

  it("el respaldo con envoltorio (salto de línea, comillas, `Bearer `) sigue valiendo", async () => {
    const t = activo();
    for (const envuelto of [`${t}\n`, `"${t}"`, `Bearer ${t}`]) {
      const r = await arrancar({ licenseKey: envuelto, fetchImpl: responde(503) as unknown as typeof fetch });
      expect(r).toMatchObject({ ok: true, source: "offline" });
    }
  });

  it("un respaldo VACÍO se trata como ausente (timeout de 10 s, no de 3)", async () => {
    vi.useFakeTimers();
    for (const licenseKey of ["", "   "]) {
      let r: StartupResult | null = null;
      void resolveStartupLicense({
        serviceAccountKey: CLAVE,
        licenseKey,
        licenseServerUrl: CP,
        publicKey: TEST_KEYS.publicKey,
        fetchImpl: colgado() as unknown as typeof fetch,
      }).then((x) => (r = x));
      await vi.advanceTimersByTimeAsync(3_000);
      expect(r).toBeNull();
      await vi.advanceTimersByTimeAsync(7_000);
      expect(r).toMatchObject({ ok: false, code: "unreachable" });
    }
  });

  it("offline válido + online que NO verifica contra este build → offline, con aviso de actualizar", async () => {
    const r = await arrancar({
      licenseKey: activo(),
      fetchImpl: conToken(signLicense(testPayload(), atacante.privateKey)) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({ ok: true, source: "offline" });
    expect(r.ok && r.warnings[0]).toContain("does not verify");
  });

  // Estas dos van AL FINAL a propósito: recorren todo lo enseñado arriba.
  it("⛔ ningún texto lleva el valor de la clave de servicio ni del token", () => {
    expect(enseñado.length).toBeGreaterThan(30);
    for (const { texto, secretos } of enseñado) {
      for (const s of secretos) {
        expect(texto, texto).not.toContain(s);
        // Ni un trozo reconocible del token (su cabecera va en todos).
        if (s.includes(".")) expect(texto).not.toContain(s.split(".")[1]!.slice(0, 24));
      }
    }
  });

  it("⛔ todo lo enseñado es ASCII imprimible y en inglés", () => {
    for (const { texto } of enseñado) {
      expect(texto, texto).toMatch(/^[\x20-\x7E]+$/);
      expect(texto, texto).not.toMatch(/[áéíóúüñ¿¡]/i);
    }
  });
});

describe("verifyGatewayLicense", () => {
  it("normaliza, verifica, exige typ BVL y devuelve el token limpio", () => {
    const t = activo();
    const c = verifyGatewayLicense(`  "${t}"\n`, TEST_KEYS.publicKey);
    expect(c.ok).toBe(true);
    expect(c.ok && c.license.token).toBe(t);
    expect(verifyGatewayLicense("", TEST_KEYS.publicKey)).toMatchObject({ ok: false, shape: "empty" });
    expect(verifyGatewayLicense("bvk_x", TEST_KEYS.publicKey)).toMatchObject({ ok: false, shape: "malformed" });
    const typOtro = signLicense(testPayload(), TEST_KEYS.privateKey, { alg: "EdDSA", typ: "JWT", v: 1 });
    expect(verifyGatewayLicense(typOtro, TEST_KEYS.publicKey)).toMatchObject({ ok: false, reason: "not a license token (typ JWT)" });
    expect(verifyGatewayLicense(activo({ grace_days: -1 }), TEST_KEYS.publicKey)).toMatchObject({ ok: false, shape: "token" });
    expect(verifyGatewayLicense(activo({ jti: "" }), TEST_KEYS.publicKey)).toMatchObject({ ok: false, shape: "token" });
  });
});

describe("licenseVerdict — la tabla gate × canal entera (gana el corte)", () => {
  const p = payloadDe(activo()) as LicenseTokenPayload;
  const esperado: Record<string, Record<string, GatewayLicenseState>> = {
    active: { null: "active", "license-expired": "expired", "license-revoked": "revoked", "no-license": "no-license", otro: "blocked" },
    grace: { null: "grace", "license-expired": "expired", "license-revoked": "revoked", "no-license": "no-license", otro: "blocked" },
    expired: { null: "expired", "license-expired": "expired", "license-revoked": "revoked", "no-license": "no-license", otro: "blocked" },
    revoked: { null: "revoked", "license-expired": "expired", "license-revoked": "revoked", "no-license": "no-license", otro: "blocked" },
    invalid: { null: "invalid", "license-expired": "expired", "license-revoked": "revoked", "no-license": "no-license", otro: "blocked" },
  };
  for (const [gate, fila] of Object.entries(esperado)) {
    for (const [razon, estado] of Object.entries(fila)) {
      it(`gate ${gate} × canal ${razon} → ${estado}`, () => {
        const v = licenseVerdict(fakeGate(gate as LicenseStatus), razon === "null" ? null : razon === "otro" ? "org-suspended" : razon, p);
        expect(v.state).toBe(estado);
        expect(v.serve).toBe(estado === "active" || estado === "grace");
      });
    }
  }

  it("none y stale se tratan como invalid; un reason vacío o en blanco es null", () => {
    expect(licenseVerdict(fakeGate("none"), null, p).state).toBe("invalid");
    expect(licenseVerdict(fakeGate("stale"), null, p).state).toBe("invalid");
    expect(licenseVerdict(fakeGate("active"), "", p)).toEqual({ serve: true, state: "active" });
    expect(licenseVerdict(fakeGate("active"), "  ", p)).toEqual({ serve: true, state: "active" });
  });

  it("el detalle dice de dónde sale el corte", () => {
    const v = licenseVerdict(fakeGate("expired"), null, p);
    expect(!v.serve && v.detail).toBe(`grace period ended ${isoDay(p.expires_at + p.grace_days * DIA)}`);
    const c = licenseVerdict(fakeGate("active"), "license-revoked", p);
    expect(!c.serve && c.detail).toBe("reported by savings.bivelio.com");
  });
});

describe("refusalBody — el 402 que enseñan Claude Code y Codex", () => {
  for (const estado of ["expired", "revoked", "no-license", "blocked", "invalid"] as const) {
    it(`${estado}: forma de error de los dos dialectos, sin cortar lo que está en vuelo`, () => {
      const cuerpo = refusalBody(estado);
      expect(cuerpo).toMatch(/^[\x20-\x7E]+$/);
      const json = JSON.parse(cuerpo) as { type: string; error: { type: string; status: string; message: string } };
      expect(json.type).toBe("error");
      expect(json.error.type).toBe("license_error");
      expect(json.error.status).toBe(estado);
      expect(json.error.message).toContain("requests already in flight were not interrupted");
      if (estado === "invalid") expect(json.error.message).toContain("support@bivelio.com");
      else expect(json.error.message).toContain("/dashboard/account");
    });
  }
});

describe("transitionLine — una línea por transición, nunca por petición", () => {
  const p = payloadDe(activo());
  const corte = (state: "expired" | "revoked" | "no-license" | "blocked" | "invalid") =>
    ({ serve: false, state, detail: "x" }) as const;

  it("active → expired: una línea que dice que lo que está en vuelo no se toca", () => {
    const l = transitionLine("active", corte("expired"), p);
    expect(l).toContain("license expired");
    expect(l).toContain("requests in flight are not touched");
    expect(l).toContain("/dashboard/account");
    expect(l).toMatch(/^[\x20-\x7E]+$/);
  });

  it("expired → expired: nada; expired → active: «again»", () => {
    expect(transitionLine("expired", corte("expired"), p)).toBeNull();
    expect(transitionLine("expired", { serve: true, state: "active" }, p)).toContain("license active again");
  });

  it("active → grace: «in grace»; grace → grace: nada", () => {
    expect(transitionLine("active", { serve: true, state: "grace" }, p)).toContain("in grace");
    expect(transitionLine("grace", { serve: true, state: "grace" }, p)).toBeNull();
  });

  it("null → active: nada; null → expired: una línea", () => {
    expect(transitionLine(null, { serve: true, state: "active" }, p)).toBeNull();
    expect(transitionLine(null, corte("expired"), p)).toContain("license expired");
  });
});

describe("LicenseRenewer — recoge la licencia renovada o reemitida con la bvk_", () => {
  const AHORA = 1_900_000_000_000;
  const aS = Math.floor(AHORA / 1000);
  const verificada = (over: Record<string, unknown>): VerifiedLicense => {
    const token = signLicense(testPayload(over, AHORA));
    return { token, payload: payloadDe(token) };
  };

  function renovador(opts: {
    actual: VerifiedLicense;
    fetchImpl: unknown;
    revocation?: RevocationSnapshot;
  }) {
    const adoptadas: VerifiedLicense[] = [];
    const avisos: string[] = [];
    let actual = opts.actual;
    const r = new LicenseRenewer({
      licenseServerUrl: CP,
      serviceAccountKey: CLAVE,
      publicKey: TEST_KEYS.publicKey,
      revocation: opts.revocation ?? new RevocationSnapshot(),
      current: () => actual,
      onAdopt: (l) => {
        adoptadas.push(l);
        actual = l;
      },
      onWarning: (l) => avisos.push(l),
      fetchImpl: opts.fetchImpl as typeof fetch,
      now: () => AHORA,
    });
    return { r, adoptadas, avisos };
  }

  it("lejos de la caducidad y concediendo: sin red; con force sí", async () => {
    const actual = verificada({ jti: "a", expires_at: aS + 30 * DIA });
    const f = conToken(signLicense(testPayload({ jti: "b", expires_at: aS + 60 * DIA }, AHORA)));
    const { r, adoptadas } = renovador({ actual, fetchImpl: f });
    expect(await r.check()).toBe(false);
    expect(llamadas(f)).toHaveLength(0);
    expect(await r.check({ force: true })).toBe(true);
    expect(llamadas(f)).toHaveLength(1);
    expect(adoptadas[0]!.payload.jti).toBe("b");
  });

  it("licencia Medir (diez años): mira en cada vuelta y adopta la de PAGO aunque caduque antes; no otra Medir", async () => {
    // Por la verificación de la pasarela, que aplica la vigencia efectiva.
    const v = verifyGatewayLicense(
      signLicense(
        testPayload(
          { jti: "m", plan: "measure", features: [], expires_at: aS, grace_days: 0, measure_expires_at: aS + 3650 * DIA, measure_grace_days: 30 },
          AHORA,
        ),
      ),
      TEST_KEYS.publicKey,
    );
    if (!v.ok) throw new Error("la licencia Medir de prueba no verifica");
    const medir = v.license;
    // La vigencia efectiva es la real: concede, y queda lejísimos.
    expect(medir.payload.expires_at).toBe(aS + 3650 * DIA);
    const pago = signLicense(testPayload({ jti: "p", expires_at: aS + 30 * DIA }, AHORA));
    const f = conToken(pago);
    const { r, adoptadas } = renovador({ actual: medir, fetchImpl: f });
    expect(await r.check()).toBe(true);
    expect(adoptadas[0]!.payload.plan).toBe("pro");
    const otraMedir = signLicense(
      testPayload({ jti: "m2", plan: "measure", features: [], expires_at: aS, grace_days: 0, measure_expires_at: aS + 3000 * DIA, measure_grace_days: 30 }, AHORA),
    );
    expect(await renovador({ actual: medir, fetchImpl: conToken(otraMedir) }).r.check()).toBe(false);
  });

  it("dentro de la antelación: adopta uno más nuevo de la misma org; no el mismo jti, ni uno revocado, ni uno caducado", async () => {
    const actual = verificada({ jti: "a", expires_at: aS + 2 * DIA });
    const nuevo = signLicense(testPayload({ jti: "b", expires_at: aS + 32 * DIA }, AHORA));
    expect(await renovador({ actual, fetchImpl: conToken(nuevo) }).r.check()).toBe(true);
    expect(await renovador({ actual, fetchImpl: conToken(actual.token) }).r.check()).toBe(false);
    const snap = new RevocationSnapshot();
    snap.apply({ seq: 1, asOf: aS, revoked: ["b"] });
    expect(await renovador({ actual, fetchImpl: conToken(nuevo), revocation: snap }).r.check()).toBe(false);
    const viejo = signLicense(testPayload({ jti: "c", expires_at: aS - 40 * DIA }, AHORA));
    expect(await renovador({ actual, fetchImpl: conToken(viejo) }).r.check()).toBe(false);
  });

  it("⛔ adopta el de OTRA org aunque no sea más nuevo: manda la org de la bvk_", async () => {
    const actual = verificada({ jti: "a", org_id: "org-ajena", expires_at: aS + 2 * DIA });
    const suyo = signLicense(testPayload({ jti: "b", org_id: "org-test", expires_at: aS + DIA }, AHORA));
    const { r, adoptadas } = renovador({ actual, fetchImpl: conToken(suyo) });
    expect(await r.check()).toBe(true);
    expect(adoptadas[0]!.payload.org_id).toBe("org-test");
  });

  it("⛔ con el actual REVOCADO adopta el reemitido aunque no sea más nuevo (así se cura)", async () => {
    const actual = verificada({ jti: "a", expires_at: aS + 30 * DIA });
    const snap = new RevocationSnapshot();
    snap.apply({ seq: 1, asOf: aS, revoked: ["a"] });
    const reemitido = signLicense(testPayload({ jti: "b", expires_at: aS + 20 * DIA }, AHORA));
    const { r } = renovador({ actual, fetchImpl: conToken(reemitido), revocation: snap });
    expect(await r.check()).toBe(true);
  });

  it("401 ×3 → un aviso; 404 → un aviso; inalcanzable → ninguno", async () => {
    const actual = verificada({ jti: "a", expires_at: aS + DIA });
    const c401 = renovador({ actual, fetchImpl: responde(401) });
    for (let i = 0; i < 3; i++) await c401.r.check({ force: true });
    expect(c401.avisos).toHaveLength(1);
    expect(c401.avisos[0]).toContain("no longer recognised");
    expect(c401.avisos[0]).toMatch(/^[\x20-\x7E]+$/);
    const c404 = renovador({ actual, fetchImpl: responde(404) });
    await c404.r.check({ force: true });
    await c404.r.check({ force: true });
    expect(c404.avisos).toHaveLength(1);
    expect(c404.avisos[0]).toContain("no active license");
    const red = renovador({
      actual,
      fetchImpl: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    await red.r.check({ force: true });
    expect(red.avisos).toHaveLength(0);
  });

  it("stop() durante una recogida en vuelo: el fetch recibe abort y no se adopta nada", async () => {
    const actual = verificada({ jti: "a", expires_at: aS + DIA });
    let señal: AbortSignal | undefined;
    let soltar: (r: Response) => void = () => {};
    const f = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          señal = init?.signal ?? undefined;
          soltar = resolve;
        }),
    );
    const { r, adoptadas } = renovador({ actual, fetchImpl: f });
    const p = r.check({ force: true });
    await new Promise((res) => setTimeout(res, 5));
    r.stop();
    expect(señal?.aborted).toBe(true);
    soltar(new Response(JSON.stringify({ token: signLicense(testPayload({ jti: "b", expires_at: aS + 30 * DIA }, AHORA)) })));
    expect(await p).toBe(false);
    expect(adoptadas).toHaveLength(0);
  });

  it("start({checkNow:true}) mira la red en el acto aunque falte mucho para la caducidad", async () => {
    const actual = verificada({ jti: "a", expires_at: aS + 300 * DIA });
    const f = responde(503);
    const { r } = renovador({ actual, fetchImpl: f });
    r.start({ checkNow: true });
    await new Promise((res) => setTimeout(res, 5));
    expect(llamadas(f)).toHaveLength(1);
    r.stop();
  });
});

describe("isSubscriptionTraffic — por marcas de protocolo, jamás por credenciales", () => {
  it("anthropic-beta oauth-* (en cualquier posición de la lista) → suscripción", () => {
    expect(isSubscriptionTraffic("/v1/messages", "oauth-2025-04-20,claude-code-20250219", "https://api.anthropic.com")).toBe(true);
    expect(isSubscriptionTraffic("/v1/messages", " x , oauth-2026-01-01", "https://api.anthropic.com")).toBe(true);
    expect(isSubscriptionTraffic("/v1/messages", "claude-code-20250219", "https://api.anthropic.com")).toBe(false);
    expect(isSubscriptionTraffic("/v1/messages", undefined, "https://api.anthropic.com")).toBe(false);
    expect(isSubscriptionTraffic("/v1/messages", "xoauth-1", "https://api.anthropic.com")).toBe(false);
  });

  it("el backend de ChatGPT, por ruta o por upstream → suscripción; la API de OpenAI no", () => {
    expect(isSubscriptionTraffic("/backend-api/codex/responses", undefined, "https://chatgpt.com")).toBe(true);
    expect(isSubscriptionTraffic("/v1/responses", undefined, "https://api.openai.com")).toBe(false);
    expect(isSubscriptionTraffic("/v1/responses", undefined, "https://chatgpt.com")).toBe(true);
  });

  it("la función no lee Authorization ni x-api-key (ni sabría: no las recibe)", () => {
    const fuente = readFileSync(fileURLToPath(new URL("../gateway/medidor.ts", import.meta.url)), "utf8");
    const cuerpo = fuente.slice(fuente.indexOf("export function isSubscriptionTraffic"));
    const funcion = cuerpo
      .slice(0, cuerpo.indexOf("\n}\n"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(funcion).toContain("anthropicBeta");
    expect(funcion).not.toMatch(/authorization|x-api-key/i);
  });
});

/**
 * LA COPIA QUE VIAJA EN NPM dice lo mismo que el código. Hermana de
 * apps/web/lib/readme-alineado.test.ts (que ata las cifras): aquí se ata la
 * promesa de la licencia, que es texto y no cifra. Sin esto, el README podía
 * seguir diciendo «nunca corta el tráfico» con un gateway que no arranca sin
 * licencia, y ningún test lo habría visto.
 */
describe("la copia que viaja en npm (README y guías de terminales)", () => {
  const leer = (ruta: string) => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), "utf8");
  const readme = leer("../README.md");
  const terminales = leer("../docs/terminales/README.md");

  it("el README dice que el gateway arranca sin claves (COMMUNITY), que solo corta las NUEVAS y que la suscripción no comisiona", () => {
    expect(readme).toMatch(/COMMUNITY\s+mode/);
    expect(readme).toMatch(/only\s+new\s+requests\s+are\s+refused/);
    expect(readme).toMatch(/never\s+carries\s+commission/);
    expect(readme).toMatch(/cache-write\s+TTL/);
  });

  it("⛔ las guías de terminales dicen modo Community, y no prometen reenviar sin clave", () => {
    expect(terminales).toMatch(/modo\s+Community/);
    expect(terminales).not.toMatch(/Nunca\s+corta\s+el\s+tráfico:\s+sin\s+clave/);
    expect(terminales).not.toMatch(/Sin ella: reenvía, NO mide/);
    expect(terminales).toMatch(/TTL\s+de\s+escritura\s+de\s+caché/);
  });

  it("⛔ la guía de Codex ya no dice que la suscripción «no se monetiza» cuando la licencia se paga igual", () => {
    const codex = leer("../docs/terminales/codex.md");
    expect(codex).not.toMatch(/NO monetizado|no se monetiza\*\*/);
    expect(codex).toMatch(/sin\s+comisión/);
  });
});

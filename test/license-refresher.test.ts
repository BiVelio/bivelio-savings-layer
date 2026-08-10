import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { LicenseRefresher } from "../src/license/refresher.js";
import { createSavingsLayer } from "../src/pipeline/create.js";
import { LicenseError } from "../src/license/errors.js";
import type { Provider } from "../src/providers/types.js";

/**
 * Renovación SIN entrega = muerte al día ~45 de cada ciclo. `invoice.paid`
 * emite un token nuevo y el viejo solo se supersede (muere en expires_at + 14
 * días de gracia), pero el SDK solo aceptaba un licenseKey estático y la única
 * recogida era humana (panel con sesión). Todo cliente mensual que no re-pegara
 * el token a mano perdía el servicio PAGANDO. El LicenseRefresher recoge el
 * token renovado con la clave de servicio, lo verifica contra la clave pública
 * y conmuta el gate sin reiniciar.
 */

const DAY = 86400;
const ISSUED = 1_800_000_000;
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const kp = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const kpAtacante = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function token(payload: Record<string, unknown>, privateKey = kp.privateKey): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

const base = {
  plan: "pro",
  seats: 1,
  features: ["semantic_cache"],
  grace_days: 14,
};
const VIEJO = token({ ...base, jti: "v", org_id: "org-1", issued_at: ISSUED, expires_at: ISSUED + 30 * DAY });
const NUEVO = token({ ...base, jti: "n", org_id: "org-1", issued_at: ISSUED + 30 * DAY, expires_at: ISSUED + 60 * DAY });

const respuestaConToken = (t: string) =>
  vi.fn(async () => ({ ok: true, json: async () => ({ token: t }) })) as unknown as typeof fetch;

function refresher(opts: {
  fetchImpl: typeof fetch;
  nowDay: number;
  onNewToken?: (t: string) => void;
  initialToken?: string;
}) {
  return new LicenseRefresher({
    url: "https://cp.test/api/license/current",
    serviceAccountKey: "bvk_test",
    publicKey: kp.publicKey,
    initialToken: opts.initialToken ?? VIEJO,
    onNewToken: opts.onNewToken ?? (() => {}),
    fetchImpl: opts.fetchImpl,
    now: () => (ISSUED + opts.nowDay * DAY) * 1000,
  });
}

describe("LicenseRefresher — la recogida del token renovado", () => {
  it("adopta un token más nuevo con firma válida", async () => {
    const onNew = vi.fn();
    const f = respuestaConToken(NUEVO);
    const r = refresher({ fetchImpl: f, nowDay: 40, onNewToken: onNew });
    expect(await r.checkNow()).toBe(true);
    expect(onNew).toHaveBeenCalledWith(NUEVO);
  });

  it("lejos de la caducidad NI llama a la red (no machaca el control plane)", async () => {
    const f = respuestaConToken(NUEVO);
    const r = refresher({ fetchImpl: f, nowDay: 1 });
    expect(await r.checkNow()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("una respuesta rancia (el MISMO token vigente) no se re-adopta", async () => {
    const onNew = vi.fn();
    const r = refresher({ fetchImpl: respuestaConToken(VIEJO), nowDay: 40, onNewToken: onNew });
    expect(await r.checkNow()).toBe(false);
    expect(onNew).not.toHaveBeenCalled();
  });

  it("rechaza un token de OTRA org (una bvk_ pegada en el sitio equivocado)", async () => {
    const otraOrg = token({ ...base, jti: "x", org_id: "org-AJENA", issued_at: ISSUED + 30 * DAY, expires_at: ISSUED + 60 * DAY });
    const onNew = vi.fn();
    const r = refresher({ fetchImpl: respuestaConToken(otraOrg), nowDay: 40, onNewToken: onNew });
    expect(await r.checkNow()).toBe(false);
    expect(onNew).not.toHaveBeenCalled();
  });

  it("rechaza una firma que no es de BiVelio (CP suplantado)", async () => {
    const falso = token(
      { ...base, jti: "f", org_id: "org-1", issued_at: ISSUED + 30 * DAY, expires_at: ISSUED + 99 * DAY },
      kpAtacante.privateKey,
    );
    const onNew = vi.fn();
    const r = refresher({ fetchImpl: respuestaConToken(falso), nowDay: 40, onNewToken: onNew });
    expect(await r.checkNow()).toBe(false);
    expect(onNew).not.toHaveBeenCalled();
  });

  it("un fallo de red no lanza, no adopta, y el vigente sigue mandando", async () => {
    const f = vi.fn(async () => {
      throw new Error("egress blocked");
    }) as unknown as typeof fetch;
    const r = refresher({ fetchImpl: f, nowDay: 40 });
    expect(await r.checkNow()).toBe(false);
  });

  it("monotónico: tras adoptar, el mismo token no se re-adopta en la siguiente vuelta", async () => {
    const onNew = vi.fn();
    const r = refresher({ fetchImpl: respuestaConToken(NUEVO), nowDay: 40, onNewToken: onNew });
    expect(await r.checkNow()).toBe(true);
    expect(await r.checkNow()).toBe(false);
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});

/**
 * Integración por la vía pública: la capa arranca con el token del ciclo
 * anterior (en gracia), el refresher recoge el renovado, y cuando la gracia del
 * viejo se agota la capa SIGUE funcionando — sin reiniciar y sin humanos.
 */
describe("createSavingsLayer + refresher — el cliente mensual no muere el día 45", () => {
  const proveedor: Provider = {
    id: "stub",
    generate: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 } }),
  };
  const respuesta = (extra: Record<string, unknown>) => ({
    ok: false,
    status: 503,
    headers: { get: () => null },
    json: async () => ({}),
    ...extra,
  });
  const fetchDelCP = vi.fn(async (url: string) => {
    if (String(url).includes("/api/license/current")) {
      return respuesta({ ok: true, status: 200, json: async () => ({ token: NUEVO }) });
    }
    return respuesta({}); // revocations → 503: el poller conserva su snapshot
  }) as unknown as typeof fetch;

  let devOpenGuardado: string | undefined;
  beforeEach(() => {
    devOpenGuardado = process.env.BVSALA_DEV_OPEN;
    delete process.env.BVSALA_DEV_OPEN; // el gate tiene que mandar de verdad
  });
  afterEach(() => {
    if (devOpenGuardado !== undefined) process.env.BVSALA_DEV_OPEN = devOpenGuardado;
  });

  const capaEn = (dia: number, reloj: { ahora: number }, conServiceAccount: boolean) => {
    reloj.ahora = (ISSUED + dia * DAY) * 1000;
    return createSavingsLayer({
      provider: proveedor,
      licenseKey: VIEJO,
      licensePublicKey: kp.publicKey,
      licenseServerUrl: "https://cp.test",
      ...(conServiceAccount ? { serviceAccountKey: "bvk_test" } : {}),
      metering: { enabled: false },
      licenseFetch: fetchDelCP,
      // La verja de frescura online no es lo que se prueba aquí; se abre para
      // que el veredicto dependa SOLO de la caducidad del token vigente.
      licenseRevocation: { maxStalenessSeconds: 365 * DAY },
      now: () => reloj.ahora,
    });
  };

  it("recoge el renovado en el arranque y sobrevive al fin de la gracia del viejo", async () => {
    const reloj = { ahora: 0 };
    const capa = capaEn(40, reloj, true); // día 40: el viejo está en gracia (30 + 14)
    try {
      // La comprobación inmediata del refresher es fire-and-forget: dale un tick.
      await vi.waitFor(async () => {
        reloj.ahora = (ISSUED + 46 * DAY) * 1000; // pasada la gracia del VIEJO
        await capa.generate({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "ping" }],
        });
      });
    } finally {
      capa.close();
    }
  });

  it("control: SIN clave de servicio no hay recogida y el día 46 muere (el hueco que esto cierra)", async () => {
    const reloj = { ahora: 0 };
    const capa = capaEn(40, reloj, false);
    try {
      await new Promise((r) => setTimeout(r, 20));
      reloj.ahora = (ISSUED + 46 * DAY) * 1000;
      await expect(
        capa.generate({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
      ).rejects.toThrow(LicenseError);
    } finally {
      capa.close();
    }
  });
});

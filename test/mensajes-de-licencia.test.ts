import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";

import { mensajeDeLicencia } from "../src/pipeline/pipeline.js";
import { createSavingsLayer, createMockProvider, LicenseError } from "../src/index.js";
import { liveGateFromKey } from "../src/license/live-gate.js";
import { UsageEmitter } from "../src/metering/emitter.js";
import { reiniciarAvisos } from "../src/util/warn-once.js";
import type { SavingsReport } from "../src/contracts/types.js";

/**
 * Los mensajes que se lleva el cliente cuando algo se para.
 *
 * Es el texto más importante del producto: es lo ÚNICO que ve alguien a quien el
 * SDK acaba de dejar de funcionar, y decide si va al sitio correcto o pierde una
 * tarde. Había uno solo para todos los casos —«license is not active (X). Renew
 * your subscription»— así que a tres personas con tres problemas distintos, dos
 * de ellos a un copiar-y-pegar de la solución, se les mandaba a pagar.
 */

describe("el mensaje manda a la acción correcta", () => {
  it("clave mal pegada: NO se le manda a pagar", () => {
    const m = mensajeDeLicencia("invalid");
    expect(m).not.toMatch(/renew/i);
    expect(m).not.toMatch(/subscription/i);
    // Lo que sí tiene que decir: revisa la clave, y ojo con confundirla con la bvk_.
    expect(m).toMatch(/whole key/i);
    expect(m).toMatch(/bvk_/);
    expect(m).toMatch(/serviceAccountKey/);
  });

  it("salida de red bloqueada: se dice que la licencia SIGUE SIENDO VÁLIDA", () => {
    const m = mensajeDeLicencia("stale");
    expect(m).not.toMatch(/renew/i);
    expect(m).toMatch(/still valid/i);
    expect(m).toMatch(/connectivity/i);
    expect(m).toMatch(/licenseServerUrl/);
  });

  it("revocada: al estado de facturación y a soporte, no a renovar", () => {
    const m = mensajeDeLicencia("revoked");
    expect(m).toMatch(/revoked/i);
    expect(m).toMatch(/support@bivelio\.com/);
    expect(m).not.toMatch(/renew/i);
  });

  it("caducada o en gracia: AHÍ sí, renovar", () => {
    for (const st of ["expired", "grace"] as const) {
      expect(mensajeDeLicencia(st)).toMatch(/renew your subscription/i);
    }
  });

  it("sin estado no inventa un diagnóstico", () => {
    const m = mensajeDeLicencia(undefined);
    expect(m).toMatch(/not active/i);
    expect(m).not.toMatch(/renew/i);
  });
});

/**
 * LA OTRA MITAD DEL MENSAJE MÁS LEÍDO DEL PRODUCTO.
 *
 * `test/sala-limpia-del-tarball.test.ts` comprueba el contexto PUBLICADO: allí el
 * mensaje no puede nombrar `devUnlicensed` porque está tapiado. Aquí se comprueba
 * el contexto FUENTE, donde sí funciona y tiene que seguir funcionando: tests,
 * banco y ejemplos del repo dependen de él, y un mensaje que no lo nombrara
 * mandaría a quien desarrolla sobre el repo a buscar una licencia que no
 * necesita. Un mensaje solo es correcto si lo es en los DOS.
 */
describe("el mensaje de «no hay licencia» es correcto en el contexto FUENTE", () => {
  it("nombra la puerta que aquí SÍ abre, y dice que solo vale aquí", () => {
    const m = mensajeDeLicencia("none");
    expect(m).toMatch(/devUnlicensed/);
    // Y no la vende como una forma de usar el producto: dice dónde NO vale.
    expect(m).toMatch(/never in the published npm package/i);
  });

  it("«no configuraste nada» y «un gate devolvió algo raro» son mensajes distintos", () => {
    // Antes los dos caían en la misma rama por defecto, con `status` undefined:
    // dos problemas con arreglos opuestos y una sola pista.
    expect(mensajeDeLicencia("none")).not.toBe(mensajeDeLicencia(undefined));
    expect(mensajeDeLicencia("none")).toMatch(/license status: none/);
  });

  it("manda a la página que resuelve, no a la portada de venta", () => {
    const enlaces = mensajeDeLicencia("none").match(/https:\/\/savings\.bivelio\.com[^\s)]*/g) ?? [];
    expect(enlaces).toContain("https://savings.bivelio.com/dashboard/install");
    expect(enlaces.filter((u) => !/savings\.bivelio\.com\/\w/.test(u))).toEqual([]);
  });

  it("sin clave ya no es un error: corre el modo Community, y una clave inválida sigue trayendo estado", async () => {
    // Open core: sin `licenseKey` la capa corre con el gate comunitario. La
    // suite corre dev-open (vitest.config.ts); aquí se cierra la puerta para
    // ver el camino real, y se restaura.
    const guardado = process.env.BVSALA_DEV_OPEN;
    delete process.env.BVSALA_DEV_OPEN;
    try {
      const capa = createSavingsLayer({ provider: createMockProvider({ answer: "x" }) });
      const res = await capa.generate({ model: "m", messages: [{ role: "user", content: "hola" }] });
      expect(res.report.requestId).toBeTruthy();
      // El fail-closed que queda es el de la clave PRESENTE pero inválida: el
      // asidero estable para ramificar en código del cliente.
      const conClaveMala = createSavingsLayer({
        provider: createMockProvider({ answer: "x" }),
        licenseKey: "no-es-una-clave",
      });
      const err = await conClaveMala
        .generate({ model: "m", messages: [{ role: "user", content: "hola" }] })
        .then(() => null)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LicenseError);
      expect(["invalid", "none"]).toContain((err as LicenseError).status);
    } finally {
      if (guardado !== undefined) process.env.BVSALA_DEV_OPEN = guardado;
    }
  });
});

describe("frescura vencida NO es caducidad", () => {
  const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const ahora = Math.floor(Date.now() / 1000);
  /** Una licencia PAGADA Y VIGENTE: caduca dentro de 30 días. */
  function licenciaVigente(): string {
    const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
    const body = b64url(
      JSON.stringify({
        jti: "lic_viva",
        org_id: "org1",
        plan: "pro",
        seats: 1,
        features: [],
        issued_at: ahora,
        expires_at: ahora + 30 * 86400,
        grace_days: 21,
      }),
    );
    const sig = sign(null, Buffer.from(`${head}.${body}`), privateKey);
    return `${head}.${body}.${b64url(sig)}`;
  }
  const sinRevocaciones = { snapshot: () => new Set<string>(), lastContactAt: 0 } as never;

  it("con contacto reciente, la licencia vigente está ACTIVA", () => {
    const gate = liveGateFromKey(licenciaVigente(), publicKey, {
      revocation: { snapshot: () => new Set<string>(), lastContactAt: ahora } as never,
      maxStalenessSeconds: 3600,
      startedAt: ahora,
    });
    expect(gate.status()).toBe("active");
  });

  it("sin contacto durante más de la ventana: 'stale', NUNCA 'expired'", () => {
    // Este es el caso: el cliente PAGA, su licencia caduca dentro de 30 días, y
    // lo único que le pasa es que tiene la salida de red cerrada. Decirle
    // "expired" le manda a renovar lo que ya tiene pagado.
    const gate = liveGateFromKey(licenciaVigente(), publicKey, {
      revocation: sinRevocaciones,
      maxStalenessSeconds: 3600,
      startedAt: ahora - 7200, // arrancó hace 2 h, sin un solo contacto
    });
    expect(gate.status()).toBe("stale");
    expect(gate.status()).not.toBe("expired");
  });

  it("y sigue siendo fail-closed: 'stale' NO concede", () => {
    // El comportamiento no cambia; lo que cambia es lo que se le dice al cliente.
    const gate = liveGateFromKey(licenciaVigente(), publicKey, {
      revocation: sinRevocaciones,
      maxStalenessSeconds: 3600,
      startedAt: ahora - 7200,
    });
    expect(gate.isActive()).toBe(false);
  });

  it("el mensaje de ese estado dice que la licencia sigue valiendo", () => {
    const gate = liveGateFromKey(licenciaVigente(), publicKey, {
      revocation: sinRevocaciones,
      maxStalenessSeconds: 3600,
      startedAt: ahora - 7200,
    });
    const m = mensajeDeLicencia(gate.status());
    expect(m).toMatch(/still valid/i);
    expect(m).not.toMatch(/renew/i);
  });
});

function informe(): SavingsReport {
  return {
    requestId: "req-1",
    model: "openai/gpt-4o-mini",
    calls: { avoidedLlm: 0, actualLlm: 1 },
    tokens: {
      baselineInput: 10,
      actualInput: 10,
      eliminatedInput: 0,
      compressedInput: 0,
      baselineOutput: 5,
      actualOutput: 5,
    },
    cache: { result: "miss" },
    cost: { baselineEstimate: 0.001, actual: 0.001, netSavingsRatio: 0 },
  } as unknown as SavingsReport;
}

describe("una clave de servicio rechazada deja de ser silenciosa", () => {
  afterEach(() => {
    reiniciarAvisos();
    vi.restoreAllMocks();
  });

  for (const status of [401, 403]) {
    it(`avisa y llama a onAuthError ante un ${status}`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const vistos: number[] = [];
      const emitter = new UsageEmitter({
        url: "https://savings.bivelio.com/api/metering/usage",
        serviceAccountKey: "bvk_rotada",
        flushIntervalMs: 0,
        onAuthError: (s) => vistos.push(s),
        fetchImpl: (() => Promise.resolve({ ok: false, status } as Response)) as unknown as typeof fetch,
      });
      emitter.record(informe());
      await emitter.flush();

      expect(vistos).toEqual([status]);
      expect(warn).toHaveBeenCalledTimes(1);
      const texto = String(warn.mock.calls[0]?.[0] ?? "");
      // Tiene que apuntar a la causa (la clave) y a lo que se pierde mientras.
      expect(texto).toMatch(/serviceAccountKey/);
      expect(texto).toMatch(/billable seats/i);
      emitter.stop();
    });
  }

  it("no repite el aviso en cada lote: uno por proceso", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emitter = new UsageEmitter({
      url: "https://savings.bivelio.com/api/metering/usage",
      serviceAccountKey: "bvk_rotada",
      flushIntervalMs: 0,
      fetchImpl: (() => Promise.resolve({ ok: false, status: 401 } as Response)) as unknown as typeof fetch,
    });
    for (let i = 0; i < 4; i++) {
      emitter.record(informe());
      await emitter.flush();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    emitter.stop();
  });

  it("un 5xx NO dispara el aviso de credencial: eso sí se cura solo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vistos: number[] = [];
    const emitter = new UsageEmitter({
      url: "https://savings.bivelio.com/api/metering/usage",
      serviceAccountKey: "bvk_buena",
      flushIntervalMs: 0,
      onAuthError: (s) => vistos.push(s),
      fetchImpl: (() => Promise.resolve({ ok: false, status: 503 } as Response)) as unknown as typeof fetch,
    });
    emitter.record(informe());
    await emitter.flush();
    expect(vistos).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    emitter.stop();
  });
});

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

import {
  createSavingsLayer,
  createMockProvider,
  LicenseError,
} from "../src/index.js";
import { gateFromKey, resolveLicense, verifyCompactSignature, normalizeLicenseKey, licenseKeyShape } from "../src/license/index.js";
import { LicenseRefresher } from "../src/license/refresher.js";
import { mensajeDeLicencia } from "../src/pipeline/pipeline.js";

/**
 * Una clave de licencia CORRECTA con envoltorio alrededor no es una clave
 * incorrecta.
 *
 * Reproducido en la verificación de la 0.4.20 sobre `gateFromKey` con un par
 * Ed25519 propio: `tok` → active; `tok + "\n"` → invalid; `" " + tok` → invalid;
 * y, de forma inconsistente, `tok + "\r\n"` → active (porque `atob` ignora el
 * espacio en blanco y dos caracteres de más dan el mismo resto módulo 4 que
 * cero). El README manda `export BIVELIO_LICENSE_KEY=…` y dotenv recorta, así
 * que por esa vía nunca se vio; pero quien lee la clave de un fichero
 * (`readFileSync`, un secreto de Docker o Kubernetes montado con su salto de
 * línea final) recibía «does not verify. Check you pasted the WHOLE key…» con
 * una clave buena: el diagnóstico equivocado, que manda a mirar donde no está
 * el problema.
 *
 * Y una clave que ni siquiera tiene FORMA de token (la `bvk_` de servicio
 * pegada donde va la licencia, un texto cualquiera) recibía el mismo texto que
 * una firma inválida, cuando no se había verificado nada.
 *
 * Lo que NO se afloja, y se comprueba abajo: una firma inválida sigue siendo
 * `invalid`, y un espacio INTERIOR no se recorta.
 */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const ahora = Math.floor(Date.now() / 1000);

function firmar(payload: Record<string, unknown>): string {
  const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "BVL", v: 1 }));
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(`${head}.${body}`), privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

/** Una licencia vigente: caduca dentro de una hora. */
const tok = firmar({
  jti: "lic_norm",
  org_id: "org1",
  plan: "pro",
  seats: 1,
  features: ["semantic_cache"],
  issued_at: ahora,
  expires_at: ahora + 3600,
  grace_days: 7,
});

/** El mismo token con la firma tocada: tiene FORMA, pero no verifica. */
const tokManipulado = `${tok.slice(0, -6)}AAAAAA`;

/** El mismo token con un espacio en medio: NO es envoltorio, es una clave rota. */
const tokConEspacioInterior = `${tok.slice(0, 20)} ${tok.slice(20)}`;

describe("normalizeLicenseKey quita SOLO el envoltorio exterior", () => {
  it.each([
    ["salto de línea final (readFileSync)", `${tok}\n`],
    ["CRLF final (fichero de Windows)", `${tok}\r\n`],
    ["espacio delante", ` ${tok}`],
    ["espacios a ambos lados", `  ${tok}  `],
    ["comillas dobles", `"${tok}"`],
    ["comillas simples", `'${tok}'`],
    ["prefijo Bearer", `Bearer ${tok}`],
    ["prefijo bearer en minúsculas", `bearer ${tok}`],
    ["prefijo BEARER en mayúsculas", `BEARER ${tok}`],
    ["comillas alrededor de Bearer y salto de línea", `"Bearer ${tok}"\n`],
  ])("%s → el token limpio", (_nombre, envuelta) => {
    expect(normalizeLicenseKey(envuelta)).toBe(tok);
  });

  it("un espacio INTERIOR no se toca: no es envoltorio", () => {
    expect(normalizeLicenseKey(tokConEspacioInterior)).toBe(tokConEspacioInterior);
  });

  it("solo espacio en blanco queda vacío", () => {
    expect(normalizeLicenseKey("   ")).toBe("");
    expect(normalizeLicenseKey("\n")).toBe("");
    expect(normalizeLicenseKey('""')).toBe("");
  });
});

describe("licenseKeyShape distingue vacía, sin forma y token", () => {
  it("vacía", () => {
    expect(licenseKeyShape("")).toBe("empty");
  });

  it.each([
    ["la bvk_ de servicio pegada donde va la licencia", "bvk_abc"],
    ["un texto con puntos pero sin tres segmentos base64url", "bvl.esto-no-es-un-token"],
    ["un token con un espacio en medio", tokConEspacioInterior],
    ["dos segmentos", tok.slice(0, tok.lastIndexOf("."))],
    ["cuatro segmentos", `${tok}.extra`],
    ["base64 estándar con relleno", "aGk=.aGk=.aGk="],
  ])("%s → malformed", (_nombre, clave) => {
    expect(licenseKeyShape(clave)).toBe("malformed");
  });

  it("un token bien formado tiene forma aunque la firma no verifique", () => {
    expect(licenseKeyShape(tok)).toBe("token");
    expect(licenseKeyShape(tokManipulado)).toBe("token");
  });
});

describe("gateFromKey: la clave correcta con envoltorio ABRE", () => {
  it.each([
    ["tok + '\\n'", `${tok}\n`],
    ["tok + '\\r\\n'", `${tok}\r\n`],
    ["' ' + tok", ` ${tok}`],
    ['"tok"', `"${tok}"`],
    ["'tok'", `'${tok}'`],
    ["'Bearer ' + tok", `Bearer ${tok}`],
  ])("%s → active", (_nombre, clave) => {
    const gate = gateFromKey(clave, publicKey);
    expect(gate.status()).toBe("active");
    expect(gate.isActive()).toBe(true);
    expect(gate.isEntitled("semantic_cache")).toBe(true);
    expect(gate.reason()).toBeUndefined();
  });

  it("control: el token tal cual sigue abriendo", () => {
    expect(gateFromKey(tok, publicKey).status()).toBe("active");
  });
});

describe("gateFromKey: lo que NO se afloja", () => {
  it.each([
    ["'bvl.esto-no-es-un-token'", "bvl.esto-no-es-un-token"],
    ["'bvk_abc' (la clave de servicio en el sitio de la licencia)", "bvk_abc"],
    ["tok con un espacio en medio", tokConEspacioInterior],
  ])("%s → invalid, y la razón es que no tiene forma de token", (_nombre, clave) => {
    const gate = gateFromKey(clave, publicKey);
    expect(gate.status()).toBe("invalid");
    expect(gate.isActive()).toBe(false);
    expect(gate.isEntitled("semantic_cache")).toBe(false);
    expect(gate.reason()).toBe("malformed");
  });

  it("una firma inválida sigue siendo invalid, y la razón NO es «malformed»", () => {
    const gate = gateFromKey(tokManipulado, publicKey);
    expect(gate.status()).toBe("invalid");
    expect(gate.isActive()).toBe(false);
    expect(gate.reason()).toBeDefined();
    expect(gate.reason()).not.toBe("malformed");
  });

  it("una firma inválida CON envoltorio sigue siendo invalid (normalizar no verifica)", () => {
    expect(gateFromKey(`${tokManipulado}\n`, publicKey).status()).toBe("invalid");
    expect(gateFromKey(`Bearer ${tokManipulado}`, publicKey).status()).toBe("invalid");
  });

  it("'   ' → none: no hay clave, no una clave que no verifica", () => {
    for (const vacia of ["   ", "", "\n", '""']) {
      const gate = gateFromKey(vacia, publicKey);
      expect(gate.status()).toBe("none");
      expect(gate.isActive()).toBe(false);
      expect(gate.reason()).toBe("empty");
    }
  });
});

describe("el primitivo compartido da la misma respuesta a la misma entrada", () => {
  it("un token con CRLF detrás NO verifica sin normalizar (antes sí, por la tolerancia de atob)", () => {
    // Era la inconsistencia: `tok + "\n"` fallaba y `tok + "\r\n"` pasaba.
    // Quien tolere envoltorio normaliza ANTES; el verificador es estricto.
    expect(verifyCompactSignature(`${tok}\r\n`, publicKey)).toMatchObject({
      ok: false,
      reason: "malformed token",
    });
    expect(verifyCompactSignature(`${tok}\n`, publicKey).ok).toBe(false);
    expect(verifyCompactSignature(tok, publicKey).ok).toBe(true);
  });

  it("resolveLicense (entrada pública) normaliza como el gate", () => {
    expect(resolveLicense(`${tok}\n`, publicKey).status).toBe("active");
    expect(resolveLicense(`Bearer ${tok}`, publicKey).status).toBe("active");
    expect(resolveLicense("   ", publicKey).status).toBe("none");
    expect(resolveLicense("bvk_abc", publicKey).status).toBe("invalid");
    expect(resolveLicense(tokManipulado, publicKey).status).toBe("invalid");
  });
});

describe("el mensaje apunta al diagnóstico correcto", () => {
  it("sin forma de token: dice «malformed», qué aspecto tiene una clave, y lo de la bvk_", () => {
    const m = mensajeDeLicencia("invalid", "malformed");
    expect(m).toMatch(/malformed/i);
    expect(m).toMatch(/looks like/i);
    expect(m).toMatch(/bvk_/);
    expect(m).toMatch(/serviceAccountKey/);
    // Y NO dice que no verifica: no se verificó nada.
    expect(m).not.toMatch(/does not verify/i);
    // Ni manda a pagar.
    expect(m).not.toMatch(/renew/i);
    expect(m).not.toMatch(/subscription/i);
    // El asidero estable sigue siendo el mismo estado.
    expect(m).toMatch(/license status: invalid/);
  });

  it("con forma pero sin firma válida: el texto de siempre, «does not verify»", () => {
    for (const reason of ["bad signature", undefined]) {
      const m = mensajeDeLicencia("invalid", reason);
      expect(m).toMatch(/does not verify/i);
      expect(m).toMatch(/whole key/i);
      expect(m).not.toMatch(/malformed/i);
    }
  });
});

/**
 * De punta a punta por la vía pública: `createSavingsLayer({ licenseKey })`.
 * La suite corre dev-open (vitest.config.ts); aquí se cierra la puerta para ver
 * la verja real, y se restaura.
 */
describe("createSavingsLayer con la clave leída de un fichero", () => {
  let devOpenGuardado: string | undefined;
  beforeAll(() => {
    devOpenGuardado = process.env.BVSALA_DEV_OPEN;
    delete process.env.BVSALA_DEV_OPEN;
  });
  afterAll(() => {
    if (devOpenGuardado !== undefined) process.env.BVSALA_DEV_OPEN = devOpenGuardado;
  });

  const peticion = { model: "m", messages: [{ role: "user" as const, content: "hola" }] };
  const capa = (licenseKey: string) =>
    createSavingsLayer({
      provider: createMockProvider({ answer: "ok" }),
      licenseKey,
      licensePublicKey: publicKey,
    });

  const errorDe = async (licenseKey: string): Promise<LicenseError> => {
    const err = await capa(licenseKey)
      .generate(peticion)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LicenseError);
    return err as LicenseError;
  };

  it("licenseKey: tok + '\\n' → generate() funciona", async () => {
    const res = await capa(`${tok}\n`).generate(peticion);
    expect(res.text).toBe("ok");
  });

  it("licenseKey: 'Bearer ' + tok → generate() funciona", async () => {
    const res = await capa(`Bearer ${tok}`).generate(peticion);
    expect(res.text).toBe("ok");
  });

  it("licenseKey: 'bvk_abc' → invalid con el mensaje «malformed», no «does not verify»", async () => {
    const err = await errorDe("bvk_abc");
    expect(err.status).toBe("invalid");
    expect(err.message).toMatch(/malformed/i);
    expect(err.message).toMatch(/bvk_/);
    expect(err.message).not.toMatch(/does not verify/i);
  });

  it("licenseKey: firma inválida → invalid con «does not verify» (no se afloja)", async () => {
    const err = await errorDe(tokManipulado);
    expect(err.status).toBe("invalid");
    expect(err.message).toMatch(/does not verify/i);
  });

  it("licenseKey: '   ' → none, con el mensaje de «none was configured»", async () => {
    const err = await errorDe("   ");
    expect(err.status).toBe("none");
    expect(err.message).toMatch(/none was configured/i);
    expect(err.message).toMatch(/license status: none/);
  });
});

/**
 * El refresher recibe el token inicial (la `licenseKey` tal cual) y tokens por
 * red: los dos se normalizan igual que en el gate.
 */
describe("LicenseRefresher normaliza el token inicial y el recibido por red", () => {
  const DIA = 86400;
  const ISSUED = 1_800_000_000;
  const base = { plan: "pro", seats: 1, features: ["semantic_cache"], grace_days: 14 };
  const VIEJO = firmar({ ...base, jti: "v", org_id: "org-1", issued_at: ISSUED, expires_at: ISSUED + 30 * DIA });
  const NUEVO = firmar({ ...base, jti: "n", org_id: "org-1", issued_at: ISSUED + 30 * DIA, expires_at: ISSUED + 60 * DIA });

  const respuestaConToken = (t: string) =>
    vi.fn(async () => ({ ok: true, json: async () => ({ token: t }) })) as unknown as typeof fetch;

  it("un token inicial con '\\n' fija el expiry: lejos de la caducidad NI llama a la red", async () => {
    // Sin normalizar, el inicial no verificaba, `currentExpiresAt` quedaba en 0
    // y el refresher salía a buscar renovación desde el primer segundo.
    const f = respuestaConToken(NUEVO);
    const r = new LicenseRefresher({
      url: "https://cp.test/api/license/current",
      serviceAccountKey: "bvk_test",
      publicKey,
      initialToken: `${VIEJO}\n`,
      onNewToken: () => {},
      fetchImpl: f,
      now: () => (ISSUED + 1 * DIA) * 1000, // día 1 de 30: a 29 días de caducar
    });
    expect(await r.checkNow()).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("un token renovado que llega con '\\n' se adopta, y se entrega LIMPIO", async () => {
    const adoptados: string[] = [];
    const r = new LicenseRefresher({
      url: "https://cp.test/api/license/current",
      serviceAccountKey: "bvk_test",
      publicKey,
      initialToken: VIEJO,
      onNewToken: (t) => adoptados.push(t),
      fetchImpl: respuestaConToken(`${NUEVO}\n`),
      now: () => (ISSUED + 28 * DIA) * 1000, // dentro de la antelación de 7 días
    });
    expect(await r.checkNow()).toBe(true);
    expect(adoptados).toEqual([NUEVO]);
  });
});

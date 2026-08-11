import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

/**
 * La sonda de la pareja de claves.
 *
 * Vigila el fallo más silencioso del producto: si la privada de este despliegue deja
 * de ser pareja de la pública que los SDK llevan incrustada, la emisión de licencias
 * sigue funcionando sin un solo error y son TODOS los clientes los que se apagan a la
 * vez, cada uno en su infraestructura.
 *
 * Los pares se generan aquí: la privada real NO está commiteada (y no debe estarlo),
 * así que un test que dependiera de ella pasaría en mi portátil y fallaría en CI.
 */
function par() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publica: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privada: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const bueno = par();
const otro = par();

// La constante "lado SDK" se sustituye por la pública del par `bueno`; el resto del
// módulo (cuerpoDelPem) se conserva de verdad.
vi.mock("@/lib/license/clave-esperada", async () => {
  const real = await vi.importActual<typeof import("@/lib/license/clave-esperada")>(
    "@/lib/license/clave-esperada",
  );
  return { ...real, CLAVE_PUBLICA_DEL_SDK: bueno.publica };
});

const enB64 = (pem: string) => Buffer.from(pem, "utf8").toString("base64");

async function sonda() {
  vi.resetModules();
  const { GET } = await import("./health/signing/route.js");
  const res = await GET();
  return { status: res.status, cuerpo: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/health/signing — la pareja de claves", () => {
  const previo = process.env.LICENSE_PRIVATE_KEY_B64;
  beforeEach(() => {
    delete process.env.LICENSE_PRIVATE_KEY_B64;
    delete process.env.LICENSE_PRIVATE_KEY;
  });
  afterEach(() => {
    if (previo === undefined) delete process.env.LICENSE_PRIVATE_KEY_B64;
    else process.env.LICENSE_PRIVATE_KEY_B64 = previo;
  });

  it("200 cuando la privada del despliegue ES pareja de la pública del SDK", async () => {
    process.env.LICENSE_PRIVATE_KEY_B64 = enB64(bueno.privada);
    const { status, cuerpo } = await sonda();
    expect(status).toBe(200);
    expect(cuerpo.ok).toBe(true);
  });

  // EL CASO QUE JUSTIFICA TODO: una rotación a medias, o la variable de otro entorno.
  it("503 cuando la privada es de OTRO par: hoy esto no lo detectaba nadie", async () => {
    process.env.LICENSE_PRIVATE_KEY_B64 = enB64(otro.privada);
    const { status, cuerpo } = await sonda();
    expect(status).toBe(503);
    expect(cuerpo.motivo).toBe("par_de_claves_distinto");
  });

  it("503 y motivo propio cuando no hay clave puesta en el despliegue", async () => {
    const { status, cuerpo } = await sonda();
    expect(status).toBe(503);
    expect(cuerpo.motivo).toBe("sin_clave_privada");
  });

  it("503 cuando la clave está puesta pero es ilegible (saltos de línea perdidos al copiarla)", async () => {
    process.env.LICENSE_PRIVATE_KEY_B64 = enB64("-----BEGIN PRIVATE KEY-----no-es-una-clave-----END PRIVATE KEY-----");
    const { status, cuerpo } = await sonda();
    expect(status).toBe(503);
    expect(cuerpo.motivo).toBe("clave_privada_ilegible");
  });

  it("no filtra NADA de la clave privada en ninguna respuesta", async () => {
    for (const valor of [enB64(bueno.privada), enB64(otro.privada)]) {
      process.env.LICENSE_PRIVATE_KEY_B64 = valor;
      const { cuerpo } = await sonda();
      const texto = JSON.stringify(cuerpo);
      expect(texto).not.toContain("PRIVATE KEY");
      expect(texto).not.toContain(valor);
      // Ni el cuerpo del PEM privado, en crudo ni troceado.
      const cuerpoPrivado = bueno.privada.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
      expect(texto).not.toContain(cuerpoPrivado.slice(0, 24));
    }
  });

  it("no se cachea: una sonda cacheada mediría el pasado", async () => {
    process.env.LICENSE_PRIVATE_KEY_B64 = enB64(bueno.privada);
    vi.resetModules();
    const { GET } = await import("./health/signing/route.js");
    const res = await GET();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});

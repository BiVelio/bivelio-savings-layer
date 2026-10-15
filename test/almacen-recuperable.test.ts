import { createHash, createHmac, randomBytes } from "node:crypto";

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  AlmacenRecuperableEnMemoria,
  corteUtf8,
  type AmbitoRecuperable,
  type DepositoDeBytes,
  type LecturaRecuperable,
  type PaginaRecuperable,
} from "../src/retrieval/almacen-recuperable.js";
import { hmacSha256, sha256DeBytes } from "../src/util/hash.js";

/**
 * D04 · el almacén del modo recuperable, solo en memoria.
 *
 * Los oráculos no salen del módulo: los bytes se comparan con lo que se guardó,
 * las huellas con `node:crypto`, y «indistinguible» quiere decir el MISMO
 * objeto de fallo que recibe un handle inventado.
 */

const ambito: AmbitoRecuperable = {
  tenantId: "acme",
  projectId: "facturacion",
  sessionId: "ses-1",
  branchId: "main",
  epoch: 0,
};
const POLITICA = "pol-v1";
const utf8 = new TextEncoder();
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function reloj(inicio = 1_000_000) {
  let t = inicio;
  return { now: () => t, avanzar: (ms: number) => (t += ms) };
}

function esPagina(r: LecturaRecuperable): asserts r is PaginaRecuperable {
  if (!r.ok) throw new Error(`se esperaba página, llegó ${r.error}`);
}

async function guardar(
  almacen: AlmacenRecuperableEnMemoria,
  bytes: Uint8Array,
  extra: { ttlMs?: number; pinUntil?: number; en?: AmbitoRecuperable } = {},
): Promise<string> {
  const r = await almacen.put(extra.en ?? ambito, bytes, {
    policyFingerprint: POLITICA,
    contentType: "text/plain; charset=utf-8",
    ...(extra.ttlMs !== undefined ? { ttlMs: extra.ttlMs } : {}),
    ...(extra.pinUntil !== undefined ? { pinUntil: extra.pinUntil } : {}),
  });
  if (!r.ok) throw new Error(`put falló: ${r.error}`);
  return r.handle;
}

/** Lee el objeto entero página a página y devuelve las páginas. */
async function leerTodo(
  almacen: AlmacenRecuperableEnMemoria,
  handle: string,
  maxBytes: number,
  en: AmbitoRecuperable = ambito,
): Promise<PaginaRecuperable[]> {
  const paginas: PaginaRecuperable[] = [];
  let cursor: string | undefined;
  for (let vueltas = 0; vueltas < 100_000; vueltas++) {
    const r = await almacen.get(en, handle, {
      policyFingerprint: POLITICA,
      maxBytes,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    esPagina(r);
    paginas.push(r);
    if (r.nextCursor === null) return paginas;
    cursor = r.nextCursor;
  }
  throw new Error("la paginación no termina");
}

const unir = (paginas: PaginaRecuperable[]) => {
  const total = paginas.reduce((n, p) => n + p.bytes.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of paginas) {
    out.set(p.bytes, o);
    o += p.bytes.length;
  }
  return out;
};

afterEach(() => vi.restoreAllMocks());

describe("almacén recuperable: devuelve el original exacto", () => {
  // ñ (2 bytes), € (3), 𝄞 (4), 👩‍💻 (secuencia con ZWJ): hay cortes posibles dentro de todos.
  const texto = "Factura nº 0042 — total 1.234,56 € 𝄞 revisado por 👩‍💻 «ñandú»\n".repeat(7);
  const bytes = utf8.encode(texto);

  it("put informa la sha256 real y el tamaño en bytes, no en caracteres", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    const r = await almacen.put(ambito, bytes, { policyFingerprint: POLITICA, contentType: "text/plain" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sha256).toBe(hex(bytes));
    expect(r.size).toBe(bytes.length);
    expect(r.size).toBeGreaterThan(texto.length);
  });

  it.each([4, 5, 6, 7, 9, 13, 64, 1 << 20])(
    "páginas de %i bytes: ninguna parte un carácter y juntas son los bytes guardados",
    async (maxBytes) => {
      const almacen = new AlmacenRecuperableEnMemoria();
      const handle = await guardar(almacen, bytes);
      const paginas = await leerTodo(almacen, handle, maxBytes);
      const estricto = new TextDecoder("utf-8", { fatal: true });
      let esperado = 0;
      for (const p of paginas) {
        expect(p.offset).toBe(esperado);
        expect(p.bytes.length).toBeGreaterThan(0);
        expect(p.bytes.length).toBeLessThanOrEqual(maxBytes);
        // Cada página por separado es UTF-8 válido: el corte cayó entre caracteres.
        expect(() => estricto.decode(p.bytes)).not.toThrow();
        expect(p.sha256).toBe(hex(bytes));
        expect(p.size).toBe(bytes.length);
        esperado += p.bytes.length;
      }
      const junto = unir(paginas);
      expect(Buffer.from(junto).equals(Buffer.from(bytes))).toBe(true);
      expect(new TextDecoder().decode(junto)).toBe(texto);
      if (maxBytes < bytes.length) expect(paginas.length).toBeGreaterThan(1);
    },
  );

  it("bytes que no son UTF-8 también vuelven exactos (el corte nunca deja una página vacía)", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    // Una racha larga de bytes de continuación: no hay byte inicial al que retroceder.
    const binario = new Uint8Array([...randomBytes(300), ...new Array(40).fill(0x80), ...randomBytes(300)]);
    const handle = await guardar(almacen, binario);
    for (const maxBytes of [4, 5, 17]) {
      const paginas = await leerTodo(almacen, handle, maxBytes);
      expect(paginas.every((p) => p.bytes.length > 0)).toBe(true);
      expect(Buffer.from(unir(paginas)).equals(Buffer.from(binario))).toBe(true);
    }
  });

  it("corteUtf8 retrocede justo hasta el inicio del carácter", () => {
    const b = utf8.encode("a𝄞b"); // 61 F0 9D 84 9E 62
    expect(corteUtf8(b, 0, 1)).toBe(1); // entre 'a' y 𝄞
    expect(corteUtf8(b, 0, 2)).toBe(1);
    expect(corteUtf8(b, 0, 3)).toBe(1);
    expect(corteUtf8(b, 0, 4)).toBe(1);
    expect(corteUtf8(b, 0, 5)).toBe(5); // entre 𝄞 y 'b'
    expect(corteUtf8(b, 0, 99)).toBe(6);
  });

  it("ni lo que el llamante toca después del put ni lo que hace con la página cambia lo guardado", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    const mio = utf8.encode("original intacto");
    const handle = await guardar(almacen, mio);
    mio.fill(0x58);
    const r1 = await almacen.get(ambito, handle, { policyFingerprint: POLITICA });
    esPagina(r1);
    expect(new TextDecoder().decode(r1.bytes)).toBe("original intacto");
    r1.bytes.fill(0x59);
    const r2 = await almacen.get(ambito, handle, { policyFingerprint: POLITICA });
    esPagina(r2);
    expect(new TextDecoder().decode(r2.bytes)).toBe("original intacto");
  });
});

describe("almacén recuperable: una lectura ajena no sabe si el objeto existe", () => {
  const variantes: Array<[string, AmbitoRecuperable]> = [
    ["otro tenant", { ...ambito, tenantId: "otra-org" }],
    ["otro proyecto", { ...ambito, projectId: "contratos" }],
    ["otra sesión", { ...ambito, sessionId: "ses-2" }],
    ["otra rama", { ...ambito, branchId: "rama-b" }],
    ["otra época", { ...ambito, epoch: 1 }],
  ];

  it.each(variantes)("%s: el mismo not_found que un handle inventado", async (_n, ajeno) => {
    const almacen = new AlmacenRecuperableEnMemoria();
    const handle = await guardar(almacen, utf8.encode("secreto de acme"));
    const inventado = "bvr1_" + Buffer.from(randomBytes(24)).toString("base64url");

    const deAjeno = await almacen.get(ajeno, handle, { policyFingerprint: POLITICA });
    const deInventado = await almacen.get(ajeno, inventado, { policyFingerprint: POLITICA });
    const malFormado = await almacen.get(ajeno, "no-es-un-handle", { policyFingerprint: POLITICA });
    const inventadoDelDueno = await almacen.get(ambito, inventado, { policyFingerprint: POLITICA });

    expect(deAjeno).toEqual({ ok: false, error: "not_found", status: 404 });
    // El MISMO objeto, no uno parecido: no hay campo, ni orden, ni identidad que distinga.
    expect(deAjeno).toBe(deInventado);
    expect(deAjeno).toBe(malFormado);
    expect(deAjeno).toBe(inventadoDelDueno);
    expect(JSON.stringify(deAjeno)).not.toContain(handle);

    // Con otra política tampoco: policy_changed es solo para el dueño.
    expect(await almacen.get(ajeno, handle, { policyFingerprint: "pol-v2" })).toBe(deInventado);
    // Fijar desde fuera tampoco distingue, y no cambia nada.
    expect(await almacen.pin(ajeno, handle, 1_000_000_000_000)).toBe(deInventado);
    // Borrar desde fuera responde igual que siempre y NO borra.
    expect(await almacen.delete(ajeno, handle)).toEqual(await almacen.delete(ajeno, inventado));
    const delDueno = await almacen.get(ambito, handle, { policyFingerprint: POLITICA });
    esPagina(delDueno);
    expect(new TextDecoder().decode(delDueno.bytes)).toBe("secreto de acme");
  });

  it("caducado y borrado responden lo mismo que desconocido", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const caduca = await guardar(almacen, utf8.encode("a"), { ttlMs: 1000 });
    const borrado = await guardar(almacen, utf8.encode("b"));
    await almacen.delete(ambito, borrado);
    r.avanzar(1001);
    const desconocido = await almacen.get(ambito, "bvr1_" + "Z".repeat(32), { policyFingerprint: POLITICA });
    expect(await almacen.get(ambito, caduca, { policyFingerprint: POLITICA })).toBe(desconocido);
    expect(await almacen.get(ambito, borrado, { policyFingerprint: POLITICA })).toBe(desconocido);
  });

  it("no escribe nada en consola en todo el ciclo (ni contenido, ni handles, ni cursores)", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const almacen = new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 64 });
    const handle = await guardar(almacen, utf8.encode("x".repeat(40)));
    await leerTodo(almacen, handle, 8);
    await almacen.get(ambito, handle, { policyFingerprint: "otra" });
    await almacen.get(ambito, handle, { policyFingerprint: POLITICA, cursor: "1.00" });
    await almacen.put(ambito, utf8.encode("y".repeat(40)), { policyFingerprint: POLITICA, contentType: "t" });
    await almacen.revokeScope(ambito);
    await almacen.get(ambito, handle, { policyFingerprint: POLITICA });
    for (const e of espias) expect(e).not.toHaveBeenCalled();
  });
});

describe("almacén recuperable: caducidad, fijación y borrado", () => {
  it("por defecto vive 24 h y ni un milisegundo más", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const handle = await guardar(almacen, utf8.encode("dato"));
    r.avanzar(24 * 3600_000);
    expect((await almacen.get(ambito, handle, { policyFingerprint: POLITICA })).ok).toBe(true);
    r.avanzar(1);
    expect((await almacen.get(ambito, handle, { policyFingerprint: POLITICA })).ok).toBe(false);
  });

  it("fijado no caduca mientras dure la fijación, y después sí", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const fijado = await guardar(almacen, utf8.encode("fijado"), { ttlMs: 1000, pinUntil: r.now() + 5000 });
    const suelto = await guardar(almacen, utf8.encode("suelto"), { ttlMs: 1000 });
    r.avanzar(3000);
    expect((await almacen.get(ambito, fijado, { policyFingerprint: POLITICA })).ok).toBe(true);
    expect((await almacen.get(ambito, suelto, { policyFingerprint: POLITICA })).ok).toBe(false);
    r.avanzar(2001);
    expect((await almacen.get(ambito, fijado, { policyFingerprint: POLITICA })).ok).toBe(false);
  });

  it("la fijación se recorta a 2 h por defecto y no resucita lo caducado", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const t0 = r.now();
    const put = await almacen.put(ambito, utf8.encode("x"), {
      policyFingerprint: POLITICA,
      contentType: "text/plain",
      ttlMs: 1000,
      pinUntil: t0 + 10 * 3600_000,
    });
    expect(put.ok && put.pinnedUntil).toBe(t0 + 2 * 3600_000);
    r.avanzar(2 * 3600_000 + 1);
    if (!put.ok) return;
    expect((await almacen.get(ambito, put.handle, { policyFingerprint: POLITICA })).ok).toBe(false);
    const tarde = await almacen.pin(ambito, put.handle, r.now() + 1000);
    expect(tarde).toEqual({ ok: false, error: "not_found", status: 404 });
  });

  it("pin sobre un objeto vivo alarga su vida más allá del TTL", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const handle = await guardar(almacen, utf8.encode("x"), { ttlMs: 1000 });
    r.avanzar(900);
    expect(await almacen.pin(ambito, handle, r.now() + 60_000)).toEqual({ ok: true, pinnedUntil: r.now() + 60_000 });
    r.avanzar(30_000);
    expect((await almacen.get(ambito, handle, { policyFingerprint: POLITICA })).ok).toBe(true);
  });

  it("borrar prevalece sobre la fijación", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const handle = await guardar(almacen, utf8.encode("x"), { pinUntil: r.now() + 3600_000 });
    await almacen.delete(ambito, handle);
    expect(await almacen.get(ambito, handle, { policyFingerprint: POLITICA })).toEqual({
      ok: false,
      error: "not_found",
      status: 404,
    });
    expect(almacen.bytesEnUso(ambito)).toBe(0);
  });

  it("revocar la sesión prevalece sobre la fijación y no toca otras sesiones", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ now: r.now });
    const otra = { ...ambito, sessionId: "ses-2" };
    const fijados = [
      await guardar(almacen, utf8.encode("uno"), { pinUntil: r.now() + 3600_000 }),
      await guardar(almacen, utf8.encode("dos"), { pinUntil: r.now() + 3600_000, en: { ...ambito, branchId: "b" } }),
    ];
    const ajeno = await guardar(almacen, utf8.encode("de la otra sesión"), { en: otra });
    expect(await almacen.revokeScope(ambito)).toEqual({ ok: true, removed: 2 });
    for (const h of fijados) {
      expect(await almacen.get(ambito, h, { policyFingerprint: POLITICA })).toEqual({
        ok: false,
        error: "scope_revoked",
        status: 410,
      });
    }
    expect(almacen.size).toBe(1);
    const sigue = await almacen.get(otra, ajeno, { policyFingerprint: POLITICA });
    esPagina(sigue);
    expect(new TextDecoder().decode(sigue.bytes)).toBe("de la otra sesión");
  });
});

describe("almacén recuperable: la lápida de una revocación", () => {
  it("un reintento del put no recrea la sesión revocada, en ninguna rama ni época", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    await guardar(almacen, utf8.encode("antes"));
    await almacen.revokeScope(ambito);
    for (const en of [ambito, { ...ambito, epoch: 7 }, { ...ambito, branchId: "otra" }]) {
      const r = await almacen.put(en, utf8.encode("antes"), { policyFingerprint: POLITICA, contentType: "t" });
      expect(r).toEqual({ ok: false, error: "scope_revoked", status: 410 });
      expect("handle" in r).toBe(false);
    }
    expect(almacen.size).toBe(0);
  });

  it("la lápida es del ámbito que revocó: el mismo sessionId en otro tenant sigue funcionando", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    await almacen.revokeScope(ambito);
    const otro = { ...ambito, tenantId: "otra-org" };
    const h = await guardar(almacen, utf8.encode("suyo"), { en: otro });
    expect((await almacen.get(otro, h, { policyFingerprint: POLITICA })).ok).toBe(true);
  });

  it("revocar una época deja reconstruir en la siguiente; revocar una rama deja las demás", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    const vieja = await guardar(almacen, utf8.encode("época 0"));
    const nueva = { ...ambito, epoch: 1 };
    const yaEnLaNueva = await guardar(almacen, utf8.encode("ya en la 1"), { en: nueva });
    expect(await almacen.revokeScope(ambito, "epoch")).toEqual({ ok: true, removed: 1 });
    expect((await almacen.get(ambito, vieja, { policyFingerprint: POLITICA })).ok).toBe(false);
    expect((await almacen.get(nueva, yaEnLaNueva, { policyFingerprint: POLITICA })).ok).toBe(true);
    const h = await guardar(almacen, utf8.encode("época 1"), { en: nueva });
    expect((await almacen.get(nueva, h, { policyFingerprint: POLITICA })).ok).toBe(true);

    await almacen.revokeScope(nueva, "branch");
    expect((await almacen.put(nueva, utf8.encode("x"), { policyFingerprint: POLITICA, contentType: "t" })).ok).toBe(
      false,
    );
    expect((await almacen.put({ ...nueva, branchId: "b2" }, utf8.encode("x"), { policyFingerprint: POLITICA, contentType: "t" })).ok).toBe(true);
  });
});

describe("almacén recuperable: lleno, se niega; nunca desaloja", () => {
  it("con la cuota agotada no hay handle y lo que había sigue intacto", async () => {
    const almacen = new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 100 });
    const primero = utf8.encode("p".repeat(60));
    const h = await guardar(almacen, primero);
    const r = await almacen.put(ambito, utf8.encode("q".repeat(41)), { policyFingerprint: POLITICA, contentType: "t" });
    expect(r).toEqual({ ok: false, error: "quota_exceeded", status: 507 });
    expect("handle" in r).toBe(false);
    expect(almacen.size).toBe(1);
    expect(almacen.bytesEnUso(ambito)).toBe(60);
    const sigue = await almacen.get(ambito, h, { policyFingerprint: POLITICA });
    esPagina(sigue);
    expect(Buffer.from(sigue.bytes).equals(Buffer.from(primero))).toBe(true);
    // Justo hasta el límite sí cabe.
    expect((await almacen.put(ambito, utf8.encode("q".repeat(40)), { policyFingerprint: POLITICA, contentType: "t" })).ok).toBe(true);
  });

  it("la cuota es por sesión: llenar una no niega otra", async () => {
    const almacen = new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 10 });
    await guardar(almacen, utf8.encode("0123456789"));
    expect((await almacen.put(ambito, utf8.encode("x"), { policyFingerprint: POLITICA, contentType: "t" })).ok).toBe(false);
    await guardar(almacen, utf8.encode("0123456789"), { en: { ...ambito, sessionId: "ses-2" } });
  });

  it("lo caducado sin fijar deja sitio; lo caducado-pero-fijado, no", async () => {
    const r = reloj();
    const almacen = new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 100, now: r.now });
    const fijado = await guardar(almacen, utf8.encode("f".repeat(50)), { ttlMs: 10, pinUntil: r.now() + 60_000 });
    await guardar(almacen, utf8.encode("s".repeat(50)), { ttlMs: 10 });
    r.avanzar(1000);
    // El suelto caducó: su sitio se recupera. El fijado sigue contando.
    expect((await almacen.put(ambito, utf8.encode("n".repeat(50)), { policyFingerprint: POLITICA, contentType: "t" })).ok).toBe(true);
    expect((await almacen.put(ambito, utf8.encode("m".repeat(1)), { policyFingerprint: POLITICA, contentType: "t" })).ok).toBe(false);
    expect((await almacen.get(ambito, fijado, { policyFingerprint: POLITICA })).ok).toBe(true);
  });

  it("borrar libera cuota", async () => {
    const almacen = new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 10 });
    const h = await guardar(almacen, utf8.encode("0123456789"));
    await almacen.delete(ambito, h);
    await guardar(almacen, utf8.encode("0123456789"));
  });

  it("por defecto: 1 MiB por objeto entra, 1 MiB + 1 no", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    expect((await almacen.put(ambito, new Uint8Array(1 << 20), { policyFingerprint: POLITICA, contentType: "b" })).ok).toBe(true);
    expect(await almacen.put(ambito, new Uint8Array((1 << 20) + 1), { policyFingerprint: POLITICA, contentType: "b" })).toEqual({
      ok: false,
      error: "object_too_large",
      status: 413,
    });
  });

  it("por defecto la sesión admite 256 MiB y ni un byte más", async () => {
    const almacen = new AlmacenRecuperableEnMemoria();
    const mib = new Uint8Array(1 << 20);
    for (let i = 0; i < 256; i++) {
      const r = await almacen.put(ambito, mib, { policyFingerprint: POLITICA, contentType: "b" });
      expect(r.ok).toBe(true);
    }
    expect(almacen.bytesEnUso(ambito)).toBe(256 * (1 << 20));
    expect((await almacen.put(ambito, new Uint8Array(1), { policyFingerprint: POLITICA, contentType: "b" })).ok).toBe(false);
    expect(almacen.size).toBe(256);
  });
});

describe("almacén recuperable: cursores y política", () => {
  async function conCursor() {
    const almacen = new AlmacenRecuperableEnMemoria();
    const bytes = utf8.encode("abcdefghijklmnopqrstuvwxyz".repeat(4));
    const handle = await guardar(almacen, bytes);
    const p1 = await almacen.get(ambito, handle, { policyFingerprint: POLITICA, maxBytes: 10 });
    esPagina(p1);
    expect(p1.nextCursor).not.toBeNull();
    return { almacen, handle, cursor: p1.nextCursor!, bytes };
  }
  const CURSOR_INVALIDO = { ok: false, error: "invalid_cursor", status: 400 };

  it("el cursor bueno sigue justo donde acabó la página", async () => {
    const { almacen, handle, cursor, bytes } = await conCursor();
    const p2 = await almacen.get(ambito, handle, { policyFingerprint: POLITICA, maxBytes: 10, cursor });
    esPagina(p2);
    expect(p2.offset).toBe(10);
    expect(Buffer.from(p2.bytes).equals(Buffer.from(bytes.slice(10, 20)))).toBe(true);
  });

  it("cambiar la posición del cursor sin poder refirmarlo no salta a otra parte", async () => {
    const { almacen, handle, cursor } = await conCursor();
    const [, mac] = cursor.split(".");
    for (const falso of [`20.${mac}`, `0.${mac}`, `9.${mac}`]) {
      expect(await almacen.get(ambito, handle, { policyFingerprint: POLITICA, cursor: falso })).toEqual(CURSOR_INVALIDO);
    }
    const ultimo = mac!.slice(-1) === "0" ? "1" : "0";
    const macTocado = `${cursor.slice(0, -1)}${ultimo}`;
    expect(await almacen.get(ambito, handle, { policyFingerprint: POLITICA, cursor: macTocado })).toEqual(CURSOR_INVALIDO);
    for (const basura of ["", "10", "x.y", "10." + "g".repeat(64)]) {
      expect(await almacen.get(ambito, handle, { policyFingerprint: POLITICA, cursor: basura })).toEqual(CURSOR_INVALIDO);
    }
  });

  it("el cursor de otro handle, aunque sea del mismo ámbito y la misma posición, no vale", async () => {
    const { almacen, cursor } = await conCursor();
    const otro = await guardar(almacen, utf8.encode("abcdefghijklmnopqrstuvwxyz".repeat(4)));
    expect(await almacen.get(ambito, otro, { policyFingerprint: POLITICA, cursor })).toEqual(CURSOR_INVALIDO);
  });

  it("el cursor de otro almacén (otro secreto) no vale", async () => {
    const { cursor } = await conCursor();
    const { almacen: otroAlmacen, handle: suHandle } = await conCursor();
    expect(await otroAlmacen.get(ambito, suHandle, { policyFingerprint: POLITICA, cursor })).toEqual(CURSOR_INVALIDO);
  });

  it("con el cursor bueno desde otro ámbito: not_found, nunca invalid_cursor", async () => {
    const { almacen, handle, cursor } = await conCursor();
    const r = await almacen.get({ ...ambito, epoch: 3 }, handle, { policyFingerprint: POLITICA, cursor });
    expect(r).toEqual({ ok: false, error: "not_found", status: 404 });
  });

  it("con la política cambiada, el dueño recibe policy_changed y ningún byte", async () => {
    const { almacen, handle, cursor } = await conCursor();
    for (const c of [undefined, cursor]) {
      const r = await almacen.get(ambito, handle, {
        policyFingerprint: "pol-v2-mas-estricta",
        ...(c !== undefined ? { cursor: c } : {}),
      });
      expect(r).toEqual({ ok: false, error: "policy_changed", status: 409 });
      expect("bytes" in r).toBe(false);
    }
  });
});

describe("almacén recuperable: integridad", () => {
  class DepositoQueCorrompe implements DepositoDeBytes {
    readonly m = new Map<string, Uint8Array>();
    leer(c: string) {
      return this.m.get(c);
    }
    escribir(c: string, b: Uint8Array) {
      this.m.set(c, b);
    }
    borrar(c: string) {
      this.m.delete(c);
    }
  }

  it("un solo bit cambiado: integrity_failure y ningún byte", async () => {
    const deposito = new DepositoQueCorrompe();
    const almacen = new AlmacenRecuperableEnMemoria({ deposito });
    const handle = await guardar(almacen, utf8.encode("importe: 1.234,56 €"));
    const [guardado] = [...deposito.m.values()];
    guardado![3] = guardado![3]! ^ 0x01;
    const r = await almacen.get(ambito, handle, { policyFingerprint: POLITICA });
    expect(r).toEqual({ ok: false, error: "integrity_failure", status: 500 });
    expect("bytes" in r).toBe(false);
  });

  it("bytes que faltan o con otro largo: integrity_failure", async () => {
    const deposito = new DepositoQueCorrompe();
    const almacen = new AlmacenRecuperableEnMemoria({ deposito });
    const a = await guardar(almacen, utf8.encode("uno"));
    const b = await guardar(almacen, utf8.encode("dos"));
    const [ka, kb] = [...deposito.m.keys()];
    deposito.m.delete(ka!);
    deposito.m.set(kb!, utf8.encode("dos y algo más"));
    expect((await almacen.get(ambito, a, { policyFingerprint: POLITICA })).ok).toBe(false);
    expect(await almacen.get(ambito, b, { policyFingerprint: POLITICA })).toEqual({
      ok: false,
      error: "integrity_failure",
      status: 500,
    });
  });

  it("el depósito no ve el handle: sus claves son la sha256 del handle", async () => {
    const deposito = new DepositoQueCorrompe();
    const almacen = new AlmacenRecuperableEnMemoria({ deposito });
    const handle = await guardar(almacen, utf8.encode("x"));
    expect([...deposito.m.keys()]).toEqual([createHash("sha256").update(handle).digest("hex")]);
  });
});

describe("almacén recuperable: el handle", () => {
  it("192 bits aleatorios en base64url, no un hash del contenido ni un UUID", async () => {
    const almacen = new AlmacenRecuperableEnMemoria({ quotaBytesPerSession: 1 << 30 });
    const N = 2000;
    const mismo = utf8.encode("mismo contenido");
    const handles: string[] = [];
    for (let i = 0; i < N; i++) handles.push(await guardar(almacen, mismo));

    expect(new Set(handles).size).toBe(N); // el mismo contenido no da el mismo handle
    const unos = new Array(192).fill(0);
    for (const h of handles) {
      expect(h).toMatch(/^bvr1_[A-Za-z0-9_-]{32}$/);
      expect(h).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(h).not.toContain(hex(mismo).slice(0, 12));
      const crudo = Buffer.from(h.slice(5), "base64url");
      expect(crudo.length).toBe(24);
      for (let bit = 0; bit < 192; bit++) unos[bit] += (crudo[bit >> 3]! >> (bit & 7)) & 1;
    }
    // Cada uno de los 192 bits sale a 1 cerca de la mitad de las veces (±10 %,
    // a más de 8 sigmas para N=2000): ninguno está fijo ni sesgado.
    for (const n of unos) {
      expect(n / N).toBeGreaterThan(0.4);
      expect(n / N).toBeLessThan(0.6);
    }
  });
});

describe("sha256DeBytes y hmacSha256 coinciden con node:crypto", () => {
  it.each([0, 1, 55, 56, 63, 64, 65, 1000, 70_000])("sha256 de %i bytes", (n) => {
    const b = new Uint8Array(randomBytes(n));
    expect(sha256DeBytes(b)).toBe(hex(b));
  });

  it.each([0, 16, 32, 64, 65, 131])("hmac con clave de %i bytes", (n) => {
    const clave = new Uint8Array(randomBytes(n));
    for (const largo of [0, 3, 64, 500]) {
      const mensaje = new Uint8Array(randomBytes(largo));
      expect(hmacSha256(clave, mensaje)).toBe(createHmac("sha256", clave).update(mensaje).digest("hex"));
    }
  });

  it("vector 2 del RFC 4231", () => {
    expect(hmacSha256(utf8.encode("Jefe"), utf8.encode("what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

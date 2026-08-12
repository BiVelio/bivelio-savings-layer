import { describe, it, expect } from "vitest";

import {
  acunarToken,
  hashDeToken,
  mismoHash,
  normalizarCorreo,
  sePuedeAceptar,
  esRolInvitable,
  enlaceDeInvitacion,
  DIAS_DE_VIGENCIA,
  type Invitacion,
} from "./invitaciones";

/**
 * UN ENLACE DE INVITACIÓN ES UNA CREDENCIAL. Quien lo tenga entra en la
 * organización de otra empresa y —según el rol— se lleva su licencia firmada. Los
 * tests de aquí van todos contra la misma idea: que no entre quien no debe.
 */

const AHORA = new Date("2026-08-12T12:00:00Z");
const viva = (extra: Partial<Invitacion> = {}): Invitacion => ({
  id: "inv-1",
  org_id: "org-1",
  email: "nuevo@empresa.com",
  role: "member",
  expires_at: "2026-08-19T12:00:00Z",
  accepted_at: null,
  ...extra,
});

describe("el token", () => {
  it("no se puede reconstruir desde lo que se guarda", () => {
    const { token, hash } = acunarToken(AHORA);
    expect(hash).not.toContain(token);
    expect(token).not.toContain(hash);
    expect(hash).toBe(hashDeToken(token));
  });

  it("dos tokens seguidos son distintos", () => {
    // Con `Math.random` o con una semilla fija, el enlace sería adivinable.
    const tokens = new Set(Array.from({ length: 50 }, () => acunarToken(AHORA).token));
    expect(tokens.size).toBe(50);
  });

  it("lleva prefijo reconocible y entropía de sobra", () => {
    const { token } = acunarToken(AHORA);
    expect(token.startsWith("bvi_")).toBe(true);
    expect(token.length).toBeGreaterThan(40); // 32 bytes en base64url
  });

  it("caduca a los siete días, contados desde el momento que se le pase", () => {
    const { expiraEn } = acunarToken(AHORA);
    expect(Date.parse(expiraEn) - AHORA.getTime()).toBe(DIAS_DE_VIGENCIA * 86_400_000);
  });
});

describe("mismoHash", () => {
  it("compara bien", () => {
    expect(mismoHash("abcd", "abcd")).toBe(true);
    expect(mismoHash("abcd", "abce")).toBe(false);
  });

  it("⛔ longitudes distintas NO lanzan: devuelven false", () => {
    // `timingSafeEqual` lanza si difieren, y un token de otra longitud llega desde
    // fuera. Sin esta guarda, un enlace manipulado da 500 en vez de 403.
    expect(() => mismoHash("abc", "abcd")).not.toThrow();
    expect(mismoHash("abc", "abcd")).toBe(false);
    expect(mismoHash("", "")).toBe(false);
  });
});

describe("normalizarCorreo", () => {
  it("iguala espacios y mayúsculas", () => {
    expect(normalizarCorreo("  Nuevo@Empresa.COM ")).toBe("nuevo@empresa.com");
  });

  it("⛔ NO quita puntos ni sufijos +", () => {
    // En Gmail `a.b@` y `ab@` son la misma cuenta; en la mayoría de servidores
    // corporativos NO. Una equivalencia de más aquí es dejar entrar a quien no es.
    expect(normalizarCorreo("a.b@empresa.com")).not.toBe(normalizarCorreo("ab@empresa.com"));
    expect(normalizarCorreo("a+x@empresa.com")).not.toBe(normalizarCorreo("a@empresa.com"));
  });

  it("nulos y vacíos dan cadena vacía, no revientan", () => {
    expect(normalizarCorreo(null)).toBe("");
    expect(normalizarCorreo(undefined)).toBe("");
  });
});

describe("sePuedeAceptar", () => {
  it("la invitación viva de su destinatario se acepta", () => {
    expect(sePuedeAceptar(viva(), "nuevo@empresa.com", AHORA)).toEqual({ ok: true });
    expect(sePuedeAceptar(viva(), "  NUEVO@Empresa.com ", AHORA)).toEqual({ ok: true });
  });

  it("⛔ el correo tiene que COINCIDIR — es la mitad de la seguridad", () => {
    // Sin esto, un enlace reenviado por error a una lista de distribución mete en
    // la organización a quien lo pille primero.
    expect(sePuedeAceptar(viva(), "otro@empresa.com", AHORA)).toEqual({
      ok: false,
      motivo: "otro_correo",
    });
  });

  it("⛔ sin correo en la sesión NO se acepta", () => {
    // Un usuario sin email verificado no puede demostrar que es el destinatario.
    for (const sin of [null, undefined, "", "   "]) {
      expect(sePuedeAceptar(viva(), sin, AHORA)).toEqual({ ok: false, motivo: "otro_correo" });
    }
  });

  it("⛔ una invitación SIN email tampoco casa con nadie", () => {
    // Fila corrupta o migrada a medias: no puede volverse una llave maestra.
    expect(sePuedeAceptar(viva({ email: "" }), "", AHORA)).toEqual({ ok: false, motivo: "otro_correo" });
  });

  it("caducada, aunque el correo sea el bueno", () => {
    expect(sePuedeAceptar(viva({ expires_at: "2026-08-11T12:00:00Z" }), "nuevo@empresa.com", AHORA)).toEqual({
      ok: false,
      motivo: "caducada",
    });
  });

  it("justo en el instante de caducar, NO", () => {
    expect(sePuedeAceptar(viva({ expires_at: AHORA.toISOString() }), "nuevo@empresa.com", AHORA)).toEqual({
      ok: false,
      motivo: "caducada",
    });
  });

  it("⛔ una fecha ilegible se trata como caducada", () => {
    // Fallar hacia "no entra" es barato. Fallar hacia "entra" mete a un tercero en
    // la organización de un cliente que paga.
    expect(sePuedeAceptar(viva({ expires_at: "cuando sea" }), "nuevo@empresa.com", AHORA)).toEqual({
      ok: false,
      motivo: "caducada",
    });
  });

  it("una ya aceptada no se reutiliza", () => {
    expect(
      sePuedeAceptar(viva({ accepted_at: "2026-08-13T00:00:00Z" }), "nuevo@empresa.com", AHORA),
    ).toEqual({ ok: false, motivo: "ya_aceptada" });
  });

  it("una que no existe es 'invalida'", () => {
    expect(sePuedeAceptar(null, "nuevo@empresa.com", AHORA)).toEqual({ ok: false, motivo: "invalida" });
  });

  it("el orden no convierte la respuesta en un oráculo", () => {
    // Caducada + correo ajeno responde "caducada", no "no eres tú": si respondiera
    // lo segundo, cualquiera podría averiguar si una dirección concreta tiene
    // invitación pendiente probando enlaces viejos.
    expect(
      sePuedeAceptar(viva({ expires_at: "2026-01-01T00:00:00Z" }), "otro@empresa.com", AHORA),
    ).toEqual({ ok: false, motivo: "caducada" });
  });
});

describe("roles invitables", () => {
  it("⛔ owner NO se invita: se transfiere", () => {
    expect(esRolInvitable("owner")).toBe(false);
  });

  it("admin, member y billing sí", () => {
    for (const r of ["admin", "member", "billing"]) expect(esRolInvitable(r)).toBe(true);
  });

  it("lo raro no cuela", () => {
    for (const r of [null, undefined, 1, {}, "OWNER", "Admin", "", "root"]) {
      expect(esRolInvitable(r)).toBe(false);
    }
  });
});

describe("el enlace", () => {
  it("el token va en la RUTA, no en la query", () => {
    // Las query strings acaban en los registros de los proxies y en el `Referer`
    // de la siguiente navegación. Una credencial no puede ir ahí.
    const url = enlaceDeInvitacion("https://savings.bivelio.com", "es", "bvi_secreto");
    expect(url).toBe("https://savings.bivelio.com/es/invitacion/bvi_secreto");
    expect(url).not.toContain("?");
  });

  it("un locale raro cae a es en vez de construir una URL rota", () => {
    expect(enlaceDeInvitacion("https://x.com", "../../etc", "t")).toBe("https://x.com/es/invitacion/t");
    expect(enlaceDeInvitacion("https://x.com", "", "t")).toBe("https://x.com/es/invitacion/t");
  });

  it("el token se escapa", () => {
    expect(enlaceDeInvitacion("https://x.com/", "en", "a/b?c")).toBe("https://x.com/en/invitacion/a%2Fb%3Fc");
  });
});

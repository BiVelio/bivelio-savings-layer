import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";

import { verificarFirma, elegirProducto, idiomaDe, construirEnlace } from "./auth-hook";
import { componerCorreoAuth, juegoPara } from "./auth-plantillas";
import { IDIOMAS } from "./invitacion";

/**
 * EL HOOK DE CORREOS DE AUTH. Dos cosas que no pueden fallar:
 *
 *  1. La firma: sin ella verificada, cualquiera que descubra la URL podría
 *     hacernos mandar correos con enlaces de sesión a quien quiera.
 *  2. El enlace: el bug que motivó todo esto era una URL montada pegando
 *     cadenas (`{{ .RedirectTo }}&token_hash=…`). Aquí se prueba que el `?`/`&`
 *     sale bien CON y SIN query previa, que era exactamente lo que se rompía.
 */

const SECRETO_CRUDO = Buffer.from("un-secreto-de-prueba-suficientemente-largo").toString("base64");
const SECRETO = `v1,whsec_${SECRETO_CRUDO}`;

function firmar(cuerpo: string, id = "msg_1", tsSeg = Math.floor(1_756_200_000)): {
  id: string;
  timestamp: string;
  signature: string;
} {
  const clave = Buffer.from(SECRETO_CRUDO, "base64");
  const firma = createHmac("sha256", clave).update(`${id}.${tsSeg}.${cuerpo}`).digest("base64");
  return { id, timestamp: String(tsSeg), signature: `v1,${firma}` };
}

const AHORA_MS = 1_756_200_000 * 1000;

describe("verificarFirma — Standard Webhooks", () => {
  it("acepta una firma correcta", () => {
    const cab = firmar("{}");
    expect(verificarFirma("{}", cab, SECRETO, AHORA_MS)).toEqual({ ok: true });
  });

  it("⛔ rechaza cuerpo alterado, firma ajena y cabeceras ausentes", () => {
    const cab = firmar("{}");
    expect(verificarFirma('{"otro":1}', cab, SECRETO, AHORA_MS).ok).toBe(false);
    expect(verificarFirma("{}", { ...cab, signature: "v1,AAAA" }, SECRETO, AHORA_MS).ok).toBe(false);
    expect(verificarFirma("{}", { ...cab, id: null }, SECRETO, AHORA_MS).ok).toBe(false);
  });

  it("⛔ rechaza un timestamp fuera de la tolerancia (repetición)", () => {
    const cab = firmar("{}");
    expect(verificarFirma("{}", cab, SECRETO, AHORA_MS + 10 * 60 * 1000).ok).toBe(false);
  });

  it("acepta el secreto aunque llegue sin los prefijos v1,/whsec_", () => {
    const cab = firmar("{}");
    expect(verificarFirma("{}", cab, SECRETO_CRUDO, AHORA_MS)).toEqual({ ok: true });
  });

  it("acepta varias firmas en la cabecera si una es la buena", () => {
    const cab = firmar("{}");
    const conRuido = { ...cab, signature: `v1,AAAA ${cab.signature}` };
    expect(verificarFirma("{}", conRuido, SECRETO, AHORA_MS)).toEqual({ ok: true });
  });
});

describe("elegirProducto — por el dominio del redirect", () => {
  it("reconoce los tres dominios y sus previews", () => {
    expect(elegirProducto("https://savings.bivelio.com/auth/callback?next=/en/x")).toBe("savings");
    expect(elegirProducto("https://bivelio-savings-web-git-rama-x.vercel.app/auth/callback")).toBe("savings");
    expect(elegirProducto("https://privacy.bivelio.com/auth/callback?next=/")).toBe("privacy");
    expect(elegirProducto("https://app.bivelio.com/auth/callback?next=/onboarding")).toBe("gpos");
  });

  it("sin pista (el site_url pelado del fallback) → gpos", () => {
    expect(elegirProducto("https://app.bivelio.com")).toBe("gpos");
    expect(elegirProducto(null)).toBe("gpos");
  });
});

describe("idiomaDe — el locale que viaja en el redirect", () => {
  it("lo saca del next= aunque venga URL-encoded", () => {
    expect(idiomaDe("https://savings.bivelio.com/auth/callback?next=/en/dashboard")).toBe("en");
    expect(idiomaDe("https://savings.bivelio.com/auth/callback?next=%2Fvi%2Fdashboard")).toBe("vi");
    expect(idiomaDe("https://app.bivelio.com/auth/callback?next=/onboarding")).toBe("es");
  });

  it("no confunde un segmento cualquiera de dos letras que no sea idioma", () => {
    expect(idiomaDe("https://savings.bivelio.com/xx/qq?next=/zz/panel")).toBe("es");
  });
});

describe("construirEnlace — donde murió el bug del «&»", () => {
  it("con query previa usa «&»; sin query usa «?» — las dos salen válidas", () => {
    const con = construirEnlace("savings", "https://savings.bivelio.com/auth/callback?next=/en/d", "th_1", "signup");
    expect(con).toBe("https://savings.bivelio.com/auth/callback?next=%2Fen%2Fd&token_hash=th_1&type=signup");
    const sin = construirEnlace("savings", "https://savings.bivelio.com/auth/callback", "th_1", "signup");
    expect(sin).toBe("https://savings.bivelio.com/auth/callback?token_hash=th_1&type=signup");
  });

  it("el site_url pelado (el caso que producía el enlace muerto) se convierte en un callback válido", () => {
    const u = construirEnlace("gpos", "https://app.bivelio.com", "th_2", "signup");
    expect(u).toBe("https://app.bivelio.com/auth/callback?token_hash=th_2&type=signup");
  });

  it("un redirect roto o vacío cae al callback del producto", () => {
    expect(construirEnlace("savings", "", "th_3", "recovery")).toContain("https://savings.bivelio.com/auth/callback?");
    expect(construirEnlace("privacy", "esto-no-es-una-url", "th_3", "recovery")).toContain("https://privacy.bivelio.com/auth/callback?");
  });
});

describe("las plantillas", () => {
  it("los 12 idiomas tienen los 3 juegos completos, sin campos vacíos", () => {
    for (const accion of ["signup", "recovery", "magiclink"] as const) {
      const juego = juegoPara(accion);
      for (const idioma of IDIOMAS) {
        const t = juego[idioma];
        for (const campo of [t.asunto, t.saludo, t.cuerpo, t.boton, t.seguridad, t.ignorar]) {
          expect(campo, `${accion}/${idioma}`).toBeTruthy();
        }
      }
    }
  });

  it("un tipo de acción desconocido cae en el juego genérico, nunca sin correo", () => {
    expect(juegoPara("algo_nuevo_de_gotrue")).toBe(juegoPara("magiclink"));
  });

  it("cada producto lleva su carcasa y su pie", () => {
    const base = { accion: "signup" as const, idioma: "en" as const, enlace: "https://x.example/cb?token_hash=t&type=signup", destinatario: "a@b.com" };
    const savings = componerCorreoAuth({ ...base, producto: "savings" });
    const gpos = componerCorreoAuth({ ...base, producto: "gpos" });
    const privacy = componerCorreoAuth({ ...base, producto: "privacy" });
    expect(savings.html).toContain("savings.bivelio.com");
    expect(savings.html).not.toContain("#070B14");
    expect(gpos.html).toContain("#070B14"); // la carcasa oscura de GPOS
    expect(gpos.html).toContain("Governed Process");
    expect(privacy.html).toContain("privacy.bivelio.com");
  });

  it("⛔ el enlace va escapado en el HTML", () => {
    const c = componerCorreoAuth({
      producto: "savings",
      accion: "signup",
      idioma: "es",
      enlace: 'https://x.example/cb?a="><script>alert(1)</script>',
      destinatario: "a@b.com",
    });
    expect(c.html).not.toContain("<script>");
  });

  it("reauthentication sin enlace muestra el código", () => {
    const c = componerCorreoAuth({
      producto: "savings",
      accion: "reauthentication",
      idioma: "en",
      enlace: "",
      codigo: "123456",
      destinatario: "a@b.com",
    });
    expect(c.html).toContain("123456");
    expect(c.texto).toContain("123456");
  });
});

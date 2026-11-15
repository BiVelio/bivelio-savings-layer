import { createHmac } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";

import {
  verificarFirma,
  elegirProducto,
  elegirMarca,
  idiomaDe,
  construirEnlace,
  callbackPorDefecto,
  VAR_CALLBACK_PRIVACY,
} from "./auth-hook";
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

  it("shield.bivelio.com y sus previews son el producto privacy (BiVelio Shield), no GPOS", () => {
    expect(elegirProducto("https://shield.bivelio.com/auth/callback?next=/en/dashboard")).toBe("privacy");
    expect(elegirProducto("https://SHIELD.bivelio.com/auth/callback")).toBe("privacy");
    expect(elegirProducto("https://shield.bivelio.com")).toBe("privacy");
    expect(elegirProducto("https://bivelio-shield-git-rama-x.vercel.app/auth/callback")).toBe("privacy");
  });

  it("privacy.bivelio.com y sus previews siguen exactamente igual", () => {
    expect(elegirProducto("https://privacy.bivelio.com/auth/callback?next=/es/dashboard")).toBe("privacy");
    expect(elegirProducto("https://privacy.bivelio.com")).toBe("privacy");
    expect(elegirProducto("https://bivelio-privacy-gateway-git-rama-x.vercel.app/auth/callback")).toBe("privacy");
  });

  it("un dominio desconocido sigue cayendo en GPOS, como hasta hoy", () => {
    expect(elegirProducto("https://desconocido.example/auth/callback")).toBe("gpos");
    expect(elegirProducto("https://otra.bivelio.com/auth/callback")).toBe("gpos");
    expect(elegirProducto("")).toBe("gpos");
  });
});

describe("el callback por defecto de privacy — el interruptor del día del cambio", () => {
  const SHIELD = "https://shield.bivelio.com/auth/callback";
  afterEach(() => vi.restoreAllMocks());

  it("sin la variable (hoy) sigue siendo privacy.bivelio.com", () => {
    expect(callbackPorDefecto("privacy", {})).toBe("https://privacy.bivelio.com/auth/callback");
    expect(construirEnlace("privacy", "", "th_d", "signup", {})).toBe(
      "https://privacy.bivelio.com/auth/callback?token_hash=th_d&type=signup",
    );
  });

  it("con la variable a shield, un redirect vacío o roto cae en shield", () => {
    const env = { [VAR_CALLBACK_PRIVACY]: SHIELD };
    expect(callbackPorDefecto("privacy", env)).toBe(SHIELD);
    expect(construirEnlace("privacy", "", "th_d", "recovery", env)).toBe(`${SHIELD}?token_hash=th_d&type=recovery`);
    expect(construirEnlace("privacy", "esto-no-es-una-url", "th_d", "recovery", env)).toBe(
      `${SHIELD}?token_hash=th_d&type=recovery`,
    );
    // El origen pelado también vale: se le pone la ruta del callback.
    expect(construirEnlace("privacy", "", "th_d", "signup", { [VAR_CALLBACK_PRIVACY]: "https://shield.bivelio.com" })).toBe(
      `${SHIELD}?token_hash=th_d&type=signup`,
    );
  });

  it("la variable NUNCA pisa un redirect válido: privacy sigue llevando a privacy", () => {
    const env = { [VAR_CALLBACK_PRIVACY]: SHIELD };
    expect(construirEnlace("privacy", "https://privacy.bivelio.com/auth/callback?next=/en/d", "th_d", "signup", env)).toBe(
      "https://privacy.bivelio.com/auth/callback?next=%2Fen%2Fd&token_hash=th_d&type=signup",
    );
  });

  it("⛔ un valor que no es https a privacy/shield se ignora (y avisa): nunca enlaces a otro sitio", () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const malo of [
      "http://shield.bivelio.com/auth/callback",
      "https://shield.bivelio.com.evil.example/auth/callback",
      "https://evil.example/auth/callback",
      "https://app.bivelio.com/auth/callback",
      "https://shield.bivelio.com:8443/auth/callback",
      "https://usuario:clave@shield.bivelio.com/auth/callback",
      "javascript:alert(1)",
      "esto no es una url",
    ]) {
      expect(callbackPorDefecto("privacy", { [VAR_CALLBACK_PRIVACY]: malo }), malo).toBe(
        "https://privacy.bivelio.com/auth/callback",
      );
    }
    expect(aviso).toHaveBeenCalled();
    // El aviso nombra la variable, nunca repite su valor.
    expect(String(aviso.mock.calls[0]![0])).toContain(VAR_CALLBACK_PRIVACY);
  });

  it("la variable solo toca a privacy: savings y GPOS no se mueven", () => {
    const env = { [VAR_CALLBACK_PRIVACY]: SHIELD };
    expect(callbackPorDefecto("savings", env)).toBe("https://savings.bivelio.com/auth/callback");
    expect(callbackPorDefecto("gpos", env)).toBe("https://app.bivelio.com/auth/callback");
    expect(construirEnlace("gpos", "", "th_d", "signup", env)).toContain("https://app.bivelio.com/auth/callback?");
  });
});

describe("elegirMarca — Privacy o BiVelio Shield, según adónde lleva el enlace", () => {
  const SHIELD = { [VAR_CALLBACK_PRIVACY]: "https://shield.bivelio.com/auth/callback" };

  it("un alta en shield se presenta como BiVelio Shield", () => {
    expect(elegirMarca("privacy", "https://shield.bivelio.com/auth/callback?next=/en/dashboard", {})).toBe("shield");
    expect(elegirMarca("privacy", "https://bivelio-shield-git-rama-x.vercel.app/auth/callback", {})).toBe("shield");
  });

  it("un alta en privacy sigue siendo Privacy, aunque el interruptor ya apunte a shield", () => {
    expect(elegirMarca("privacy", "https://privacy.bivelio.com/auth/callback?next=/es/dashboard", {})).toBe("privacy");
    expect(elegirMarca("privacy", "https://privacy.bivelio.com/auth/callback", SHIELD)).toBe("privacy");
    expect(elegirMarca("privacy", "https://bivelio-privacy-gateway-git-rama-x.vercel.app/auth/callback", {})).toBe("privacy");
    // Lo que decide es el HOST, no un «shield» suelto en la query.
    expect(elegirMarca("privacy", "https://privacy.bivelio.com/auth/callback?next=/shield.bivelio.com", {})).toBe("privacy");
  });

  it("sin redirect, la marca sigue al callback por defecto (el interruptor)", () => {
    expect(elegirMarca("privacy", "", {})).toBe("privacy");
    expect(elegirMarca("privacy", null, SHIELD)).toBe("shield");
  });

  it("savings y GPOS conservan la suya pase lo que pase", () => {
    expect(elegirMarca("savings", "https://savings.bivelio.com/auth/callback", SHIELD)).toBe("savings");
    expect(elegirMarca("gpos", "https://app.bivelio.com/auth/callback", SHIELD)).toBe("gpos");
    expect(elegirMarca("gpos", "https://desconocido.example/auth/callback", SHIELD)).toBe("gpos");
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

  it("un redirect a shield lleva a shield, con su next y su idioma", () => {
    const r = "https://shield.bivelio.com/auth/callback?next=/fr/dashboard";
    expect(elegirProducto(r)).toBe("privacy");
    expect(idiomaDe(r)).toBe("fr");
    expect(construirEnlace("privacy", r, "th_4", "signup", {})).toBe(
      "https://shield.bivelio.com/auth/callback?next=%2Ffr%2Fdashboard&token_hash=th_4&type=signup",
    );
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

  it("privacy se ve EXACTAMENTE como hasta hoy: «Privacy.» + «BY BIVELIO», sin rastro de Shield", () => {
    const base = { producto: "privacy" as const, accion: "signup" as const, idioma: "es" as const, enlace: "https://privacy.bivelio.com/auth/callback?token_hash=t&type=signup", destinatario: "persona@ejemplo.com" };
    const sinMarca = componerCorreoAuth(base);
    expect(componerCorreoAuth({ ...base, marca: "privacy" })).toEqual(sinMarca);
    expect(sinMarca.html).toContain('Privacy<span style="color:#2F63D8">.</span><span');
    expect(sinMarca.html).toContain("BY BIVELIO</span></p>");
    expect(sinMarca.html).toContain('href="https://privacy.bivelio.com"');
    expect(sinMarca.html).not.toContain("Shield");
    expect(sinMarca.texto.endsWith("BiVelio · privacy.bivelio.com")).toBe(true);
  });

  it("shield: «BiVelio Shield» en la cabecera y el pie, en los 12 idiomas y los 3 juegos", () => {
    for (const accion of ["signup", "recovery", "magiclink"] as const) {
      for (const idioma of IDIOMAS) {
        const c = componerCorreoAuth({
          producto: "privacy",
          marca: "shield",
          accion,
          idioma,
          enlace: "https://shield.bivelio.com/auth/callback?token_hash=t&type=signup",
          destinatario: "persona@ejemplo.com",
        });
        const donde = `${accion}/${idioma}`;
        expect(c.html, donde).toContain('BiVelio Shield<span style="color:#2F63D8">.</span></p>');
        expect(c.html, donde).toContain('href="https://shield.bivelio.com"');
        // La marca nueva ya dice BiVelio: nada de «BiVelio Shield. BY BIVELIO».
        expect(c.html, donde).not.toContain("BY BIVELIO");
        expect(c.html, donde).not.toContain("privacy.bivelio.com");
        expect(c.html, donde).not.toContain("#070B14");
        expect(c.texto.endsWith("BiVelio Shield · shield.bivelio.com"), donde).toBe(true);
        // La copy es de la plataforma: el asunto es el mismo que en privacy.
        expect(c.asunto, donde).toBe(juegoPara(accion)[idioma].asunto);
      }
    }
  });

  it("⛔ la marca shield solo existe dentro de privacy: GPOS y savings la ignoran", () => {
    const base = { accion: "signup" as const, idioma: "en" as const, enlace: "https://x.example/cb?token_hash=t&type=signup", destinatario: "persona@ejemplo.com" };
    expect(componerCorreoAuth({ ...base, producto: "gpos", marca: "shield" })).toEqual(componerCorreoAuth({ ...base, producto: "gpos" }));
    expect(componerCorreoAuth({ ...base, producto: "savings", marca: "shield" })).toEqual(componerCorreoAuth({ ...base, producto: "savings" }));
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

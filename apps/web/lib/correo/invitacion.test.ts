import { describe, it, expect } from "vitest";

import { componerInvitacion, escapar, idiomaValido, nombreParaCorreo, IDIOMAS, type Idioma } from "./invitacion";

/**
 * El correo de invitación. Es el ÚNICO que este producto manda a alguien de fuera
 * del equipo, así que se prueban tres cosas distintas:
 *
 *  1. Que no se escape nada que no deba: HTML inyectado desde el nombre de la
 *     organización, que lo escribe el cliente.
 *  2. Que los doce idiomas estén completos. Un idioma a medias no da error: manda
 *     `undefined` dentro del correo, a un desconocido, con nuestro logo.
 *  3. Que no lleve datos de la organización que el destinatario aún no puede ver.
 */

const base = {
  org: "Acme S.L.",
  quienInvita: "ana@acme.com",
  rol: "member",
  enlace: "https://savings.bivelio.com/es/invitacion/bvi_secreto",
  dias: 7,
  idioma: "es" as Idioma,
};

describe("los doce idiomas están completos", () => {
  it("son doce y no se repiten", () => {
    expect(IDIOMAS).toHaveLength(12);
    expect(new Set(IDIOMAS).size).toBe(12);
  });

  for (const idioma of IDIOMAS) {
    it(`${idioma}: ningún hueco, ninguna sustitución sin resolver`, () => {
      const c = componerInvitacion({ ...base, idioma });
      for (const parte of [c.asunto, c.html, c.texto]) {
        expect(parte).toBeTruthy();
        // Lo que de verdad pasa cuando falta una clave.
        expect(parte).not.toContain("undefined");
        expect(parte).not.toContain("[object");
        // Ninguna llave sin sustituir.
        expect(parte).not.toMatch(/\{(org|quien|rol|dias)\}/);
      }
      // El nombre de la organización y el enlace tienen que aparecer SIEMPRE: son
      // las dos cosas sin las que el correo no sirve para nada.
      // Desde la auditoría del lanzamiento el nombre va en el CUERPO y no en el
      // asunto, que es fijo de plantilla (ver «el asunto no lo elige quien invita»).
      expect(c.html).toContain("Acme S.L.");
      expect(c.texto).toContain("Acme S.L.");
      expect(c.html).toContain(base.enlace);
      expect(c.texto).toContain(base.enlace);
    });
  }

  for (const idioma of IDIOMAS) {
    it(`${idioma}: los tres roles tienen nombre propio`, () => {
      for (const rol of ["admin", "member", "billing"]) {
        const c = componerInvitacion({ ...base, idioma, rol });
        expect(c.html).not.toContain("undefined");
        // El rol no puede salir con su nombre técnico en inglés dentro de un
        // correo en vietnamita.
        if (idioma !== "en") expect(c.html.includes(`<b>${rol}</b>`)).toBe(false);
      }
    });
  }

  it("un idioma desconocido cae a español en vez de romper", () => {
    for (const x of [null, undefined, "", "zz", "es-ES", "../../etc"]) {
      expect(IDIOMAS).toContain(idiomaValido(x));
    }
    expect(idiomaValido("de")).toBe("de");
  });
});

describe("nada que venga de fuera entra crudo en el HTML", () => {
  it("⛔ el nombre de la organización se escapa", () => {
    // Lo escribe el cliente en Stripe o en el panel, y acaba en un correo que
    // mandamos NOSOTROS a un tercero. Es la vía más directa a que nuestro dominio
    // firme un HTML ajeno.
    const c = componerInvitacion({ ...base, org: '<img src=x onerror=alert(1)>"' });
    // Lo que importa no es que la cadena `onerror` desaparezca —como TEXTO es
    // inerte— sino que no quede ni un `<` ni una comilla sin escapar que permita
    // salirse de donde está y abrir una etiqueta o un atributo. Desde el 02-09
    // la carcasa lleva UN <img> legítimo (el logo, con src fijo de la casa):
    // la verja apunta al PAYLOAD, no a la etiqueta en general — el inyectado no
    // puede aparecer sin escapar, y el único src de imagen permitido es el logo.
    expect(c.html).not.toContain("<img src=x");
    // `onerror=` SÍ queda como texto escapado (&lt;img … onerror=…&gt;) y como
    // texto es inerte — el propio comentario de arriba lo dice: la verja es que
    // no sobreviva NINGÚN `<` ni comilla sin escapar, no que la palabra muera.
    expect(c.html).toContain("&lt;img");
    expect(c.html).toContain("&gt;&quot;");
    const srcsDeImagen = [...c.html.matchAll(/<img [^>]*src="([^"]*)"/g)].map((m) => m[1]);
    expect(srcsDeImagen).toEqual(["https://savings.bivelio.com/correo/logo-savings.png"]);
  });

  it("⛔ quien invita también se escapa", () => {
    const c = componerInvitacion({ ...base, quienInvita: "<script>x</script>" });
    expect(c.html).not.toContain("<script>");
  });

  it("⛔ el enlace se escapa dentro del href", () => {
    const c = componerInvitacion({ ...base, enlace: 'https://x.com/"><script>y</script>' });
    expect(c.html).not.toContain("<script>");
    expect(c.html).toContain("&quot;");
  });

  it("escapar cubre los cinco de siempre", () => {
    expect(escapar('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });
});

describe("qué NO lleva el correo", () => {
  it("⛔ ningún dato de la organización más allá de su nombre", () => {
    // El destinatario todavía no ha aceptado nada, y un correo se reenvía. Ni
    // gasto, ni asientos, ni quién más está dentro.
    const c = componerInvitacion(base);
    const todo = `${c.asunto}${c.html}${c.texto}`.toLowerCase();
    for (const filtrado of ["€", "$", "seats", "asientos", "usage", "gasto", "bvk_", "sk_", "price_"]) {
      expect(todo).not.toContain(filtrado);
    }
  });

  it("el texto plano lleva el enlace pinchable y sin etiquetas", () => {
    // Hay clientes de correo que no pintan el botón, y hay quien no pincha en
    // botones de un remitente que no conoce.
    const c = componerInvitacion(base);
    expect(c.texto).not.toContain("<b>");
    expect(c.texto).not.toContain("<div");
    expect(c.texto).toContain("https://savings.bivelio.com/es/invitacion/bvi_secreto");
  });

  it("dice cuándo caduca y qué hacer si no esperabas nada", () => {
    const c = componerInvitacion(base);
    expect(c.texto).toContain("7");
    expect(c.texto.length).toBeGreaterThan(80);
  });
});

describe("el asunto no lo elige quien invita (W3: la ruta no es un repetidor de correo)", () => {
  const CEBO = "URGENT: your invoice is overdue, pay at evil.example";

  for (const idioma of IDIOMAS) {
    it(`${idioma}: el asunto es el de la plantilla, diga lo que diga el nombre de la organización`, () => {
      const normal = componerInvitacion({ ...base, idioma });
      const cebo = componerInvitacion({ ...base, idioma, org: CEBO });
      expect(cebo.asunto).toBe(normal.asunto);
      expect(cebo.asunto).not.toMatch(/URGENT|invoice|evil|Acme/);
      expect(cebo.asunto).toContain("BiVelio");
    });
  }

  it("⛔ nada con forma de enlace llega al cuerpo: ni URL, ni dominio, ni dirección", () => {
    for (const org of [
      CEBO,
      "Pague en https://cobros-inventados.example/factura",
      "www.cobros-inventados.example",
      "soporte@cobros-inventados.example",
      "cobros-inventados.example/pagar",
      "cobros\u200b.inventados\u200b.example",
      "ｃｏｂｒｏｓ．ｅｘａｍｐｌｅ",
      "203.0.113.9:8080",
    ]) {
      const c = componerInvitacion({ ...base, org });
      // Lo único del correo que escribe el usuario es el nombre, y va en la
      // primera negrita del cuerpo. Se mira ESE trozo: el resto es plantilla.
      const enCorreo = /<b>(.*?)<\/b>/.exec(c.html)![1]!;
      expect(enCorreo).toBe(escapar(nombreParaCorreo(org)));
      expect(c.texto).toContain(enCorreo);
      expect(enCorreo, org).not.toMatch(/[\p{L}\p{N}]\.[\p{L}\p{N}-]{2,}/u);
      expect(enCorreo, org).not.toMatch(/:\/\/|@|\/|\d[.:]\d/);
      expect(enCorreo, org).not.toMatch(/[\u200b-\u200f\u202a-\u202e]/);
      expect(c.html).not.toContain(org);
      expect(c.texto).not.toContain(org);
    }
  });

  it("un nombre normal pasa intacto, y uno larguísimo se recorta", () => {
    for (const nombre of ["Acme S.L.", "Talleres Ruiz e Hijos S.A.", "Müller & Söhne GmbH", "Đại Việt Co., Ltd."]) {
      expect(nombreParaCorreo(nombre)).toBe(nombre);
    }
    expect(Array.from(nombreParaCorreo("x".repeat(80))).length).toBe(60);
    expect(nombreParaCorreo("   ")).toBe("BiVelio");
  });
});

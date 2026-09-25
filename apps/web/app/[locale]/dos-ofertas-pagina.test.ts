import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * LA PORTADA DE LAS DOS OFERTAS, LEÍDA DEL FUENTE.
 *
 * Tres decisiones que un cambio posterior podría deshacer sin que nada se
 * ponga rojo:
 *   · El gateway va SIN cifra: no hay un ahorro medido y publicado que la
 *     respalde. Su tarjeta no lee `hero.proofs` ni el artefacto A/B, ni escribe
 *     un porcentaje.
 *   · La cifra del SDK es la fila de `hero.proofs` (la de la verja
 *     cifra-del-heroe), leída y no copiada.
 *   · El verificador vuelve a la portada, pero el PROYECTOR no: su retirada en
 *     9feb377 (#85) fue por los porcentajes que inventaba el visitante, y ese
 *     motivo sigue en pie. La página no importa ProjectorVerifier.
 */
const PAGINA = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
/** El fuente sin comentarios: lo que se comprueba es el JSX, no lo que se cuenta de él. */
const CODIGO = PAGINA.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** El bloque de una sección `<section id="x">` hasta su `</section>`. */
function seccion(id: string): string {
  const ini = CODIGO.indexOf(`<section id="${id}">`);
  expect(ini, `#${id}`).toBeGreaterThan(-1);
  return CODIGO.slice(ini, CODIGO.indexOf("</section>", ini));
}

describe("portada: dos ofertas, cada una con su bloque", () => {
  it("las anclas existen y en este orden: ofertas → SDK → medición → verificador → instalación → gateway → skill → precios", () => {
    // El skill (suscripción, gratis) lleva su propia banda: bajo la del gateway
    // «con API key» se leía como parte de esa oferta.
    const ids = ["offers", "sdk", "measured", "verify", "sdk-install", "gateway", "skill", "pricing"];
    const pos = ids.map((id) => CODIGO.indexOf(`id="${id}"`));
    for (const [i, p] of pos.entries()) expect(p, ids[i]).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("el botón principal del héroe lleva a #offers, y el viejo «Ver lo medido» ya no está", () => {
    const cta = CODIGO.slice(CODIGO.indexOf('className="hero-cta"'), CODIGO.indexOf('className="hero-note"'));
    expect(cta).toContain('href="#offers"');
    expect(cta).toContain('t("hero.ctaOffers")');
    expect(PAGINA).not.toContain("hero.ctaRun");
  });

  it("la tarjeta del gateway no lleva cifra: ni hero.proofs, ni el artefacto, ni un porcentaje", () => {
    const ofertas = seccion("offers");
    const gateway = ofertas.slice(ofertas.indexOf('t("offers.gateway.name")'));
    expect(gateway.length).toBeGreaterThan(200);
    for (const prohibido of ["proofs", "cifra", "proofSdk", "ab.", "%"]) {
      expect(gateway, prohibido).not.toContain(prohibido);
    }
    // Y en el fuente CON comentarios tampoco se cuela nada de eso dentro de la tarjeta.
    const bruto = PAGINA.slice(PAGINA.indexOf('t("offers.gateway.name")'), PAGINA.indexOf("</section>", PAGINA.indexOf('t("offers.gateway.name")')));
    for (const prohibido of ["proofs", "cifra", "ab.", "%"]) expect(bruto, prohibido).not.toContain(prohibido);
  });

  it("la tarjeta del SDK enseña la fila de hero.proofs, leída del mensaje y no copiada", () => {
    expect(CODIGO).toMatch(/const proofs = t\.raw\("hero\.proofs"\)/);
    expect(CODIGO).toMatch(/const proofSdk = proofs\[0\]/);
    const ofertas = seccion("offers");
    const sdk = ofertas.slice(ofertas.indexOf('t("offers.sdk.name")'), ofertas.indexOf('t("offers.gateway.name")'));
    expect(sdk).toContain("{proofSdk.cifra}");
    expect(sdk).toContain("{proofSdk.modelo}");
    expect(sdk).toContain('href="#measured"');
    expect(sdk).toContain('href="#verify"');
  });

  // Cable trampa con #321 (fix/titular-lo-que-lleva-npm), abierto a la vez que
  // este PR: trae `lib/bench/sdk-instalado.ts` y baja `hero.proofs` a un titular
  // PROVISIONAL (recalculado, no medido con el SDK de npm) que el héroe
  // acompaña de `hero.proofSdkPendiente` mientras la tirada publicada no mida
  // el SDK tal como se instala. Esta tarjeta enseña esa misma fila: el día que
  // los dos PR convivan, tiene que llevar la misma nota bajo la misma regla, o
  // la portada presentaría como medido lo que no lo es. Se pone rojo en quien
  // rebase segundo, en cualquier orden.
  it.skipIf(!existsSync(fileURLToPath(new URL("../../lib/bench/sdk-instalado.ts", import.meta.url))))(
    "con la regla del SDK instalado en el árbol, la tarjeta del SDK lleva su nota provisional",
    () => {
      const ofertas = seccion("offers");
      const sdk = ofertas.slice(ofertas.indexOf('t("offers.sdk.name")'), ofertas.indexOf('t("offers.gateway.name")'));
      expect(sdk).toContain("SDK_INSTALADO");
      expect(sdk).toMatch(/SdkPendiente/);
    },
  );

  it("el verificador vive en #verify, y la página no importa el proyector", () => {
    expect(seccion("verify")).toContain("<FormatVerifier");
    expect(PAGINA).not.toContain("ProjectorVerifier");
  });
});

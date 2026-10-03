import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * LA PORTADA DE LAS DOS OFERTAS, LEÍDA DEL FUENTE.
 *
 * Tres decisiones que un cambio posterior podría deshacer sin que nada se
 * ponga rojo:
 *   · El gateway lleva UNA cifra desde el 2026-10-03: el neto de la rebaja de
 *     caché que simuló el banco de TTL (lib/portada/palanca-ttl.ts, con verja
 *     contra su informe), enlazada a su sección de /benchmarks. Su tarjeta no
 *     lee `hero.proofs` ni el artefacto A/B, ni lleva un porcentaje tecleado.
 *   · La cifra del SDK son las filas de lo medido (con repeticiones Y sin
 *     ellas, nunca la primera sola), construidas de lib/portada/banco-en-vivo.ts
 *     —con verja contra sus informes— y no del artefacto sintético.
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

  it("el héroe (dueño, 2026-10-03): «Empezar» lleva al alta y el secundario al banco público", () => {
    // Hasta el 2026-10-03 el botón principal preguntaba «¿SDK o gateway?» y
    // llevaba a #offers. El héroe nuevo es titular, línea, dos botones y la
    // captura del panel: la elección entre las dos ofertas sigue justo debajo.
    const cta = CODIGO.slice(CODIGO.indexOf('className="hero-cta"'), CODIGO.indexOf('className="hpanel-shot"'));
    expect(cta).toMatch(/className="btn" href="\/signup">\s*\{t\("hero\.ctaStart"\)\}/);
    expect(cta).toMatch(/className="btn ghost" href="\/benchmarks">\s*\{t\("hero\.ctaBench"\)\}/);
    expect(PAGINA).not.toContain("hero.ctaRun");
    expect(PAGINA).not.toContain("hero.ctaOffers");
  });

  it("la tarjeta del gateway lleva UNA cifra, la del banco de TTL, y ninguna escrita a mano (dueño, 2026-10-03)", () => {
    const ofertas = seccion("offers");
    const gateway = ofertas.slice(ofertas.indexOf('t("offers.gateway.name")'));
    expect(gateway.length).toBeGreaterThan(200);
    // La fila sale de lib/portada/palanca-ttl.ts (con su verja contra el informe).
    expect(gateway).toContain("<FilasMedidas filas={[filaDeLaPalancaTtl(t, locale)]} />");
    expect(gateway).toContain('t("offers.gateway.figureNote")');
    expect(gateway).not.toContain("offer-nofig");
    // Ni el artefacto sintético ni un número tecleado en la tarjeta.
    for (const prohibido of ["proofs", "proofSdk", "ab.", "%"]) expect(gateway, prohibido).not.toContain(prohibido);
  });

  it("la tarjeta del gateway enlaza al informe: la sección #gateway-ttl del banco público, con idioma (dueño, 2026-10-03)", () => {
    const ofertas = seccion("offers");
    const gateway = ofertas.slice(ofertas.indexOf('t("offers.gateway.name")'));
    // El `Link` de @/i18n/navigation antepone el idioma; un <a> a secas lo perdería.
    expect(gateway).toMatch(/<Link href="\/benchmarks#gateway-ttl">\{t\("offers\.gateway\.benchLink"\)\}<\/Link>/);
    expect(PAGINA).toMatch(/import \{[^}]*\bLink\b[^}]*\} from "@\/i18n\/navigation"/);
    // Dentro de la caja de la cifra, justo debajo de su nota: la cifra y su informe van juntos.
    const fig = gateway.slice(gateway.indexOf('className="offer-fig"'), gateway.indexOf('className="offer-install"'));
    expect(fig.indexOf('t("offers.gateway.figureNote")')).toBeGreaterThan(-1);
    expect(fig.indexOf("/benchmarks#gateway-ttl")).toBeGreaterThan(fig.indexOf('t("offers.gateway.figureNote")'));
    // Y el ancla existe en la página de destino.
    const banco = readFileSync(new URL("../components/BancoPublico.tsx", import.meta.url), "utf8");
    expect(banco).toContain('id="gateway-ttl"');
  });

  it("la fila del gateway toma sus números de PALANCA_TTL y su texto de los mensajes", () => {
    const fuente = readFileSync(new URL("../components/MedidoEnVivo.tsx", import.meta.url), "utf8");
    const fn = fuente.slice(fuente.indexOf("export function filaDeLaPalancaTtl"), fuente.indexOf("/** Las filas, pintadas"));
    expect(fn).toContain("const P = PALANCA_TTL;");
    expect(fn).toContain('t("offers.gateway.figureQue"');
    for (const campo of ["P.neto.point", "P.neto.lower", "P.neto.upper", "P.confianza", "P.sesiones"]) expect(fn).toContain(campo);
  });

  it("la tarjeta del SDK enseña la cifra medida con repeticiones (sin la baldosa del cero, 2026-10-02)", () => {
    expect(CODIGO).toContain("const filasMedidas: FilaMedida[] = filasDelBancoEnVivo(t, locale);");
    expect(CODIGO).toContain("BANCO_EN_VIVO");
    const ofertas = seccion("offers");
    const sdk = ofertas.slice(ofertas.indexOf('t("offers.sdk.name")'), ofertas.indexOf('t("offers.gateway.name")'));
    expect(sdk).toContain("<FilasMedidas filas={filasMedidas.slice(0, 1)} />");
    expect(sdk).toContain('t("offers.sdk.figureNote")');
    expect(sdk).toContain('href="#measured"');
    expect(sdk).toContain('href="#verify"');
  });

  it("⛔ la portada no lee el artefacto sintético ni su nota provisional", () => {
    expect(CODIGO).not.toMatch(/ab-live|abData|SDK_INSTALADO|SdkPendiente|hero\.proofs|ReciboMedido/);
  });

  it("el verificador vive en #verify, y la página no importa el proyector", () => {
    expect(seccion("verify")).toContain("<FormatVerifier");
    expect(PAGINA).not.toContain("ProjectorVerifier");
  });
});

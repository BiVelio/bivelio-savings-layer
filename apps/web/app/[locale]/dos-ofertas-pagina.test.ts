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
 *     contra su informe), enlazada a su sección de /benchmarks. No lee
 *     `hero.proofs` ni el artefacto A/B, ni lleva un porcentaje tecleado.
 *   · La cifra del SDK son las filas de lo medido, construidas de
 *     lib/portada/banco-en-vivo.ts —con verja contra sus informes— y no del
 *     artefacto sintético.
 *   · El verificador existe, pero el PROYECTOR no: su retirada en 9feb377
 *     (#85) fue por los porcentajes que inventaba el visitante, y ese motivo
 *     sigue en pie. Ninguna página importa ProjectorVerifier.
 *
 * LA PORTADA CORTA (dueño, 2026-11). «Dónde lo conectas» (#offers) reúne lo
 * que eran cinco secciones y YA NO lleva cifras: cada cifra está en #measured,
 * en su recibo y con su clase de evidencia. El verificador y la instalación
 * completa viven en /how-it-works. Las verjas de arriba siguen: solo cambia
 * dónde se mira.
 */
const PAGINA = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
const COMO_FUNCIONA = readFileSync(fileURLToPath(new URL("./how-it-works/page.tsx", import.meta.url)), "utf8");
/** El fuente sin comentarios: lo que se comprueba es el JSX, no lo que se cuenta de él. */
const sinComentarios = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const CODIGO = sinComentarios(PAGINA);
const CODIGO_COMO_FUNCIONA = sinComentarios(COMO_FUNCIONA);

/** El bloque de una sección `<section id="x">` hasta su `</section>`. */
function seccion(id: string, codigo = CODIGO): string {
  const ini = codigo.indexOf(`<section id="${id}">`);
  expect(ini, `#${id}`).toBeGreaterThan(-1);
  return codigo.slice(ini, codigo.indexOf("</section>", ini));
}

/** Los tres recibos de #measured, en su orden: OpenAI, Claude y el gateway. */
function recibos(): [string, string, string] {
  const partes = seccion("measured").split('<article className="prueba-item');
  expect(partes.length, "recibos de #measured").toBe(4);
  return [partes[1]!, partes[2]!, partes[3]!];
}

describe("portada: dos ofertas, cada una con su bloque", () => {
  it("las anclas existen y en este orden: ofertas → instalación → SDK → gateway → skill → medición → precios", () => {
    // Portada corta (2026-11): #offers contiene el selector SDK · Gateway, y las
    // anclas de siempre (#sdk-install —la que enlaza bivelio.com—, #sdk,
    // #gateway, #skill) siguen dentro de esa sección. La prueba va después.
    const ids = ["offers", "sdk-install", "sdk", "gateway", "skill", "measured", "pricing"];
    const pos = ids.map((id) => CODIGO.indexOf(`id="${id}"`));
    for (const [i, p] of pos.entries()) expect(p, ids[i]).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    // Todas las de conexión, DENTRO de #offers.
    const ofertas = seccion("offers");
    for (const id of ["sdk-install", "sdk", "gateway", "skill"]) expect(ofertas, id).toContain(`id="${id}"`);
    // Lo que se mudó no deja un ancla huérfana en la portada, y existe en su nueva casa.
    for (const id of ["verify", "ledgers", "explica", "devs"]) expect(CODIGO, id).not.toContain(`id="${id}"`);
    for (const id of ["verify", "ledgers", "explica", "install-gateway", "skill"]) expect(CODIGO_COMO_FUNCIONA, id).toContain(`id="${id}"`);
    // #install-sdk es la sección final de «cómo funciona» (la pinta el componente).
    const hiw = readFileSync(new URL("../components/HowItWorks.tsx", import.meta.url), "utf8");
    expect(hiw).toContain('id={entera ? "install-sdk" : undefined}');
    // Y la portada redirige las anclas antiguas, con idioma.
    const enlaces = readFileSync(new URL("../components/landing/EnlacesAntiguos.tsx", import.meta.url), "utf8");
    expect(CODIGO).toContain("<EnlacesAntiguos />");
    for (const destino of ['verify: "/how-it-works#verify"', 'ledgers: "/how-it-works#ledgers"', 'explica: "/how-it-works#explica"']) expect(enlaces).toContain(destino);
    expect(enlaces).toMatch(/import \{ useRouter \} from "@\/i18n\/navigation"/);
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

  it("el recibo del gateway lleva UNA cifra, la del banco de TTL, y ninguna escrita a mano (dueño, 2026-10-03)", () => {
    // Desde la portada corta la cifra no va en la tarjeta de #offers sino en su
    // recibo de #measured. La verja es la misma: sale de lib/portada/palanca-ttl.ts
    // (con su verja contra el informe) por `filaDeLaPalancaTtl`, nunca tecleada.
    expect(CODIGO).toContain("const filaTtl = filaDeLaPalancaTtl(t, locale);");
    const gateway = recibos()[2];
    expect(gateway.length).toBeGreaterThan(200);
    expect(gateway).toContain("valor: filaTtl.cifra");
    expect(gateway).toContain("{filaTtl.que}");
    expect(gateway).toContain('t("offers.gateway.figureNote")');
    // Es un replay, no un A/B: su propia insignia.
    expect(gateway).toContain('evidencia={{ tipo: "replay-gateway", label: tu("evidence.replayGateway") }}');
    expect(gateway).not.toContain('tipo: "ab-sdk"');
    expect(gateway).not.toContain("offer-nofig");
    // Ni el artefacto sintético ni un número tecleado en el recibo.
    for (const prohibido of ["proofs", "proofSdk", "ab.", "%"]) expect(gateway, prohibido).not.toContain(prohibido);
    // Y la sección de conexión no lleva ninguna cifra: ni filas de lo medido, ni recibo, ni porcentaje.
    const ofertas = seccion("offers");
    for (const prohibido of ["FilasMedidas", "<Recibo", "filaTtl", "filasMedidas", "proofs", "%"]) expect(ofertas, prohibido).not.toContain(prohibido);
  });

  it("el recibo del gateway enlaza al informe: la sección #gateway-ttl del banco público, con idioma (dueño, 2026-10-03)", () => {
    const gateway = recibos()[2];
    // El `Link` de @/i18n/navigation antepone el idioma; un <a> a secas lo perdería.
    expect(gateway).toMatch(/<Link href="\/benchmarks#gateway-ttl">\{t\("offers\.gateway\.benchLink"\)\}<\/Link>/);
    expect(PAGINA).toMatch(/import \{[^}]*\bLink\b[^}]*\} from "@\/i18n\/navigation"/);
    // Junto a la cifra y justo debajo de su nota: la cifra y su informe van juntos.
    expect(gateway.indexOf('t("offers.gateway.figureNote")')).toBeGreaterThan(gateway.indexOf("valor: filaTtl.cifra"));
    expect(gateway.lastIndexOf("/benchmarks#gateway-ttl")).toBeGreaterThan(gateway.indexOf('t("offers.gateway.figureNote")'));
    // El resguardo del propio recibo también lleva a su informe.
    expect(gateway).toContain('href: "/benchmarks#gateway-ttl"');
    // Y el ancla existe en la página de destino.
    const banco = readFileSync(new URL("../components/BancoPublico.tsx", import.meta.url), "utf8");
    expect(banco).toContain('id="gateway-ttl"');
  });

  it("la fila del gateway toma sus números de PALANCA_TTL, con dos decimales, y su texto de los mensajes", () => {
    const fuente = readFileSync(new URL("../components/MedidoEnVivo.tsx", import.meta.url), "utf8");
    const fn = fuente.slice(fuente.indexOf("export function filaDeLaPalancaTtl"), fuente.indexOf("/** Las filas, pintadas"));
    expect(fn).toContain("const P = PALANCA_TTL;");
    expect(fn).toContain('t("offers.gateway.figureQue"');
    expect(fn).toContain("minimumFractionDigits: 2, maximumFractionDigits: 2");
    for (const campo of ["P.neto.point", "P.neto.lower", "P.neto.upper", "P.confianza", "P.sesiones"]) expect(fn).toContain(campo);
  });

  it("los recibos del SDK enseñan las cifras medidas con repeticiones (sin la baldosa del cero, 2026-10-02)", () => {
    expect(CODIGO).toContain("const filasMedidas: FilaMedida[] = filasDelBancoEnVivo(t, locale);");
    expect(CODIGO).toContain("BANCO_EN_VIVO");
    // Las dos filas de lo medido, cada una en su recibo de #measured, con la
    // insignia de A/B y su condición (la frase de la fila) desplegable debajo.
    expect(CODIGO).toContain("const [filaOpenAi, filaClaude] = filasMedidas as [FilaMedida, FilaMedida];");
    const [openai, claude] = recibos();
    for (const [recibo, fila] of [[openai, "filaOpenAi"], [claude, "filaClaude"]] as const) {
      expect(recibo, fila).toContain(`valor: ${fila}.cifra`);
      expect(recibo, fila).toContain(`{${fila}.que}`);
      expect(recibo, fila).toContain('evidencia={{ tipo: "ab-sdk", label: tu("evidence.abSdk") }}');
      expect(recibo, fila).not.toContain("%");
    }
    expect(openai).toContain('t("offers.sdk.figureNote")');
    // El panel del SDK de #offers lleva a la prueba y al verificador (que vive en /how-it-works).
    const ofertas = seccion("offers");
    const sdk = ofertas.slice(ofertas.indexOf('data-panel="sdk"'), ofertas.indexOf('data-panel="gateway"'));
    expect(sdk.length).toBeGreaterThan(200);
    expect(sdk).toContain('href="#measured"');
    expect(sdk).toMatch(/<Link href="\/how-it-works#verify">\{t\("offers\.sdk\.ctaVerify"\)\}<\/Link>/);
    expect(sdk).toMatch(/<Link className="btn ghost" href="\/how-it-works#install-sdk">/);
  });

  it("⛔ la portada no lee el artefacto sintético ni su nota provisional", () => {
    expect(CODIGO).not.toMatch(/ab-live|abData|SDK_INSTALADO|SdkPendiente|hero\.proofs|ReciboMedido/);
  });

  it("el verificador vive en #verify de /how-it-works (salió de la portada en 2026-11), y ninguna de las dos páginas importa el proyector", () => {
    expect(seccion("verify", CODIGO_COMO_FUNCIONA)).toContain("<FormatVerifier");
    expect(COMO_FUNCIONA).toContain('import { FormatVerifier } from "@/app/components/FormatVerifier";');
    expect(PAGINA).not.toContain("FormatVerifier");
    expect(PAGINA).not.toContain("ProjectorVerifier");
    expect(COMO_FUNCIONA).not.toContain("ProjectorVerifier");
  });
});

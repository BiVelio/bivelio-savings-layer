import { getTranslations, setRequestLocale } from "next-intl/server";

import Footer from "@/app/components/Footer";
import { FormatVerifier } from "@/app/components/FormatVerifier";
import { HowItWorks } from "@/app/components/HowItWorks";
import { LogoProveedor } from "@/app/components/LogoProveedor";
import { SkillPorSuperficie } from "@/app/components/SkillPorSuperficie";
import { SnippetPorSistema } from "@/app/components/SnippetPorSistema";
import { CodeFrame, PageHeader, SectionHead } from "@/app/components/ui";
import { VideoExplicativo } from "@/app/components/VideoExplicativo";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";
import { BANCO_EN_VIVO } from "@/lib/portada/banco-en-vivo";

/**
 * Página pública «¿Dónde se instala el ahorro?» — la explicación sin jerga que
 * responde a la pregunta que se hace cualquier visitante no técnico: «¿y esto
 * cómo lo instalo yo, que uso ChatGPT?». Indexable, con canonical + hreflang y
 * su propia tarjeta OG (ver `opengraph-image.tsx` al lado).
 *
 * TAMBIÉN ES EL SITIO DE QUIEN QUIERE COMPROBARLO (dueño, 2026-11). La portada
 * se acortó y lo que allí «nadie se iba a mirar» vive ahora aquí, entero, para
 * quien sí quiere hacer pruebas:
 *   · #explica  — las cuatro ideas en palabras normales, con sus animaciones;
 *   · #ledgers  — «contabilidad honesta»: los cuatro libros que nunca se suman;
 *   · #verify   — el verificador de formato, con tus datos y sin cuenta;
 *   · #install-sdk, #install-gateway y #skill — la instalación completa.
 * Sus textos siguen en `landing.*` (no se duplican) y la portada redirige las
 * anclas antiguas (#verify, #ledgers, #explica) hasta aquí.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "howItWorks" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/how-it-works`);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("how-it-works") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function HowItWorksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("howItWorks");
  // Los bloques que llegaron de la portada conservan sus claves de `landing`.
  const tl = await getTranslations("landing");
  const tu = await getTranslations("ui");

  const ledgers = tl.raw("ledgers") as { idx: string; name: string; desc: string }[];

  return (
    <div className="lp hiw-page">
      <main className="wrap">
        {/* Instalar open source no pasa por registro ni compra: la acción principal
            lleva a la instalación completa, más abajo en esta página; la de apoyo,
            al banco. */}
        <PageHeader
          className="hiw-hero"
          eyebrow={t("eyebrow")}
          titulo={t("title")}
          lede={t("lede")}
          acciones={
            <>
              <a className="btn btn-lg" href="#install-sdk">
                {t("hero.ctaInstall")}
              </a>
              <Link className="btn btn-lg ghost" href="/benchmarks">
                {t("hero.ctaResults")}
              </Link>
            </>
          }
        />
        <HowItWorks
          variant="landing"
          profundiza={
            <>
              {/* EN PALABRAS NORMALES — la explicación para todo el mundo (dueño,
                  2026-09-04): cuatro ideas en lenguaje llano, cada una con su
                  animación de 8 s. Los vídeos son mudos y sin texto en pantalla a
                  propósito: la página se sirve en 12 idiomas. Aquí no se promete
                  ningún número. */}
              <section id="explica">
                <SectionHead eyebrow={tl("explica.eyebrow")} titulo={tl("explica.title")} lede={tl("explica.sub")} />
                <div className="explica-grid explica-grid--cuatro">
                  {(tl.raw("explica.pasos") as { title: string; body: string }[]).map((p, i) => (
                    <div className="explica-card" key={p.title}>
                      <VideoExplicativo src={`/videos/explica-${i + 1}.mp4`} poster={`/videos/explica-${i + 1}.jpg`} etiqueta={p.title} />
                      <div className="explica-texto">
                        <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                        <h4>{p.title}</h4>
                        <p>{p.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {/* LEDGERS — cuatro libros que nunca se suman. Las tarjetas DESCRIBEN
                  los libros, sin cifra, y la nota dice de qué libro salió el ahorro
                  medido en el banco público. */}
              <section id="ledgers">
                <SectionHead eyebrow={tl("ledgersHead.eyebrow")} titulo={tl("ledgersHead.title")} lede={tl("ledgersHead.body")} />
                <div className="ledgers">
                  {ledgers.map((l) => (
                    <div className="ledger" key={l.idx}>
                      <div className="idx">{l.idx}</div>
                      <h4>{l.name}</h4>
                      <p>{l.desc}</p>
                    </div>
                  ))}
                </div>
                <p className="ledgers-modelo">{tl("ledgersHead.providerNote", { fecha: BANCO_EN_VIVO.fecha })}</p>
              </section>

              {/* PRUÉBALO CON TUS DATOS — el verificador de formato, sin cuenta.
                  El PROYECTOR no vuelve (9feb377, #85: deslizadores donde el
                  visitante inventaba sus porcentajes) y esta página no lo importa.
                  El verificador sí: corre el selector de formato real del bundle web
                  en el navegador, con el tokenizador exacto, abre con la muestra de
                  menor efecto, redondea hacia abajo y dice en pantalla que es UNA
                  palanca, no la factura. */}
              <section id="verify">
                <SectionHead eyebrow={tl("verify.eyebrow")} titulo={tl("verify.title")} lede={tl("verify.sub")} />
                <FormatVerifier />
                <div className="offer-cta verify-cta">
                  <a className="btn ghost" href="#install-sdk">
                    {tl("verify.ctaInstall")}
                  </a>
                </div>
              </section>
            </>
          }
          instalacion={
            <>
              {/* INSTALACIÓN COMPLETA · SDK — la vía de un comando (0.4.26):
                  `init` lee el package.json, detecta la pila e imprime el cableado
                  exacto y una comprobación que no llama al modelo. No escribe nada
                  sin permiso. */}
              <div className="hiw-muro">
                <p className="lp-nota">{tl.rich("integrate.initNote", { b: (c) => <b>{c}</b>, code: (c) => <code>{c}</code> })}</p>
                <CodeFrame
                  className="hiw-code"
                  etiqueta="Terminal"
                  copiar={{ texto: "npx @bivelio/savings-layer@latest init", etiqueta: tu("copy"), etiquetaCopiado: tu("copied") }}
                >
                  <pre className="code">
                    <span className="k">npx</span>
                    {" @bivelio/savings-layer@latest init"}
                  </pre>
                </CodeFrame>
                {/* Hecho para desarrolladores — cuatro hechos del paquete, ninguno
                    una promesa: cero dependencias, un SavingsReport por llamada,
                    tráfico directo y streaming con el mismo informe. Sin cifras. */}
                <div className="devs-grid hiw-devs">
                  {(tl.raw("devs.cards") as { title: string; body: string; mono: string }[]).map((c) => (
                    <div className="dev-card" key={c.title}>
                      <span className="mono">{c.mono}</span>
                      <h4>{c.title}</h4>
                      <p>{c.body}</p>
                    </div>
                  ))}
                </div>
                {/* Sistemas donde ya viven las automatizaciones del cliente: logos
                    oficiales a color (decisión del dueño). El texto mantiene la
                    afirmación honesta: se mide la llamada a la API con su clave
                    (#313; lo fija messages/copia-del-gateway.test.ts). */}
                <div className="sys-marquee" aria-label="Salesforce, HubSpot, Odoo, Zapier, n8n, UiPath">
                  <div className="sys-track">
                    {[0, 1].map((copia) =>
                      ["Salesforce", "HubSpot", "Odoo", "Zapier", "n8n", "UiPath"].map((sys) => (
                        <span className="sys" key={`${copia}-${sys}`} aria-hidden={copia === 1}>
                          <LogoProveedor marca={sys} size={16} /> {sys}
                        </span>
                      )),
                    )}
                  </div>
                </div>
                <p className="sys-note">{tl("systems.caption")}</p>
              </div>

              {/* INSTALACIÓN COMPLETA · GATEWAY — el medidor de terminales (S3):
                  Claude Code/Codex sin tocar código. Aquí solo se promete MEDIR. */}
              <div className="hiw-muro" id="install-gateway">
                <SectionHead como="h3" pequeno eyebrow={tl("gateway.eyebrow")} titulo={tl("gateway.title")} lede={tl("gateway.body")} />
                {/* Los comandos NO son iguales por sistema: `export` es POSIX; en
                    Windows (PowerShell) es `$env:VAR = "…"`. Pestañas con detección. */}
                <SnippetPorSistema
                  unix={
                    <pre className="code">
                      {"npm i -g @bivelio/savings-layer\n"}
                      {"# optional: cloud dashboard\n"}
                      {"export "}
                      <span className="s">BIVELIO_SERVICE_KEY</span>
                      {"=bvk_…\n\n"}
                      <span className="k">bvsala</span>
                      {" claude"}
                    </pre>
                  }
                  windows={
                    <pre className="code">
                      {"npm i -g @bivelio/savings-layer\n"}
                      {"# optional: cloud dashboard\n"}
                      <span className="s">$env:BIVELIO_SERVICE_KEY</span>
                      {' = "bvk_…"\n\n'}
                      <span className="k">bvsala</span>
                      {" claude"}
                    </pre>
                  }
                />
                <p className="lp-nota">{tl("gateway.note")}</p>
                {/* Cualquier lenguaje con el SDK oficial de OpenAI o de Anthropic
                    (Python incluido): se MIDE, solo para modelos con precio de lista,
                    y no se ahorra. Sus salvedades las fija
                    messages/copia-del-gateway.test.ts. */}
                <p className="lp-nota">{tl("gateway.pythonNote")}</p>
              </div>

              {/* RECURSO COMPLEMENTARIO · SKILL SAVINGS-MODE — instrucciones de uso
                  para agentes con SUSCRIPCIÓN (sin factura, con topes). No es un
                  plan ni un sustituto del gateway, y su efecto NO lleva cifra hasta
                  que un A/B lo mida: de las tres partidas se enseña solo el ORDEN. */}
              <div className="hiw-muro" id="skill">
                <SectionHead como="h3" pequeno eyebrow={tl("skill.eyebrow")} titulo={tl("skill.title")} lede={tl("skill.body")} />
                <div className="ledgers ledgers--tres">
                  {(
                    [
                      ["lecturaCache", "mLectura", "mLecturaDesc"],
                      ["escritura1h", "mEscritura", "mEscrituraDesc"],
                      ["salida", "mSalida", "mSalidaDesc"],
                    ] as const
                  ).map(([campo, nombre, desc], i) => (
                    <div className="ledger" key={campo}>
                      <div className="idx">{String(i + 1).padStart(2, "0")}</div>
                      <h4>{tl(`skill.${nombre}`)}</h4>
                      <p>{tl(`skill.${desc}`)}</p>
                    </div>
                  ))}
                </div>
                <p className="ledgers-modelo">{tl("skill.anatomiaNota")}</p>
                <SkillPorSuperficie
                  pestanas={[
                    {
                      id: "claude-code",
                      etiqueta: "Claude Code",
                      panel: (
                        <div>
                          <pre className="code">
                            <span className="k">npx</span>
                            {" -y @bivelio/savings-layer skill"}
                          </pre>
                          <p className="lp-nota">{tl("skill.ccNota")}</p>
                        </div>
                      ),
                    },
                    {
                      id: "codex",
                      etiqueta: "Codex CLI",
                      panel: (
                        <div>
                          <pre className="code">
                            <span className="k">npx</span>
                            {" -y @bivelio/savings-layer skill --codex"}
                          </pre>
                          <p className="lp-nota">{tl("skill.cxNota")}</p>
                        </div>
                      ),
                    },
                    {
                      id: "claude-ai",
                      etiqueta: "claude.ai",
                      panel: (
                        <div>
                          <p className="skill-descarga">
                            {/* Sin atributo `download`: sin sesión la ruta redirige a
                                /login y un download-attr guardaría el HTML del login
                                como fichero. El Content-Disposition ya hace el resto. */}
                            <a className="btn ghost" href="/api/skill/descargar">
                              {tl("skill.aiDescargar")}
                            </a>
                          </p>
                          <p className="lp-nota">
                            {tl("skill.aiCuenta")} {tl("skill.aiPaso1")} {tl("skill.aiPaso2")}
                          </p>
                        </div>
                      ),
                    },
                    // ChatGPT fuera por decisión del dueño (01-09): sus topes cuentan
                    // mensajes, no tokens — allí el skill no puede ahorrar nada
                    // medible, y esta sección no enseña nada que no ahorre.
                  ]}
                />
              </div>
            </>
          }
        />
      </main>
      <Footer />
    </div>
  );
}

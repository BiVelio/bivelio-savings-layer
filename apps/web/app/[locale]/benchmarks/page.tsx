import { getTranslations, setRequestLocale } from "next-intl/server";

import { BancoPublico, type Traductor } from "@/app/components/BancoPublico";
import { CentroDeEvidencia, type SeccionDelIndice } from "@/app/components/evidencia/CentroDeEvidencia";
import { ComparacionAB } from "@/app/components/evidencia/ComparacionAB";
import { filasAB } from "@/app/components/evidencia/filas-ab";
import Footer from "@/app/components/Footer";
import { LogoProveedor } from "@/app/components/LogoProveedor";
import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { VideoExplicativo } from "@/app/components/VideoExplicativo";
import { absolute, languageAlternates, tarjetaSocial } from "@/i18n/site";
import { cargarBanco } from "@/lib/banco-publico/cargar";
import { BANCO_EN_VIVO, GEMINI_EN_EL_SEMANAL, VERSION_GEMINI_NATIVO } from "@/lib/portada/banco-en-vivo";
import { PALANCA_TTL } from "@/lib/portada/palanca-ttl";

// Proveedores que exponen un endpoint OpenAI-compatible (o, en el caso de
// Anthropic y de Gemini desde la 0.4.33, tienen adaptador nativo). Es una lista
// de COMPATIBILIDAD, no de mediciones: compatible ≠ medido, y la nota de debajo
// (`landing.hero.compatibleNota`) lo dice. Lo medido es solo lo que tiene cifra
// en esta página (o, para Gemini, lo que midió el banco semanal en vivo, sin
// cifra de ahorro). Vivía en la portada hasta el 2026-11; el dueño la quiso
// aquí, con el resto de la letra pequeña.
const LLMS = [
  { marca: "openai", label: "OpenAI" },
  { marca: "anthropic", label: "Anthropic" },
  { marca: "gemini", label: "Gemini" },
  { marca: "mistral", label: "Mistral" },
  { marca: "meta", label: "Llama" },
  { marca: "deepseek", label: "DeepSeek" },
  { marca: "perplexity", label: "Perplexity" },
  { marca: "huggingface", label: "Hugging Face" },
  { marca: "nvidia", label: "NVIDIA NIM" },
  { marca: "azure", label: "Azure OpenAI" },
  { marca: "aws", label: "Bedrock" },
  { marca: "ollama", label: "Ollama" },
  { marca: "vllm", label: "vLLM" },
] as const;

/**
 * /benchmarks — EL BANCO PÚBLICO: nuestro A/B reproducible y la invitación a
 * medirnos (decisión del dueño, 2026-09-29).
 *
 * Los datos se leen de `docs/benchmarks/<fecha>/*.json` AL CONSTRUIR (de ahí el
 * `force-static`): la página no lleva un número escrito a mano, y un informe
 * nuevo que entre en esa carpeta aparece en el siguiente build sin tocar nada.
 * `dynamicParams = false`: un idioma que no existe da 404 sin intentar leer el
 * disco en tiempo de ejecución.
 *
 * Una excepción, dicha: la sección de la rebaja de caché del gateway
 * (#gateway-ttl) no es una batería A/B ni un JSON de esa carpeta, sino un replay
 * cuyo informe no se sirve. Sus números vienen de lib/portada/palanca-ttl.ts,
 * con una verja que los cuadra uno a uno contra el informe.
 *
 * EL REPOSITORIO ES ABIERTO (P1 de la guía maestra del rediseño): esta página
 * dejó de pasar `sinGitHub` al pie y enlaza el código junto a las descargas.
 * `BancoPublico` conserva su lista blanca: sus enlaces siguen siendo solo
 * informes servidos, el artículo y el correo; el del repositorio vive aquí.
 *
 * DOS BLOQUES LLEGARON DE LA PORTADA (dueño, 2026-11: la portada se acorta y lo
 * metodológico vive donde lo busca quien quiere comprobarlo). Los pinta ESTA
 * página y entran en el banco por dos huecos, igual que el índice:
 *   · #explained — el experimento justo dicho en llano, con su vídeo (tras #method);
 *   · #compat — «compatible no es medido»: dónde corre el SDK frente a qué
 *     modelos tienen cifra o tirada publicada (tras #status).
 * Sus textos siguen en `landing.*` (step2.*, hero.compatible*): no se duplican.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "benchmarksPage" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}/benchmarks`);
  const social = tarjetaSocial(locale, title);

  return {
    title,
    description,
    alternates: { canonical: url, languages: languageAlternates("benchmarks") },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article", ...social.openGraph },
    twitter: { ...social.twitter, title, description },
  };
}

export default async function BenchmarksPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("benchmarksPage");
  const tUi = await getTranslations("ui");
  const tNav = await getTranslations("nav");
  const tl = await getTranslations("landing");
  const banco = cargarBanco();
  const tr = t as unknown as Traductor;

  // EL CENTRO DE EVIDENCIA: el índice y los filtros de lectura se pintan desde
  // aquí y entran en el banco por su hueco. Solo se listan las secciones que la
  // página pinta de verdad (#weekly y #bugs dependen de los informes).
  const secciones: SeccionDelIndice[] = [
    { id: "method", etiqueta: t("index.method") },
    { id: "explained", etiqueta: tl("step2.plainTitle") },
    ...(banco.semanales.length > 0 ? [{ id: "weekly", etiqueta: t("index.weekly") }] : []),
    { id: "savings", etiqueta: t("index.savings") },
    { id: "gateway-ttl", etiqueta: t("index.gatewayTtl") },
    { id: "guarantees", etiqueta: t("index.guarantees") },
    { id: "no-savings", etiqueta: t("index.noSavings") },
    { id: "status", etiqueta: t("index.status") },
    { id: "compat", etiqueta: t("index.compat") },
    ...(banco.fallos.length > 0 ? [{ id: "bugs", etiqueta: t("index.bugs") }] : []),
    { id: "reproduce", etiqueta: t("index.reproduce") },
    { id: "invite", etiqueta: t("index.invite") },
  ];
  const filas = filasAB(banco, tr, locale);

  // La frase llana del experimento: las cifras llegan como PARÁMETROS desde
  // lib/portada/banco-en-vivo.ts (con verja contra su informe).
  const pct1 = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct0 = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const V = BANCO_EN_VIVO;
  // Lo medido de Gemini (banco semanal en vivo): qué modelo y qué día, nunca
  // una cifra de ahorro. Nombres y fecha llegan por parámetro.
  const G = GEMINI_EN_EL_SEMANAL;
  const diaLargo = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" });
  const dia = (d: string) => new Date(`${d}T00:00:00Z`);
  const notaCompatible = {
    gemini: VERSION_GEMINI_NATIVO,
    flash: G.medido.nombre,
    pro: G.pro.nombre,
    fecha: diaLargo.format(dia(G.fecha)),
    fechaPro: diaLargo.formatRange(dia(G.pro.desde), dia(G.pro.hasta)),
  };

  return (
    <div className="lp terms-page evc">
      <BancoPublico
        banco={banco}
        t={tr}
        locale={locale}
        palancaTtl={PALANCA_TTL}
        etiquetas={{ abSdk: tUi("evidence.abSdk"), replayGateway: tUi("evidence.replayGateway") }}
        indice={
          <CentroDeEvidencia
            secciones={secciones}
            enlaces={
              <>
                <a className="evc-link" href="/papers/bv-sala-savings-layer-2026-10.pdf" target="_blank" rel="noopener">
                  {t("centre.paper")}
                </a>
                {/* P1 de la guía: el repositorio es abierto y el centro de evidencia lo enlaza. */}
                <a className="evc-link" href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer">
                  {t("centre.repo")}
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 2.5h5.5V8M9.5 2.5 2.5 9.5" />
                  </svg>
                  <span className="sr-only"> {tNav("newTab")}</span>
                </a>
              </>
            }
          />
        }
        comparacion={filas.length > 0 ? <ComparacionAB filas={filas} locale={locale} etiquetaAb={tUi("evidence.abSdk")} /> : null}
        explicacion={
          <section className="terms-sec banco-llano" aria-labelledby="explained-h" id="explained">
            <h2 id="explained-h">{tl("step2.plainTitle")}</h2>
            {/* La traducción sin jerga (petición del dueño, 2026-09-04): el vídeo
                del experimento justo + la cifra dicha en lenguaje llano. Los
                números llegan como PARÁMETROS — aquí no se escribe ni un dígito. */}
            <div className="medido-llano">
              <div className="explica-card">
                <VideoExplicativo src="/videos/explica-5.mp4" poster="/videos/explica-5.jpg" etiqueta={tl("step2.plainTitle")} />
                <div className="explica-texto">
                  <p>{tl("step2.videoCaption")}</p>
                </div>
              </div>
              <div className="medido-llano-texto">
                <p className="grande">
                  {tl("step2.plain", {
                    rep: pct0.format(V.repeticiones),
                    punto: pct1.format(V.openai.ahorro.point),
                    bajo: pct1.format(V.openai.ahorro.lower),
                    alto: pct1.format(V.openai.ahorro.upper),
                  })}
                </p>
                <p className="nota">{tl("step2.plainNote")}</p>
              </div>
            </div>
          </section>
        }
        compatibilidad={
          <section className="terms-sec" aria-labelledby="compat-h" id="compat">
            <h2 id="compat-h">{t("index.compat")}</h2>
            {/* «Compatible con» ≠ «Medido en»: la franja dice dónde CORRE el SDK
                (cualquier endpoint OpenAI-compatible o el adaptador nativo); la
                nota de debajo dice con qué modelo hay cifra publicada. */}
            <div className="hero-compat banco-compat">
              <span className="hm-k">{tl("hero.compatibleCon")}</span>
              <div className="compat-marquee" aria-label={LLMS.map((l) => l.label).join(", ")}>
                <div className="compat-track">
                  {[0, 1].map((copia) =>
                    LLMS.map((l) => (
                      <span className="cm" key={`${copia}-${l.marca}`} aria-hidden={copia === 1}>
                        <LogoProveedor marca={l.marca} size={15} />
                        {l.label}
                      </span>
                    )),
                  )}
                </div>
              </div>
              <p className="compat-nota">{tl("hero.compatibleNota", notaCompatible)}</p>
            </div>
          </section>
        }
      />
      <Footer />
    </div>
  );
}

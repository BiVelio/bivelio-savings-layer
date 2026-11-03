import { Fragment } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { getImageProps } from "next/image";

import { ReservarLlamada } from "./components/ReservarLlamada";
import { CursorGrid } from "@/app/components/CursorGrid";
import { RevealObserver } from "@/app/components/RevealObserver";
import { SnippetPorSistema } from "@/app/components/SnippetPorSistema";
import { SkillPorSuperficie } from "@/app/components/SkillPorSuperficie";
import { LogoProveedor } from "@/app/components/LogoProveedor";
import { FilasMedidas, filaDeLaPalancaTtl, filasDelBancoEnVivo, type FilaMedida } from "@/app/components/MedidoEnVivo";
import { NvidiaEcosystemBand } from "@/app/components/NvidiaInception";
import { VideoExplicativo } from "@/app/components/VideoExplicativo";
import { DIAS_ACTIVOS_PARA_CONTAR_ASIENTO } from "@/lib/billing/asientos";
import { FormatVerifier } from "@/app/components/FormatVerifier";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";
import { tarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { LIMITES_MEDIR, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";
import { BANCO_EN_VIVO, GEMINI_EN_EL_SEMANAL, VERSION_GEMINI_NATIVO } from "@/lib/portada/banco-en-vivo";
import panelDelBanco from "@/assets/portada/panel-del-banco.png";
import panelDelBancoMovil from "@/assets/portada/panel-del-banco-movil.png";

// Proveedores que exponen un endpoint OpenAI-compatible (o, en el caso de
// Anthropic y de Gemini desde la 0.4.33, tienen adaptador nativo). Es una lista
// de COMPATIBILIDAD, no de mediciones: compatible ≠ medido, y la nota de debajo
// (`hero.compatibleNota`) lo dice. Lo medido es solo lo que tiene cifra en
// /benchmarks (o, para Gemini, lo que midió el banco semanal en vivo, sin
// cifra de ahorro), y la portada lo lee de lib/portada/banco-en-vivo.ts.
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

// La franja bajo la captura del héroe: los proveedores con los que el banco
// mide EN VIVO, con el contador de cada uno (OpenAI y Anthropic con cifra de
// ahorro en /benchmarks; Gemini en el banco semanal, sin cifra de ahorro —
// lo dice la nota de #measured).
const MEDIDO_EN_VIVO = [
  { marca: "openai", label: "OpenAI" },
  { marca: "anthropic", label: "Anthropic" },
  { marca: "google", label: "Google" },
] as const;

// LO QUE LA PORTADA PUBLICA COMO MEDIDO (2026-09-29). Hasta hoy la portada leía
// `public/data/ab-live.json` —una tirada sintética del 2026-09-12 con un
// compresor que npm no trae— y de ahí salían el «al menos un 10 %», el recibo
// del héroe y los libros «avoided_calls ≥ 22 %». Ya no lo lee: publica la cifra
// CONDICIONADA del banco en vivo (GSM8K, con repeticiones) y, aparte, la caché
// de prefijo del proveedor. El ≈ 0 % sin repeticiones vive en /benchmarks, no
// en la portada (dueño, 2026-10-02). Los números salen
// de lib/portada/banco-en-vivo.ts, con verja contra sus informes.

// The "integrate" snippet: the open-core 2-step story (package → wrap the
// call), with its step headers localized via the shared `howItWorks.snip*`
// keys. Code tokens stay verbatim; each carries a color class: n = paso
// (brand, bold), k = keyword (brand), s = string (ámbar), c = comentario
// (soft), g = resultado (menta).
type TokenCls = "c" | "k" | "s" | "n" | "g";
function lineasDelSnippet(th: (k: string) => string): { cls?: TokenCls; v: string }[][] {
  return [
    [{ cls: "n", v: `# 1 · ${th("snip1")}` }],
    [{ v: "pnpm add " }, { cls: "s", v: "@bivelio/savings-layer" }],
    [],
    [{ cls: "n", v: `# 2 · ${th("snip3")}` }],
    [{ cls: "k", v: "const" }, { v: " layer = createSavingsLayer({ provider });" }],
    [
      { cls: "k", v: "const" },
      { v: " { text, report } = " },
      { cls: "k", v: "await" },
      { v: " layer.generate({ model, messages });" },
    ],
    [],
    [{ v: "console.log(report.cost.netSavingsRatio)  " }, { cls: "g", v: `// ← ${th("snipResult")}` }],
  ];
}

/**
 * ESTÁTICA, Y REGENERADA CADA HORA (ISR). Desde el 22-09-2026 la portada se
 * prerenderiza y se sirve desde la caché del borde (antes la hacía dinámica
 * un `headers()` en not-found.tsx). El precio del plan lo lee Stripe con una
 * caché de una hora (`lib/stripe/pricing.ts`), y «estática» a secas lo
 * dejaría clavado hasta el siguiente despliegue: con la misma hora aquí, la
 * página se regenera en segundo plano y nadie espera a la regeneración.
 */
export const revalidate = 3600;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "landing" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  const url = absolute(`/${locale}`);

  return {
    title,
    description,
    // `canonical` por idioma + `hreflang` de los 12 (con x-default). Sin esto,
    // doce traducciones de esta misma página compiten entre sí como duplicados.
    alternates: { canonical: url, languages: languageAlternates() },
    // Sin Open Graph, compartir el enlace en LinkedIn, X, Slack o WhatsApp
    // producía una URL pelada, sin título ni imagen. Para un producto cuyo gancho
    // es "entra y verifica tu ahorro", esa tarjeta es la primera impresión.
    openGraph: {
      type: "website",
      siteName: "BiVelio Savings Layer",
      title,
      description,
      url,
      locale,
      images: [{ url: `${url}/opengraph-image`, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${url}/opengraph-image`],
    },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  const th = await getTranslations("howItWorks");
  const CODE = lineasDelSnippet(th);

  const ledgers = t.raw("ledgers") as { idx: string; name: string; desc: string }[];
  const features = t.raw("pricing.features") as string[];

  // El precio sale del Price de Stripe, que es lo que de verdad se cobra, y se
  // formatea AQUÍ (servidor) para el idioma de la página. Antes estaba escrito a
  // mano en los 12 ficheros de traducción y no se hablaba con Stripe: por eso la
  // landing estática llegó a anunciar dólares mientras se cobraban euros.
  // Desde el 2026-09-29 son las cifras de Pro y Equipo (la modalidad con
  // comisión ya no se vende a clientes nuevos).
  const planes = terminosDeLosPlanes(locale, await tarifasDeLosPlanes());
  const moneda = planes.moneda;

  // La captura del panel del héroe (el LCP en escritorio): `priority` pone
  // carga inmediata y prioridad alta. Las dos tomas salen de la misma ruta con
  // las mismas cifras (lib/portada/panel-del-banco.ts y su verja).
  const comunes = { alt: "", quality: 80, priority: true } as const;
  const { props: panelEscritorio } = getImageProps({
    ...comunes,
    src: panelDelBanco,
    sizes: "(max-width: 1240px) calc(100vw - 48px), 1160px",
  });
  const { props: panelMovil } = getImageProps({
    ...comunes,
    src: panelDelBancoMovil,
    sizes: "calc(100vw - 32px)",
  });

  // Las cifras de lo medido, en el idioma de la página (app/components/MedidoEnVivo.tsx).
  const pct1 = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const pct0 = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const V = BANCO_EN_VIVO;
  const rep = pct0.format(V.repeticiones);
  // Las filas de lo medido: OpenAI con 100 familias y Claude con un flujo
  // reducido distinto de 31, con el efecto de cache_control habilitado en B
  // dicho aparte. Cada cifra con su intervalo y su flujo; ninguna con un
  // «al menos». La fila «sin
  // repeticiones ≈ 0» salió de la portada (dueño, 2026-10-02): sigue entera en
  // /benchmarks, y la frase de «depende de cuánto repita tu tráfico» se queda.
  const filasMedidas: FilaMedida[] = filasDelBancoEnVivo(t, locale);
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

  // Los límites de Medir salen de la constante que aplica la ingesta.
  const medir = {
    seats: LIMITES_MEDIR.asientos,
    requests: LIMITES_MEDIR.peticionesDiarias.toLocaleString(locale),
    version: VERSION_MINIMA_MEDIR,
  };

  return (
    <div className="lp">
      <CursorGrid />
      <RevealObserver />
      <main className="wrap">
        {/* HERO (dueño, 2026-10-03): el producto es la imagen. Titular
            centrado, una línea, dos botones y, debajo, una captura del panel
            DE VERDAD —sus componentes— alimentado solo con el banco público
            (lib/portada/panel-del-banco.ts, con verja contra los informes;
            la regenera scripts/captura-panel.ts). El h1 pinta desde el HTML,
            sin animación: es lo primero que se lee. La franja de debajo dice
            con qué proveedores se midió en vivo; «compatible con» y la nota de
            Gemini viven en #measured. */}
        <section className="hero hero-panel">
          <div className="hpanel-copy">
            <h1>
              {t("hero.title")} <span className="u">{t("hero.titleAccent")}</span>
            </h1>
            <p className="lede">{t("hero.sub")}</p>
            <div className="hero-cta">
              <Link className="btn" href="/signup">
                {t("hero.ctaStart")}
              </Link>
              <Link className="btn ghost" href="/benchmarks">
                {t("hero.ctaBench")}
              </Link>
            </div>
          </div>

          <figure className="hpanel-shot">
            <div className="hpanel-frame-fade">
              <div className="hpanel-frame">
                <div className="hpanel-chrome" aria-hidden="true">
                  <span className="hpanel-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="hpanel-url">
                    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
                      <path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h.5Zm1.5 0h4V5a2 2 0 1 0-4 0v2Z" fill="currentColor" />
                    </svg>
                    savings.bivelio.com
                  </span>
                </div>
                <div className="hpanel-img">
                  {/* Dos tomas de la misma ruta y las mismas cifras: en móvil,
                      el titular y la tabla solos y más grandes, para que se
                      lean; en escritorio, el panel entero. */}
                  <picture>
                    <source
                      media="(max-width: 640px)"
                      srcSet={panelMovil.srcSet}
                      sizes={panelMovil.sizes}
                      width={panelMovil.width}
                      height={panelMovil.height}
                    />
                    <img {...panelEscritorio} alt={t("hero.panelAlt")} />
                  </picture>
                </div>
              </div>
            </div>
            <figcaption>
              <Link href="/benchmarks">{t("hero.panelCaption")}</Link>
            </figcaption>
          </figure>

          <div className="hpanel-medido">
            <span className="hpanel-marcas">
              {MEDIDO_EN_VIVO.map((m) => (
                <span className="hpanel-marca" key={m.marca}>
                  <LogoProveedor marca={m.marca} size={18} />
                  {m.label}
                </span>
              ))}
            </span>
            <span className="hpanel-medido-t">{t("hero.medidoEnVivo")}</span>
          </div>
        </section>

        {/* DOS OFERTAS (decisión delegada, bitácora del 10-09): la portada
            mezclaba dos productos. Al cliente con una app y su API key el SDK
            le recorta la factura cuando su tráfico repite, con cifra publicada; al de un agente de
            código, el gateway le MIDE con el contador del proveedor y lo suma
            en el panel por día y modelo (no hay recibo por petición del
            gateway: `renderizarRecibo` no tiene llamador, y el recibo del
            producto es el SavingsReport del SDK). Cada uno lleva su público, su
            instalación y su propia promesa.
            · La cifra del SDK son las filas de lo medido (con y sin
              repeticiones), las mismas del héroe y de #measured: una sola
              fuente, lib/portada/banco-en-vivo.ts, con su verja.
            · El gateway lleva UNA cifra desde el 2026-10-03 (dueño): el neto de
              la rebaja de caché de PRO que midió el banco de TTL, con su
              intervalo y dicho como lo que es — un replay a precio de lista
              sobre sesiones de una sola organización, no una previsión
              (lib/portada/palanca-ttl.ts, con verja contra el informe). La
              rebaja pasa a 5m las escrituras de caché SOLO en los turnos con
              buena parte del prompt nueva (gateway/tarifa.ts, `decidirRebaja`):
              nunca «mientras la sesión sigue caliente», que es la política de
              #229 que perdía dinero. */}
        <section id="offers">
          <div className="sec-head rv">
            <span className="eyebrow">{t("offers.eyebrow")}</span>
            <h2>{t("offers.title")}</h2>
            <p>{t("offers.sub")}</p>
          </div>
          <div className="offers-grid">
            <article className="offer-card rv">
              <h3 className="offer-name">{t("offers.sdk.name")}</h3>
              <p className="offer-who">{t("offers.sdk.who")}</p>
              <p>{t("offers.sdk.what")}</p>
              <div className="offer-fig">
                <span className="offer-fig-t">{t("offers.sdk.figureLabel")}</span>
                {/* La primera fila de lo medido (OpenAI), que ya dice su
                    condición: «en un flujo donde el 30 % repite». Debajo, la
                    nota de que depende de cuánto repita tu tráfico. */}
                <FilasMedidas filas={filasMedidas.slice(0, 1)} />
                <p className="offer-fig-note">{t("offers.sdk.figureNote")}</p>
              </div>
              <div className="offer-install">
                <span className="offer-fig-t">{t("offers.install")}</span>
                <pre className="code">
                  {"pnpm add "}
                  <span className="s">@bivelio/savings-layer</span>
                </pre>
                <a href="#sdk-install">{t("offers.installMore")}</a>
              </div>
              <div className="offer-cta">
                <a className="btn" href="#measured">
                  {t("offers.sdk.ctaMeasured")}
                </a>
                <a className="btn ghost" href="#verify">
                  {t("offers.sdk.ctaVerify")}
                </a>
              </div>
            </article>

            <article className="offer-card rv">
              <h3 className="offer-name">{t("offers.gateway.name")}</h3>
              <p className="offer-who">{t("offers.gateway.who")}</p>
              <p>{t("offers.gateway.what")}</p>
              <div className="offer-fig">
                <span className="offer-fig-t">{t("offers.gateway.figureLabel")}</span>
                {/* El neto de la rebaja de TTL del banco del 2026-10-03, con su
                    intervalo y su condición en la misma fila. */}
                <FilasMedidas filas={[filaDeLaPalancaTtl(t, locale)]} />
                <p className="offer-fig-note">{t("offers.gateway.figureNote")}</p>
                {/* El informe entero, con sus límites, en su sección del banco público. */}
                <p className="offer-fig-link">
                  <Link href="/benchmarks#gateway-ttl">{t("offers.gateway.benchLink")}</Link>
                </p>
              </div>
              <div className="offer-install">
                <span className="offer-fig-t">{t("offers.install")}</span>
                {/* Open core: sin claves el gateway arranca en modo Community.
                    La clave de servicio es OPCIONAL (nube: panel de equipo). */}
                <pre className="code">
                  {"npm i -g @bivelio/savings-layer\n"}
                  {"# optional: cloud dashboard\n"}
                  {"export "}
                  <span className="s">BIVELIO_SERVICE_KEY</span>
                  {"=bvk_…\n"}
                  <span className="k">bvsala</span>
                  {" claude"}
                </pre>
                <a href="#gateway">{t("offers.installMore")}</a>
              </div>
              <div className="offer-cta">
                <a className="btn" href="#gateway">
                  {t("offers.gateway.cta")}
                </a>
              </div>
            </article>
          </div>
        </section>

        <div className="offer-band rv" id="sdk">
          {t("offers.sdk.band")}
        </div>

        {/* HECHO PARA DESARROLLADORES — cuatro hechos del paquete, ninguno una
            promesa: cero dependencias, un SavingsReport por llamada, tráfico
            directo y streaming con el mismo informe (y las mismas reglas de base:
            un stream sin el contador final del proveedor sale no medido). Sin
            cifras: aquí no hay nada que medir, solo describir. */}
        <section id="devs">
          <div className="sec-head rv">
            <span className="eyebrow">{t("devs.eyebrow")}</span>
            <h2>{t("devs.title")}</h2>
            <p>{t("devs.sub")}</p>
          </div>
          <div className="devs-grid">
            {(t.raw("devs.cards") as { title: string; body: string; mono: string }[]).map((c) => (
              <div className="dev-card rv" key={c.title}>
                <span className="mono">{c.mono}</span>
                <h4>{c.title}</h4>
                <p>{c.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* EN PALABRAS NORMALES — la explicación para todo el mundo (petición
            del dueño, 2026-09-04): cuatro ideas en lenguaje llano, cada una con
            su animación de 8 s. Los vídeos son mudos y sin texto en pantalla a
            propósito: la página se sirve en 12 idiomas y lo que se lee vive en
            los mensajes. Las CIFRAS siguen viviendo solo en las secciones
            medidas de más abajo — aquí no se promete ningún número. */}
        <section id="explica">
          <div className="sec-head rv">
            <span className="eyebrow">{t("explica.eyebrow")}</span>
            <h2>{t("explica.title")}</h2>
            <p>{t("explica.sub")}</p>
          </div>
          <div className="explica-grid">
            {(t.raw("explica.pasos") as { title: string; body: string }[]).map((p, i) => (
              <div className="explica-card rv" key={p.title}>
                <VideoExplicativo
                  src={`/videos/explica-${i + 1}.mp4`}
                  poster={`/videos/explica-${i + 1}.jpg`}
                  etiqueta={p.title}
                />
                <div className="explica-texto">
                  <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                  <h4>{p.title}</h4>
                  <p>{p.body}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="explica-nota">{t("explica.nota")}</p>
        </section>

        <section id="measured">
          <div className="sec-head rv">
            <span className="eyebrow">{t("step2.eyebrow")}</span>
            <h2>{t("step2.title")}</h2>
            <p>
              {t.rich("step2.body", {
                b: (c) => <b>{c}</b>,
                i: (c) => <i>{c}</i>,
                code: (c) => <code>{c}</code>,
              })}
            </p>
            {/* Los informes completos viven en /benchmarks (servidos desde la
                web: el repositorio es privado). Antes se enlazaba aquí el CSV de
                la tirada sintética del 12-09, que ya no se publica como medida. */}
            <p className="sec-head-link">
              <Link href="/benchmarks">{t("step2.benchLink")}</Link>
            </p>
          </div>

          {/* La prueba, con su modelo y su tráfico: las mismas filas que el
              héroe, desde lib/portada/banco-en-vivo.ts (con verja contra los
              informes), y la nota de qué palanca ahorró y cuál no. */}
          <div className="hero-prueba medido-prueba rv">
            <span className="hero-prueba-t">{t("hero.proofTitle")}</span>
            <FilasMedidas filas={filasMedidas} />
            <p className="cascade-nota">{t("cascade.footnote")}</p>
          </div>
          {/* «Compatible con» ≠ «Medido en» (estaba en el héroe hasta el
              2026-10-03): la franja dice dónde CORRE el SDK (cualquier
              endpoint OpenAI-compatible o el adaptador nativo); la nota de
              debajo dice con qué modelo hay cifra publicada. */}
          <div className="hero-compat rv">
            <span className="hm-k">{t("hero.compatibleCon")}</span>
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
            <p className="compat-nota">{t("hero.compatibleNota", notaCompatible)}</p>
          </div>
          {/* La traducción sin jerga (petición del dueño, 2026-09-04): el vídeo
              del experimento justo + las dos cifras del artefacto dichas en
              lenguaje llano. Los números llegan como PARÁMETROS desde el
              artefacto publicado — aquí no se escribe ni un dígito a mano. */}
          <div className="medido-llano">
            <div className="explica-card rv">
              <VideoExplicativo
                src="/videos/explica-5.mp4"
                poster="/videos/explica-5.jpg"
                etiqueta={t("step2.plainTitle")}
              />
              <div className="explica-texto">
                <p>{t("step2.videoCaption")}</p>
              </div>
            </div>
            <div className="medido-llano-texto">
              <h3>{t("step2.plainTitle")}</h3>
              <p className="grande">
                {t("step2.plain", {
                  rep,
                  punto: pct1.format(V.openai.ahorro.point),
                  bajo: pct1.format(V.openai.ahorro.lower),
                  alto: pct1.format(V.openai.ahorro.upper),
                })}
              </p>
              <p className="nota">{t("step2.plainNote")}</p>
            </div>
          </div>
          {/* Aquí iba el bloque del panel (insignia de referencia, banda del
              intervalo y tarjetas por libro) leyendo la tirada sintética del
              12-09. Fuera de la portada: la portada no enseña esa tirada. */}
          {/* La tabla de escenarios, los chips y la nota de caché eran
              «demasiado concreto y científico» para la landing (dueño,
              04-09): viven en el panel. Aquí iban también dos vídeos
              («trabajos»: con paja se recorta mucho, magra pasa intacta) que
              prometían que la capa RECORTA el texto de entrada. No está
              medido: en el banco A/B en vivo y en el semanal el ahorro del SDK
              instalado sale de las peticiones repetidas servidas sin llamar al
              proveedor (y la caché de prefijo es del proveedor, aparte); el
              compresor de la tirada sintética es solo del banco y el paquete
              no lo trae. Fuera (2026-09-30). Debajo quedó una frase con el
              «≈ 0 %» del tráfico sin repeticiones; fuera también (dueño,
              2026-10-02): lo honesto ya lo dice la frase llana de justo
              encima («depende de cuánto repita tu tráfico»), y el cero vive
              en /benchmarks con su informe. */}
        </section>

        {/* LEDGERS — cuatro libros que nunca se suman. Hasta el 2026-09-29 cada
            tarjeta enseñaba el suelo de su libro en la tirada sintética del
            12-09 («avoided_calls ≥ 22 %», «eliminated_tokens ≥ 43,2 %»): cifras
            de un banco con un compresor que npm no trae. Ahora las tarjetas
            DESCRIBEN los libros, sin cifra, y la nota dice de qué libro salió el
            ahorro medido en el banco público. Sin «el tercero fue cero» (dueño,
            2026-10-02): la portada no enseña ceros; /benchmarks, sí. */}
        <section>
          <div className="sec-head rv">
            <span className="eyebrow">{t("ledgersHead.eyebrow")}</span>
            <h2>{t("ledgersHead.title")}</h2>
            <p>{t("ledgersHead.body")}</p>
            <p className="ledgers-modelo">{t("ledgersHead.providerNote", { fecha: V.fecha })}</p>
          </div>
          <div className="ledgers">
            {ledgers.map((l) => (
              <div className="ledger rv" key={l.idx}>
                <div className="idx">{l.idx}</div>
                <h4>{l.name}</h4>
                <p>{l.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* PRUEBA ANTES DE PAGAR — el verificador de formato, sin cuenta. Lo
            quitó 9feb377 (#85) junto con el PROYECTOR, y el motivo era el
            proyector: deslizadores donde el visitante inventaba sus
            porcentajes. Ese motivo sigue vigente, así que el proyector NO
            vuelve (se queda en el panel) y esta página no lo importa. El
            verificador sí: corre el selector de formato real del bundle web en
            el navegador, con el tokenizador exacto, abre con la muestra de
            menor efecto, redondea hacia abajo y dice en pantalla que es UNA
            palanca, no la factura. Ni proveedor ni paquete de pago. */}
        <section id="verify">
          <div className="sec-head rv">
            <span className="eyebrow">{t("verify.eyebrow")}</span>
            <h2>{t("verify.title")}</h2>
            <p>{t("verify.sub")}</p>
          </div>
          <FormatVerifier />
          <div className="offer-cta" style={{ marginTop: 20 }}>
            <a className="btn" href="#sdk-install">
              {t("verify.ctaInstall")}
            </a>
          </div>
        </section>

        {/* INTEGRATE — five lines to start */}
        <section id="sdk-install">
          <div className="sec-head rv">
            <span className="eyebrow">{t("integrate.eyebrow")}</span>
            <h2>{t("integrate.title")}</h2>
            <p>{t("integrate.body")}</p>
          </div>
          <pre className="code">
            {CODE.map((line, i) => (
              <Fragment key={i}>
                {line.map((tok, j) =>
                  tok.cls ? (
                    <span className={tok.cls} key={j}>
                      {tok.v}
                    </span>
                  ) : (
                    <Fragment key={j}>{tok.v}</Fragment>
                  ),
                )}
                {i < CODE.length - 1 ? "\n" : null}
              </Fragment>
            ))}
          </pre>
          {/* La vía de un comando (0.4.26): `init` lee el package.json, detecta la
              pila e imprime el cableado exacto y una comprobación que no llama al
              modelo. No escribe nada sin permiso, así que va aquí sin letra
              pequeña. La comprobación también exige licencia (el SDK es
              fail-closed): la copia lo dice en vez de venderla como prueba gratis. */}
          <p style={{ marginTop: 16, opacity: 0.85 }}>
            {t.rich("integrate.initNote", { b: (c) => <b>{c}</b>, code: (c) => <code>{c}</code> })}
          </p>
          <pre className="code" style={{ marginTop: 8 }}>
            <span className="k">npx</span>
            {" @bivelio/savings-layer@latest init"}
          </pre>
          {/* Sistemas donde ya viven las automatizaciones del cliente: logos
              oficiales a color (decisión del dueño). El texto mantiene la
              afirmación honesta: se mide la llamada a la API con su clave, con
              el SDK en Node.js o, desde otro código con el SDK oficial de
              OpenAI o de Anthropic, con el gateway y solo para modelos con
              precio de lista (#313; lo fija messages/copia-del-gateway.test.ts). */}
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
          <p className="sys-note">{t("systems.caption")}</p>
        </section>

        <div className="offer-band rv" id="gateway">
          {t("offers.gateway.band")}
        </div>

        {/* GATEWAY — el medidor de terminales (S3): Claude Code/Codex sin tocar código.
            Honestidad: aquí solo se promete MEDIR; el veredicto de ahorro en
            terminales sigue siendo «Aún no» en /how-it-works. */}
        <section>
          <div className="sec-head rv">
            <span className="eyebrow">{t("gateway.eyebrow")}</span>
            <h2>{t("gateway.title")}</h2>
            <p>{t("gateway.body")}</p>
          </div>
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
          <p style={{ marginTop: 12, opacity: 0.85 }}>
            {t("gateway.note")} <Link href="/how-it-works">{t("gateway.cta")}</Link>
          </p>
          {/* Cualquier lenguaje con el SDK oficial de OpenAI o de Anthropic
              (Python incluido): se MIDE, solo para modelos con precio de lista,
              y no se ahorra. Clave aparte de gateway.note a propósito, para no
              pisar el texto de la licencia del gateway. Sus salvedades las fija
              messages/copia-del-gateway.test.ts. */}
          <p style={{ marginTop: 8, opacity: 0.85 }}>{t("gateway.pythonNote")}</p>
        </section>

        {/* Su propia banda: sin ella, el skill (gratis, para quien usa un agente
            con SUSCRIPCIÓN) quedaba bajo la del gateway «con API key» y se leía
            como parte de esa oferta. */}
        <div className="offer-band rv" id="skill">
          {t("offers.skill.band")}
        </div>

        {/* SKILL SAVINGS-MODE — el segmento SUSCRIPCIÓN (sin factura, con topes).
            Gratis a propósito: el embudo. Las tres partidas (lecturas de caché,
            escrituras de una hora, salida) salían con cifra de
            lib/skill/anatomia (68,2 / 19,6 / 11,6 % sobre 959 peticiones), pero
            ese corpus no tiene informe publicado en docs/: desde el 2026-09-29
            se enseña solo el ORDEN, sin porcentajes. El efecto del propio skill
            NO lleva cifra hasta que el A/B lo mida — la doctrina de la casa. */}
        <section>
          <div className="sec-head rv">
            <span className="eyebrow">{t("skill.eyebrow")}</span>
            <h2>{t("skill.title")}</h2>
            <p>{t("skill.body")}</p>
          </div>
          <div className="ledgers">
            {(
              [
                ["lecturaCache", "mLectura", "mLecturaDesc"],
                ["escritura1h", "mEscritura", "mEscrituraDesc"],
                ["salida", "mSalida", "mSalidaDesc"],
              ] as const
            ).map(([campo, nombre, desc], i) => (
              <div className="ledger" key={campo}>
                <div className="idx">{String(i + 1).padStart(2, "0")}</div>
                <h4>{t(`skill.${nombre}`)}</h4>
                <p>{t(`skill.${desc}`)}</p>
              </div>
            ))}
          </div>
          <p className="ledgers-modelo">{t("skill.anatomiaNota")}</p>
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
                    <p style={{ marginTop: 10, opacity: 0.85 }}>{t("skill.ccNota")}</p>
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
                    <p style={{ marginTop: 10, opacity: 0.85 }}>{t("skill.cxNota")}</p>
                  </div>
                ),
              },
              {
                id: "claude-ai",
                etiqueta: "claude.ai",
                panel: (
                  <div>
                    <p style={{ marginTop: 4 }}>
                      {/* Sin atributo `download`: sin sesión la ruta redirige a
                          /login y un download-attr guardaría el HTML del login
                          como fichero. El Content-Disposition ya hace el resto. */}
                      <a className="btn" href="/api/skill/descargar">
                        {t("skill.aiDescargar")}
                      </a>
                    </p>
                    <p style={{ marginTop: 10, opacity: 0.85 }}>
                      {t("skill.aiCuenta")} {t("skill.aiPaso1")} {t("skill.aiPaso2")}
                    </p>
                  </div>
                ),
              },
              // ChatGPT fuera por decisión del dueño (01-09): sus topes cuentan
              // mensajes, no tokens — allí el skill no puede ahorrar nada
              // medible, y esta sección no enseña nada que no ahorre.
            ]}
          />
        </section>

        {/* La llamada de 15 minutos, justo antes de los precios (dueño,
            2026-10-03): salió del héroe con la captura del panel y vuelve aquí. */}
        <div className="cta15-sec rv" id="llamada">
          <ReservarLlamada
            t={{
              titulo: t("cta15.titulo"),
              sub: t("cta15.sub"),
              placeholder: t("cta15.placeholder"),
              boton: t("cta15.boton"),
              enviando: t("cta15.enviando"),
              ok: t("cta15.ok"),
              errorCorreo: t("cta15.errorCorreo"),
              errorEnvio: t("cta15.errorEnvio"),
              alterna: t("cta15.alterna"),
            }}
          />
        </div>

        {/* PRICING — el modelo del 2026-09-29: Medir (gratis, sin tarjeta) → Pro
            (por asiento) → Equipo (asientos incluidos) → Enterprise. Ninguno
            lleva comisión sobre el ahorro; la modalidad con comisión está
            CERRADA a clientes nuevos y aquí solo se nombra para quien la
            conserva (una línea, con enlace a sus condiciones en /pricing). Las
            cifras de Pro y Equipo salen de sus Prices de Stripe
            (`tarifasDeLosPlanes`, con PRECIOS_DE_LOS_PLANES de respaldo). */}
        <section id="pricing">
          <div className="sec-head rv">
            <span className="eyebrow">{t("pricing.eyebrow")}</span>
            <h2>{t("pricing.title")}</h2>
            <p>{t("pricing.body", { currency: moneda })}</p>
          </div>
          <div className="plan-grid rv">
            <div className="plan-card">
              <h3>{t("pricing.plans.medir.name")}</h3>
              <div className="amt">{t("pricing.plans.medir.price")}</div>
              {/* Límites y versión mínima desde LIMITES_MEDIR / VERSION_MINIMA_MEDIR:
                  la 0.4.32 no reconoce la licencia Medir (la ve caducada). */}
              <p>{t("pricing.plans.medir.body", medir)}</p>
              <Link className="btn ghost" href="/signup">
                {t("pricing.plans.medir.cta")}
              </Link>
            </div>
            <div className="plan-card price-card">
              <h3>{t("pricing.plans.pro.name")}</h3>
              <div className="amt">
                {t("pricing.amount", { amount: planes.pro.mensual })}
                <small> {t("pricing.per")}</small>
              </div>
              <p>{t.rich("pricing.plans.pro.note", { b: (c) => <b>{c}</b>, yearly: planes.pro.anual })}</p>
              {/* El plan elegido viaja en `next` hasta el panel (registro → correo →
                  /auth/callback → signup/success → /dashboard?plan=…), donde el
                  selector de BillingButtons arranca en él. */}
              <Link className="btn" href={{ pathname: "/signup", query: { next: `/${locale}/dashboard?plan=pro` } }}>
                {t("pricing.plans.pro.cta")}
              </Link>
            </div>
            <div className="plan-card">
              <h3>{t("pricing.plans.team.name")}</h3>
              <div className="amt">
                {t("pricing.amount", { amount: planes.equipo.mensual })}
                <small> {t("pricing.plans.team.per")}</small>
              </div>
              <p>
                {t.rich("pricing.plans.team.note", {
                  b: (c) => <b>{c}</b>,
                  included: planes.equipo.incluidos,
                  extra: planes.equipo.extraMensual,
                  yearly: planes.equipo.anual,
                })}
              </p>
              <Link className="btn ghost" href={{ pathname: "/signup", query: { next: `/${locale}/dashboard?plan=equipo` } }}>
                {t("pricing.plans.team.cta")}
              </Link>
            </div>
            <div className="plan-card">
              <h3>{t("pricing.plans.enterprise.name")}</h3>
              <div className="amt">{t("pricing.plans.enterprise.price")}</div>
              <p>
                {t.rich("pricing.plans.enterprise.body", {
                  contact: (c) => <a href="mailto:support@bivelio.com">{c}</a>,
                })}
              </p>
            </div>
          </div>
          <div className="plan-foot rv">
            <ul>
              {features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <p>
              {/* Se cobran los asientos de la suscripción (la `quantity` de Stripe); los
                  días activos solo cuentan cuántos hubo en uso, y el panel lo compara
                  (/api/billing/reconcile no cobra). La cifra llega de la constante
                  espejo del SQL, no escrita a mano: portada-como-cobra.test.ts. */}
              {t.rich("pricing.seatNote", { b: (c) => <b>{c}</b>, dias: DIAS_ACTIVOS_PARA_CONTAR_ASIENTO })}
            </p>
            <p className="ck-note">{t("pricing.taxNote")}</p>
            <p className="ck-note">
              {t.rich("pricing.legacy", { terms: (c) => <Link href="/pricing#commission">{c}</Link> })}
            </p>
          </div>
        </section>

      </main>

      {/* COMPAÑÍA Y ECOSISTEMA — la banda del NVIDIA Inception Program al
          cierre de la home, la MISMA que cierra el héroe de bivelio.com
          (captura aprobada el 2026-09-15; el copy de las cuatro claves es el
          suyo, verbatim, en los 12 idiomas). No había banda de partners (las
          dos marquesinas de arriba son listas de COMPATIBILIDAD, no de
          pertenencia). Va FUERA de `main.wrap` porque es a sangre completa,
          como la banda CTA que abre el pie justo debajo. */}
      <NvidiaEcosystemBand kicker={t("nvidia.kicker")} title={t("nvidia.title")} sub={t("nvidia.sub")} cta={t("nvidia.cta")} />

      <Footer />
    </div>
  );
}

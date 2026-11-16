import { Fragment } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { getImageProps } from "next/image";

import { ReservarLlamada } from "./components/ReservarLlamada";
import { CierreMeasure } from "@/app/components/landing/CierreMeasure";
import { DosManeras } from "@/app/components/landing/DosManeras";
import { PlanesCloud } from "@/app/components/landing/PlanesCloud";
import { PreguntasDeCompra } from "@/app/components/landing/PreguntasDeCompra";
import { TarjetaDeEvidencia } from "@/app/components/landing/TarjetaDeEvidencia";
import { ViajeDeLosDatos } from "@/app/components/landing/ViajeDeLosDatos";
import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { CodeFrame, EvidenceBadge, Recibo } from "@/app/components/ui";
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
import { PALANCA_TTL } from "@/lib/portada/palanca-ttl";
import { GradientText } from "@/vendor/affectui/gradient-text";
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
      images: [{ url: absolute("/brand/og-image.png"), width: 1731, height: 909, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [absolute("/brand/og-image.png")],
    },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("landing");
  const th = await getTranslations("howItWorks");
  // Etiquetas compartidas de la fundación (copiar, clases de evidencia, recibo)
  // y el «se abre en una pestaña nueva» del chrome.
  const tu = await getTranslations("ui");
  const tn = await getTranslations("nav");
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

  // La fila del gateway (banco de TTL) para su tarjeta de evidencia, y la línea
  // de contexto del recibo del héroe: batería, fecha y versión del SDK medido.
  const filaTtl = filaDeLaPalancaTtl(t, locale);
  const diaCorto = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const reciboMeta = `${V.bateria} · ${diaCorto.format(dia(V.fecha))} · SDK ${V.versionSdk}`;

  return (
    <div className="lp">
      <CursorGrid />
      <RevealObserver />
      <main className="wrap">
        {/* 2 · HÉROE (rediseño 2026-11, guía §2.3 y §6). El mensaje: optimiza
            tus llamadas, comprueba cada ahorro. Tres salidas, por este orden:
            Measure (el alta), el motor open source (#sdk-install, sin pasar
            por registro) y, de apoyo, los resultados reproducibles. La frase
            de acento es texto real (Gradient Text de affectUI: se selecciona y
            se lee; con movimiento reducido el degradado queda quieto).
            Debajo, el paisaje de la marca madre DETRÁS de una tarjeta blanca
            de producto —la captura del panel de verdad, con los datos del
            banco público— y, junto a ella, el recibo verificable de una
            medición, con su clase de evidencia y su procedencia. El h1 pinta
            desde el HTML, sin animación. */}
        <section className="hero hero-panel">
          <div className="hpanel-copy">
            <p className="hero-sello">{t("hero.kicker")}</p>
            <h1>
              {t("hero.title")}{" "}
              <GradientText className="hero-acento">
                <span className="u">{t("hero.titleAccent")}</span>
              </GradientText>
            </h1>
            <p className="lede">{t("hero.sub")}</p>
            <div className="hero-cta">
              <Link className="btn" href="/signup">
                {t("hero.ctaStart")}
              </Link>
              <a className="btn ghost hero-oss" href="#sdk-install">
                {t("hero.ctaOss")}
              </a>
              <span className="hero-apoyo">
                <Link className="btn ghost" href="/benchmarks">
                  {t("hero.ctaBench")}
                </Link>
              </span>
            </div>
          </div>

          <figure className="hpanel-shot">
            <div className="hero-escena">
              <div className="hero-paisaje" aria-hidden="true" />
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
              {/* El recibo de una medición del banco público: el A/B del SDK con
                  OpenAI. Cada valor sale de BANCO_EN_VIVO (con verja contra el
                  informe) y llega ya formateado; aquí no hay un dígito. */}
              <div className="hero-recibo">
                <Recibo
                  compacto
                  titulo={t("receipt.title")}
                  meta={reciboMeta}
                  filas={[
                    { etiqueta: t("receipt.model"), valor: V.openai.modelo.split("/").pop(), mono: true },
                    { etiqueta: t("receipt.sample"), valor: t("receipt.sampleValue", { familias: V.openai.familias, peticiones: V.openai.peticionesPorBrazo }), mono: false },
                    { etiqueta: t("receipt.repeats"), valor: rep },
                    { etiqueta: t("receipt.interval"), valor: pct1.formatRange(V.openai.ahorro.lower, V.openai.ahorro.upper), tono: "atenuado" },
                  ]}
                  total={{ etiqueta: t("receipt.total"), valor: pct1.format(V.openai.ahorro.point), tono: "ahorro" }}
                  evidencia={{ tipo: "ab-sdk", label: tu("evidence.abSdk") }}
                  procedencia={{ texto: t("receipt.source"), href: "/benchmarks", enlace: tu("recibo.comoSeMidio") }}
                />
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

        {/* 3 · DOS MANERAS DE USAR SAVINGS (guía §2.1): Community —el motor
            open source en tu infraestructura, sin cuenta— frente a Savings
            Cloud, opcional. Es un eje distinto de «SDK o gateway» (eso va
            justo debajo). El camino local no termina en el alta: sus acciones
            son instalar y leer el código. */}
        <section id="ways" className="lp-band">
          <div className="sec-head rv">
            <span className="eyebrow">{t("ways.eyebrow")}</span>
            <h2>{t("ways.title")}</h2>
            <p>{t("ways.sub")}</p>
          </div>
          <DosManeras
            preguntas={[t("ways.q.runs"), t("ways.q.account"), t("ways.q.telemetry"), t("ways.q.manage")]}
            maneras={[
              {
                nombre: t("ways.community.name"),
                etiqueta: t("ways.community.tag"),
                resumen: t("ways.community.lede"),
                respuestas: [t("ways.community.runs"), t("ways.community.account"), t("ways.community.telemetry"), t("ways.community.manage")],
                acciones: (
                  <>
                    <a className="btn ghost" href="#sdk-install">
                      {t("hero.ctaOss")}
                    </a>
                    <a className="btn btn-quiet" href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer">
                      {t("ways.community.code")}
                      <span className="sr-only"> {tn("newTab")}</span>
                    </a>
                  </>
                ),
              },
              {
                nombre: t("ways.cloud.name"),
                etiqueta: t("ways.cloud.tag"),
                resumen: t("ways.cloud.lede"),
                respuestas: [t("ways.cloud.runs"), t("ways.cloud.account"), t("ways.cloud.telemetry"), t("ways.cloud.manage")],
                destacada: true,
                acciones: (
                  <>
                    <Link className="btn" href="/signup">
                      {t("hero.ctaStart")}
                    </Link>
                    <a className="btn btn-quiet" href="#pricing">
                      {t("ways.cloud.plans")}
                    </a>
                  </>
                ),
              },
            ]}
          />
        </section>

        {/* 4 · DÓNDE LO CONECTAS: las dos formas de integrar el mismo motor.
            El SDK envuelve la llamada dentro de una app JS/TS; el gateway
            local se pone delante de un agente de código. Cada tarjeta trae su
            primer comando, sus requisitos, el enlace a la instalación completa
            y SU cifra con SU clase de evidencia (bitácora del 10-09 y dueño,
            2026-10-03):
            · la del SDK es la primera fila de lo medido —un A/B en vivo—, de
              lib/portada/banco-en-vivo.ts, con su verja;
            · la del gateway es el neto de la rebaja de caché de PRO que midió
              el banco de TTL —una reproducción contrafactual sobre sesiones de
              una sola organización, no una previsión— de
              lib/portada/palanca-ttl.ts, con verja contra el informe. La rebaja
              pasa a 5m las escrituras de caché SOLO en los turnos con buena
              parte del prompt nueva (gateway/tarifa.ts, `decidirRebaja`). */}
        <section id="offers">
          <div className="sec-head rv">
            <span className="eyebrow">{t("offers.eyebrow")}</span>
            <h2>{t("offers.title")}</h2>
            <p>{t("offers.sub")}</p>
          </div>
          <div className="offers-grid">
            <article className="offer-card rv" id="sdk">
              <header className="offer-head">
                <h3 className="offer-name">{t("offers.sdk.name")}</h3>
                <p className="offer-who">{t("offers.sdk.who")}</p>
              </header>
              <p>{t("offers.sdk.what")}</p>
              <div className="offer-fig">
                <span className="offer-fig-top">
                  <span className="offer-fig-t">{t("offers.sdk.figureLabel")}</span>
                  <EvidenceBadge tipo="ab-sdk" label={tu("evidence.abSdk")} />
                </span>
                {/* La primera fila de lo medido (OpenAI), que ya dice su
                    condición: un flujo donde parte de las peticiones se repite. */}
                <FilasMedidas filas={filasMedidas.slice(0, 1)} />
                <details className="offer-fig-details">
                  <summary>{t("offers.figNoteToggle")}</summary>
                  <p className="offer-fig-note">{t("offers.sdk.figureNote")}</p>
                </details>
              </div>
              <div className="offer-install">
                <span className="offer-fig-t">{t("offers.install")}</span>
                <CodeFrame
                  etiqueta="Terminal"
                  copiar={{ texto: "pnpm add @bivelio/savings-layer", etiqueta: tu("copy"), etiquetaCopiado: tu("copied") }}
                >
                  <pre className="code">
                    {"pnpm add "}
                    <span className="s">@bivelio/savings-layer</span>
                  </pre>
                </CodeFrame>
                <p className="offer-req">
                  <b>{t("offers.requires")}</b> {t("offers.sdk.requires")}
                </p>
                <a className="offer-more" href="#sdk-install">
                  {t("offers.installMore")}
                </a>
              </div>
              <div className="offer-cta">
                <a className="btn ghost" href="#measured">
                  {t("offers.sdk.ctaMeasured")}
                </a>
                <a className="btn btn-quiet" href="#verify">
                  {t("offers.sdk.ctaVerify")}
                </a>
              </div>
            </article>

            <article className="offer-card rv">
              <header className="offer-head">
                <h3 className="offer-name">{t("offers.gateway.name")}</h3>
                <p className="offer-who">{t("offers.gateway.who")}</p>
              </header>
              <p>{t("offers.gateway.what")}</p>
              <div className="offer-fig">
                <span className="offer-fig-top">
                  <span className="offer-fig-t">{t("offers.gateway.figureLabel")}</span>
                  <EvidenceBadge tipo="replay-gateway" label={tu("evidence.replayGateway")} />
                </span>
                {/* El neto de la rebaja de TTL del banco del 2026-10-03, con su
                    intervalo y su condición en la misma fila. */}
                <FilasMedidas filas={[filaDeLaPalancaTtl(t, locale)]} />
                <details className="offer-fig-details">
                  <summary>{t("offers.figNoteToggle")}</summary>
                  <p className="offer-fig-note">{t("offers.gateway.figureNote")}</p>
                </details>
                {/* El informe entero, con sus límites, en su sección del banco público. */}
                <p className="offer-fig-link">
                  <Link href="/benchmarks#gateway-ttl">{t("offers.gateway.benchLink")}</Link>
                </p>
              </div>
              <div className="offer-install">
                <span className="offer-fig-t">{t("offers.install")}</span>
                {/* Open core: sin claves el gateway arranca en modo Community.
                    La clave de servicio es OPCIONAL (nube: panel de equipo). */}
                <CodeFrame
                  etiqueta="Terminal"
                  copiar={{ texto: "npm i -g @bivelio/savings-layer\nbvsala claude", etiqueta: tu("copy"), etiquetaCopiado: tu("copied") }}
                >
                  <pre className="code">
                    {"npm i -g @bivelio/savings-layer\n"}
                    {"# optional: cloud dashboard\n"}
                    {"export "}
                    <span className="s">BIVELIO_SERVICE_KEY</span>
                    {"=bvk_…\n"}
                    <span className="k">bvsala</span>
                    {" claude"}
                  </pre>
                </CodeFrame>
                <p className="offer-req">
                  <b>{t("offers.requires")}</b> {t("offers.gateway.requires")}
                </p>
                <a className="offer-more" href="#gateway">
                  {t("offers.installMore")}
                </a>
              </div>
              <div className="offer-cta">
                <a className="btn ghost" href="#gateway">
                  {t("offers.gateway.cta")}
                </a>
              </div>
            </article>
          </div>
        </section>

        {/* 5 · PRUEBA Y RESULTADOS. Cada resultado en su tarjeta, con su modelo,
            su clase de estudio, su fecha, su muestra y su intervalo: dos A/B
            del SDK (lib/portada/banco-en-vivo.ts) y, APARTE, la reproducción
            contrafactual del gateway (lib/portada/palanca-ttl.ts). No son la
            misma clase de evidencia y por eso no comparten insignia. */}
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
            {/* Los informes completos viven en /benchmarks. */}
            <p className="sec-head-link">
              <Link href="/benchmarks">{t("step2.benchLink")}</Link>
            </p>
          </div>

          <div className="evi-grid">
            {filasMedidas.map((f) => (
              <TarjetaDeEvidencia
                key={f.que}
                marca={f.marca}
                modelo={f.modelo}
                cifra={f.cifra}
                que={f.que}
                evidencia={{ tipo: "ab-sdk", label: tu("evidence.abSdk") }}
                fecha={t("evidence.dated", { fecha: diaLargo.format(dia(V.fecha)) })}
                pie={<Link href="/benchmarks">{t("evidence.report")}</Link>}
              />
            ))}
            <TarjetaDeEvidencia
              marca={filaTtl.marca}
              modelo="Claude Code"
              cifra={filaTtl.cifra}
              que={filaTtl.que}
              evidencia={{ tipo: "replay-gateway", label: tu("evidence.replayGateway") }}
              fecha={t("evidence.dated", { fecha: diaLargo.format(dia(PALANCA_TTL.fecha)) })}
              pie={<Link href="/benchmarks#gateway-ttl">{t("evidence.report")}</Link>}
            />
          </div>
          <p className="cascade-nota evi-nota">{t("cascade.footnote")}</p>

          {/* «Compatible con» ≠ «Medido en»: la franja dice dónde CORRE el SDK
              (cualquier endpoint OpenAI-compatible o el adaptador nativo); la
              nota de debajo dice con qué modelo hay cifra publicada. */}
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
              del experimento justo + la cifra dicha en lenguaje llano. Los
              números llegan como PARÁMETROS — aquí no se escribe ni un dígito. */}
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
        </section>

        {/* LEDGERS — cuatro libros que nunca se suman. Las tarjetas DESCRIBEN
            los libros, sin cifra, y la nota dice de qué libro salió el ahorro
            medido en el banco público. */}
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

        {/* 6 · PRUÉBALO CON TUS DATOS — el verificador de formato, sin cuenta.
            El PROYECTOR no vuelve (9feb377, #85: deslizadores donde el
            visitante inventaba sus porcentajes) y esta página no lo importa.
            El verificador sí: corre el selector de formato real del bundle web
            en el navegador, con el tokenizador exacto, abre con la muestra de
            menor efecto, redondea hacia abajo y dice en pantalla que es UNA
            palanca, no la factura. */}
        <section id="verify">
          <div className="sec-head rv">
            <span className="eyebrow">{t("verify.eyebrow")}</span>
            <h2>{t("verify.title")}</h2>
            <p>{t("verify.sub")}</p>
          </div>
          <FormatVerifier />
          <div className="offer-cta verify-cta">
            <a className="btn ghost" href="#sdk-install">
              {t("verify.ctaInstall")}
            </a>
          </div>
        </section>

        {/* 7 · CÓMO VIAJAN LOS DATOS: SDK o gateway local → el proveedor que
            configures. La conexión a Cloud es opcional y, una vez hecha, lleva
            telemetría (recuentos y coste), nunca el prompt. Diagrama estático;
            el recorrido interactivo vive en /how-it-works. */}
        <section id="data" className="lp-band">
          <div className="sec-head rv">
            <span className="eyebrow">{t("flow.eyebrow")}</span>
            <h2>{t("flow.title")}</h2>
            <p>{t("flow.sub")}</p>
          </div>
          <ViajeDeLosDatos
            t={{
              app: t("flow.app"),
              local: t("flow.local"),
              localSub: t("flow.localSub"),
              proveedor: t("flow.provider"),
              proveedorSub: t("flow.providerSub"),
              cloud: t("flow.cloud"),
              cloudSub: t("flow.cloudSub"),
              prompts: t("flow.prompts"),
              telemetria: t("flow.telemetry"),
              pie: t("flow.caption"),
            }}
          />
          <p className="viaje-enlaces">
            <Link href="/privacy">{t("flow.privacy")}</Link>
            <Link href="/how-it-works">{t("gateway.cta")}</Link>
          </p>
        </section>

        {/* EN PALABRAS NORMALES — la explicación para todo el mundo (dueño,
            2026-09-04): cuatro ideas en lenguaje llano, cada una con su
            animación de 8 s. Los vídeos son mudos y sin texto en pantalla a
            propósito: la página se sirve en 12 idiomas. Aquí no se promete
            ningún número. */}
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

        {/* INSTALACIÓN COMPLETA · SDK — el paquete en dos pasos. */}
        <section id="sdk-install">
          <div className="sec-head rv">
            <span className="eyebrow">{t("integrate.eyebrow")}</span>
            <h2>{t("integrate.title")}</h2>
            <p>{t("integrate.body")}</p>
          </div>
          <div className="instala">
            <CodeFrame
              etiqueta="app.ts"
              copiar={{ texto: CODE.map((l) => l.map((x) => x.v).join("")).join("\n"), etiqueta: tu("copy"), etiquetaCopiado: tu("copied") }}
            >
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
            </CodeFrame>
            {/* La vía de un comando (0.4.26): `init` lee el package.json, detecta
                la pila e imprime el cableado exacto y una comprobación que no
                llama al modelo. No escribe nada sin permiso. */}
            <div className="instala-lado">
              <p className="lp-nota">
                {t.rich("integrate.initNote", { b: (c) => <b>{c}</b>, code: (c) => <code>{c}</code> })}
              </p>
              <CodeFrame
                etiqueta="Terminal"
                copiar={{ texto: "npx @bivelio/savings-layer@latest init", etiqueta: tu("copy"), etiquetaCopiado: tu("copied") }}
              >
                <pre className="code">
                  <span className="k">npx</span>
                  {" @bivelio/savings-layer@latest init"}
                </pre>
              </CodeFrame>
            </div>
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
          <p className="sys-note">{t("systems.caption")}</p>
        </section>

        {/* HECHO PARA DESARROLLADORES — cuatro hechos del paquete, ninguno una
            promesa: cero dependencias, un SavingsReport por llamada, tráfico
            directo y streaming con el mismo informe. Sin cifras: aquí no hay
            nada que medir, solo describir. */}
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

        {/* INSTALACIÓN COMPLETA · GATEWAY — el medidor de terminales (S3):
            Claude Code/Codex sin tocar código. Aquí solo se promete MEDIR. */}
        <section id="gateway">
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
          <p className="lp-nota">
            {t("gateway.note")} <Link href="/how-it-works">{t("gateway.cta")}</Link>
          </p>
          {/* Cualquier lenguaje con el SDK oficial de OpenAI o de Anthropic
              (Python incluido): se MIDE, solo para modelos con precio de lista,
              y no se ahorra. Sus salvedades las fija
              messages/copia-del-gateway.test.ts. */}
          <p className="lp-nota">{t("gateway.pythonNote")}</p>
        </section>

        {/* RECURSO COMPLEMENTARIO · SKILL SAVINGS-MODE — instrucciones de uso
            para agentes con SUSCRIPCIÓN (sin factura, con topes). No es un
            plan ni un sustituto del gateway, y su efecto NO lleva cifra hasta
            que un A/B lo mida: de las tres partidas se enseña solo el ORDEN. */}
        <section id="skill">
          <div className="sec-head rv">
            <span className="eyebrow">{t("skill.eyebrow")}</span>
            <h2>{t("skill.title")}</h2>
            <p>{t("skill.body")}</p>
          </div>
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
                    <p className="lp-nota">{t("skill.ccNota")}</p>
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
                    <p className="lp-nota">{t("skill.cxNota")}</p>
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
                        {t("skill.aiDescargar")}
                      </a>
                    </p>
                    <p className="lp-nota">
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
            2026-10-03). Su confirmación acredita que la solicitud llegó; no es
            una cita reservada. */}
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

        {/* 8 · PLANES CLOUD — Measure (gratis, sin tarjeta) → Pro (por asiento)
            → Team (asientos incluidos) → Enterprise. Ninguno lleva comisión
            sobre el ahorro; la modalidad con comisión está CERRADA a clientes
            nuevos y aquí solo se nombra para quien la conserva. Community no
            es una de las cuatro tarjetas: es el motor, y va en la línea de
            encima. Las cifras de Pro y Team salen de sus Prices de Stripe
            (`tarifasDeLosPlanes`, con PRECIOS_DE_LOS_PLANES de respaldo); el
            documento completo es /pricing. */}
        <section id="pricing">
          <div className="sec-head rv">
            <span className="eyebrow">{t("pricing.eyebrow")}</span>
            <h2>{t("pricing.title")}</h2>
            <p>{t("pricing.body", { currency: moneda })}</p>
          </div>
          <p className="planes-community rv">
            {t.rich("pricing.community", {
              b: (c) => <b>{c}</b>,
              install: (c) => <a href="#sdk-install">{c}</a>,
            })}
          </p>
          {/* Límites y versión mínima de Measure desde LIMITES_MEDIR /
              VERSION_MINIMA_MEDIR. El plan elegido viaja en `next` hasta el
              panel (registro → correo → /auth/callback → signup/success →
              /dashboard?plan=…), donde el selector de BillingButtons arranca
              en él. */}
          <PlanesCloud
            grupo="periodo-portada"
            planes={planes}
            medir={medir}
            nombres={{
              medir: t("pricing.plans.medir.name"),
              pro: t("pricing.plans.pro.name"),
              team: t("pricing.plans.team.name"),
              enterprise: t("pricing.plans.enterprise.name"),
            }}
            destinos={{
              pro: { pathname: "/signup", query: { next: `/${locale}/dashboard?plan=pro` } },
              team: { pathname: "/signup", query: { next: `/${locale}/dashboard?plan=equipo` } },
            }}
          />
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
            <p className="plan-foot-mas">
              <Link className="btn ghost" href="/pricing">
                {t("pricing.fullTerms")}
              </Link>
            </p>
          </div>
        </section>

        {/* 9 · PREGUNTAS DE COMPRA — <details> nativo, sin script. */}
        <section id="faq">
          <div className="faq-cols">
            <div className="sec-head rv">
              <span className="eyebrow">{t("faq.eyebrow")}</span>
              <h2>{t("faq.title")}</h2>
              <p>
                {t.rich("faq.more", {
                  pricing: (c) => <Link href="/pricing">{c}</Link>,
                  privacy: (c) => <Link href="/privacy">{c}</Link>,
                })}
              </p>
            </div>
            <PreguntasDeCompra preguntas={t.raw("faq.items") as { q: string; a: string }[]} />
          </div>
        </section>

        {/* 10 · CIERRE — Measure + acceso al repositorio, sobre el Gradient
            Floor (tenue y casi quieto). La banda CTA del pie se retira en esta
            página desde la hoja de estilos: diría lo mismo dos veces. */}
        <section className="cierre-sec">
          <CierreMeasure
            titulo={t("closing.title")}
            acento={t("closing.titleAccent")}
            texto={t("closing.sub")}
            acciones={
              <>
                <Link className="btn btn-lg" href="/signup">
                  {t("hero.ctaStart")}
                </Link>
                <a className="btn btn-lg ghost" href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer">
                  {t("closing.repo")}
                  <span className="sr-only"> {tn("newTab")}</span>
                </a>
              </>
            }
            nota={<a href="#sdk-install">{t("hero.ctaOss")}</a>}
          />
        </section>
      </main>

      {/* COMPAÑÍA Y ECOSISTEMA — la banda del NVIDIA Inception Program al
          cierre de la home, la MISMA que cierra el héroe de bivelio.com
          (captura aprobada el 2026-09-15; el copy de las cuatro claves es el
          suyo, verbatim, en los 12 idiomas). Va FUERA de `main.wrap` porque es
          a sangre completa, como la banda CTA que abre el pie justo debajo. */}
      <NvidiaEcosystemBand kicker={t("nvidia.kicker")} title={t("nvidia.title")} sub={t("nvidia.sub")} cta={t("nvidia.cta")} />

      <Footer />
    </div>
  );
}

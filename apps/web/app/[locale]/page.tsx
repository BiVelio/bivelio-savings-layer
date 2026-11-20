import { Fragment } from "react";
import { preload } from "react-dom";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { getImageProps } from "next/image";

import { ReservarLlamada } from "./components/ReservarLlamada";
import { CapaEnAccion } from "@/app/components/landing/CapaEnAccion";
import { CierreMeasure } from "@/app/components/landing/CierreMeasure";
import { DosManeras } from "@/app/components/landing/DosManeras";
import { EnlacesAntiguos } from "@/app/components/landing/EnlacesAntiguos";
import { PlanesCloud } from "@/app/components/landing/PlanesCloud";
import { PreguntasDeCompra } from "@/app/components/landing/PreguntasDeCompra";
import { TarjetaLanzamiento } from "@/app/components/landing/TarjetaLanzamiento";
import { elegirVariante } from "@/app/components/franja-lanzamiento";
import { InsigniaProductHunt } from "@/app/components/ProductHunt";
import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { CodeFrame, Recibo } from "@/app/components/ui";
import { Marcado } from "@/app/components/campana/Marcado";
import { MosaicoDeLlamadas } from "@/app/components/campana/MosaicoDeLlamadas";
import { CursorGrid } from "@/app/components/CursorGrid";
import { RevealObserver } from "@/app/components/RevealObserver";
import { LogoProveedor } from "@/app/components/LogoProveedor";
import { filaDeLaPalancaTtl, filasDelBancoEnVivo, type FilaMedida } from "@/app/components/MedidoEnVivo";
import { NvidiaEcosystemBand } from "@/app/components/NvidiaInception";
import { DIAS_ACTIVOS_PARA_CONTAR_ASIENTO } from "@/lib/billing/asientos";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { IMAGEN_AL_COMPARTIR, absolute, languageAlternates } from "@/i18n/site";
import { tarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { LIMITES_MEDIR, VERSION_MINIMA_MEDIR } from "@/lib/license/medir-publico";
import { BANCO_EN_VIVO } from "@/lib/portada/banco-en-vivo";
import { textosDeTarjeta, type Traductor } from "@/lib/plataformas-de-lanzamiento";
import { PALANCA_TTL } from "@/lib/portada/palanca-ttl";
import { GradientText } from "@/vendor/affectui/gradient-text";
import panelDelBanco from "@/assets/portada/panel-del-banco.png";
import panelDelBancoMovil from "@/assets/portada/panel-del-banco-movil.png";

// La franja bajo la captura del héroe: los proveedores con los que el banco
// mide EN VIVO, con el contador de cada uno (OpenAI y Anthropic con cifra de
// ahorro en /benchmarks; Gemini en el banco semanal, sin cifra de ahorro —
// lo dice la nota de compatibilidad, que vive en /benchmarks#compat).
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

/** Índice (en `landing.faq.items`) de la pregunta que la portada corta no repite. */
const PREGUNTA_SOLO_EN_COMO_FUNCIONA = 3;

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
      images: [{ url: absolute(IMAGEN_AL_COMPARTIR.ruta), width: IMAGEN_AL_COMPARTIR.width, height: IMAGEN_AL_COMPARTIR.height, type: IMAGEN_AL_COMPARTIR.type, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [absolute(IMAGEN_AL_COMPARTIR.ruta)],
    },
  };
}

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  // EL PAISAJE DEL HÉROE ES EL LCP, y como fondo CSS el navegador no lo pide
  // hasta tener la hoja entera parseada: con la red de un móvil salía a los
  // 2,3 s y el LCP a los 4,2 s (main: 1,7 s). Se anuncia desde el HTML con los
  // mismos cortes que .hero-paisaje en globals.css (≤ 640 px, la de 900; por
  // encima, la de 1600), solo AVIF —el navegador sin AVIF ignora el aviso por
  // `type` y sigue con el WebP del image-set— y con prioridad alta.
  preload("/brand/paisaje/dia-900.avif", { as: "image", type: "image/avif", media: "(max-width: 640px)", fetchPriority: "high" });
  preload("/brand/paisaje/dia-1600.avif", { as: "image", type: "image/avif", media: "(min-width: 641px)", fetchPriority: "high" });
  const t = await getTranslations("landing");
  const th = await getTranslations("howItWorks");
  // Etiquetas compartidas de la fundación (copiar, clases de evidencia, recibo)
  // y el «se abre en una pestaña nueva» del chrome.
  const tu = await getTranslations("ui");
  const tn = await getTranslations("nav");
  const tl = await getTranslations("landing.launch");
  // Las etiquetas del replay del gateway son las de su sección del banco público.
  const tb = await getTranslations("benchmarksPage");
  const CODE = lineasDelSnippet(th);

  // Las preguntas de compra, cortas: la de las suscripciones de tarifa plana
  // ya la responde /how-it-works («Tu caso, en 10 segundos»), con más sitio.
  const preguntasDeCompra = (t.raw("faq.items") as { q: string; a: string }[]).filter((_, i) => i !== PREGUNTA_SOLO_EN_COMO_FUNCIONA);

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
  const [filaOpenAi, filaClaude] = filasMedidas as [FilaMedida, FilaMedida];
  const dia = (d: string) => new Date(`${d}T00:00:00Z`);

  // Los límites de Medir salen de la constante que aplica la ingesta.
  const medir = {
    seats: LIMITES_MEDIR.asientos,
    requests: LIMITES_MEDIR.peticionesDiarias.toLocaleString(locale),
    version: VERSION_MINIMA_MEDIR,
  };

  // La fila del gateway (banco de TTL) para su recibo de #measured, con su
  // muestra y su intervalo (lib/portada/palanca-ttl.ts, con verja contra el
  // informe), y la línea de contexto de los recibos del SDK: batería, fecha y
  // versión medida.
  const filaTtl = filaDeLaPalancaTtl(t, locale);
  const P = PALANCA_TTL;
  const pct2 = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const ent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const diaCorto = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const reciboMeta = `${V.bateria} · ${diaCorto.format(dia(V.fecha))} · SDK ${V.versionSdk}`;

  // LANZAMIENTO EN PRODUCT HUNT (22-11-2026): la ventana con el reloj de esta
  // regeneración (ISR, cada hora). La insignia del héroe y el botón de la
  // tarjeta del final se corrigen solos si la página es vieja (guion previo
  // de NavBar y, al montar, el reloj del navegador): franja-lanzamiento.ts.
  const ventanaPh = elegirVariante(Date.now());

  return (
    <div className="lp lp2">
      <CursorGrid />
      <RevealObserver />
      <EnlacesAntiguos />
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
          {/* FIRMA DE CAMPAÑA: el cielo cian de la pieza promocional, en la
              esquina superior derecha, detrás de todo (no es candidato a LCP;
              el contexto de apilamiento lo pone `.lp .hero.hero-panel`). */}
          <div className="cielo" aria-hidden="true" />
          <div className="hpanel-copy">
            {/* LA ETIQUETA, COMO LA DE BIVELIO.COM («Engineer your 10x Business
                Infrastructure.», `.hero__tag` de la madre): la misma píldora
                de cristal, la marca en sans pesada, la palabra clave en un
                bloque cian y el resto en serif cursiva. Como allí, en inglés
                en todos los idiomas; lang="en" para los lectores de pantalla. */}
            <p className="hero-sello" lang="en">
              <b>Savings Layer</b> <mark>Measured</mark> <em>on every call.</em>
            </p>
            <h1>
              {t("hero.title")}{" "}
              <GradientText className="hero-acento">
                <span className="u">
                  <Marcado texto={t("hero.titleAccent")} marca={t("hero.titleMark")} />
                </span>
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
            {/* La insignia oficial de Product Hunt, bajo los botones, SOLO la
                semana del lanzamiento (22–29-11-2026). Fuera de ella no hay
                imagen ni hueco. */}
            <InsigniaProductHunt lugar="heroe" inicial={ventanaPh} nuevaPestana={tn("newTab")} />
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

          {/* La franja de proveedores de la pieza (rótulo + teselas entre
              filetes): con qué contador se midió en vivo. */}
          <div className="hpanel-medido franja-eco">
            <span className="hpanel-medido-t franja-eco-k">{t("hero.medidoEnVivo")}</span>
            <span className="hpanel-marcas franja-eco-teselas">
              {MEDIDO_EN_VIVO.map((m) => (
                <span className="hpanel-marca eco-tesela" key={m.marca}>
                  <span className="eco-tesela-logo">
                    <LogoProveedor marca={m.marca} size={16} />
                  </span>
                  {m.label}
                </span>
              ))}
            </span>
          </div>
          {/* El mosaico de llamadas al pie del héroe: cada casilla, una llamada. */}
          <MosaicoDeLlamadas semilla={11} filas={4} className="mosaico--sangre hero-mosaico" />
        </section>

        {/* 2 · SAVINGS LAYER, EN ACCIÓN (#data). Lo primero bajo el héroe: qué
            es la capa y por dónde viaja cada cosa. SDK o gateway local → el
            proveedor que configures; la conexión a Cloud es opcional y lleva
            telemetría (recuentos y coste), nunca el prompt. La ilustración
            entra por `CapaEnAccion`: hoy pinta el diagrama estático y la
            animada la sustituye cambiando una línea de ese fichero. */}
        <section id="data" className="lp-band capa-sec">
          <div className="sec-head sec-head--centro rv">
            <span className="eyebrow">{t("layer.eyebrow")}</span>
            <h2>
              {t("layer.title")}{" "}
              <span className="serif-accent">
                <Marcado texto={t("layer.titleAccent")} marca={t("layer.titleMark")} />
              </span>
            </h2>
            <p>{t("layer.sub")}</p>
          </div>
          <CapaEnAccion
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
          <p className="viaje-enlaces capa-enlaces">
            <Link href="/how-it-works">{t("gateway.cta")}</Link>
            <Link href="/privacy">{t("flow.privacy")}</Link>
          </p>
        </section>

        {/* 3 · DOS MANERAS DE USAR SAVINGS (guía §2.1): Community —el motor
            open source en tu infraestructura, sin cuenta— frente a Savings
            Cloud, opcional. Es un eje distinto de «SDK o gateway» (eso va
            justo debajo). El camino local no termina en el alta: sus acciones
            son instalar y leer el código. */}
        <section id="ways">
          <div className="sec-head rv">
            <span className="eyebrow">{t("ways.eyebrow")}</span>
            <h2>{t("ways.title")}</h2>
            <p>{t("ways.sub")}</p>
          </div>
          <DosManeras
            preguntas={[t("ways.q.runs"), t("ways.q.account"), t("ways.q.telemetry"), t("ways.q.manage")]}
            maneras={[
              {
                variante: "community",
                nombre: t("ways.community.name"),
                etiqueta: t("ways.community.tag"),
                resumen: t("ways.community.lede"),
                pastillas: t.raw("ways.community.chips") as string[],
                respuestas: [t("ways.community.runs"), t("ways.community.account"), t("ways.community.telemetry"), t("ways.community.manage")],
                acciones: (
                  <>
                    <a className="btn" href="#sdk-install">
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
                variante: "cloud",
                nombre: t("ways.cloud.name"),
                etiqueta: t("ways.cloud.tag"),
                resumen: t("ways.cloud.lede"),
                pastillas: t.raw("ways.cloud.chips") as string[],
                respuestas: [t("ways.cloud.runs"), t("ways.cloud.account"), t("ways.cloud.telemetry"), t("ways.cloud.manage")],
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

        {/* 4 · DÓNDE LO CONECTAS: una sola sección para lo que antes eran
            cinco (#offers, #sdk-install, #devs, #gateway y #skill). Un
            selector SDK · Gateway —dos radios y `:has()`, como el de los
            planes: funciona sin script y con las flechas del teclado— y, en
            cada panel, para quién es, su primer comando, sus requisitos y el
            enlace a la instalación completa, que vive en /how-it-works.
            Las anclas de siempre siguen aquí (bivelio.com enlaza
            #sdk-install): la del contenedor y las de las dos etiquetas del
            selector, siempre visibles; `EnlacesAntiguos` elige la pestaña.
            Las CIFRAS no van en esta sección: cada una está en #measured, en
            su recibo y con su clase de evidencia. */}
        <section id="offers">
          <div className="sec-head rv">
            <span className="eyebrow">{t("offers.eyebrow")}</span>
            <h2>{t("offers.title")}</h2>
            <p>{th("ways.lede")}</p>
          </div>
          <div className="conecta rv" id="sdk-install">
            <div className="conecta-selector" role="radiogroup" aria-label={t("offers.eyebrow")}>
              <label className="conecta-opcion" id="sdk">
                <input className="conecta-radio" type="radio" name="conecta" value="sdk" defaultChecked />
                <span className="conecta-opcion-icono" aria-hidden>
                  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m7 6.5-3.5 3.5L7 13.5M13 6.5l3.5 3.5-3.5 3.5M11.2 4.5 8.8 15.5" />
                  </svg>
                </span>
                <span className="conecta-opcion-t">
                  <b>{t("offers.sdk.name")}</b>
                  <small>{th("pieces.sdk.hint")}</small>
                </span>
              </label>
              <label className="conecta-opcion" id="gateway">
                <input className="conecta-radio" type="radio" name="conecta" value="gateway" />
                <span className="conecta-opcion-icono" aria-hidden>
                  <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5zM6.5 8.5 8.5 10.5 6.5 12.5M10.5 12.5h3" />
                  </svg>
                </span>
                <span className="conecta-opcion-t">
                  <b>{t("offers.gateway.name")}</b>
                  <small>{th("pieces.gateway.hint")}</small>
                </span>
              </label>
            </div>

            <div className="conecta-panel" data-panel="sdk">
              <div className="conecta-texto">
                <p className="conecta-k">{th("ways.sdk.kicker")}</p>
                <h3>{th("ways.sdk.title")}</h3>
                <p className="conecta-quien">{t("offers.sdk.who")}</p>
                <ul className="conecta-req">
                  <li>
                    <b>{t("offers.requires")}</b> {t("offers.sdk.requires")}
                  </li>
                  <li>{th("ways.sdk.p2")}</li>
                  <li>{th("ways.sdk.p3")}</li>
                </ul>
                <div className="conecta-acciones">
                  <Link className="btn ghost" href="/how-it-works#install-sdk">
                    {t("offers.installMore")}
                  </Link>
                  <a className="btn btn-quiet" href="#measured">
                    {t("offers.sdk.ctaMeasured")}
                  </a>
                </div>
                <p className="conecta-mas">
                  <Link href="/how-it-works#verify">{t("offers.sdk.ctaVerify")}</Link>
                </p>
              </div>
              <div className="conecta-codigo">
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
                {/* Lo esencial de «hecho para desarrolladores», en una tira:
                    cuatro hechos del paquete, ninguno una promesa ni una cifra. */}
                <ul className="conecta-hechos">
                  {(t.raw("devs.cards") as { title: string; mono: string }[]).map((c) => (
                    <li key={c.title}>
                      <code>{c.mono}</code>
                      <span>{c.title}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="conecta-panel" data-panel="gateway">
              <div className="conecta-texto">
                <p className="conecta-k">{th("ways.gateway.kicker")}</p>
                <h3>{th("ways.gateway.title")}</h3>
                <p className="conecta-quien">{t("offers.gateway.who")}</p>
                <ul className="conecta-req">
                  <li>
                    <b>{t("offers.requires")}</b> {t("offers.gateway.requires")}
                  </li>
                  <li>{th("ways.gateway.p2")}</li>
                  <li>{th("ways.gateway.p3")}</li>
                </ul>
                <div className="conecta-acciones">
                  <Link className="btn ghost" href="/how-it-works#install-gateway">
                    {t("offers.installMore")}
                  </Link>
                  <a className="btn btn-quiet" href="#measured">
                    {t("offers.sdk.ctaMeasured")}
                  </a>
                </div>
              </div>
              <div className="conecta-codigo">
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
              </div>
            </div>
          </div>

          {/* RECURSO COMPLEMENTARIO · el skill savings-mode, para agentes con
              SUSCRIPCIÓN. No es un plan ni un sustituto del gateway, y no
              lleva cifra: aquí solo se nombra y se enlaza su instalación. */}
          <aside className="conecta-skill rv" id="skill">
            <span className="conecta-skill-icono" aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 3.5 11.6 8l4.4.4-3.4 2.9 1 4.4L10 13.3l-3.6 2.4 1-4.4L4 8.4 8.4 8z" />
              </svg>
            </span>
            <p className="conecta-skill-t">
              <b>{t("skill.eyebrow")}</b>
              <span>{t("skill.title")}</span>
            </p>
            <Link className="conecta-skill-a" href="/how-it-works#skill">
              {t("offers.installMore")}
            </Link>
          </aside>
        </section>

        {/* 5 · PRUEBA. Tres recibos, uno por resultado, cada uno con su modelo,
            su fecha, su muestra, su intervalo y SU clase de evidencia: dos A/B
            del SDK (lib/portada/banco-en-vivo.ts) y, APARTE, la reproducción
            contrafactual del gateway (lib/portada/palanca-ttl.ts). No son la
            misma clase de prueba y por eso no comparten insignia. La condición
            de cada cifra se despliega bajo su recibo; el método, el vídeo del
            experimento justo y la nota de compatibilidad viven en /benchmarks. */}
        <section id="measured">
          <div className="sec-head sec-head--lado rv">
            <div>
              <span className="eyebrow">{t("step2.eyebrow")}</span>
              <h2>{t("step2.title")}</h2>
              <p>{t.rich("enVivo.pie", { bench: (c) => <Link href="/benchmarks">{c}</Link> })}</p>
            </div>
            <Link className="btn ghost" href="/benchmarks">
              {t("hero.ctaBench")}
            </Link>
          </div>

          <div className="prueba">
            <article className="prueba-item rv">
              <header className="prueba-cabeza">
                <LogoProveedor marca={filaOpenAi.marca ?? "OpenAI"} size={18} />
                <b>{filaOpenAi.marca}</b>
                <span>{t("offers.sdk.name")}</span>
              </header>
              <Recibo
                ancho
                compacto
                titulo={t("receipt.title")}
                meta={reciboMeta}
                filas={[
                  { etiqueta: t("receipt.model"), valor: filaOpenAi.modelo, mono: true },
                  { etiqueta: t("receipt.sample"), valor: t("receipt.sampleValue", { familias: V.openai.familias, peticiones: V.openai.peticionesPorBrazo }), mono: false },
                  { etiqueta: t("receipt.repeats"), valor: rep },
                  { etiqueta: t("receipt.interval"), valor: pct1.formatRange(V.openai.ahorro.lower, V.openai.ahorro.upper), tono: "atenuado" },
                ]}
                total={{ etiqueta: t("receipt.total"), valor: filaOpenAi.cifra, tono: "ahorro" }}
                evidencia={{ tipo: "ab-sdk", label: tu("evidence.abSdk") }}
                procedencia={{ texto: t("receipt.source"), href: "/benchmarks", enlace: tu("recibo.comoSeMidio") }}
              />
              <details className="prueba-mas">
                <summary>{t("offers.figNoteToggle")}</summary>
                <p>{filaOpenAi.que}</p>
                <p>{t("offers.sdk.figureNote")}</p>
              </details>
            </article>

            <article className="prueba-item rv">
              <header className="prueba-cabeza">
                <LogoProveedor marca={filaClaude.marca ?? "Anthropic"} size={18} />
                <b>{filaClaude.marca}</b>
                <span>{t("offers.sdk.name")}</span>
              </header>
              <Recibo
                ancho
                compacto
                titulo={t("receipt.title")}
                meta={reciboMeta}
                filas={[
                  { etiqueta: t("receipt.model"), valor: filaClaude.modelo, mono: true },
                  { etiqueta: t("receipt.sample"), valor: t("receipt.sampleValue", { familias: V.anthropic.familias, peticiones: V.anthropic.peticionesPorBrazo }), mono: false },
                  { etiqueta: t("receipt.prefixCache"), valor: pct0.format(V.anthropic.prefijoDelProveedor), tono: "atenuado" },
                  { etiqueta: t("receipt.interval"), valor: pct1.formatRange(V.anthropic.ahorro.lower, V.anthropic.ahorro.upper), tono: "atenuado" },
                ]}
                total={{ etiqueta: t("receipt.total"), valor: filaClaude.cifra, tono: "ahorro" }}
                evidencia={{ tipo: "ab-sdk", label: tu("evidence.abSdk") }}
                procedencia={{ texto: t("receipt.source"), href: "/benchmarks", enlace: tu("recibo.comoSeMidio") }}
              />
              <details className="prueba-mas">
                <summary>{t("offers.figNoteToggle")}</summary>
                <p>{filaClaude.que}</p>
              </details>
            </article>

            {/* El gateway: el neto de la rebaja de TTL del banco del 2026-10-03.
                Un replay, no un A/B: otra insignia, y el enlace a su informe. */}
            <article className="prueba-item rv">
              <header className="prueba-cabeza">
                <LogoProveedor marca={filaTtl.marca ?? "Anthropic"} size={18} />
                <b>Claude Code</b>
                <span>{t("offers.gateway.name")}</span>
              </header>
              <Recibo
                ancho
                compacto
                titulo={t("receipt.title")}
                meta={`${t("offers.gateway.name")} · ${diaCorto.format(dia(P.fecha))}`}
                filas={[
                  { etiqueta: tb("gatewayTtl.stat.sessions"), valor: ent.format(P.sesiones) },
                  { etiqueta: tb("gatewayTtl.stat.requests"), valor: ent.format(P.peticiones) },
                  { etiqueta: tb("gatewayTtl.stat.days"), valor: ent.format(P.dias) },
                  { etiqueta: tb("gatewayTtl.thInterval", { confianza: pct0.format(P.confianza) }), valor: pct2.formatRange(P.neto.lower, P.neto.upper), tono: "atenuado" },
                ]}
                total={{ etiqueta: tb("gatewayTtl.row.net"), valor: filaTtl.cifra, tono: "ahorro" }}
                evidencia={{ tipo: "replay-gateway", label: tu("evidence.replayGateway") }}
                procedencia={{ texto: tb("centre.classReplay"), href: "/benchmarks#gateway-ttl", enlace: tu("recibo.comoSeMidio") }}
              />
              <details className="prueba-mas">
                <summary>{t("offers.figNoteToggle")}</summary>
                <p>{filaTtl.que}</p>
                <p>{t("offers.gateway.figureNote")}</p>
                {/* El informe entero, con sus límites, en su sección del banco público. */}
                <p>
                  <Link href="/benchmarks#gateway-ttl">{t("offers.gateway.benchLink")}</Link>
                </p>
              </details>
            </article>
          </div>
        </section>

        {/* 6 · PLANES CLOUD — Measure (gratis, sin tarjeta) → Pro (por asiento)
            → Team (asientos incluidos) → Enterprise. Ninguno lleva comisión
            sobre el ahorro; la modalidad con comisión está CERRADA a clientes
            nuevos y aquí solo se nombra para quien la conserva. Community no
            es una de las cuatro tarjetas: es el motor, y va en la línea de
            encima. Las cifras de Pro y Team salen de sus Prices de Stripe
            (`tarifasDeLosPlanes`, con PRECIOS_DE_LOS_PLANES de respaldo); el
            documento completo es /pricing. */}
        <section id="pricing" className="lp-band">
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

        {/* 7 · PREGUNTAS DE COMPRA (<details> nativo, sin script) y, a su lado,
            la llamada de 15 minutos. La confirmación de la llamada acredita
            que la solicitud llegó; no es una cita reservada. */}
        <section id="faq">
          <div className="faq-cols">
            <div className="faq-lado">
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
            </div>
            <PreguntasDeCompra preguntas={preguntasDeCompra} />
          </div>
        </section>

        {/* 8 · CIERRE — Measure + acceso al repositorio, sobre el Gradient
            Floor (tenue y casi quieto). La banda CTA del pie se retira en esta
            página desde la hoja de estilos: diría lo mismo dos veces. */}
        <section className="cierre-sec">
          <CierreMeasure
            titulo={t("closing.title")}
            acento={t("closing.titleAccent")}
            marca={t("closing.titleMark")}
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
            firma={
              /* La firma de la pieza: el dominio y el precio de Pro, leído de
                 Stripe (`planes.pro.mensual`) como el resto de la página. */
              <span className="pildora-precio">
                Pro · {planes.pro.mensual} {t("pricing.per")}
              </span>
            }
          />
        </section>

        {/* 9 · PLATAFORMAS DE LANZAMIENTO — la tarjeta «Find us on …», un
            carrusel discreto con Product Hunt, DevHunt y las que vengan
            (lib/plataformas-de-lanzamiento.ts), después del cierre y antes de
            la banda de NVIDIA y del pie. La franja de arriba enseña siempre
            otra plataforma que la tarjeta. */}
        <TarjetaLanzamiento construido={Date.now()} t={textosDeTarjeta(tl as unknown as Traductor, tn("newTab"))} />
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

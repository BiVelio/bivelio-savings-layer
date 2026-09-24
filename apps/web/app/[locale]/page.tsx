import { Fragment } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import abData from "@/public/data/ab-live.json";
import { ReservarLlamada } from "./components/ReservarLlamada";
import { CursorGrid } from "@/app/components/CursorGrid";
import { RevealObserver } from "@/app/components/RevealObserver";
import { KineticTitle } from "@/app/components/KineticTitle";
import { ReciboMedido } from "@/app/components/ReciboMedido";
import { CalculadoraComision } from "@/app/components/CalculadoraComision";
import { SnippetPorSistema } from "@/app/components/SnippetPorSistema";
import { SkillPorSuperficie } from "@/app/components/SkillPorSuperficie";
import { ANATOMIA_MEDIDA } from "@/lib/skill/anatomia";
import { LogoProveedor } from "@/app/components/LogoProveedor";
import { NvidiaEcosystemBand } from "@/app/components/NvidiaInception";
import { VideoExplicativo } from "@/app/components/VideoExplicativo";
import { GARANTIA_NETA_RATIO, TRAMOS } from "@/lib/billing/tarifa";
import { type AbArtifact } from "@/app/[locale]/dashboard/data";
import { ReferenceModeBadge } from "@/app/[locale]/dashboard/components/ReferenceModeBadge";
import { NetSavingsCIBand } from "@/app/[locale]/dashboard/components/NetSavingsCIBand";
import { ReferenceLedgerCards } from "@/app/[locale]/dashboard/components/ReferenceLedgerCards";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { absolute, languageAlternates } from "@/i18n/site";
import { preciosDelPlan } from "@/lib/stripe/pricing";
import { formatearPrecio } from "@/lib/format/precio";

// Proveedores que exponen un endpoint OpenAI-compatible (o, en el caso de
// Anthropic, tienen adaptador nativo). Es una lista de COMPATIBILIDAD, no de
// mediciones: la única cifra publicada vive en `hero.proofs`.
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

// The measured A/B artifact powers Step 2 (the reference bench) and the price
// used by the Step-1 projector — exactly like the dashboard verify/proof pages.
const ab = abData as unknown as AbArtifact;

const mini = (ab.pricing.table["gpt-4o-mini"] ?? {}) as { inputPer1k?: number; outputPer1k?: number };
const prices = { inPer1k: mini.inputPer1k ?? 0.00015, outPer1k: mini.outputPer1k ?? 0.0006 };

// The "integrate" snippet: the same 3-step story as /how-it-works (package →
// license → wrap the call), with its step headers localized via the shared
// `howItWorks.snip*` keys. Code tokens stay verbatim; each carries a color
// class: n = paso (brand, bold), k = keyword (brand), s = string (ámbar),
// c = comentario (soft), g = resultado (menta).
type TokenCls = "c" | "k" | "s" | "n" | "g";
function lineasDelSnippet(th: (k: string) => string): { cls?: TokenCls; v: string }[][] {
  return [
    [{ cls: "n", v: `# 1 · ${th("snip1")}` }],
    [{ v: "pnpm add " }, { cls: "s", v: "@bivelio/savings-layer" }],
    [],
    [{ cls: "n", v: `# 2 · ${th("snip2")}` }],
    [{ v: "export " }, { cls: "s", v: "BIVELIO_LICENSE_KEY" }, { v: "=…" }],
    [],
    [{ cls: "n", v: `# 3 · ${th("snip3")}` }],
    [{ cls: "k", v: "const" }, { v: " layer = createSavingsLayer({ provider, licenseKey, … });" }],
    [
      { cls: "k", v: "const" },
      { v: " { text, report } = " },
      { cls: "k", v: "await" },
      { v: " layer.generate({ model, messages });" },
    ],
    [],
    [{ v: "console.log(report.cost.netSavings)  " }, { cls: "g", v: `// ← ${th("snipResult")}` }],
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

  const cascadeSteps = t.raw("cascade.steps") as {
    n: string;
    title: string;
    sub: string;
    ledger: string;
    grey: boolean;
  }[];
  const ledgers = t.raw("ledgers") as { idx: string; name: string; desc: string }[];

  // Las cuatro tarjetas llevaban un guion ESCRITO A MANO y el texto «ejecuta el
  // optimizador para medir», encima de un artefacto que YA traía las cuatro
  // cifras medidas con su intervalo. Cuatro cajas vacías sobre datos reales: la
  // misma clase de fallo que un libro contable sin productor.
  //
  // Se casa por NOMBRE del libro, no por posición: el artefacto viejo traía
  // `output_restriction` donde el nuevo trae `provider_cached`, y casar por
  // índice habría puesto la cifra de una palanca bajo el título de otra.
  const CLAVE_DE_TARJETA: Record<string, string> = {
    avoided_calls: "avoided_calls",
    eliminated_tokens: "eliminated_tokens",
    compressed_tokens: "compressed_tokens",
    provider_cached_tokens: "provider_cached",
  };
  const medidoPorLibro = new Map(
    (ab.ledgers ?? []).map((l) => [l.ledger, l]),
  );
  const features = t.raw("pricing.features") as string[];

  // El precio sale del Price de Stripe, que es lo que de verdad se cobra, y se
  // formatea AQUÍ (servidor) para el idioma de la página. Antes estaba escrito a
  // mano en los 12 ficheros de traducción y no se hablaba con Stripe: por eso la
  // landing estática llegó a anunciar dólares mientras se cobraban euros.
  const precios = await preciosDelPlan();
  const precioMensual = formatearPrecio(locale, precios.monthly);
  const precioAnual = formatearPrecio(locale, precios.yearly);
  const moneda = precios.monthly.currency.toUpperCase();

  // Los números de la fórmula pública, formateados AQUÍ: los mensajes no
  // llevan ni un dígito de tarifa (tarifa-en-parametros.test.ts).
  const pctLocal = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 0 }) + "%";
  // La traducción llana enseña el decimal: es la misma cota que publica el
  // héroe (23,1%), y redondearla aquí haría que las dos cifras no cuadrasen.
  const pctLocal1 = (n: number) => (n * 100).toLocaleString(locale, { maximumFractionDigits: 1 }) + "%";

  // El rango real de la tirada, escenario a escenario — sustituye a la tabla
  // en la landing sin inventar nada: mínimo y máximo medidos del artefacto.
  const puntosEscenario = ab.scenarios
    .map((s) => s.measured?.savings?.point)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const rangoMin = pctLocal1(Math.min(...puntosEscenario));
  const rangoMax = pctLocal1(Math.max(...puntosEscenario));
  const moneyLocal = (n: number) =>
    n.toLocaleString(locale, { style: "currency", currency: moneda, maximumFractionDigits: 0 });
  const tramosLocal = TRAMOS.map((tr) =>
    Number.isFinite(tr.hastaEur) ? `${pctLocal(tr.tipo)} ≤ ${moneyLocal(tr.hastaEur)}` : `${pctLocal(tr.tipo)} +`,
  ).join(" · ");

  return (
    <div className="lp">
      <CursorGrid />
      <RevealObserver />
      <main className="wrap">
        {/* HERO */}
        <section className="hero">
          <div>
            <span className="eyebrow">{t("hero.eyebrow")}</span>
            <h1>
              <KineticTitle text={t("hero.title")} />{" "}
              <KineticTitle text={t("hero.titleAccent")} className="u" start={220} />
            </h1>
            <p className="lede">{t("hero.lede")}</p>
            <div className="hero-cta">
              <a className="btn" href="#measured">
                {t("hero.ctaRun")}
              </a>
              <a className="btn ghost" href="#pricing">
                {t("hero.ctaPricing")}
              </a>
            </div>
            <div className="hero-note">
              <span className="pulse" /> {t("hero.note")}
            </div>

            {/* HÉROE LIMPIO (petición del dueño, 2026-09-12): aquí solo el
                titular, la entradilla, los botones y el carrusel de marcas. La
                cifra medida vive en el recibo de la derecha y, con su tarjeta
                «Medido contra proveedor real», en la sección de lo medido.
                El sello del programa de startups que iba aquí bajo la nota
                (2026-09-14) se fue el 2026-09-15 (decisión del dueño): vive en
                la banda antes del pie y en la tarjeta del pie, no en el héroe.
                «Compatible con» ≠ «Medido en»: la franja dice dónde CORRE el SDK
                (cualquier endpoint OpenAI-compatible o el adaptador nativo); la
                nota de debajo dice con qué modelo hay cifra publicada. */}
            <div className="hero-compat">
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
              <p className="compat-nota">{t("hero.compatibleNota", { modelo: abData.model.split("/").pop() ?? "" })}</p>
            </div>
          </div>

          <div className="hero-col">
          <ReciboMedido
            ab={ab}
            locale={locale}
            labels={{
              title: t("recibo.title"),
              modelo: t("recibo.modelo"),
              parejas: t("recibo.parejas"),
              calidad: t("recibo.calidad"),
              suelo: t("recibo.suelo"),
              punto: t("recibo.punto"),
              libros: t("recibo.libros"),
              pie: t("recibo.pie"),
              fecha: t("recibo.fecha"),
            }}
            filas={cascadeSteps.map((st) => ({ ledger: st.ledger, title: st.title }))}
          />

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
        </section>

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
            {/* EL FICHERO DE ENSAYOS CRUDOS, ENLAZADO DE VERDAD.
                `ab:publish` lleva copiando `ab-live-trials.csv` a `public/data`
                desde que existe, y NADIE lo enlazaba: el titular decía «puedes
                repetir la medición» y no había por dónde empezar. Repetir el
                banco sigue sin poder hacerlo un cliente (el repo es privado y
                los bancos no viajan en el paquete de npm), pero comprobar la
                aritmética de cada pareja sí — y eso es lo que ahora promete la
                frase de arriba. */}
            <p className="sec-head-link">
              <a href="/data/ab-live-trials.csv" download>
                {t("step2.trialsLink")}
              </a>
            </p>
          </div>

          {/* La prueba, con su modelo. Estaba en el héroe; el dueño pidió un
              héroe limpio y aquí es donde se explica lo medido. Sigue siendo la
              ÚNICA cifra prometida de la web y sigue pasando por la verja
              «prometido ≤ medido» (cifra-del-heroe.test.ts). */}
          <div className="hero-prueba medido-prueba rv">
            <span className="hero-prueba-t">{t("hero.proofTitle")}</span>
            <div className="hero-prueba-filas">
              {(t.raw("hero.proofs") as { marca: string; modelo: string; cifra: string; que: string }[]).map((p) => (
                <div className="hp" key={p.marca}>
                  <div className="hp-marca">
                    <LogoProveedor marca={p.marca} />
                    <b>{p.marca}</b>
                    <code>{p.modelo}</code>
                  </div>
                  <div className="hp-dato">
                    <span className="hp-n">{p.cifra}</span>
                    <span className="hp-q">{p.que}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="cascade-nota">{t("cascade.footnote")}</p>
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
                  piso: pctLocal1(ab.aggregate.savings.lower),
                  punto: pctLocal1(ab.aggregate.savings.point),
                })}
              </p>
              <p className="nota">{t("step2.plainNote")}</p>
            </div>
          </div>
          <div className="bench rv">
            <ReferenceModeBadge ab={ab} />
            <NetSavingsCIBand savings={ab.aggregate.savings} mode={ab.mode} />
            <div style={{ marginTop: "16px" }}>
              <ReferenceLedgerCards ab={ab} />
            </div>
          </div>
          {/* La tabla de escenarios, los chips y la nota de caché eran
              «demasiado concreto y científico» para la landing (dueño,
              04-09): viven en el panel. La cinta única tampoco se entendía
              (dueño, misma tarde), así que la idea va PARTIDA EN DOS
              animaciones de una sola caja — con paja se recorta mucho,
              magra pasa intacta — y UNA línea con el rango real de la
              tirada, con las cifras llegando del artefacto. */}
          <div className="trabajos">
            <div className="explica-grid">
              <div className="explica-card rv">
                <VideoExplicativo
                  src="/videos/trabajos-paja.mp4"
                  poster="/videos/trabajos-paja.jpg"
                  etiqueta={t("trabajos.pajaTitle")}
                />
                <div className="explica-texto">
                  <h4>{t("trabajos.pajaTitle")}</h4>
                  <p>{t("trabajos.pajaBody")}</p>
                </div>
              </div>
              <div className="explica-card rv">
                <VideoExplicativo
                  src="/videos/trabajos-magro.mp4"
                  poster="/videos/trabajos-magro.jpg"
                  etiqueta={t("trabajos.magroTitle")}
                />
                <div className="explica-texto">
                  <h4>{t("trabajos.magroTitle")}</h4>
                  <p>{t("trabajos.magroBody")}</p>
                </div>
              </div>
            </div>
            <p className="explica-nota">{t("trabajos.caption", { min: rangoMin, max: rangoMax })}</p>
          </div>
        </section>

        {/* LEDGERS — four separate ledgers, never summed */}
        <section>
          <div className="sec-head rv">
            <div className="prov">
              <span className="prov-marca">{t("ledgersHead.providerTag")}</span>
              <code className="prov-modelo">{t("ledgersHead.providerModel")}</code>
            </div>
            <span className="eyebrow">{t("ledgersHead.eyebrow")}</span>
            <h2>{t("ledgersHead.title")}</h2>
            <p>{t("ledgersHead.body")}</p>
            <p className="ledgers-modelo">{t("ledgersHead.providerNote")}</p>
          </div>
          <div className="ledgers">
            {ledgers
              .filter((l) => {
                // Una tarjeta sin cifra define una palanca y remata con un guion:
                // promete y no cumple, en la seccion cuya tesis es justamente que
                // aqui no se infla nada. Si esta tirada no midio ese libro, el
                // libro no sale. Que salgan tres tarjetas en vez de cuatro es la
                // verdad de esa tirada.
                const m = medidoPorLibro.get(CLAVE_DE_TARJETA[l.name] ?? "");
                return !!m && m.proven;
              })
              .map((l) => {
              const m = medidoPorLibro.get(CLAVE_DE_TARJETA[l.name] ?? "");
              // Se publica el LÍMITE INFERIOR del intervalo, nunca el punto: es
              // la regla del banco y no cambia por estar en una landing. Y un
              // libro que no despejó el cero NO se anuncia como ahorro.
              const cifra = `${(m!.savings.lower * 100).toFixed(1)}%`;
              const pie = t("ledgersHead.measuredFloor");
              return (
                <div className="ledger rv" key={l.idx}>
                  <div className="idx">{l.idx}</div>
                  <h4>{l.name}</h4>
                  <p>{l.desc}</p>
                  <div className="mval">{cifra}</div>
                  {/* El intervalo entero, dibujado: suelo→techo en menta y el
                      punto en tinta, sobre la misma escala en las cuatro. */}
                  <div className="ledger-ci" aria-hidden="true">
                    <i className="f" style={{ left: `${(m!.savings.lower / 0.75) * 100}%`, width: `${((m!.savings.upper - m!.savings.lower) / 0.75) * 100}%` }} />
                    <i className="p" style={{ left: `${(m!.savings.point / 0.75) * 100}%` }} />
                  </div>
                  <div className="munit">{pie}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* INTEGRATE — five lines to start */}
        <section>
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
          {/* Sistemas donde ya viven las automatizaciones del cliente: logos
              oficiales a color (decisión del dueño). El texto mantiene la
              afirmación honesta: se mide lo que llama a la API con su clave. */}
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

        {/* SKILL SAVINGS-MODE — el segmento SUSCRIPCIÓN (sin factura, con topes).
            Gratis a propósito: el embudo. Las tres cifras salen de
            lib/skill/anatomia (medidas, con verja) y el efecto del propio skill
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
                <div className="mval">{(ANATOMIA_MEDIDA[campo] * 100).toLocaleString(locale, { maximumFractionDigits: 1 })}%</div>
                <div className="munit">{t("skill.medidaPie")}</div>
              </div>
            ))}
          </div>
          <p className="ledgers-modelo">
            {t("skill.anatomiaNota", {
              peticiones: ANATOMIA_MEDIDA.peticiones.toLocaleString(locale),
              fecha: ANATOMIA_MEDIDA.fecha,
            })}
          </p>
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

        {/* PRICING */}
        <section id="pricing">
          <div className="sec-head rv">
            <span className="eyebrow">{t("pricing.eyebrow")}</span>
            <h2>{t("pricing.title")}</h2>
            <p>{t("pricing.body", { currency: moneda })}</p>
          </div>
          <div className="split">
            <div className="price-card rv">
              <div className="amt">
                {t("pricing.amount", { amount: precioMensual })}
                <small> {t("pricing.per")}</small>
              </div>
              <p style={{ margin: 0, opacity: 0.85 }}>
                {t.rich("pricing.proNote", { b: (c) => <b>{c}</b>, yearly: precioAnual })}
              </p>
              <p className="ck-note">
                {t("pricing.taxNote")}
              </p>
              <p style={{ margin: "6px 0 0", opacity: 0.65, fontSize: 13 }}>
                {t.rich("pricing.seatNote", { b: (c) => <b>{c}</b> })}
              </p>
              <ul>
                {features.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              <Link className="btn" href="/signup" style={{ alignSelf: "flex-start", marginTop: 6 }}>
                {t("pricing.cta")}
              </Link>
            </div>
            {/* La tarjeta estática de confianza dejó paso a la calculadora de
                comisión (2026-08-23): que el visitante JUEGUE y vea nuestro
                extra y su neto, con los precios del SDK y la tarifa real. */}
            <CalculadoraComision asiento={{ cents: precios.monthly.amount, currency: precios.monthly.currency }} />
          </div>

          {/* LA FÓRMULA, PÚBLICA — el borrador del plan maestro, publicado.
              Regla de anclaje llevada al límite: en los mensajes NO HAY NI UN
              DÍGITO (lo vigila tarifa-en-parametros.test.ts); cada número llega
              como parámetro desde lib/billing/tarifa y desde el Price de
              Stripe. Cambiar la tarifa real cambia esta sección sola. */}
          <div className="formula-publica rv">
            <h3>{t("formula.title")}</h3>
            <ul>
              <li>{t.rich("formula.mes1", { b: (c) => <b>{c}</b>, precioMes: precioMensual })}</li>
              <li>{t.rich("formula.medido", { b: (c) => <b>{c}</b> })}</li>
              <li>
                {/* Sin mínimo desde el 2026-09-01: la promesa pasa de «bajo el
                    umbral no cobramos» a «te quedas siempre con ≥{garantia} de
                    lo ahorrado» — derivada del tramo más caro, no escrita. */}
                {t.rich("formula.garantia", {
                  b: (c) => <b>{c}</b>,
                  garantia: pctLocal(GARANTIA_NETA_RATIO),
                })}
              </li>
              <li>{t.rich("formula.tramos", { b: (c) => <b>{c}</b>, tramos: tramosLocal })}</li>
              <li>{t.rich("formula.permanencia", { b: (c) => <b>{c}</b>, cero: moneyLocal(0) })}</li>
            </ul>
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

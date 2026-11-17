import type { Metadata } from "next";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { HeroeDeCampana } from "@/app/components/campana/HeroeDeCampana";
import { BotonImprimir } from "@/app/components/docs/BotonImprimir";
import { DocIndice } from "@/app/components/docs/DocIndice";
import { Migas } from "@/app/components/docs/Migas";
import Footer from "@/app/components/Footer";
import { Link } from "@/i18n/navigation";
import { absolute, tarjetaSocial } from "@/i18n/site";
import { EDICION_PAPER } from "@/lib/paper/edicion";
import { formulaHtml } from "@/lib/paper/formulas";
import { DataTable } from "@/vendor/affectui/data-table-clean";
import { GridBackground } from "@/vendor/affectui/grid-background";

import { BLOQUES, CABECERA, type Bloque } from "./contenido";

// El CSS de KaTeX SOLO en esta ruta (es la única con fórmulas). Sus fuentes las
// empaqueta Next en /_next/static/media: mismo origen, dentro de la CSP.
import "katex/dist/katex.min.css";

/**
 * /[locale]/paper — el preprint en la web, con plantilla de lectura académica.
 *
 * Cabecera (serie, título, subtítulo, autor, afiliación, fecha y versión),
 * abstract destacado, índice de secciones —fijo a la izquierda en escritorio,
 * plegado en móvil—, cuerpo a una medida cómoda (~68 caracteres), tablas tipo
 * booktabs y referencias con sangría francesa.
 *
 * El contenido se genera desde `docs/PAPER.md` (fuente única) con
 * `pnpm paper:contenido`: el markdown del repo y esta página no pueden
 * divergir. La página es estática (sin datos ni sesión).
 *
 * EL ARTÍCULO ESTÁ EN INGLÉS EN LOS DOCE IDIOMAS, y no se finge otra cosa: lo
 * que se traduce es la INTERFAZ de lectura (botones, «Resumen», «Contenido»,
 * nombres accesibles), por `docsPage.*`. El texto científico va marcado con
 * `lang="en"` y, fuera de /en, una línea lo dice.
 *
 * UNA SOLA EDICIÓN INDEXABLE. El sitemap lista únicamente `/en/paper`; las
 * otras once URL sirven el mismo artículo. Por eso el `canonical` de TODAS es
 * `/en/paper`, y el `hreflang` solo declara esa (en + x-default): anunciar
 * doce alternativas que a su vez apuntan a otra canónica sería contradecirse.
 */
const URL_MARKDOWN = "https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/PAPER.md";
const URL_LATEX = "https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/paper/main.tex";
/**
 * El PDF y el DOI son los de la MISMA edición que pinta esta página
 * (`lib/paper/edicion.ts`; su test exige que versión y DOI cuadren con
 * `contenido.ts`). El botón del PDF dice la versión.
 */
const E = EDICION_PAPER;

export async function generateMetadata(): Promise<Metadata> {
  const title = `${CABECERA.titulo} — ${CABECERA.subtitulo} · Preprint`;
  const description =
    "BV-SALA preprint: verifiable measurement of LLM cost savings. Paired live double-runs, percentile cluster bootstrap, four never-summed ledgers, measured/reference/estimated labels, and the open-core edition.";
  const url = absolute("/en/paper");
  const social = tarjetaSocial("en", CABECERA.titulo);
  return {
    title,
    description,
    alternates: { canonical: url, languages: { en: url, "x-default": url } },
    openGraph: { title, description, url, siteName: "BiVelio Savings Layer", type: "article", ...social.openGraph },
    twitter: { ...social.twitter, title, description },
  };
}

/**
 * Inline: $`fórmula`$, **bold**, `code`, [text](url) y *énfasis*. Nada más (el
 * markdown del paper es simple). La fórmula va PRIMERO: su LaTeX puede llevar
 * asteriscos (`B^{*}`) que no son énfasis. El énfasis exige letra pegada a cada
 * asterisco, para no confundirlo con un asterisco suelto de una nota. Un `\$`
 * es un dólar escapado (GitHub lo pide en las líneas con fórmulas).
 *
 * La puntuación PEGADA a una fórmula («($`-67.91\,\%`$)», «$`e`$,») viaja con
 * ella en un trozo que no se parte: si no, el «)» o la «,» caen solos a la
 * línea siguiente.
 */
function Inline({ texto }: { texto: string }) {
  const partes = texto.split(/(\$`[^`]+`\$|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^\s*](?:[^*]*[^\s*])?\*)/g);
  const esFormula = (p: string | undefined) => p !== undefined && p.length > 4 && p.startsWith("$`") && p.endsWith("`$");
  const ABRE = /[(\[«“"']+$/;
  const CIERRA = /^[)\],.;:!?»”"'%]+/;
  // Recorta la puntuación que toca cada fórmula de los trozos de texto vecinos.
  const antes: string[] = partes.map(() => "");
  const despues: string[] = partes.map(() => "");
  partes.forEach((p, i) => {
    if (!esFormula(p)) return;
    const previo = partes[i - 1];
    if (previo !== undefined) {
      const m = ABRE.exec(previo);
      if (m) {
        antes[i] = m[0];
        partes[i - 1] = previo.slice(0, -m[0].length);
      }
    }
    const siguiente = partes[i + 1];
    if (siguiente !== undefined) {
      const m = CIERRA.exec(siguiente);
      if (m) {
        despues[i] = m[0];
        partes[i + 1] = siguiente.slice(m[0].length);
      }
    }
  });
  return (
    <>
      {partes.map((p, i) => {
        if (esFormula(p)) {
          const html = { __html: formulaHtml(p.slice(2, -2)) };
          if (!antes[i] && !despues[i]) return <span key={i} dangerouslySetInnerHTML={html} />;
          return (
            <span key={i} className="paper-pegado">
              {antes[i]}
              <span dangerouslySetInnerHTML={html} />
              {despues[i]}
            </span>
          );
        }
        if (p === "") return null;
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        if (p.length > 2 && p.startsWith("*") && p.endsWith("*")) return <em key={i}>{p.slice(1, -1)}</em>;
        const enlace = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
        if (enlace) {
          const [, etiqueta, url] = enlace as unknown as [string, string, string];
          return /^https?:/.test(url) ? (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer">
              {etiqueta}
            </a>
          ) : (
            <Link key={i} href={url}>
              {etiqueta}
            </Link>
          );
        }
        return <span key={i}>{p.replaceAll("\\$", () => "$")}</span>;
      })}
    </>
  );
}

type Lista = { tipo: "lista"; ordenada: boolean; items: string[] };

/** Agrupa listas consecutivas del mismo tipo en un solo <ul>/<ol>. */
function cuerpo(bloques: Bloque[]): (Bloque | Lista)[] {
  const piezas: (Bloque | Lista)[] = [];
  let lista: { ordenada: boolean; items: string[] } | null = null;

  for (const b of bloques) {
    if (b.tipo === "li") {
      if (lista && lista.ordenada === b.ordenada) lista.items.push(b.texto);
      else {
        if (lista) piezas.push({ tipo: "lista", ...lista });
        lista = { ordenada: b.ordenada, items: [b.texto] };
      }
      continue;
    }
    if (lista) {
      piezas.push({ tipo: "lista", ...lista });
      lista = null;
    }
    piezas.push(b);
  }
  if (lista) piezas.push({ tipo: "lista", ...lista });
  return piezas;
}

const esReferencia = (b: Bloque) => b.tipo === "p" && /^\[\d+\]/.test(b.texto);

export default async function PaperPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("docsPage");
  const tn = await getTranslations("landing");

  const iAbstract = BLOQUES.findIndex((b) => b.tipo === "h2" && b.id === "abstract");
  const iFinAbstract = BLOQUES.findIndex((b, i) => i > iAbstract && b.tipo === "hr");
  const resumen = BLOQUES.slice(iAbstract + 1, iFinAbstract < 0 ? BLOQUES.length : iFinAbstract).filter(
    (b): b is Bloque & { texto: string } => "texto" in b,
  );
  const cuerpoBloques = BLOQUES.slice(iFinAbstract < 0 ? iAbstract + 1 : iFinAbstract + 1);
  const secciones = cuerpoBloques.filter((b): b is Bloque & { tipo: "h2"; id: string } => b.tipo === "h2" && Boolean(b.id));

  return (
    <div className="lp doc-page paper-page">
      <main className="wrap paper-shell">
        {/* FIRMA DE CAMPAÑA: solo el cielo y el mosaico. El título científico
            no lleva marcador ni cambia una letra. */}
        <HeroeDeCampana pagina="paper">
        <GridBackground className="doc-fondo">
        <header className="paper-cabecera" id="inicio">
          <Migas actual={tn("footer.paper")} />
          <p className="kicker paper-serie" lang="en">
            {CABECERA.coleccion}
          </p>
          <h1 className="editorial-title editorial-title--lg paper-titulo" lang="en">
            {CABECERA.titulo}
          </h1>
          <p className="paper-subtitulo" lang="en">
            {CABECERA.subtitulo}
          </p>
          <p className="paper-autor" lang="en">
            {CABECERA.autor} · {CABECERA.afiliacion} · <a href={`mailto:${CABECERA.email}`}>{CABECERA.email}</a>
          </p>
          <p className="paper-fecha" lang="en">
            {CABECERA.fecha} · {CABECERA.version}
          </p>
          <nav className="paper-acciones" aria-label={t("paper.linksAria")}>
            <BotonImprimir className="btn btn-primary">{t("paper.print")}</BotonImprimir>
            <a className="btn btn-ghost" href={E.pdf} target="_blank" rel="noopener">
              {t("paper.pdf", { version: E.version })}
            </a>
            <a className="btn btn-ghost" href={E.urlDoi} target="_blank" rel="noopener noreferrer">
              {t("paper.zenodo")}
            </a>
            <a className="btn btn-ghost" href={URL_MARKDOWN} target="_blank" rel="noopener noreferrer">
              {t("paper.markdown")}
            </a>
            <a className="btn btn-ghost" href={URL_LATEX} target="_blank" rel="noopener noreferrer">
              {t("paper.latex")}
            </a>
            <Link className="btn btn-ghost" href="/benchmarks">
              {t("paper.bench")}
            </Link>
          </nav>
          {locale === "en" ? null : <p className="doc-nota">{t("englishOnly")}</p>}
        </header>
        </GridBackground>
        </HeroeDeCampana>

        <div className="doc-grid">
          <DocIndice titulo={t("contents")} entradas={secciones.map((s) => ({ id: s.id, texto: s.texto }))} lang="en" />

          <div className="doc-body">
            <section className="paper-abstract" aria-labelledby="resumen">
              <h2 id="resumen" className="paper-abstract-t">
                {t("paper.abstract")}
              </h2>
              {resumen.map((b, i) => (
                <p key={i} lang="en" className={/^\*\*Keywords/.test(b.texto) ? "paper-palabras" : "paper-abstract-p"}>
                  <Inline texto={b.texto} />
                </p>
              ))}
            </section>

            <article className="paper-cuerpo" lang="en">
              {cuerpo(cuerpoBloques).map((b, i) => {
                if (b.tipo === "lista") {
                  const Elemento = b.ordenada ? "ol" : "ul";
                  return (
                    <Elemento key={i} className="paper-lista">
                      {b.items.map((it, j) => (
                        <li key={j}>
                          <Inline texto={it} />
                        </li>
                      ))}
                    </Elemento>
                  );
                }
                if (b.tipo === "h2")
                  return (
                    <h2 key={i} id={b.id} className="paper-h2">
                      {b.texto}
                    </h2>
                  );
                if (b.tipo === "h3")
                  return (
                    <h3 key={i} id={b.id} className="paper-h3">
                      {b.texto}
                    </h3>
                  );
                if (b.tipo === "hr") return <hr key={i} className="paper-regla" />;
                if (b.tipo === "ecuacion")
                  return (
                    // Ecuación en bloque, compuesta al construir. Centrada y con
                    // su número a la derecha, como en el PDF; si no cabe (móvil),
                    // se desplaza DENTRO de su caja, que es recorrible con el
                    // teclado: la página nunca.
                    <div key={i} className="paper-ecuacion" id={b.numero ? `ecuacion-${b.numero}` : undefined}>
                      <div
                        className="paper-ecuacion-formula"
                        role="group"
                        tabIndex={0}
                        aria-label={b.numero ? `Equation (${b.numero})` : "Equation"}
                        dangerouslySetInnerHTML={{ __html: formulaHtml(b.latex, true) }}
                      />
                      {b.numero ? (
                        <span className="paper-ecuacion-num" aria-hidden="true">
                          ({b.numero})
                        </span>
                      ) : null}
                    </div>
                  );
                if (b.tipo === "tabla")
                  return (
                    // La Data Table de affectUI, bifurcada a solo lectura. Cuando
                    // no cabe, se desplaza dentro de su Scroll Area, que es una
                    // región con nombre y recorrible con el teclado.
                    <DataTable
                      key={i}
                      className="paper-datos"
                      label={t("paper.tableScroll")}
                      minWidth={`${Math.max(b.filas[0]?.length ?? 0, 2) * 8.5}rem`}
                      dense
                      prose
                      columns={(b.filas[0] ?? []).map((celda, c) => ({ key: String(c), label: <span><Inline texto={celda} /></span> }))}
                      rows={b.filas.slice(1).map((fila, r) => ({
                        id: String(r),
                        cells: Object.fromEntries(fila.map((celda, c) => [String(c), <span key={c}><Inline texto={celda} /></span>])),
                      }))}
                    />
                  );
                return (
                  <p key={i} className={esReferencia(b) ? "paper-ref" : "paper-p"}>
                    <Inline texto={b.texto} />
                  </p>
                );
              })}
            </article>

            <p className="doc-arriba">
              <a href="#inicio">{t("backToTop")}</a>
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

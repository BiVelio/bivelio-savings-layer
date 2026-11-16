import type { ReactNode } from "react";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { DocIndice } from "@/app/components/docs/DocIndice";
import Footer from "@/app/components/Footer";
import { CodeFrame } from "@/app/components/ui";
import { absolute, tarjetaSocial } from "@/i18n/site";
import { cargarGuia } from "@/lib/guia-migracion/cargar";
import { textoPlano, type Bloque, type EnLinea } from "@/lib/guia-migracion/markdown";

/**
 * /migrate-to-0.5 — LA GUÍA DE MIGRACIÓN 0.4 → 0.5, publicada en la web
 * (docs/CAMINO-A-0.5.md, «Lo que falta», punto 6).
 *
 * El texto es `docs/MIGRAR-A-0.5.md` tal cual, leído al construir: la guía está
 * en inglés (es para el cliente que programa) y se sirve en inglés en los doce
 * idiomas, con `lang="en"` en el artículo y el `canonical` en /en, para que los
 * buscadores no vean doce copias. No hay traducciones que mantener ni ninguna
 * copia del texto que pueda desviarse de la que vigila el test del inventario.
 *
 * LA FORMA (rediseño 2026-11): plantilla de documentación. Índice de secciones
 * —fijo a la izquierda en escritorio, plegado en móvil—, y los ejemplos en el
 * marco de código de la fundación. Un bloque que trae sus dos mitades marcadas
 * con `// Before (…)` y `// After (…)` se parte en DOS marcos, uno por mitad,
 * con ese mismo comentario como rótulo: el texto no cambia, solo deja de haber
 * que buscar la frontera a ojo. Lo que se traduce es la interfaz (`docsPage.*`
 * y `ui.copy`); la guía sigue en inglés, y una línea avisa de que es la guía
 * hacia ESA versión, no el anuncio de la más reciente.
 */
export const dynamic = "force-static";
export const dynamicParams = false;

const TITULO = "Migrating from 0.4 to 0.5";
/** La versión a la que lleva esta guía. Histórica: no es «la última». */
const VERSION_DESTINO = "0.5";
const DESCRIPCION =
  "Every breaking change of @bivelio/savings-layer 0.5 in one place: renamed and removed exports, the closed finishReason set, and the CLI, each with a before and after.";

export function generateMetadata() {
  const url = absolute("/en/migrate-to-0.5");
  const social = tarjetaSocial("en", TITULO);
  return {
    title: `${TITULO} · BiVelio Savings Layer`,
    description: DESCRIPCION,
    alternates: { canonical: url },
    openGraph: { title: TITULO, description: DESCRIPCION, url, siteName: "BiVelio Savings Layer", type: "article", ...social.openGraph },
    twitter: { ...social.twitter, title: TITULO, description: DESCRIPCION },
  };
}

function EnLineaR({ c }: { c: readonly EnLinea[] }): ReactNode {
  return c.map((n, i) => {
    switch (n.t) {
      case "texto":
        return n.v;
      case "codigo":
        return <code key={i}>{n.v}</code>;
      case "negrita":
        return (
          <b key={i}>
            <EnLineaR c={n.c} />
          </b>
        );
      case "cursiva":
        return (
          <em key={i}>
            <EnLineaR c={n.c} />
          </em>
        );
      case "enlace": {
        // Anclas de la propia guía y enlaces absolutos; un enlace relativo a
        // otro fichero del repositorio no existe en la web y se pinta como texto.
        if (n.href.startsWith("#")) {
          return (
            <a key={i} href={n.href}>
              <EnLineaR c={n.c} />
            </a>
          );
        }
        if (/^https:\/\//.test(n.href)) {
          return (
            <a key={i} href={n.href} rel="noopener noreferrer">
              <EnLineaR c={n.c} />
            </a>
          );
        }
        return <EnLineaR key={i} c={n.c} />;
      }
    }
  });
}

type Copiar = { etiqueta: string; etiquetaCopiado: string };

/**
 * Las mitades de un ejemplo. Una línea que es SOLO el comentario
 * `// Before (0.4)` / `# After (0.5)` abre una mitad y pasa a ser su rótulo;
 * un bloque sin esas marcas es una sola pieza sin rótulo.
 */
function mitades(v: string): { rotulo: string | null; lado: "antes" | "despues" | null; codigo: string }[] {
  const piezas: { rotulo: string | null; lado: "antes" | "despues" | null; lineas: string[] }[] = [
    { rotulo: null, lado: null, lineas: [] },
  ];
  for (const linea of v.split("\n")) {
    const marca = /^(?:\/\/|#)\s*((Before|After)\b.*)$/.exec(linea);
    if (marca) piezas.push({ rotulo: marca[1]!, lado: marca[2] === "Before" ? "antes" : "despues", lineas: [] });
    else piezas[piezas.length - 1]!.lineas.push(linea);
  }
  return piezas
    .map((p) => ({ rotulo: p.rotulo, lado: p.lado, codigo: p.lineas.join("\n").replace(/^\n+|\s+$/g, "") }))
    .filter((p) => p.codigo !== "");
}

function Codigo({ v, lenguaje, copiar }: { v: string; lenguaje: string; copiar: Copiar }) {
  const piezas = mitades(v);
  const marcos = piezas.map((p, i) => (
    <CodeFrame
      key={i}
      className={p.lado === "antes" ? "guia-cf guia-cf--antes" : p.lado === "despues" ? "guia-cf guia-cf--despues" : "guia-cf"}
      etiqueta={p.rotulo ?? (lenguaje || undefined)}
      ariaLabel={p.rotulo ?? (lenguaje || "code")}
      copiar={{ texto: p.codigo, ...copiar }}
    >
      <pre data-lenguaje={lenguaje || undefined}>
        <code>{p.codigo}</code>
      </pre>
    </CodeFrame>
  ));
  return piezas.some((p) => p.lado) ? <div className="guia-pareja">{marcos}</div> : marcos;
}

function Bloques({ bloques, copiar }: { bloques: readonly Bloque[]; copiar: Copiar }): ReactNode {
  return bloques.map((b, i) => {
    switch (b.t) {
      case "titulo": {
        const H = (b.nivel <= 2 ? "h2" : b.nivel === 3 ? "h3" : "h4") as "h2" | "h3" | "h4";
        return (
          <H key={i} id={b.id}>
            <EnLineaR c={b.c} />
          </H>
        );
      }
      case "parrafo":
        return (
          <p key={i}>
            <EnLineaR c={b.c} />
          </p>
        );
      case "codigo":
        return <Codigo key={i} v={b.v} lenguaje={b.lenguaje} copiar={copiar} />;
      case "cita":
        return (
          <blockquote key={i} className="terms-governs guia-cita">
            <Bloques bloques={b.c} copiar={copiar} />
          </blockquote>
        );
      case "lista": {
        const items = b.items.map((it, j) => (
          <li key={j}>
            {it.length === 1 && it[0]!.t === "parrafo" ? <EnLineaR c={it[0]!.c} /> : <Bloques bloques={it} copiar={copiar} />}
          </li>
        ));
        return b.ordenada ? (
          <ol key={i} className="terms-list" start={b.inicio}>
            {items}
          </ol>
        ) : (
          <ul key={i} className="terms-list">
            {items}
          </ul>
        );
      }
      case "tabla":
        return (
          <div key={i} className="guia-tabla" tabIndex={0} role="region" aria-label="Table">
            <table className="tbl tbl--static">
              <thead>
                <tr>
                  {b.cabecera.map((c, j) => (
                    <th key={j} scope="col">
                      <EnLineaR c={c} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.filas.map((f, j) => (
                  <tr key={j}>
                    {f.map((c, k) => (
                      <td key={k}>
                        <EnLineaR c={c} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "separador":
        return null;
    }
  });
}

/** Parte la guía en la cabecera (el `#` y lo que va antes del primer `##`) y una sección por `##`. */
function secciones(bloques: readonly Bloque[]): { cabecera: Bloque[]; secciones: Bloque[][] } {
  const cabecera: Bloque[] = [];
  const out: Bloque[][] = [];
  for (const b of bloques) {
    if (b.t === "titulo" && b.nivel === 2) out.push([b]);
    else if (out.length) out[out.length - 1]!.push(b);
    else cabecera.push(b);
  }
  return { cabecera, secciones: out };
}

export default async function MigrateTo05Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("docsPage");
  const tu = await getTranslations("ui");
  const copiar: Copiar = { etiqueta: tu("copy"), etiquetaCopiado: tu("copied") };

  const { cabecera, secciones: partes } = secciones(cargarGuia());
  const h1 = cabecera.find((b) => b.t === "titulo" && b.nivel === 1);
  const resto = cabecera.filter((b) => b !== h1);
  const indice = partes.flatMap((p) => {
    const titulo = p[0]!;
    return titulo.t === "titulo" ? [{ id: titulo.id, texto: textoPlano(titulo.c) }] : [];
  });

  return (
    <div className="lp terms-page doc-page">
      <main className="wrap guia-page" lang="en">
        <section className="terms-hero guia-hero" id="inicio">
          <span className="eyebrow">@bivelio/savings-layer · {VERSION_DESTINO}</span>
          <h1>{h1 && h1.t === "titulo" ? textoPlano(h1.c) : TITULO}</h1>
          {/* Interfaz, no artículo: va en el idioma de quien lee. */}
          <p className="doc-nota" lang={locale}>
            {t("migrate.versionNote", { version: VERSION_DESTINO })}
            {locale === "en" ? null : <> {t("englishOnly")}</>}
          </p>
          <Bloques bloques={resto} copiar={copiar} />
        </section>
        <div className="doc-grid">
          <DocIndice titulo={t("contents")} entradas={indice} lang="en" />
          <div className="doc-body">
            {partes.map((p, i) => (
              <section key={i} className="terms-sec" aria-labelledby={p[0]!.t === "titulo" ? p[0]!.id : undefined}>
                <Bloques bloques={p} copiar={copiar} />
              </section>
            ))}
            <p className="doc-arriba" lang={locale}>
              <a href="#inicio">{t("backToTop")}</a>
            </p>
          </div>
        </div>
      </main>
      <Footer sinGitHub />
    </div>
  );
}

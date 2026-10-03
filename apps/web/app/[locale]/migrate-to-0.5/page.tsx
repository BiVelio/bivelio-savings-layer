import type { ReactNode } from "react";

import { setRequestLocale } from "next-intl/server";

import Footer from "@/app/components/Footer";
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
 */
export const dynamic = "force-static";
export const dynamicParams = false;

const TITULO = "Migrating from 0.4 to 0.5";
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

function Bloques({ bloques }: { bloques: readonly Bloque[] }): ReactNode {
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
        return (
          <pre key={i} className="guia-codigo" data-lenguaje={b.lenguaje || undefined}>
            <code>{b.v}</code>
          </pre>
        );
      case "cita":
        return (
          <blockquote key={i} className="terms-governs">
            <Bloques bloques={b.c} />
          </blockquote>
        );
      case "lista": {
        const items = b.items.map((it, j) => (
          <li key={j}>
            {it.length === 1 && it[0]!.t === "parrafo" ? <EnLineaR c={it[0]!.c} /> : <Bloques bloques={it} />}
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
          <div key={i} className="guia-tabla">
            <table className="tbl">
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
  const { cabecera, secciones: partes } = secciones(cargarGuia());
  const h1 = cabecera.find((b) => b.t === "titulo" && b.nivel === 1);
  const resto = cabecera.filter((b) => b !== h1);

  return (
    <div className="lp terms-page">
      <main className="wrap guia-page" lang="en">
        <section className="terms-hero">
          <span className="eyebrow">@bivelio/savings-layer · 0.5</span>
          <h1>{h1 && h1.t === "titulo" ? textoPlano(h1.c) : TITULO}</h1>
          <Bloques bloques={resto} />
        </section>
        {partes.map((p, i) => (
          <section key={i} className="terms-sec" aria-labelledby={p[0]!.t === "titulo" ? p[0]!.id : undefined}>
            <Bloques bloques={p} />
          </section>
        ))}
      </main>
      <Footer sinGitHub />
    </div>
  );
}

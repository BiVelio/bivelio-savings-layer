import type { Metadata } from "next";

import { Link } from "@/i18n/navigation";

import { BLOQUES, CABECERA, type Bloque } from "./contenido";

/**
 * /[locale]/paper — el preprint en la web, con formato de publicación.
 *
 * Cabecera académica (serie, título, subtítulo, autor, afiliación, fecha),
 * abstract destacado, índice de secciones con anclas, cuerpo en serif
 * justificado, tablas tipo booktabs y referencias con sangría francesa.
 *
 * El contenido se genera desde `docs/PAPER.md` (fuente única) con
 * `pnpm paper:contenido`: el markdown del repo y esta página no pueden
 * divergir. La página es estática (sin datos ni sesión) y entra en el sitemap.
 */

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `${CABECERA.titulo} — ${CABECERA.subtitulo} · Preprint`,
    description:
      "BV-SALA preprint: verifiable measurement of LLM cost savings. Paired live double-runs, percentile cluster bootstrap, four never-summed ledgers, measured/reference/estimated labels, and the open-core edition.",
  };
}

/** Inline: **bold**, `code`, [text](url). Nada más (el markdown del paper es simple). */
function Inline({ texto }: { texto: string }) {
  const partes = texto.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {partes.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
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
        return <span key={i}>{p}</span>;
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

export default function PaperPage() {
  const iAbstract = BLOQUES.findIndex((b) => b.tipo === "h2" && b.id === "abstract");
  const iFinAbstract = BLOQUES.findIndex((b, i) => i > iAbstract && b.tipo === "hr");
  const resumen = BLOQUES.slice(iAbstract + 1, iFinAbstract < 0 ? BLOQUES.length : iFinAbstract);
  const cuerpoBloques = BLOQUES.slice(iFinAbstract < 0 ? iAbstract + 1 : iFinAbstract + 1);
  const secciones = cuerpoBloques.filter((b): b is Bloque & { tipo: "h2" } => b.tipo === "h2");

  return (
    <main className="paper-shell">
      <header className="paper-cabecera">
        <p className="paper-serie">{CABECERA.coleccion}</p>
        <h1 className="paper-titulo">{CABECERA.titulo}</h1>
        <p className="paper-subtitulo">{CABECERA.subtitulo}</p>
        <p className="paper-autor">
          {CABECERA.autor} · {CABECERA.afiliacion} ·{" "}
          <a href={`mailto:${CABECERA.email}`}>{CABECERA.email}</a>
        </p>
        <p className="paper-fecha">
          {CABECERA.fecha} · {CABECERA.version}
        </p>
        <nav className="paper-acciones" aria-label="Enlaces del paper">
          <a
            className="btn btn-ghost"
            href="https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/PAPER.md"
            target="_blank"
            rel="noopener noreferrer"
          >
            Markdown en GitHub
          </a>
          <a
            className="btn btn-ghost"
            href="https://github.com/BiVelio/bivelio-savings-layer/blob/main/docs/paper/main.tex"
            target="_blank"
            rel="noopener noreferrer"
          >
            LaTeX para arXiv
          </a>
          <Link className="btn btn-ghost" href="/benchmarks">
            El banco público
          </Link>
        </nav>
      </header>

      <section className="paper-abstract" aria-labelledby="resumen">
        <h2 id="resumen" className="paper-abstract-t">
          Abstract
        </h2>
        {resumen.map((b, i) => (
          <p key={i} className={/^\*\*Keywords/.test(b.texto) ? "paper-palabras" : "paper-abstract-p"}>
            <Inline texto={b.texto} />
          </p>
        ))}
      </section>

      <nav className="paper-indice" aria-label="Contents">
        <p className="paper-indice-t">Contents</p>
        <ol>
          {secciones.map((s) => (
            <li key={s.id}>
              <a href={`#${s.id}`}>{s.texto}</a>
            </li>
          ))}
        </ol>
      </nav>

      <article className="paper-cuerpo">
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
          if (b.tipo === "tabla")
            return (
              <div key={i} className="paper-tabla-wrap">
                <table className="paper-tabla">
                  <tbody>
                    {b.filas.map((fila, r) => (
                      <tr key={r}>
                        {fila.map((celda, c) =>
                          r === 0 ? (
                            <th key={c}>
                              <Inline texto={celda} />
                            </th>
                          ) : (
                            <td key={c}>
                              <Inline texto={celda} />
                            </td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          return (
            <p key={i} className={esReferencia(b) ? "paper-ref" : "paper-p"}>
              <Inline texto={b.texto} />
            </p>
          );
        })}
      </article>
    </main>
  );
}

import type { Metadata } from "next";

import { Link } from "@/i18n/navigation";

import { BLOQUES, type Bloque } from "./contenido";

/**
 * /[locale]/paper — el paper técnico de BV-SALA, en la web y indexable.
 *
 * El contenido se genera desde `docs/PAPER.md` (fuente única) con
 * `_research/paper-to-ts.ts`: el markdown del repo y esta página no pueden
 * divergir. La página es estática (sin datos ni sesión), así que entra en el
 * sitemap y se sirve desde el borde como el resto de páginas públicas.
 *
 * El documento es en inglés (con apéndice en español), como todo paper
 * académico: no se traduce a los 12 idiomas del sitio, y se dice.
 */

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Paper: verifiable measurement of LLM savings · BV-SALA",
    description:
      "The technical paper behind BV-SALA: live double-runs with a percentile cluster bootstrap, four separate savings ledgers, measured / reference / estimated labels, and the open-core edition (community mode, three provider protocols, Chinese-provider price gradients).",
  };
}

const VERSION = "Preprint v2.1 · November 2026 · open-core release 1.0.0";

/** Inline: **bold**, `code`, [text](url). Nada más (el markdown del paper es simple). */
function Inline({ texto }: { texto: string }) {
  const partes = texto.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return (
    <>
      {partes.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <b key={i}>{p.slice(2, -2)}</b>;
        if (p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        const enlace = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
        if (enlace) {
          const [, etiqueta, url] = enlace as unknown as [string, string, string];
          const externo = /^https?:/.test(url);
          return externo ? (
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

function BloqueRender({ b }: { b: Bloque }) {
  if (b.tipo === "h1") return <h1 className="paper-h1">{b.texto}</h1>;
  if (b.tipo === "h2") return <h2 className="paper-h2">{b.texto}</h2>;
  if (b.tipo === "h3") return <h3 className="paper-h3">{b.texto}</h3>;
  if (b.tipo === "li")
    return (
      <p className="paper-li">
        <Inline texto={b.texto} />
      </p>
    );
  if (b.tipo === "cita")
    return (
      <blockquote className="paper-cita">
        <Inline texto={b.texto} />
      </blockquote>
    );
  if (b.tipo === "tabla")
    return (
      <div className="paper-tabla-wrap">
        <table className="paper-tabla">
          <tbody>
            {b.filas.map((fila, i) => (
              <tr key={i}>
                {fila.map((celda, j) =>
                  i === 0 ? (
                    <th key={j}>
                      <Inline texto={celda} />
                    </th>
                  ) : (
                    <td key={j}>
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
    <p className="paper-p">
      <Inline texto={b.texto} />
    </p>
  );
}

export default function PaperPage() {
  return (
    <main className="wrap paper">
      <header className="paper-cabecera">
        <p className="paper-eyebrow">Paper técnico · BiVelio</p>
        <h1 className="paper-titulo">Verifiable Measurement of Cost Savings in LLM Applications</h1>
        <p className="paper-meta">
          Joan-Marc Fisa · Founder @ BiVelio · <strong>{VERSION}</strong>
        </p>
        <p className="paper-aviso">
          El documento está en inglés (con apéndice en español), como todo paper académico. Esta
          página se genera desde <code>docs/PAPER.md</code> del repositorio: la fuente y la web no
          pueden divergir.
        </p>
        <nav className="paper-enlaces">
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
            Los datos del banco público
          </Link>
          <a
            className="btn btn-ghost"
            href="https://www.npmjs.com/package/@bivelio/savings-layer"
            target="_blank"
            rel="noopener noreferrer"
          >
            El paquete en npm
          </a>
        </nav>
      </header>

      <article className="paper-cuerpo">
        {BLOQUES.map((b, i) => (
          <BloqueRender key={i} b={b} />
        ))}
      </article>
    </main>
  );
}

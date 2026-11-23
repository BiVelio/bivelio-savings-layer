import type { ReactNode } from "react";

import { CodeFrame } from "@/app/components/ui";
import type { Bloque, EnLinea } from "@/lib/guia-migracion/markdown";
import { CodeLines } from "@/vendor/affectui/code-block-clean";
import { DataTable } from "@/vendor/affectui/data-table-clean";

/**
 * Pinta el árbol de una guía (lib/guia-migracion/markdown.ts) con las mismas
 * piezas que la guía de migración: el marco de código de la fundación con el
 * coloreador de affectUI, las listas y citas de las páginas de lectura y la
 * tabla de datos. Nunca HTML en crudo.
 *
 * Diferencia con la guía de migración: aquí los enlaces a otras páginas del
 * sitio (`/en/benchmarks`, `/en/guides/…`) son enlaces de verdad, porque las
 * guías se enlazan entre sí y con el banco.
 */

export type Copiar = { etiqueta: string; etiquetaCopiado: string };

export function EnLineaR({ c }: { c: readonly EnLinea[] }): ReactNode {
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
        if (n.href.startsWith("#") || n.href.startsWith("/")) {
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

function Codigo({ v, lenguaje, copiar }: { v: string; lenguaje: string; copiar: Copiar }) {
  const codigo = v.replace(/^\n+|\s+$/g, "");
  return (
    <CodeFrame className="guia-cf" etiqueta={lenguaje || undefined} ariaLabel={lenguaje || "code"} copiar={{ texto: codigo, ...copiar }}>
      <pre data-lenguaje={lenguaje || undefined}>
        <CodeLines code={codigo} language={lenguaje} />
      </pre>
    </CodeFrame>
  );
}

export function Bloques({ bloques, copiar }: { bloques: readonly Bloque[]; copiar: Copiar }): ReactNode {
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
          <DataTable
            key={i}
            className="guia-datos"
            label="Table"
            minWidth={`${Math.max(b.cabecera.length, 2) * 9}rem`}
            prose
            columns={b.cabecera.map((c, k) => ({ key: String(k), label: <EnLineaR c={c} /> }))}
            rows={b.filas.map((f, j) => ({ id: String(j), cells: Object.fromEntries(f.map((c, k) => [String(k), <EnLineaR key={k} c={c} />])) }))}
          />
        );
      case "separador":
        return null;
    }
  });
}

/** Parte el texto en la entradilla (lo que va antes del primer `##`) y una sección por `##`. */
export function secciones(bloques: readonly Bloque[]): { entradilla: Bloque[]; secciones: Bloque[][] } {
  const entradilla: Bloque[] = [];
  const out: Bloque[][] = [];
  for (const b of bloques) {
    if (b.t === "titulo" && b.nivel <= 2) out.push([b]);
    else if (out.length) out[out.length - 1]!.push(b);
    else entradilla.push(b);
  }
  return { entradilla, secciones: out };
}

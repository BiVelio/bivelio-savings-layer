"use client";

import { useEffect, useState } from "react";

export type EntradaDeIndice = { id: string; texto: string };

/**
 * EL ÍNDICE LATERAL QUE SABE DÓNDE ESTÁS. Los enlaces son anclas normales (el
 * HTML del servidor ya funciona sin JavaScript); lo único que añade el
 * navegador es marcar con `aria-current="location"` la sección que se está
 * leyendo, que es el último título que ha pasado por debajo de la cabecera.
 *
 * Nada se mueve ni se anima: es una marca de posición, no un efecto.
 */
export function IndiceActivo({ entradas, lang }: { entradas: readonly EntradaDeIndice[]; lang?: string }) {
  const [activo, setActivo] = useState<string | null>(null);
  const clave = entradas.map((e) => e.id).join("|");

  useEffect(() => {
    const titulos = clave
      .split("|")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (titulos.length === 0) return;

    let pendiente = 0;
    const medir = () => {
      // La línea de lectura: un poco por debajo de la cabecera fija.
      const linea = 132;
      let actual: string | null = null;
      for (const el of titulos) {
        if (el.getBoundingClientRect().top <= linea) actual = el.id;
        else break;
      }
      setActivo(actual);
    };
    const alMover = () => {
      cancelAnimationFrame(pendiente);
      pendiente = requestAnimationFrame(medir);
    };
    medir();
    window.addEventListener("scroll", alMover, { passive: true });
    window.addEventListener("resize", alMover);
    return () => {
      cancelAnimationFrame(pendiente);
      window.removeEventListener("scroll", alMover);
      window.removeEventListener("resize", alMover);
    };
  }, [clave]);

  return (
    <ol className="doc-toc-lista" lang={lang}>
      {entradas.map((e) => (
        <li key={e.id}>
          <a href={`#${e.id}`} aria-current={activo === e.id ? "location" : undefined}>
            {e.texto}
          </a>
        </li>
      ))}
    </ol>
  );
}

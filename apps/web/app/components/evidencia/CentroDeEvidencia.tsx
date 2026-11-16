"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useTranslations } from "next-intl";

import { EvidenceBadge } from "@/app/components/ui";

/**
 * EL ÍNDICE Y LOS FILTROS DE LECTURA DEL CENTRO DE EVIDENCIA (/benchmarks).
 *
 * Se pinta desde `benchmarks/page.tsx` y entra en `BancoPublico` por su hueco
 * `indice`: el componente del banco no lleva ni un enlace propio que no sea a
 * un informe servido, al artículo o al correo (su test lo exige), así que los
 * `href="#…"` viven aquí.
 *
 * Dos hermanos, a propósito:
 *  - `nav.evc-index` — el índice. En escritorio es el carril fijo de la
 *    izquierda; en móvil, una tira de pastillas pegada bajo la cabecera.
 *  - `div.evc-read` — «cómo leer esta página»: las dos clases de evidencia
 *    dichas con todas sus letras, el filtro de lectura y las descargas.
 *
 * EL FILTRO NO BORRA NADA. Solo pliega secciones: por defecto se ve todo
 * (incluidos los resultados sin ahorro y los fallos), el estado se dice con
 * texto («Mostrando n de m secciones») y un enlace con ancla a una sección
 * plegada —la tarjeta del gateway de la portada apunta a #gateway-ttl— vuelve a
 * «Todo» antes de saltar. El plegado es un atributo `data-lectura` en el
 * `<main>` y unas reglas CSS por id: el marcado del banco no cambia.
 */

export type SeccionDelIndice = { id: string; etiqueta: string };

export type Lectura = "todo" | "ab" | "replay" | "negativos" | "reproducir";

/** Qué secciones enseña cada lectura. `null` = todas. Debe cuadrar con las reglas `[data-lectura]` del CSS. */
export const SECCIONES_POR_LECTURA: Record<Lectura, readonly string[] | null> = {
  todo: null,
  ab: ["method", "explained", "weekly", "savings", "guarantees", "no-savings", "status", "compat", "bugs"],
  replay: ["gateway-ttl"],
  negativos: ["no-savings", "status", "bugs"],
  reproducir: ["method", "reproduce", "invite"],
};

const ORDEN: readonly Lectura[] = ["todo", "ab", "replay", "negativos", "reproducir"];

export function CentroDeEvidencia({
  secciones,
  enlaces,
}: {
  /** Las secciones que la página pinta de verdad (#weekly, #gateway-ttl y #bugs son condicionales). */
  secciones: readonly SeccionDelIndice[];
  /** Descargas y enlaces de apoyo, ya montados por la página. */
  enlaces?: ReactNode;
}) {
  const t = useTranslations("benchmarksPage");
  const tUi = useTranslations("ui");
  const [lectura, setLectura] = useState<Lectura>("todo");
  const [activa, setActiva] = useState<string | null>(null);
  const raiz = useRef<HTMLElement>(null);
  const tira = useRef<HTMLOListElement>(null);

  const ids = useMemo(() => secciones.map((s) => s.id), [secciones]);
  const visibles = useMemo(() => {
    const permitidas = SECCIONES_POR_LECTURA[lectura];
    return secciones.filter((s) => !permitidas || permitidas.includes(s.id));
  }, [lectura, secciones]);

  // Solo se ofrecen las lecturas que enseñan algo en ESTA página.
  const lecturas = useMemo(
    () => ORDEN.filter((l) => l === "todo" || SECCIONES_POR_LECTURA[l]!.some((id) => ids.includes(id))),
    [ids],
  );
  const etiqueta: Record<Lectura, string> = {
    todo: t("filter.all"),
    ab: tUi("evidence.abSdk"),
    replay: tUi("evidence.replayGateway"),
    negativos: t("filter.negative"),
    reproducir: t("filter.reproduce"),
  };

  // El plegado: un atributo en el <main> del banco, que es quien contiene las secciones.
  useEffect(() => {
    const main = raiz.current?.closest("main");
    if (!main) return;
    if (lectura === "todo") main.removeAttribute("data-lectura");
    else main.setAttribute("data-lectura", lectura);
    return () => main.removeAttribute("data-lectura");
  }, [lectura]);

  // Un ancla a una sección plegada vuelve a «Todo» y salta cuando ya se ve.
  useEffect(() => {
    const alAncla = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id || !ids.includes(id)) return;
      setLectura((actual) => {
        const permitidas = SECCIONES_POR_LECTURA[actual];
        if (!permitidas || permitidas.includes(id)) return actual;
        requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
        return "todo";
      });
    };
    alAncla();
    window.addEventListener("hashchange", alAncla);
    return () => window.removeEventListener("hashchange", alAncla);
  }, [ids]);

  // Qué sección se está leyendo: la última cuyo borde superior ya pasó la cabecera.
  useEffect(() => {
    const nodos = visibles.map((s) => document.getElementById(s.id)).filter((n): n is HTMLElement => n !== null);
    if (!nodos.length || typeof IntersectionObserver === "undefined") return;
    const dentro = new Set<string>();
    const observador = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) {
          if (e.isIntersecting) dentro.add(e.target.id);
          else dentro.delete(e.target.id);
        }
        const primera = nodos.find((n) => dentro.has(n.id));
        setActiva(primera ? primera.id : null);
      },
      { rootMargin: "-18% 0px -72% 0px" },
    );
    for (const n of nodos) observador.observe(n);
    return () => observador.disconnect();
  }, [visibles]);

  // En la tira del móvil, la pastilla activa se mantiene a la vista (sin mover la página).
  useEffect(() => {
    const lista = tira.current;
    if (!lista || !activa || lista.scrollWidth <= lista.clientWidth) return;
    const el = lista.querySelector<HTMLElement>(`[data-seccion="${activa}"]`);
    if (!el) return;
    const destino = el.offsetLeft - (lista.clientWidth - el.offsetWidth) / 2;
    const quieto = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    lista.scrollTo({ left: Math.max(0, destino), behavior: quieto ? "auto" : "smooth" });
  }, [activa]);

  return (
    <>
      <nav className="evc-index" aria-label={t("centre.indexAria")} ref={raiz}>
        <p className="evc-index-title">{t("centre.indexTitle")}</p>
        <ol className="evc-index-list" ref={tira}>
          {visibles.map((s) => (
            <li key={s.id} data-seccion={s.id}>
              <a href={`#${s.id}`} aria-current={activa === s.id ? "location" : undefined}>
                {s.etiqueta}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="evc-read">
        <h2 className="evc-read-title">{t("centre.readTitle")}</h2>
        <dl className="evc-classes">
          <div>
            <dt>
              <EvidenceBadge tipo="ab-sdk" label={tUi("evidence.abSdk")} />
            </dt>
            <dd>{t("centre.classAb")}</dd>
          </div>
          {ids.includes("gateway-ttl") && (
            <div>
              <dt>
                <EvidenceBadge tipo="replay-gateway" label={tUi("evidence.replayGateway")} />
              </dt>
              <dd>{t("centre.classReplay")}</dd>
            </div>
          )}
        </dl>
        <p className="evc-compatible">{t("centre.compatible")}</p>

        <div className="evc-filter">
          <p className="evc-filter-label" id="evc-filter-label">
            {t("filter.label")}
          </p>
          <div className="evc-filter-options" role="group" aria-labelledby="evc-filter-label">
            {lecturas.map((l) => (
              <button key={l} type="button" className="evc-chip" aria-pressed={lectura === l} onClick={() => setLectura(l)}>
                {etiqueta[l]}
              </button>
            ))}
          </div>
          <p className="evc-filter-status" role="status">
            {t("filter.showing", { n: visibles.length, total: secciones.length })}{" "}
            {lectura !== "todo" && (
              <button type="button" className="evc-reset" onClick={() => setLectura("todo")}>
                {t("filter.reset")}
              </button>
            )}
          </p>
        </div>

        {enlaces ? <div className="evc-links">{enlaces}</div> : null}
      </div>
    </>
  );
}

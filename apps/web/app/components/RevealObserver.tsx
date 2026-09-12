"use client";

import { useEffect } from "react";

/**
 * Revelado al hacer scroll para todo elemento con la clase `rv` — el
 * `whileInView` de motion/react de bivelio.com, aquí con un solo
 * IntersectionObserver para la página entera y sin dependencias.
 *
 * VISIBLE POR DEFECTO. El servidor pinta todo a la vista; solo cuando este
 * componente arranca (JavaScript vivo e hidratado) marca `rv-on` en `.lp`, y
 * a partir de ahí la hoja oculta lo que aún no tiene `in`. Lo que ya está en
 * pantalla al arrancar recibe `in` en el mismo tick, así que no parpadea. Si
 * el script no llega a ejecutarse —CSP, error de hidratación, JS apagado— la
 * página se ve entera igual: el efecto es un extra, nunca una condición.
 * Bajo prefers-reduced-motion no se activa nada.
 */
export function RevealObserver() {
  useEffect(() => {
    const raiz = document.querySelector<HTMLElement>(".lp");
    const todos = Array.from(document.querySelectorAll<HTMLElement>(".lp .rv"));
    if (!raiz || !todos.length) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;

    const mostrar = (el: Element) => el.classList.add("in");
    const alto = window.innerHeight;
    const pendientes: HTMLElement[] = [];
    for (const el of todos) {
      if (el.getBoundingClientRect().top < alto * 0.92) mostrar(el);
      else pendientes.push(el);
    }
    raiz.classList.add("rv-on");
    if (!pendientes.length) return;

    const io = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) {
          if (e.isIntersecting) {
            mostrar(e.target);
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -4% 0px" },
    );
    pendientes.forEach((el) => io.observe(el));
    // Red: nada se queda oculto más de dos segundos y medio pase lo que pase.
    const red = window.setTimeout(() => pendientes.forEach(mostrar), 5000);
    return () => {
      io.disconnect();
      window.clearTimeout(red);
      raiz.classList.remove("rv-on");
    };
  }, []);

  return null;
}

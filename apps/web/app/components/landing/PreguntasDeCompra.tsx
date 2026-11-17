/**
 * PREGUNTAS DE COMPRA (guía §6, bloque 9): qué se paga, qué es un asiento,
 * Measure frente a Community, suscripciones cerradas, proveedor propio, datos
 * recibidos y ausencia de ahorro garantizado.
 *
 * <details> nativo: se abre con teclado y con lector de pantalla sin una línea
 * de script, se encuentra con la búsqueda del navegador y funciona con zoom.
 * La primera llega abierta para que se vea qué hay dentro.
 */
export function PreguntasDeCompra({ preguntas }: { preguntas: { q: string; a: string }[] }) {
  return (
    <div className="faq">
      {preguntas.map((p, i) => (
        <details className="faq-item" key={p.q} open={i === 0}>
          <summary>
            <span>{p.q}</span>
            <svg className="faq-mas" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden focusable="false">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </summary>
          <p>{p.a}</p>
        </details>
      ))}
    </div>
  );
}

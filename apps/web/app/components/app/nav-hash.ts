/**
 * EL ANCLA DE LA URL, COMPARTIDA POR TODAS LAS ENTRADAS DEL MENÚ — para que
 * cuando dos entradas apuntan a la misma página (Resumen `/dashboard` y
 * Máquinas `/dashboard#maquinas`) se ilumine la que toca.
 *
 * Puerto literal del `nav-hash.ts` de privacy (bivelio-privacy-gateway), con
 * el mismo diagnóstico detrás: el App Router cambia la URL con
 * `history.pushState`, que por especificación NO dispara `hashchange`, y como
 * el layout del panel persiste entre páginas, un `NavLink` que lea
 * `window.location.hash` al montar se queda con el ancla del primer load
 * completo para el resto de la sesión.
 *
 * Un almacén de módulo leído con `useSyncExternalStore`, con tres fuentes de
 * verdad, cada una para una forma de navegar:
 *
 *   · `announceHash` — cada `NavLink` lo llama en su `onClick` con SU ancla (o
 *     "" si no lleva), ANTES de que el router haga el pushState. Es el clic.
 *   · `readDocumentHash` — `NavLink` lo llama en un efecto dependiente de
 *     `usePathname()`: cuando cambia la ruta, el router ya escribió la URL y
 *     se lee lo que hay. Cubre el primer montaje y los enlaces desde otra
 *     página.
 *   · `hashchange` y `popstate` — atrás/adelante y el cambio de ancla que sí
 *     emite evento.
 *
 * Un valor de módulo y no un `useState` por enlace: las entradas que comparten
 * página tienen que ver el MISMO ancla en el mismo render, o una se enciende
 * un tick antes de que la otra se apague.
 */
let current = "";
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Lo que el menú debe creer que es el ancla ahora mismo: "" o "#…". */
export function announceHash(hash: string): void {
  const value = hash === "" || hash.startsWith("#") ? hash : `#${hash}`;
  if (value === current) return;
  current = value;
  notify();
}

/** Vuelve a leer la del documento: montaje, cambio de ruta, hashchange, popstate. */
export function readDocumentHash(): void {
  if (typeof window === "undefined") return;
  announceHash(window.location.hash);
}

/**
 * LAS DOS ESCUCHAS DEL NAVEGADOR VAN CON EL CONJUNTO, no con cada enlace: se
 * ponen al llegar el primero y se quitan al irse el último. `addEventListener`
 * deduplica la misma tripleta (tipo, función, captura), así que ponerlas una
 * vez por `NavLink` dejaba UNA sola escucha compartida — y el primer
 * `removeEventListener` se la llevaba para todos.
 */
export function subscribeHash(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("hashchange", readDocumentHash);
    window.addEventListener("popstate", readDocumentHash);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("hashchange", readDocumentHash);
      window.removeEventListener("popstate", readDocumentHash);
    }
  };
}

export function getHashSnapshot(): string {
  return current;
}

/** Antes de hidratar no hay documento que leer: `primary` cubre ese caso. */
export function getServerHashSnapshot(): string {
  return "";
}

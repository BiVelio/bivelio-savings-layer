"use client";

import { useEffect, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

import { ICONS } from "@/app/components/icons";
import { Link, usePathname } from "@/i18n/navigation";

import {
  announceHash,
  getHashSnapshot,
  getServerHashSnapshot,
  readDocumentHash,
  subscribeHash,
} from "./nav-hash";

/**
 * Las rutas que cada entrada del raíl representa, además de la suya.
 *
 * «Verificar» salió de la barra el 02-09 («lía más que otra cosa») pero la
 * página sigue existiendo por URL, y desde el 22-09 es una PESTAÑA de Prueba
 * (`ProofTabs`). Sin esta tabla, abrir /dashboard/verify dejaría el menú
 * entero apagado — y un menú sin nada seleccionado se lee como «has ido a
 * parar a un sitio raro».
 */
const ALSO_MATCHES: Record<string, string[]> = {
  "/dashboard/proof": ["/dashboard/verify"],
  // Cuenta sólo se representa a sí misma: Equipo y Extracto tienen entrada propia.
  "/dashboard/account": [],
};

/**
 * Si una entrada está encendida, decidido desde cuatro valores y nada más —
 * para poder fijarlo en un test sin DOM (`nav-hash.test.ts`).
 *
 * Resumen (`/dashboard`) casa exacto; las demás casan también sus rutas
 * anidadas (`/dashboard/x` → `/dashboard/x/...`) y las páginas hermanas que
 * representan.
 *
 * Y CUANDO DOS ENTRADAS COMPARTEN UNA PÁGINA, EL ANCLA DECIDE CUÁL SE
 * ENCIENDE, en las dos direcciones. Resumen apunta a `/dashboard` a secas y
 * Máquinas a `/dashboard#maquinas`:
 *
 *   · entrada CON ancla propia → se enciende con SU ancla, y con el ancla
 *     vacía sólo si es la `primary`;
 *   · entrada SIN ancla → manda cuando no hay ancla, y cede cuando el ancla
 *     nombrada es la de UNA HERMANA de la misma página. Un ancla que no es de
 *     nadie la sigue dejando encendida: cerrar por defecto apagaría el menú
 *     entero, que es peor que encender de más.
 *
 * `siblingHashes` son las anclas que declaran las OTRAS entradas visibles de
 * la misma ruta, y las resuelve `AppSidebar` desde su catálogo.
 */
export function isNavLinkActive({
  pathname,
  hash,
  href,
  primary,
  siblingHashes,
}: {
  pathname: string;
  hash: string;
  href: string;
  primary?: boolean;
  /** Las anclas de las demás entradas que apuntan a esta misma ruta, sin `#`. */
  siblingHashes?: readonly string[];
}): boolean {
  const matches = (base: string) =>
    pathname === base || (base !== "/dashboard" && pathname.startsWith(`${base}/`));

  const [base, ownHash] = href.split("#") as [string, string | undefined];
  const onPage = matches(base) || (ALSO_MATCHES[base] ?? []).some(matches);
  if (!onPage) return false;
  if (ownHash) return hash === `#${ownHash}` || (hash === "" && Boolean(primary));
  return !(siblingHashes ?? []).some((sibling) => hash === `#${sibling}`);
}

/**
 * Una entrada del raíl que se enciende cuando casa con la ruta actual.
 *
 * `usePathname` nunca trae el ancla, así que ésta sale del almacén compartido
 * de `nav-hash.ts` (ver allí por qué un `useState` por enlace no vale).
 */
export function NavLink({
  href,
  icon,
  primary,
  siblingHashes,
  badge,
  badgeTitle,
  children,
}: {
  href: string;
  icon?: string;
  /** Para una entrada que apunta a un ancla: encenderla cuando no se nombra ninguna. */
  primary?: boolean;
  /** Las anclas de las OTRAS entradas visibles que apuntan a esta misma ruta. */
  siblingHashes?: readonly string[];
  /** LA CIFRA DE LA DERECHA — «2/5», «3 de 5», «1 miembro».
   *
   *  `null` NO ES «cero»: es «no se pudo leer», y entonces la entrada se pinta
   *  sin nada a la derecha. Es la regla que el resto del panel sigue («lo no
   *  medido se pinta "—", nunca 0»), traída al sitio donde más barata sale de
   *  romper. Quien resuelve la cadena es `AppSidebar`; aquí sólo se dibuja. */
  badge?: string | null;
  /** La frase completa de la que la cifra es el resumen, para el `title`. */
  badgeTitle?: string | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const hash = useSyncExternalStore(subscribeHash, getHashSnapshot, getServerHashSnapshot);

  // Primer montaje y cada cambio de ruta: el router ya escribió la URL (su
  // `useInsertionEffect` corre antes que los efectos pasivos), así que se lee.
  useEffect(() => {
    readDocumentHash();
  }, [pathname]);

  const [, ownHash] = href.split("#");
  const active = isNavLinkActive({ pathname, hash, href, primary, siblingHashes });

  /**
   * LA ENTRADA ENCENDIDA, A LA VISTA. A ≤860px el raíl es una tira horizontal
   * con scroll, y en escritorio scrollea hacia abajo cuando el menú no cabe:
   * se mueven SÓLO los desplazamientos del propio `.app-nav`, nunca
   * `scrollIntoView()`, que sube también el documento y en una barra pegajosa
   * es un salto de página al cargar.
   */
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const strip = document.querySelector<HTMLElement>(".app-nav");
    const el = strip?.querySelector<HTMLElement>('.app-nav-item[aria-current="page"]');
    if (!strip || !el) return;
    const rail = strip.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    if (row.left < rail.left) strip.scrollLeft += row.left - rail.left - 12;
    else if (row.right > rail.right) strip.scrollLeft += row.right - rail.right + 12;
    if (row.top < rail.top) strip.scrollTop += row.top - rail.top - 8;
    else if (row.bottom > rail.bottom) strip.scrollTop += row.bottom - rail.bottom + 8;
  }, [active, pathname, hash]);

  // El clic es la única navegación que nadie más anuncia: el router hará el
  // pushState sin evento, así que este enlace dice a dónde lleva la página.
  // Sólo para un clic izquierdo normal que vaya a navegar en ESTA pestaña.
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    announceHash(ownHash ? `#${ownHash}` : "");
  };

  const Icon = icon ? ICONS[icon] : undefined;

  return (
    <Link
      href={href}
      onClick={onClick}
      className={`app-nav-item${active ? " on" : ""}`}
      aria-current={active ? "page" : undefined}
      title={badgeTitle ?? undefined}
    >
      {Icon && (
        <span className="ic" aria-hidden>
          <Icon />
        </span>
      )}
      <span className="app-nav-label">{children}</span>
      {badge ? <span className="app-nav-badge">{badge}</span> : null}
    </Link>
  );
}

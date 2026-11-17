/**
 * QUÉ PARTE DEL CATÁLOGO VIAJA AL NAVEGADOR, POR TRAMO DE RUTA.
 *
 * `<NextIntlClientProvider messages={…}>` serializa lo que recibe en la carga
 * RSC de la página (`self.__next_f`), dentro del HTML. Con el catálogo ENTERO
 * (`messages/<idioma>.json` fundido sobre el inglés, ~170 KB) cada página
 * pública arrastraba el panel, el banco y las pantallas de acceso aunque sus
 * componentes cliente solo leyeran la barra: medido en /es, 566 KB de HTML de
 * los que 425 KB eran carga RSC, todo antes de la primera pintura en un móvil.
 *
 * Los componentes de SERVIDOR no dependen de esto: `getTranslations` y
 * `useTranslations` en el servidor leen el catálogo completo de
 * `i18n/request.ts`. Lo que se elige aquí es solo lo que piden los componentes
 * CLIENTE ('use client' y todo lo que importan) de cada tramo.
 *
 * Cada tramo es una lista de RAMAS: un espacio de nombres (`"nav"`) o un
 * subárbol (`"benchmarksPage.ab"`). `<MensajesCliente tramo="…">` (en
 * `i18n/MensajesCliente.tsx`) entrega solo esas ramas, y un proveedor anidado
 * SUSTITUYE al de fuera (use-intl no los funde): cada tramo lista todo lo que
 * piden los componentes cliente que quedan dentro de él.
 *
 * `i18n/mensajes-cliente.test.ts` recorre el grafo de imports de cada ruta y
 * falla si un componente cliente pide una clave que su tramo no entrega. Si
 * añades un `useTranslations` a un componente cliente, ese test te dice qué
 * rama falta y en qué tramo.
 */
import type { AbstractIntlMessages } from "next-intl";

export const RAMAS_DEL_CLIENTE = {
  /** `app/[locale]/layout.tsx`: la barra (enlaces, idioma, aviso) de todo el sitio. */
  sitio: ["nav"],
  /** /benchmarks: el centro de evidencia y la comparación A/B. */
  evidencia: [
    "benchmarksPage.ab",
    "benchmarksPage.centre",
    "benchmarksPage.filter",
    "benchmarksPage.noSavings.verdict",
    "benchmarksPage.terms",
    "benchmarksPage.th",
    "ui.evidence",
  ],
  /** /how-it-works: el verificador de formato. */
  verificador: ["landing.verify"],
  /** /login, /signup, /reset-password: los formularios de acceso. */
  acceso: ["auth"],
  /** /invitacion/[token]: aceptar la invitación (y crear la clave). */
  invitacion: [
    "invitacion",
    "auth.showPassword",
    "auth.hidePassword",
    "dashboard.equipo.columnaRol",
    "dashboard.equipo.rolOwner",
    "dashboard.equipo.rolAdmin",
    "dashboard.equipo.rolBilling",
    "dashboard.equipo.rolMember",
  ],
  /**
   * /dashboard/* y las galerías de desarrollo que pintan sus piezas: la
   * cáscara (selector de idioma, tour), el panel y la verificación.
   */
  panel: ["app.tour", "dashboard", "landing.verify", "nav", "ui.state"],
} as const satisfies Record<string, readonly string[]>;

export type TramoDelCliente = keyof typeof RAMAS_DEL_CLIENTE;

type Arbol = { [clave: string]: unknown };

const esArbol = (v: unknown): v is Arbol => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Copia PROFUNDA de `mensajes` con solo las ramas pedidas (y sus antepasados).
 *
 * Profunda a propósito: `getMessages()` devuelve el mismo objeto en caché a
 * todos los proveedores de la petición, y si dos tramos anidados (el del sitio
 * y el del panel) comparten una rama por referencia, React Flight la serializa
 * una vez y en la segunda escribe un puntero al primer proveedor
 * (`"nav":"$13:props:messages:nav"`). Con copias propias cada proveedor lleva
 * sus textos y ninguno depende de otra fila de la carga RSC. Tampoco se toca
 * el original. Una rama que no existe se omite; el test comprueba que todas
 * existen en `en.json`, el catálogo base sobre el que se funde cada idioma.
 */
export function elegirRamas(mensajes: AbstractIntlMessages, ramas: readonly string[]): AbstractIntlMessages {
  const out: Arbol = {};
  for (const rama of ramas) {
    // Ya va entera dentro de otra rama más corta de la lista.
    if (ramas.some((otra) => rama.startsWith(`${otra}.`))) continue;
    const partes = rama.split(".");
    let valor: unknown = mensajes;
    for (const clave of partes) valor = esArbol(valor) && clave in valor ? valor[clave] : undefined;
    if (valor === undefined) continue;
    // Un objeto NUEVO por nivel: nunca se escribe dentro de `mensajes`.
    let destino = out;
    for (const clave of partes.slice(0, -1)) {
      if (!esArbol(destino[clave])) destino[clave] = {};
      destino = destino[clave] as Arbol;
    }
    destino[partes[partes.length - 1]!] = structuredClone(valor);
  }
  return out as AbstractIntlMessages;
}

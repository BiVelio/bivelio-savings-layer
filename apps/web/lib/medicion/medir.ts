import { track } from "@vercel/analytics";

import { EVENTOS, destinoExterno, donde, gestorDelComando, planDelAlta } from "./eventos";

/**
 * Lo que conecta la medición con `track()` de Vercel. Solo navegador: lo llaman
 * los manejadores de `MedicionWeb` y el botón de copiar (`CopiarCodigo`).
 *
 * Sin `<Analytics />` montado (en `next dev`, o si el script no carga), `track()`
 * no hace nada: no hay cola a la que empujar. Y la medición nunca puede romper
 * la página: todo va dentro de un try/catch.
 *
 * Solo se llama a `track()`. Nunca a `identify` ni a `group` del script de
 * Vercel: son lo único de ese script que guarda algo en el navegador.
 */
function enviar(nombre: string, propiedades: Record<string, string>): void {
  try {
    track(nombre, propiedades);
  } catch {
    /* medir es opcional: el clic o la copia siguen su curso */
  }
}

/** Se copió `texto` desde `el`: si es un comando que instala BV-SALA, se cuenta con su gestor. El texto no viaja. */
export function medirCopia(texto: string, el: Element | null): void {
  const gestor = gestorDelComando(texto);
  if (!gestor) return;
  enviar(EVENTOS.copia, { manager: gestor, where: donde(location.pathname, el) });
}

/** Los contenedores de código: lo que se copie fuera de ellos (un párrafo, un formulario) no cuenta. */
const CODIGO = "pre, code, .codeframe-code";

/** Copia a mano (selección + Ctrl/Cmd+C) de un bloque sin botón, o de uno con botón sin usarlo. */
export function medirCopiaManual(seleccion: Selection | null): void {
  if (!seleccion || seleccion.isCollapsed) return;
  const elemento = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));
  const el = [elemento(seleccion.anchorNode), elemento(seleccion.focusNode)].find((e) => e?.closest(CODIGO)) ?? null;
  if (!el) return;
  medirCopia(seleccion.toString(), el);
}

/** Un clic (o clic central) en un enlace: salida a GitHub/npm/PyPI, o paso al alta. */
export function medirClic(objetivo: EventTarget | null): void {
  if (!(objetivo instanceof Element)) return;
  const enlace = objetivo.closest("a[href]");
  if (!(enlace instanceof HTMLAnchorElement)) return;
  const destino = destinoExterno(enlace.href);
  if (destino) {
    enviar(EVENTOS.salida, { target: destino, where: donde(location.pathname, enlace) });
    return;
  }
  const plan = planDelAlta(enlace.href, location.origin);
  if (plan) enviar(EVENTOS.alta, { plan, where: donde(location.pathname, enlace) });
}

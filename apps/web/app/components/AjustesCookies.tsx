"use client";

import { abrirAvisoDeCookies } from "@/lib/consentimiento/navegador";

/**
 * «Ajustes de cookies»: vuelve a abrir el aviso (AvisoCookies) para cambiar o
 * retirar la elección. Va en el pie de cada página pública y en /privacy. Es
 * un botón —abre algo en esta página, no lleva a otra—; el texto llega del
 * servidor, así que no pide mensajes al cliente.
 */
export function AjustesCookies({ texto, className }: { texto: string; className?: string }) {
  return (
    <button type="button" className={className} onClick={abrirAvisoDeCookies}>
      {texto}
    </button>
  );
}

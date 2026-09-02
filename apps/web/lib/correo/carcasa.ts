/**
 * LA CARCASA CLARA COMPARTIDA de los correos de la casa — una sola tarjeta
 * para auth (confirmación/recuperación/genérico) e invitaciones, para que
 * ningún correo vuelva a nacer desnudo: el dueño cazó dos el mismo día
 * (02-09) — el de confirmación primero y el de invitación después — porque
 * cada plantilla llevaba su propia versión pelada.
 *
 * El diseño es la familia «Attio ink» del sitio: tarjeta blanca sobre gris
 * (#F4F6F9 / #DEE4E7), tinta #0F1218, azul de marca #2F63D8. El wordmark va
 * en TEXTO a propósito: los clientes de correo bloquean imágenes por defecto
 * y un logo <img> llega roto justo en la primera impresión. Todo estilos
 * inline y cero imágenes: es un correo, no una página.
 */

/** Todo lo que entra en una plantilla viene de fuera (nombres de organización
 *  que escribe el cliente, correos de quien invita…): se escapa SIEMPRE. Vive
 *  aquí y no en invitacion.ts para que la carcasa no importe de sus llamantes
 *  (invitacion lo re-exporta para no mover a nadie). */
export function escapar(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** El botón tinta del sitio, en tabla (los clientes viejos no pintan CSS en <a>). */
export function botonTinta(enlace: string, etiqueta: string): string {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr>` +
    `<td style="border-radius:8px;background:#0F1218">` +
    `<a href="${escapar(enlace)}" target="_blank" style="display:inline-block;padding:12px 24px;` +
    `font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px">${escapar(etiqueta)}</a>` +
    `</td></tr></table>`
  );
}

export interface TarjetaClara {
  /** «Savings» o «Privacy» — el punto azul lo pone la carcasa. */
  nombreMarca: string;
  /**
   * El logo REAL alojado en nuestro dominio (pedido del dueño, 02-09: el
   * wordmark de texto se quedaba corto frente a la marca de verdad). Con
   * `alt` de respaldo: Gmail y Apple Mail cargan imágenes por defecto y ven
   * el logo; un cliente que las bloquee ve el texto del alt — nunca un hueco
   * roto. Sin URL (privacy aún no tiene su PNG), la carcasa cae al wordmark
   * de texto de siempre.
   */
  logoUrl?: string;
  /** Dominio del pie, enlazado en azul de marca. */
  dominio: string;
  /** Titular de la tarjeta (texto plano: la carcasa escapa). */
  titulo: string;
  /** Saludo, si el correo lo lleva (texto plano). */
  saludo?: string;
  /** Cuerpo YA compuesto por el llamante (puede llevar <b>…</b>; las partes
   *  variables las escapa quien las interpola — el contrato de siempre). */
  cuerpoHtml: string;
  /** Botón o código, ya compuestos (botonTinta para el botón). */
  accionHtml: string;
  /** La letra pequeña (texto plano: la carcasa escapa cada línea). */
  letraPequena: string[];
  /** El pie de producto (texto plano), p. ej. «BiVelio». */
  pie: string;
}

export function tarjetaClara(t: TarjetaClara): string {
  return [
    `<div style="margin:0;padding:32px 16px;background-color:#F4F6F9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`,
    `<div style="max-width:560px;margin:0 auto;background-color:#FFFFFF;border:1px solid #DEE4E7;border-radius:16px;padding:36px 40px">`,
    t.logoUrl
      ? `<img src="${escapar(t.logoUrl)}" width="190" alt="${escapar(t.nombreMarca)}. by BiVelio" ` +
        `style="display:block;width:190px;height:auto;border:0;font-size:20px;font-weight:800;color:#0F1218" />`
      : `<p style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#0F1218">` +
        `${escapar(t.nombreMarca)}<span style="color:#2F63D8">.</span>` +
        `<span style="font-size:11px;font-weight:600;letter-spacing:0.08em;color:#5A6070;margin-left:8px">BY BIVELIO</span></p>`,
    `<h1 style="margin:26px 0 10px 0;color:#0F1218;font-size:23px;line-height:1.25;font-weight:700">${escapar(t.titulo)}</h1>`,
    ...(t.saludo ? [`<p style="margin:0 0 4px 0;color:#5A6070;font-size:15px;line-height:1.6">${escapar(t.saludo)}</p>`] : []),
    `<p style="margin:0;color:#5A6070;font-size:15px;line-height:1.6">${t.cuerpoHtml}</p>`,
    t.accionHtml,
    `<p style="margin:0;color:#8A93A6;font-size:12.5px;line-height:1.6">${t.letraPequena.map(escapar).join(" ")}</p>`,
    `<p style="margin:24px 0 0 0;padding-top:16px;border-top:1px solid #EEF1F5;color:#8A93A6;font-size:12px">` +
      `${escapar(t.pie)} · <a href="https://${t.dominio}" style="color:#2F63D8;text-decoration:none">${escapar(t.dominio)}</a></p>`,
    `</div></div>`,
  ].join("");
}

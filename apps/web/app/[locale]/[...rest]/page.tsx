import { notFound } from "next/navigation";

/**
 * ATRAPA TODA URL QUE NO ES UNA RUTA. Sin este fichero, una dirección
 * desconocida bajo un idioma (`/es/lo-que-sea`) no casaba con NINGÚN segmento
 * de `[locale]`, así que Next ni siquiera montaba el layout del idioma y
 * servía su 404 genérica: en inglés, con `<h1 class="next-error-h1">`, sin
 * cabecera ni enlace de vuelta. Un probador que se equivocara al copiar una
 * URL del README o del panel aterrizaba en una pantalla que no parecía de
 * BiVelio (hallazgo de la verificación de la 0.4.20).
 *
 * Con el catch-all la URL SÍ casa —aquí—, el layout del idioma se monta, y
 * `notFound()` deriva al `not-found.tsx` de al lado, que hereda cabecera, pie
 * y traducciones. Es la técnica que documenta next-intl para el app router.
 * Las URL sin idioma (`/no-existe`) llegan igual: el middleware las redirige
 * antes a `/<idioma>/no-existe`.
 */
export default function CatchAllPage() {
  notFound();
}

import Image from "next/image";

import { Marcado } from "@/app/components/campana/Marcado";
import { BotonProductHunt } from "@/app/components/ProductHunt";
import { MINIATURA_PH, type Variante } from "@/app/components/franja-lanzamiento";

/**
 * «FIND US ON PRODUCT HUNT» — la tarjeta de Product Hunt reinterpretada con el
 * sistema de diseño de la portada, al final de ella (después del cierre, antes
 * de la banda de NVIDIA y del pie). No es el HTML con estilos en línea que da
 * PH: es una tarjeta blanca con hairline sobre el marfil, el cielo cian muy
 * tenue en su esquina y el marcador de la campaña detrás de «Product Hunt».
 *
 * · La miniatura es NUESTRA (public/brand/product-hunt-thumb-2026-11.png, la
 *   misma de la ficha de PH), servida a 64×64 con su 2× por next/image: ni
 *   imgix ni ninguna imagen de PH, así que esta tarjeta no conecta con ellos.
 * · El título es el nombre del producto, igual en todos los idiomas; el lema,
 *   la frase de la ficha («Cut LLM costs with an open-source savings layer»)
 *   traducida.
 * · El único enlace es el botón coral (#FF6154 con texto tinta, 6,33:1), con
 *   sus dos textos apilados (BotonProductHunt): la tarjeta mide lo mismo antes,
 *   durante y después de la semana del lanzamiento.
 */
export function TarjetaProductHunt({
  inicial,
  t,
}: {
  inicial: Variante;
  t: { kicker: string; lema: string; aviso: string; vivo: string; nuevaPestana: string };
}) {
  return (
    <section className="ph-sec" aria-labelledby="ph-sec-t">
      <div className="ph-tarjeta rv">
        <Image className="ph-miniatura" src={MINIATURA_PH} width={64} height={64} alt="" loading="lazy" />
        <div className="ph-texto">
          <h2 className="ph-k" id="ph-sec-t">
            <Marcado texto={t.kicker} marca="Product Hunt" />
          </h2>
          <p className="ph-nombre">BiVelio Savings Layer</p>
          <p className="ph-lema">{t.lema}</p>
        </div>
        <BotonProductHunt inicial={inicial} aviso={t.aviso} vivo={t.vivo} nuevaPestana={t.nuevaPestana} />
      </div>
    </section>
  );
}

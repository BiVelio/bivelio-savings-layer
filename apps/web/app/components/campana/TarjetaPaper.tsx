import { getTranslations } from "next-intl/server";

import { CABECERA } from "@/app/[locale]/paper/contenido";
import { URL_DEL_CODIGO } from "@/app/components/sitio";
import { Link } from "@/i18n/navigation";
import { EDICION_PAPER } from "@/lib/paper/edicion";

import { Marcado } from "./Marcado";
import { MosaicoDeLlamadas } from "./MosaicoDeLlamadas";

/**
 * LA TARJETA DEL ARTÍCULO DE INVESTIGACIÓN, con la firma de la campaña: un
 * antetítulo en versalitas, el título en negrita con su segunda línea en serif
 * cursiva y marcador cian, una fila de datos (páginas, licencia y DOI en mono),
 * una frase, las acciones y el mosaico de llamadas al pie.
 *
 * La pinta /benchmarks tras «Cómo leer esta página». Ni un dato escrito aquí:
 *  · versión, fecha, páginas, PDF, DOI y licencia → `lib/paper/edicion.ts`;
 *  · título, subtítulo, colección y autor → `CABECERA` (generada de docs/PAPER.md);
 *  · el repositorio → `URL_DEL_CODIGO`.
 * El título está en inglés en los doce idiomas (como el artículo) y va marcado
 * con `lang="en"`. La frase no lleva cifras: dice qué documenta el artículo.
 */
function Fuera() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 2.5h5.5V8M9.5 2.5 2.5 9.5" />
    </svg>
  );
}

export async function TarjetaPaper({ locale }: { locale: string }) {
  const t = await getTranslations("paperCard");
  const tNav = await getTranslations("nav");
  const E = EDICION_PAPER;
  const fecha = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${E.fecha}T00:00:00Z`),
  );
  const nuevaPestana = <span className="sr-only"> {tNav("newTab")}</span>;

  return (
    <section className="paperc" aria-labelledby="paperc-h">
      <div className="paperc-in">
        <p className="paperc-eyebrow">
          <span>{t("kind")}</span>
          <span className="paperc-version">{E.version}</span>
          <time dateTime={E.fecha}>{fecha}</time>
        </p>
        <h2 id="paperc-h" className="paperc-titulo" lang="en">
          {CABECERA.titulo}{" "}
          <span className="serif-accent paperc-acento">
            <Marcado texto={CABECERA.subtitulo} marca={CABECERA.subtitulo} />
          </span>
        </h2>
        <p className="paperc-resumen">{t("summary")}</p>
        <ul className="paperc-meta">
          <li>{t("pages", { n: E.paginas })}</li>
          <li>{E.licenciaEtiqueta}</li>
          <li>
            <span className="pildora-precio paperc-doi">
              <span className="paperc-doi-k">DOI</span>
              {E.doi}
            </span>
          </li>
        </ul>
        <nav className="paperc-acciones" aria-label={t("linksAria")}>
          <a className="btn btn-primary" href={E.pdf} target="_blank" rel="noopener noreferrer">
            {t("pdf", { version: E.version })}
            {nuevaPestana}
          </a>
          <a className="btn btn-ghost" href={E.urlDoi} target="_blank" rel="noopener noreferrer">
            {t("zenodo")}
            <Fuera />
            {nuevaPestana}
          </a>
          {/* P1 de la guía: el repositorio es abierto y el centro de evidencia lo enlaza. */}
          <a className="btn btn-ghost" href={URL_DEL_CODIGO} target="_blank" rel="noopener noreferrer">
            {t("code")}
            <Fuera />
            {nuevaPestana}
          </a>
          <Link className="btn btn-ghost" href="/paper">
            {t("web")}
          </Link>
        </nav>
        <div className="firma-campana paperc-firma">
          <span className="firma-dominio" lang="en">
            {CABECERA.coleccion} · {CABECERA.autor}
          </span>
          <a className="paperc-versiones" href={E.urlTodasLasVersiones} target="_blank" rel="noopener noreferrer">
            {t("versions")}
            <Fuera />
            {nuevaPestana}
          </a>
        </div>
      </div>
      <MosaicoDeLlamadas filas={3} semilla={23} className="paperc-mosaico" />
    </section>
  );
}

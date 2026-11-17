import type { CSSProperties } from "react";

import { getTranslations } from "next-intl/server";

import { LogoProveedor } from "@/app/components/LogoProveedor";
import { Link } from "@/i18n/navigation";
import { ChainLinks, ChainModel } from "@/vendor/affectui/fallback-chain";
import { FlowBlobs, FlowCharge, FlowLink } from "@/vendor/affectui/integration-flow";
import { MemoryGraph } from "@/vendor/affectui/memory-graph";

import { CapaMarco } from "./CapaMarco";
import type { ViajeDeLosDatos } from "./ViajeDeLosDatos";

/**
 * SAVINGS LAYER, EN ACCIÓN — la ilustración animada de la sección #data.
 *
 *   tus llamadas ══╗                       ╭┈ OpenAI
 *   (app · SDK)    ║   SAVINGS LAYER   ────┼─ Anthropic      «el proveedor que
 *   (agente ·      ║  memoria · compacta   ├┈ Gemini           configures»
 *    gateway)   ═══╝          ┊            ╰┈ endpoint compatible
 *                             ┊ solo recuentos y costes
 *                       Savings Cloud · opcional
 *
 * Un bucle de diez segundos cuenta cuatro cosas, en este orden: (1) la llamada
 * entra en la capa; (2) si es REPETIDA, la memoria la reconoce y la respuesta
 * vuelve en verde sin tocar al proveedor; (3) si es NUEVA, se compacta y viaja
 * al proveedor configurado, cuya respuesta vuelve por la capa y queda en la
 * memoria; (4) por la línea discontinua baja a Cloud una ficha de recuento,
 * nunca la petición.
 *
 * DE QUÉ ESTÁ HECHA. De tres piezas de affectUI Pro, vendorizadas y adaptadas
 * en `vendor/affectui/` (ver su VENDOR.md), cada una en su territorio:
 *   · IZQUIERDA — Integration Flow: el enlace recto entre dos tarjetas, el haz
 *     que lo barre (núcleo + resplandor), la tarjeta que «se carga» antes de
 *     disparar y las manchas de color que derivan tras la placa.
 *   · CENTRO — Memory Graph: la memoria de peticiones recientes. Cada tarjeta
 *     es una petición vista hace un momento (sin texto: no hay nada que
 *     inventar); la repetida se enciende y la nueva sube a su hueco.
 *   · DERECHA — Fallback Chain, SIN el fallback: su gramática de ramas (una
 *     por proveedor, punteada si solo es una alternativa), la luz que recorre
 *     la rama en uso y el verde de «responde». Savings NO prueba un proveedor
 *     tras otro: envía al que configures, así que no hay estados de fallo, ni
 *     orden de intentos, ni cronómetros, ni costes.
 *
 * CÓMO SE MUEVE. Todo es HTML/SVG del servidor; las piezas están quietas y
 * quien las mueve es la hoja (SLOT CAPA EN ACCION): un solo bucle, solo
 * `transform` y `opacity`. La geometría es fija (alturas en px, enlaces de
 * ancho fijo), así que no se mide nada en el navegador. El proveedor
 * «configurado» es un grupo de radios nativo + `:has()`: se elige con teclado
 * o ratón y funciona sin script. El único script es `CapaMarco` (pausa y
 * parada fuera de pantalla).
 *
 * LO QUE NO HACE, a propósito: no enseña cifras ni contadores (una ilustración
 * no mide) y la línea de Cloud no lleva nunca la petición.
 *
 * Con `prefers-reduced-motion` no hay bucle: los cuatro pasos se pintan como
 * una tira numerada y cada número aparece sobre su sitio en el dibujo.
 */
export type TextosDeLaCapa = Parameters<typeof ViajeDeLosDatos>[0]["t"];

/** Endpoints compatibles con la API de OpenAI que se enseñan como ejemplo. */
const COMPATIBLES = ["mistral", "deepseek", "azure", "vllm", "ollama"] as const;
const NOMBRES_COMPATIBLES = "Mistral, DeepSeek, Azure OpenAI, vLLM, Ollama";

/** Doce fichas de «tokens»: las cinco últimas son las que la compactación quita. */
const TOKENS = Array.from({ length: 12 }, (_, i) => i);
const QUEDAN = 7;

/**
 * La memoria: seis sitios alrededor de la capa. Uno es la petición que se
 * repite (se enciende) y otro, el hueco donde se guarda la nueva.
 */
const MEMORIA_IZQ = ["memory", "recalled", "memory"] as const;
const MEMORIA_DCH = ["memory", "memory", "learned"] as const;

/**
 * Geometría fija, compartida con la hoja (SLOT CAPA EN ACCION, `--pa`…`--pd`):
 * la altura a la que cada rama entra en su proveedor, en horizontal (≥900px,
 * todas salen de `SALIDA`) y en árbol (de arriba abajo).
 */
const ENLACE = 60;
const SALIDA = 200;
const RAMAS_H = [
  { y: 62, className: "capa-rama capa-rama--a" },
  { y: 126, className: "capa-rama capa-rama--b" },
  { y: 190, className: "capa-rama capa-rama--c" },
  { y: 280, className: "capa-rama capa-rama--d" },
];
const RAMAS_V = [
  { y: 78, className: "capa-rama capa-rama--a" },
  { y: 138, className: "capa-rama capa-rama--b" },
  { y: 198, className: "capa-rama capa-rama--c" },
  { y: 288, className: "capa-rama capa-rama--d" },
];

const trazo = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Tilde() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m2.5 6.4 2.3 2.3 4.7-5.2" />
    </svg>
  );
}

export async function CapaEnAccion({ t: flujo }: { t: TextosDeLaCapa }) {
  const t = await getTranslations("landing");

  const pasos = [
    { clase: "capa-paso capa-paso--1", titulo: t("layer.step1Title"), cuerpo: t("layer.step1Body") },
    { clase: "capa-paso capa-paso--2", titulo: t("layer.step2Title"), cuerpo: t("layer.step2Body") },
    { clase: "capa-paso capa-paso--3", titulo: t("layer.step3Title"), cuerpo: t("layer.step3Body") },
    { clase: "capa-paso capa-paso--4", titulo: t("layer.step4Title"), cuerpo: t("layer.step4Body") },
  ];
  const nativos = [
    { clase: "capa-prov capa-prov--a", marca: "openai", nombre: "OpenAI" },
    { clase: "capa-prov capa-prov--b", marca: "anthropic", nombre: "Anthropic" },
    { clase: "capa-prov capa-prov--c", marca: "gemini", nombre: "Gemini" },
  ];
  const leyenda = [
    { forma: "ok", clase: "capa-chip-ico capa-chip-ico--ok", de: t("layer.legendRepeat"), a: t("layer.legendRepeatTo") },
    { forma: "datos", clase: "capa-chip-ico capa-chip-ico--datos", de: t("layer.legendData"), a: t("layer.legendDataTo") },
    { forma: "cache", clase: "capa-chip-ico capa-chip-ico--cache", de: t("layer.legendCache"), a: t("layer.legendCacheTo") },
  ];

  return (
    <CapaMarco
      etiqueta={t("layer.figLabel")}
      pausar={t("layer.pause")}
      reanudar={t("layer.resume")}
      pasos={
        <ol className="capa-pasos" role="list" aria-label={t("layer.stepsLabel")}>
          {pasos.map((p, i) => (
            <li key={i} className={p.clase}>
              <span className="capa-paso-n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="capa-paso-c">
                <b>{p.titulo}</b> <span>{p.cuerpo}</span>
              </span>
            </li>
          ))}
        </ol>
      }
    >
      <div className="capa-escena">
        {/* IZQUIERDA · de dónde llegan las llamadas (Integration Flow: carga y haz) */}
        <div className="capa-col capa-col--origen">
          <p className="capa-rotulo capa-rotulo--origen">{t("layer.fromLabel")}</p>
          <div className="capa-origen capa-origen--app">
            <FlowCharge side="bottom" className="capa-carga capa-carga--sale" />
            <FlowCharge side="bottom" tone="ok" className="capa-carga capa-carga--vuelve" />
            <span className="capa-eco" aria-hidden="true" />
            <span className="capa-icono" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="17" height="17" {...trazo}>
                <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h11A1.5 1.5 0 0 1 17 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5zM6.5 8.5 8.5 10.5 6.5 12.5M10.5 12.5h3" />
              </svg>
            </span>
            <span className="capa-origen-c">
              <b>{t("layer.srcApp")}</b>
              <small>{t("layer.srcAppVia")}</small>
            </span>
            <span className="capa-sello" aria-hidden="true">
              <Tilde />
            </span>
          </div>
          <div className="capa-origen capa-origen--agente">
            <FlowCharge side="bottom" className="capa-carga capa-carga--sale" />
            <FlowCharge side="bottom" tone="ok" className="capa-carga capa-carga--vuelve" />
            <span className="capa-eco" aria-hidden="true" />
            <span className="capa-icono" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="17" height="17" {...trazo}>
                <path d="M10 3v2.5M5.5 5.5h9A1.5 1.5 0 0 1 16 7v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 13V7a1.5 1.5 0 0 1 1.5-1.5ZM2 9v2.5M18 9v2.5M7.75 9.25v1.5M12.25 9.25v1.5M8 17h4" />
              </svg>
            </span>
            <span className="capa-origen-c">
              <b>{t("layer.srcAgent")}</b>
              <small>{t("layer.srcAgentVia")}</small>
            </span>
            <span className="capa-sello" aria-hidden="true">
              <Tilde />
            </span>
          </div>
        </div>

        {/* Los dos enlaces de entrada: en horizontal (≥900px) y de arriba abajo */}
        <div className="capa-enlace capa-enlace--in" aria-hidden="true">
          <FlowLink length={ENLACE} className="capa-haz capa-haz--h capa-haz--app" forwardClassName="capa-haz-ida" backClassName="capa-haz-vuelta" />
          <FlowLink length={ENLACE} className="capa-haz capa-haz--h capa-haz--agente" forwardClassName="capa-haz-ida" backClassName="capa-haz-vuelta" />
          <FlowLink length={44} className="capa-haz capa-haz--v capa-haz--app" forwardClassName="capa-haz-ida" backClassName="capa-haz-vuelta" />
          <FlowLink length={44} className="capa-haz capa-haz--v capa-haz--agente" forwardClassName="capa-haz-ida" backClassName="capa-haz-vuelta" />
          <span className="capa-puerto capa-puerto--app" />
          <span className="capa-puerto capa-puerto--agente" />
          <span className="capa-num capa-num--entrada">1</span>
        </div>

        {/* CENTRO · la capa: una placa apilada, con su memoria (Memory Graph) y su compactación */}
        <div className="capa-placa">
          <FlowBlobs className="capa-ambiente" />
          <span className="capa-hoja capa-hoja--2" aria-hidden="true" />
          <span className="capa-hoja" aria-hidden="true" />
          <div className="capa-cara">
            <FlowCharge side="top" className="capa-carga capa-carga--placa" />
            <span className="capa-luz capa-luz--azul" aria-hidden="true" />
            <span className="capa-luz capa-luz--verde" aria-hidden="true" />
            <p className="capa-titulo">
              <span className="capa-icono capa-icono--marca" aria-hidden="true">
                <svg viewBox="0 0 20 20" width="17" height="17" {...trazo}>
                  <path d="m10 3 6.5 3.5L10 10 3.5 6.5zM3.5 10 10 13.5l6.5-3.5M3.5 13.5 10 17l6.5-3.5" />
                </svg>
              </span>
              <span className="capa-titulo-c">
                <b>Savings Layer</b>
                <small>{flujo.localSub}</small>
              </span>
            </p>
            <div className="capa-modulo capa-modulo--memoria">
              <span className="capa-modulo-t">{t("layer.memoryLabel")}</span>
              <span className="capa-num" aria-hidden="true">
                2
              </span>
              <MemoryGraph className="capa-memoria" id="savings-layer" left={MEMORIA_IZQ} right={MEMORIA_DCH} />
            </div>
            <div className="capa-modulo capa-modulo--compacta">
              <span className="capa-modulo-t">{t("layer.compactLabel")}</span>
              <span className="capa-num" aria-hidden="true">
                3
              </span>
              <span className="capa-tokens" aria-hidden="true">
                {TOKENS.map((i) => (
                  <i key={i} className={i < QUEDAN ? "capa-token" : "capa-token capa-token--fuera"} style={{ "--i": i - QUEDAN } as CSSProperties} />
                ))}
              </span>
            </div>
          </div>
        </div>

        {/* Las ramas hacia los proveedores (Fallback Chain, sin fallback): punteadas
            las alternativas, continua y con luz la del proveedor configurado. */}
        <div className="capa-enlace capa-enlace--out" aria-hidden="true">
          <ChainLinks className="capa-ramas capa-ramas--h" branches={RAMAS_H} from={SALIDA} width={ENLACE} height={360} />
          <ChainLinks tree className="capa-ramas capa-ramas--v" branches={RAMAS_V} height={344} />
          <span className="capa-puerto capa-puerto--out" />
        </div>

        {/* DERECHA · los proveedores. Radios nativos: el elegido es «el que configures». */}
        <div className="capa-col capa-col--provs">
          <p className="capa-rotulo capa-rotulo--provs" id="capa-provs-t">
            {t("layer.providersLabel")}
          </p>
          <div className="capa-provs" role="radiogroup" aria-labelledby="capa-provs-t">
            {nativos.map((p, i) => (
              <ChainModel
                key={p.marca}
                as="label"
                className={p.clase}
                control={<input className="sr-only" type="radio" name="capa-proveedor" defaultChecked={i === 0} />}
                logo={<LogoProveedor marca={p.marca} size={17} />}
                name={p.nombre}
                status={t("layer.nativeAdapter")}
                end={<span className="capa-radio" aria-hidden="true" />}
              />
            ))}
            <ChainModel
              as="label"
              className="capa-prov capa-prov--d"
              control={<input className="sr-only" type="radio" name="capa-proveedor" />}
              name={t("layer.compatName")}
              end={<span className="capa-radio" aria-hidden="true" />}
            >
              <span className="capa-compat" aria-hidden="true">
                {COMPATIBLES.map((m) => (
                  <span key={m} className="capa-compat-l">
                    <LogoProveedor marca={m} size={14} />
                  </span>
                ))}
              </span>
              <span className="sr-only">{NOMBRES_COMPATIBLES}</span>
            </ChainModel>
          </div>
        </div>

        {/* ABAJO · Savings Cloud, aparte y opcional: por su línea solo baja un recuento */}
        <span className="capa-nube-linea" aria-hidden="true">
          <span className="capa-ficha">
            <i />
          </span>
        </span>
        <div className="capa-cloud">
          <span className="capa-cloud-luz" aria-hidden="true" />
          <span className="capa-num" aria-hidden="true">
            4
          </span>
          <span className="capa-icono" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="17" height="17" {...trazo}>
              <path d="M4 16V9.5M8 16V4M12 16v-5M16 16V7" />
            </svg>
          </span>
          <span className="capa-cloud-c">
            <b>
              {flujo.cloud} <em>{flujo.cloudSub}</em>
            </b>
            <small>{t("layer.step4Title")}</small>
          </span>
        </div>
      </div>

      <ul className="capa-leyenda" role="list">
        {leyenda.map((l) => (
          <li key={l.forma}>
            <Link className="capa-chip" href="/how-it-works#ledgers">
              <span className={l.clase} aria-hidden="true">
                {l.forma === "ok" ? (
                  <Tilde />
                ) : l.forma === "datos" ? (
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor" focusable="false">
                    <path d="M1 3h10v1.6H1zM1 6.2h6.5v1.6H1zM1 9.4h3.5V11H1z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" focusable="false">
                    <path d="M6 1.5v9M3 8l3 2.8L9 8" />
                  </svg>
                )}
              </span>
              <b>{l.de}</b>
              <span className="capa-chip-f" aria-hidden="true">
                →
              </span>
              <span>{l.a}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="capa-nota">
        {t("layer.compatNote")} <Link href="/benchmarks#compat">{t("layer.compatLink")}</Link>
      </p>
      <figcaption className="capa-pie">{flujo.pie}</figcaption>
    </CapaMarco>
  );
}

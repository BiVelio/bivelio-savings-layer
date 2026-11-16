import type { CSSProperties } from "react";

import { getTranslations } from "next-intl/server";

import { LogoProveedor } from "@/app/components/LogoProveedor";
import { Link } from "@/i18n/navigation";

import { CapaMarco } from "./CapaMarco";
import type { ViajeDeLosDatos } from "./ViajeDeLosDatos";

/**
 * SAVINGS LAYER, EN ACCIÓN — la ilustración animada de la sección #data.
 *
 *   tus llamadas ─╮                       ╭─ OpenAI
 *   (app · SDK)   ├─▶  SAVINGS LAYER  ───▶├─ Anthropic      «el proveedor que
 *   (agente ·     │   memoria · compacta  ├─ Gemini           configures»
 *    gateway)   ──╯          ┊            ╰─ endpoint compatible
 *                            ┊ solo recuentos y costes
 *                      Savings Cloud · opcional
 *
 * Un bucle de diez segundos cuenta cuatro cosas, en este orden: (1) la llamada
 * entra en la capa; (2) si es REPETIDA, la memoria la reconoce y la respuesta
 * vuelve en verde sin tocar al proveedor; (3) si es NUEVA, se compacta —el
 * pulso sale más corto— y viaja al proveedor elegido, cuya respuesta vuelve
 * por la capa; (4) por la línea discontinua baja a Cloud una ficha de
 * recuento, nunca la petición.
 *
 * CÓMO ESTÁ HECHA. Todo es HTML del servidor con texto real; la geometría son
 * coordenadas CSS (`--s1x`, `--iny`…: x en % del lienzo, y en px) que comparten
 * las tarjetas, los hilos SVG y los fotogramas de los pulsos, así que no hay
 * que medir nada en el navegador. Solo se animan `transform` y `opacity`. El
 * proveedor «configurado» es un grupo de radios nativo + `:has()`: se elige con
 * teclado o ratón y funciona sin script. El único script es `CapaMarco` (pausa
 * y parada fuera de pantalla).
 *
 * LO QUE NO HACE, a propósito: no enseña cifras ni contadores (una ilustración
 * no mide) y la línea de Cloud no lleva nunca el pulso de la petición.
 *
 * Con `prefers-reduced-motion` no hay bucle: los cuatro pasos se pintan como
 * una tira numerada y cada número aparece sobre su sitio en el dibujo.
 *
 * Inspiración de movimiento: Fallback Chain, Memory Graph e Integration Flow
 * de affectUI (vistas públicas); el código es propio.
 */
export type TextosDeLaCapa = Parameters<typeof ViajeDeLosDatos>[0]["t"];

/** Endpoints compatibles con la API de OpenAI que se enseñan como ejemplo. */
const COMPATIBLES = ["mistral", "deepseek", "azure", "vllm", "ollama"] as const;
const NOMBRES_COMPATIBLES = "Mistral, DeepSeek, Azure OpenAI, vLLM, Ollama";

/** Doce fichas de «tokens»: las cinco últimas son las que la compactación quita. */
const TOKENS = Array.from({ length: 12 }, (_, i) => i);
const QUEDAN = 7;

/** Nodos de la memoria (viewBox 240×56). El cuarto es el que casa con la repetida. */
const NODOS: readonly (readonly [number, number])[] = [
  [24, 28],
  [66, 12],
  [66, 44],
  [120, 28],
  [172, 12],
  [172, 44],
];
const ARISTAS = "M24 28 66 12M24 28 66 44M66 12 120 28M66 44 120 28M120 28 172 12M120 28 172 44M172 12 216 28M172 44 216 28";

/**
 * Los cuatro hilos hacia los proveedores, en horizontal y en vertical. Cada uno
 * se pinta dos veces: en gris (siempre) y en azul encima (`capa-hilo-on--x`),
 * que solo se ve cuando su proveedor es el elegido.
 */
const HILOS_H = [
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--a", d: "M64 200C68.5 200 68.5 62 73 62" },
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--b", d: "M64 200C68.5 200 68.5 126 73 126" },
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--c", d: "M64 200C68.5 200 68.5 190 73 190" },
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--d", d: "M64 200C68.5 200 68.5 280 73 280" },
] as const;
const HILOS_V = [
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--a", d: "M5 370V438Q5 448 8 448H12" },
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--b", d: "M5 370V498Q5 508 8 508H12" },
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--c", d: "M5 370V558Q5 568 8 568H12" },
  { clase: "capa-hilo capa-hilo-on capa-hilo-on--d", d: "M5 370V648Q5 658 8 658H12" },
] as const;

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
        {/* Hilos: una versión horizontal (≥900px) y otra vertical. Las x son %
            del lienzo y las y, px: las mismas coordenadas que usa la hoja. */}
        <svg className="capa-hilos capa-hilos--h" viewBox="0 0 100 472" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path className="capa-hilo capa-hilo--vivo" d="M21 148C25.5 148 25.5 200 30 200" />
          <path className="capa-hilo capa-hilo--vivo" d="M21 252C25.5 252 25.5 200 30 200" />
          {HILOS_H.map((h) => (
            <path key={h.clase} className="capa-hilo" d={h.d} />
          ))}
          {HILOS_H.map((h) => (
            <path key={h.clase} className={h.clase} d={h.d} />
          ))}
          <path className="capa-hilo capa-hilo--cloud" d="M47 344V410" />
        </svg>
        <svg className="capa-hilos capa-hilos--v" viewBox="0 0 100 804" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path className="capa-hilo capa-hilo--vivo" d="M24 94C24 112 50 112 50 130" />
          <path className="capa-hilo capa-hilo--vivo" d="M76 94C76 112 50 112 50 130" />
          {HILOS_V.map((h) => (
            <path key={h.clase} className="capa-hilo" d={h.d} />
          ))}
          {HILOS_V.map((h) => (
            <path key={h.clase} className={h.clase} d={h.d} />
          ))}
          <path className="capa-hilo capa-hilo--cloud" d="M95 370V738" />
        </svg>

        {/* IZQUIERDA · de dónde llegan las llamadas */}
        <p className="capa-rotulo capa-rotulo--origen">{t("layer.fromLabel")}</p>
        <div className="capa-origen capa-origen--app">
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
          <span className="capa-sello capa-sello--ok" aria-hidden="true">
            <Tilde />
          </span>
        </div>
        <div className="capa-origen capa-origen--agente">
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
          <span className="capa-sello capa-sello--resp" aria-hidden="true">
            <Tilde />
          </span>
        </div>

        {/* CENTRO · la capa: una placa apilada, con su memoria y su compactación */}
        <div className="capa-placa">
          <span className="capa-halo" aria-hidden="true" />
          <span className="capa-hoja capa-hoja--2" aria-hidden="true" />
          <span className="capa-hoja" aria-hidden="true" />
          <div className="capa-cara">
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
            <div className="capa-modulo">
              <span className="capa-modulo-t">{t("layer.memoryLabel")}</span>
              <span className="capa-num" aria-hidden="true">
                2
              </span>
              <svg className="capa-memoria" viewBox="0 0 240 56" aria-hidden="true" focusable="false">
                <path className="capa-arista" d={ARISTAS} />
                {NODOS.map(([x, y], i) => (
                  <circle key={i} className="capa-nodo" cx={x} cy={y} r={i === 3 ? 6.5 : 4.5} />
                ))}
                <circle className="capa-nodo capa-nodo--hueco" cx="216" cy="28" r="4.5" />
                {NODOS.map(([x, y], i) => (
                  <circle key={i} className="capa-nodo-scan" cx={x} cy={y} r={i === 3 ? 6.5 : 4.5} style={{ "--i": i } as CSSProperties} />
                ))}
                <circle className="capa-nodo-nuevo" cx="216" cy="28" r="4.5" />
                <circle className="capa-nodo-eco" cx="120" cy="28" r="13" />
                <g className="capa-nodo-ok">
                  <circle cx="120" cy="28" r="7.5" />
                  <path d="m116.6 28.2 2.4 2.4 4.4-4.9" />
                </g>
              </svg>
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
        <span className="capa-puerto capa-puerto--in" aria-hidden="true" />
        <span className="capa-puerto capa-puerto--out" aria-hidden="true" />

        {/* DERECHA · la cadena de proveedores. Radios nativos: el elegido es
            «el que configures» y su hilo es el que recorre el pulso. */}
        <p className="capa-rotulo capa-rotulo--provs" id="capa-provs-t">
          {t("layer.providersLabel")}
        </p>
        <div className="capa-provs" role="radiogroup" aria-labelledby="capa-provs-t">
          {nativos.map((p, i) => (
            <label key={p.marca} className={p.clase}>
              <input className="sr-only" type="radio" name="capa-proveedor" defaultChecked={i === 0} />
              <span className="capa-prov-luz" aria-hidden="true" />
              <span className="capa-icono" aria-hidden="true">
                <LogoProveedor marca={p.marca} size={17} />
              </span>
              <span className="capa-prov-c">
                <b>{p.nombre}</b>
                <small>{t("layer.nativeAdapter")}</small>
              </span>
              <span className="capa-radio" aria-hidden="true" />
            </label>
          ))}
          <label className="capa-prov capa-prov--d">
            <input className="sr-only" type="radio" name="capa-proveedor" />
            <span className="capa-prov-luz" aria-hidden="true" />
            <span className="capa-prov-c">
              <b>{t("layer.compatName")}</b>
              <span className="capa-compat" aria-hidden="true">
                {COMPATIBLES.map((m) => (
                  <span key={m} className="capa-compat-l">
                    <LogoProveedor marca={m} size={14} />
                  </span>
                ))}
              </span>
              <span className="sr-only">{NOMBRES_COMPATIBLES}</span>
            </span>
            <span className="capa-radio" aria-hidden="true" />
          </label>
        </div>

        {/* ABAJO · Savings Cloud, aparte y opcional */}
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

        <span className="capa-num capa-num--entrada" aria-hidden="true">
          1
        </span>

        {/* Los pulsos. Cada portador mide 100 % × 0 y se traslada en % (x) y px (y). */}
        <div className="capa-pulsos" aria-hidden="true">
          <span className="capa-pulso capa-pulso--a">
            <i />
          </span>
          <span className="capa-pulso capa-pulso--b">
            <i>
              <Tilde />
            </i>
          </span>
          <span className="capa-pulso capa-pulso--c">
            <i />
          </span>
          <span className="capa-pulso capa-pulso--d">
            <i />
          </span>
          <span className="capa-pulso capa-pulso--e">
            <i />
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

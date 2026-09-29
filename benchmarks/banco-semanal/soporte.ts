/**
 * EL BANCO SEMANAL · ¿SABE ESTE ARNÉS MEDIR ESTE MODELO?
 * ---------------------------------------------------------------------------
 * Se pregunta a cada arnés con SUS PROPIAS listas exportadas, no con una copia
 * (hasta el 2026-09-29 BFCL iba copiado a mano —«solo Anthropic y OpenAI»— y
 * MT-Bench miraba solo su lista por defecto, así que Gemini y la gama alta
 * salían «sin soporte» aunque el arnés los supiera medir):
 * el día que una batería aprenda un modelo nuevo (las ramas «gama alta» de
 * #396, #397, #398 y #400 añaden Gemini, gpt-5.5, gpt-5.6-sol y Sonnet 5.5), el banco lo
 * mide sin tocar nada aquí.
 *
 * Una celda sin soporte NO se lanza, NO reserva dinero y NO hace fallar el
 * banco: es cobertura que falta, no algo que haya empeorado. El resumen la
 * lista aparte, con el motivo, para que no pase por medida.
 */
import { HOSTS_OFICIALES as HOSTS_BFCL } from "../publicados/bfcl/arnes.js";
import { HOSTS_PERMITIDOS as HOSTS_GSM8K } from "../publicados/gsm8k/arnes.js";
import { MODELOS as MODELOS_XSTEST } from "../publicados/xstest/banco.js";
import { MODELOS_MEDIBLES as MODELOS_MT_BENCH } from "../publicados/mt-bench/nucleo.js";
import type { Bateria, ModeloDelBanco } from "./plan.js";

export type Soporte = { ok: true } | { ok: false; motivo: string };

/** Host de la API oficial de cada familia (el que la verja de hosts del arnés tiene que dejar pasar). */
export const HOST_DE_FAMILIA = {
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
  google: "generativelanguage.googleapis.com",
} as const;

export interface ListasDeLosArneses {
  hostsGsm8k: readonly string[];
  /** Los API oficiales con los que BFCL sabe hablar (`HOSTS_OFICIALES`; Gemini por su API nativa). */
  hostsBfcl: readonly string[];
  modelosXstest: readonly string[];
  modelosMtBench: readonly string[];
}

export const LISTAS_ACTUALES: ListasDeLosArneses = {
  hostsGsm8k: HOSTS_GSM8K,
  hostsBfcl: Object.values(HOSTS_BFCL),
  modelosXstest: MODELOS_XSTEST.map((x) => x.id),
  modelosMtBench: MODELOS_MT_BENCH.map((x) => x.id),
};

export function soporte(bateria: Bateria, modelo: ModeloDelBanco, l: ListasDeLosArneses = LISTAS_ACTUALES): Soporte {
  const host = HOST_DE_FAMILIA[modelo.familia];
  switch (bateria) {
    case "gsm8k":
      return l.hostsGsm8k.includes(host) ? { ok: true } : { ok: false, motivo: `la verja de hosts de GSM8K no deja pasar ${host}` };
    case "bfcl":
      return l.hostsBfcl.includes(host) ? { ok: true } : { ok: false, motivo: `BFCL solo habla con ${l.hostsBfcl.join(" y ")}` };
    case "xstest":
      return l.modelosXstest.includes(modelo.corto)
        ? { ok: true }
        : { ok: false, motivo: `XSTest no tiene ${modelo.corto} en MODELOS (banco.ts)` };
    case "mt-bench":
      return l.modelosMtBench.includes(modelo.corto)
        ? { ok: true }
        : { ok: false, motivo: `MT-Bench no tiene ${modelo.corto} en MODELOS_MEDIBLES (nucleo.ts)` };
  }
}

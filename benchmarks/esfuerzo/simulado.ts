/**
 * Banco del ESFUERZO · el PROVEEDOR SIMULADO de la tirada en seco.
 * ---------------------------------------------------------------------------
 * Contesta como /v1/messages SIN red y SIN gasto, para que `pnpm esfuerzo`
 * (en seco, por defecto) recorra el MISMO bucle, la misma construcción de
 * peticiones, el mismo `costeMedido` y el mismo criterio que la tirada real.
 *
 * LO QUE PRUEBA: la fontanería. Que cada brazo manda lo que dice (el dial, su
 * beta, la raíz), que el proveedor rechazaría lo que la API documentada rechaza
 * (dial sin beta, modelo sin esfuerzo por turno), que el `usage` se tarifa y que
 * la caché se comporta como la documentación describe (un dial añadido DETRÁS
 * del punto de ruptura no cambia el hash del prefijo).
 *
 * LO QUE NO PRUEBA: nada sobre el modelo. Los factores de salida por nivel son
 * SUPUESTOS del simulador, no evidencia; y su agente de guion no resuelve
 * ninguna tarea (entrega «simulated»), así que la verja de calidad no tiene
 * señal. Por eso `decidir` jamás enciende nada sobre una tirada simulada.
 *
 * La pregunta que la documentación deja abierta —¿rige la respuesta en curso
 * un dial que va DETRÁS del último turno de usuario, si «takes effect from the
 * next user turn»?— no se resuelve aquí: se DECLARA (`dialFinalRige`) para
 * poder comprobar que el banco detecta cada caso. La contesta la tirada real.
 */

import { admiteEsfuerzoPorTurno, BETA_ESFUERZO, defectoDeEsfuerzo, esNivel, type Esfuerzo } from "../../gateway/esfuerzo.js";
import { prng } from "../anillo1/tareas.js";
import type { PeticionConstruida, RespuestaMessages } from "./nucleo.js";

export interface OpcionesSimulador {
  /** ¿Rige la respuesta en curso un dial colocado detrás del último turno de usuario? Se declara, no se sabe. */
  dialFinalRige: boolean;
  /** Factor multiplicativo de la salida por nivel EFECTIVO. Supuesto del simulador. */
  factores?: Partial<Record<Esfuerzo, number>>;
}

/** Supuestos del simulador (monótonos con el nivel). NO son una medición de nadie. */
export const FACTORES_SUPUESTOS: Readonly<Record<Esfuerzo, number>> = {
  low: 0.5,
  medium: 0.75,
  high: 1,
  xhigh: 1.3,
  max: 1.6,
};

/** Fracción de la salida que el simulador declara como pensamiento. Supuesto. */
export const FRACCION_THINKING_SUPUESTA = 0.4;

type Objeto = Record<string, unknown>;
const esObjeto = (v: unknown): v is Objeto => typeof v === "object" && v !== null && !Array.isArray(v);
const esDial = (m: unknown): boolean => esObjeto(m) && m["role"] === "system" && m["output_config"] !== undefined;
const tokensDe = (s: string): number => Math.ceil(s.length / 4);

/** FNV-1a de 32 bits: una semilla estable a partir de un texto. */
function semillaDe(texto: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * El nivel que rige la respuesta en curso según la documentación: la raíz
 * (o el defecto del modelo) y, encima, el último dial que preceda al último
 * turno de usuario. Un dial DETRÁS de él rige solo si se declara así.
 */
export function nivelEfectivo(cuerpo: Objeto, dialFinalRige: boolean): Esfuerzo {
  const modelo = typeof cuerpo["model"] === "string" ? (cuerpo["model"] as string) : "";
  const raiz = esObjeto(cuerpo["output_config"]) ? (cuerpo["output_config"] as Objeto)["effort"] : undefined;
  let nivel: Esfuerzo = typeof raiz === "string" && esNivel(raiz) ? raiz : (defectoDeEsfuerzo(modelo) ?? "high");
  const msgs = Array.isArray(cuerpo["messages"]) ? (cuerpo["messages"] as unknown[]) : [];
  let ultimoUsuario = -1;
  msgs.forEach((m, i) => {
    if (esObjeto(m) && m["role"] === "user") ultimoUsuario = i;
  });
  msgs.forEach((m, i) => {
    if (!esDial(m)) return;
    const n = ((m as Objeto)["output_config"] as Objeto)["effort"];
    if (typeof n !== "string" || !esNivel(n)) return;
    if (i < ultimoUsuario || dialFinalRige) nivel = n;
  });
  return nivel;
}

/**
 * Las unidades del prompt renderizado, en orden, para emular la caché de
 * prefijo. La raíz del esfuerzo va PRIMERO porque la documentación dice que
 * «the resolved effort value is rendered into the prompt» y que cambiarlo
 * invalida los puntos de ruptura: el sitio exacto no está documentado y aquí se
 * toma el más conservador.
 */
export function unidadesDelPrompt(cuerpo: Objeto): { texto: string; dial: boolean }[] {
  const raiz = esObjeto(cuerpo["output_config"]) ? JSON.stringify(cuerpo["output_config"]) : "";
  const unidades = [
    { texto: `effort:${raiz}`, dial: false },
    { texto: `system:${JSON.stringify(cuerpo["system"] ?? "")}`, dial: false },
    { texto: `tools:${JSON.stringify(cuerpo["tools"] ?? [])}`, dial: false },
  ];
  const msgs = Array.isArray(cuerpo["messages"]) ? (cuerpo["messages"] as unknown[]) : [];
  for (const m of msgs) unidades.push({ texto: JSON.stringify(m), dial: esDial(m) });
  return unidades;
}

/**
 * Un paso de la caché automática: el punto de ruptura va al último bloque con
 * contenido (un dial no tiene: `content: []`), se lee la entrada previa más
 * larga que sea prefijo y se escribe el resto hasta el punto. Lo que queda
 * detrás del punto (un dial final) se cobra como entrada sin caché.
 */
export function pasoDeCache(
  entradas: string[][],
  unidades: { texto: string; dial: boolean }[],
): { leidos: number; escritos: number; sinCache: number; entrada: string[] } {
  let punto = unidades.length - 1;
  while (punto >= 0 && unidades[punto]!.dial) punto--;
  const prefijo = unidades.slice(0, punto + 1).map((u) => u.texto);
  let mejor = 0;
  for (const e of entradas) {
    if (e.length > prefijo.length || e.length <= mejor) continue;
    if (e.every((t, i) => t === prefijo[i])) mejor = e.length;
  }
  const tok = (xs: string[]): number => xs.reduce((a, t) => a + tokensDe(t), 0);
  return {
    leidos: tok(prefijo.slice(0, mejor)),
    escritos: tok(prefijo.slice(mejor)),
    sinCache: tok(unidades.slice(punto + 1).map((u) => u.texto)),
    entrada: prefijo,
  };
}

const error = (message: string): RespuestaMessages => ({ error: { type: "invalid_request_error", message } });

/**
 * El proveedor simulado. Con estado (la caché por sal), sin red. El agente de
 * guion lista, lee el primer fichero, busca y entrega «simulated»: cuatro
 * turnos que ejercitan el bucle de herramientas y la caché con un resultado
 * gordo que se escribe en un turno y se lee en el siguiente.
 */
export function proveedorSimulado(op: OpcionesSimulador): (p: PeticionConstruida) => Promise<RespuestaMessages> {
  const cache = new Map<string, string[][]>();
  const factores = { ...FACTORES_SUPUESTOS, ...(op.factores ?? {}) };
  return async (p) => {
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(p.texto);
    } catch {
      return error("invalid JSON body");
    }
    if (!esObjeto(cuerpo)) return error("body must be an object");
    const modelo = typeof cuerpo["model"] === "string" ? (cuerpo["model"] as string) : "";
    const msgs = Array.isArray(cuerpo["messages"]) ? (cuerpo["messages"] as unknown[]) : [];

    // Lo que la API documentada rechaza, rechazado igual.
    if (msgs.some(esDial)) {
      const betas = (p.cabeceras["anthropic-beta"] ?? "").split(",").map((s) => s.trim());
      if (!betas.includes(BETA_ESFUERZO)) return error(`per-message output_config requires the ${BETA_ESFUERZO} beta header`);
      if (!admiteEsfuerzoPorTurno(modelo)) {
        return error("output_config.effort requires a model that supports per-turn effort; this model does not");
      }
    }

    const system = typeof cuerpo["system"] === "string" ? (cuerpo["system"] as string) : "";
    const sal = /^\[medicion-fria ([^\]]+)\]/.exec(system)?.[1] ?? "";
    const entradas = cache.get(sal) ?? [];
    const paso = pasoDeCache(entradas, unidadesDelPrompt(cuerpo));
    entradas.push(paso.entrada);
    cache.set(sal, entradas);

    // El guion: el turno es el número de respuestas previas del asistente.
    const turno = msgs.filter((m) => esObjeto(m) && m["role"] === "assistant").length;
    const enunciado = msgs.find((m) => esObjeto(m) && m["role"] === "user" && typeof m["content"] === "string") as Objeto | undefined;
    const azar = prng(semillaDe(`${String(enunciado?.["content"] ?? "")}#${turno}`));
    const base = 150 + Math.floor(azar() * 450);
    const salida = Math.max(1, Math.round(base * factores[nivelEfectivo(cuerpo, op.dialFinalRige)]));
    const thinking = Math.round(salida * FRACCION_THINKING_SUPUESTA);

    let herramienta: { name: string; input: Record<string, unknown> };
    if (turno === 0) herramienta = { name: "listar", input: {} };
    else if (turno === 1) {
      // El primer fichero que devolvió `listar`: en el ÚLTIMO turno de USUARIO,
      // no en el último mensaje (detrás puede ir el dial del gateway).
      const ultimo = [...msgs].reverse().find((m) => esObjeto(m) && m["role"] === "user");
      const resultado = esObjeto(ultimo) && Array.isArray(ultimo["content"]) ? (ultimo["content"] as unknown[]) : [];
      const texto = resultado.map((b) => (esObjeto(b) && typeof b["content"] === "string" ? (b["content"] as string) : "")).join("\n");
      herramienta = { name: "leer_fichero", input: { ruta: texto.split("\n")[0] ?? "" } };
    } else if (turno === 2) {
      // Un turno más con el fichero gordo ya en el historial: el siguiente lo LEE de caché.
      herramienta = { name: "buscar", input: { patron: "ERROR" } };
    } else herramienta = { name: "entregar", input: { respuesta: "simulated" } };

    return {
      content: [
        // El pensamiento viaja como bloque (sin texto: aquí no hay razonamiento que mostrar).
        { type: "thinking" },
        { type: "tool_use", id: `toolu_sim_${turno}`, name: herramienta.name, input: herramienta.input },
      ],
      stop_reason: "tool_use",
      usage: {
        input_tokens: paso.sinCache,
        cache_read_input_tokens: paso.leidos,
        cache_creation_input_tokens: paso.escritos,
        output_tokens: salida,
        output_tokens_details: { thinking_tokens: thinking },
      },
    };
  };
}

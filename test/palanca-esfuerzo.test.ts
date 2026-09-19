import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";

import {
  BETA_ESFUERZO,
  NIVELES,
  admiteEsfuerzoPorTurno,
  aplicarEsfuerzo,
  conBetaDeEsfuerzo,
  describirEstadoDeEsfuerzo,
  mensajeDeEsfuerzo,
  yaGobiernaSuEsfuerzo,
} from "../gateway/esfuerzo.js";

/**
 * LO QUE ESTE FICHERO PROTEGE, y por qué esta palanca existe:
 *
 * La SALIDA es lo único que paga precio de lista ($486,06 de $3.959,73), y
 * dentro de ella el pensamiento es el bloque mayor (37,7 %). Cambiar el esfuerzo
 * en la RAÍZ de la petición lo tocaría, pero invalida la caché de mensajes — la
 * misma trampa que mató a la poda (35,7:1 en contra), a la elisión (−16,7 %) y
 * al patrón de `context-mode` (−$16,73).
 *
 * La escotilla es un mensaje AÑADIDO AL FINAL. Que se añada y no reescriba nada
 * anterior es la propiedad entera: por eso el prefijo cacheado sigue casando.
 * Si alguien «optimiza» esto insertándolo en otro sitio, la palanca deja de
 * tener sentido — y estos tests se ponen rojos.
 */

const cuerpo = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");
const PETICION = {
  model: "claude-fable-5-1",
  max_tokens: 64,
  system: [{ type: "text", text: "sé breve" }],
  messages: [
    { role: "user", content: "hola" },
    { role: "assistant", content: "qué tal" },
  ],
};

describe("qué modelos admiten el esfuerzo por turno", () => {
  it("solo los tres verificados", () => {
    for (const m of ["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5"]) {
      expect(admiteEsfuerzoPorTurno(m)).toBe(true);
    }
  });

  it("⛔ claude-fable-5 NO, aunque sea la misma familia que uno que sí", () => {
    // Devuelve 400: «output_config.effort requires a model that supports
    // per-turn effort». Meterlo aquí rompería peticiones que sin nosotros iban bien.
    expect(admiteEsfuerzoPorTurno("claude-fable-5")).toBe(false);
  });

  it("ni instantáneas con fecha ni prefijos de proveedor: no están verificados", () => {
    expect(admiteEsfuerzoPorTurno("claude-fable-5-1-20260901")).toBe(false);
    expect(admiteEsfuerzoPorTurno("anthropic/claude-opus-5")).toBe(false);
    expect(admiteEsfuerzoPorTurno("claude-sonnet-5")).toBe(false);
    expect(admiteEsfuerzoPorTurno("")).toBe(false);
  });
});

describe("el dial se AÑADE, nunca reescribe — que es toda la palanca", () => {
  it("todo lo anterior queda byte a byte igual", () => {
    const r = aplicarEsfuerzo(cuerpo(PETICION), "low");
    expect(r).not.toBeNull();
    const json = JSON.parse(r!.cuerpo.toString("utf8"));
    // Los mensajes originales, intactos y en su sitio.
    expect(json.messages.slice(0, 2)).toEqual(PETICION.messages);
    // Y todo lo que no son mensajes, igual.
    const { messages: _a, ...restoSalida } = json;
    const { messages: _b, ...restoEntrada } = PETICION;
    expect(restoSalida).toEqual(restoEntrada);
  });

  it("el dial va el ÚLTIMO y no lleva texto", () => {
    const r = aplicarEsfuerzo(cuerpo(PETICION), "medium")!;
    const msgs = JSON.parse(r.cuerpo.toString("utf8")).messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toEqual({ role: "system", content: [], output_config: { effort: "medium" } });
  });

  it("es determinista: dos cuerpos iguales dan salidas byte-iguales", () => {
    const a = aplicarEsfuerzo(cuerpo(PETICION), "low")!.cuerpo;
    const b = aplicarEsfuerzo(cuerpo(PETICION), "low")!.cuerpo;
    expect(a.equals(b)).toBe(true);
  });

  it("los cinco niveles producen su dial", () => {
    for (const n of NIVELES) expect(mensajeDeEsfuerzo(n)).toMatchObject({ output_config: { effort: n } });
  });
});

describe("cuándo NO se toca", () => {
  it("modelo que no admite la palanca", () => {
    expect(aplicarEsfuerzo(cuerpo({ ...PETICION, model: "claude-fable-5" }), "low")).toBeNull();
  });

  it("⛔ el cliente ya gobierna su esfuerzo en la raíz: su decisión gana", () => {
    const con = { ...PETICION, output_config: { effort: "max" } };
    expect(yaGobiernaSuEsfuerzo(con)).toBe(true);
    expect(aplicarEsfuerzo(cuerpo(con), "low")).toBeNull();
  });

  it("⛔ o con un dial propio dentro de messages: tampoco se pisa", () => {
    const con = {
      ...PETICION,
      messages: [...PETICION.messages, { role: "system", content: [], output_config: { effort: "high" } }],
    };
    expect(yaGobiernaSuEsfuerzo(con)).toBe(true);
    expect(aplicarEsfuerzo(cuerpo(con), "low")).toBeNull();
  });

  it("cuerpo comprimido, JSON roto o forma ajena", () => {
    expect(aplicarEsfuerzo(gzipSync(cuerpo(PETICION)), "low", "gzip")).toBeNull();
    expect(aplicarEsfuerzo(Buffer.from("{no", "utf8"), "low")).toBeNull();
    expect(aplicarEsfuerzo(cuerpo({ model: "claude-opus-5" }), "low")).toBeNull();
  });
});

describe("la beta", () => {
  it("se añade sin pisar las que ya viajaban", () => {
    expect(conBetaDeEsfuerzo("oauth-2025-04-20")).toBe(`oauth-2025-04-20,${BETA_ESFUERZO}`);
  });
  it("no se duplica", () => {
    expect(conBetaDeEsfuerzo(BETA_ESFUERZO)).toBe(BETA_ESFUERZO);
  });
  it("sirve para un entorno sin betas", () => {
    expect(conBetaDeEsfuerzo(undefined)).toBe(BETA_ESFUERZO);
  });
});

describe("dicha en voz alta al arrancar", () => {
  it("apagada sin nivel; avisa con nivel inválido, sin clave o con el canal cerrado; armada con todo", () => {
    expect(describirEstadoDeEsfuerzo(undefined, true, true)).toMatchObject({ aviso: false });
    expect(describirEstadoDeEsfuerzo(undefined, true, true).linea).toContain("OFF");
    expect(describirEstadoDeEsfuerzo("bajito", true, true)).toMatchObject({ aviso: true });
    expect(describirEstadoDeEsfuerzo("low", false, true)).toMatchObject({ aviso: true });
    expect(describirEstadoDeEsfuerzo("low", true, false)).toMatchObject({ aviso: true });
    const armada = describirEstadoDeEsfuerzo("low", true, true);
    expect(armada.aviso).toBe(false);
    expect(armada.linea).toContain("ARMED");
    expect(armada.linea).toContain("per_turn_effort");
    // Tiene que decir la propiedad que justifica la palanca.
    expect(armada.linea).toContain("prefix cache");
  });
});

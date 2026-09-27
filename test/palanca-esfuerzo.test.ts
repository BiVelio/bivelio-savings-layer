import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";

import {
  BETA_ESFUERZO,
  NIVELES,
  NIVELES_QUE_REBAJAN,
  admiteEsfuerzoPorTurno,
  aplicarEsfuerzo,
  conBetaDeEsfuerzo,
  defectoDeEsfuerzo,
  describirEstadoDeEsfuerzo,
  mensajeDeEsfuerzo,
  rebajaElDefecto,
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
  it("solo los cuatro que nombra la página oficial (2026-09-27)", () => {
    // platform.claude.com/docs/en/build-with-claude/effort, «Change effort
    // mid-conversation»: Fable 5.1, Mythos 5.1, Opus 5.5 y Opus 5.
    for (const m of ["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-opus-5"]) {
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

describe("⛔ la palanca es un TECHO: solo rebaja el defecto del modelo, nunca lo sube", () => {
  // Hasta el 2026-09-27, BVSALA_GATEWAY_ESFUERZO=max se aplicaba tal cual: más
  // pensamiento, a precio de lista, en nombre de una palanca de ahorro.
  it("el defecto de cada modelo es el de la página oficial: high, y medium en Opus 5.5", () => {
    expect(defectoDeEsfuerzo("claude-fable-5-1")).toBe("high");
    expect(defectoDeEsfuerzo("claude-mythos-5-1")).toBe("high");
    expect(defectoDeEsfuerzo("claude-opus-5")).toBe("high");
    expect(defectoDeEsfuerzo("claude-opus-5-5")).toBe("medium");
    expect(defectoDeEsfuerzo("claude-fable-5")).toBeUndefined();
  });

  it("un nivel igual o superior al defecto deja el cuerpo intacto (null = no tocar)", () => {
    for (const n of ["high", "xhigh", "max"] as const) {
      expect(rebajaElDefecto("claude-fable-5-1", n)).toBe(false);
      expect(aplicarEsfuerzo(cuerpo(PETICION), n), n).toBeNull();
    }
    const opus55 = { ...PETICION, model: "claude-opus-5-5" };
    expect(aplicarEsfuerzo(cuerpo(opus55), "medium")).toBeNull(); // su defecto
    expect(aplicarEsfuerzo(cuerpo(opus55), "high")).toBeNull(); // por encima
    expect(aplicarEsfuerzo(cuerpo(opus55), "low")).not.toBeNull();
  });

  it("los niveles con sentido se derivan de la tabla: low y medium", () => {
    expect(NIVELES_QUE_REBAJAN).toEqual(["low", "medium"]);
  });

  it("al arrancar, un nivel que no rebaja nada se dice NO ARMADA, con aviso", () => {
    for (const n of ["high", "xhigh", "max"]) {
      const e = describirEstadoDeEsfuerzo(n, true, true);
      expect(e.aviso, n).toBe(true);
      expect(e.linea).toContain("NOT ARMED");
      expect(e.linea).toContain("only lowers");
    }
    // medium sí se arma, y dice que en Opus 5.5 no cambia nada.
    const medium = describirEstadoDeEsfuerzo("medium", true, true);
    expect(medium.aviso).toBe(false);
    expect(medium.linea).toContain("opus-5-5 passes through unchanged");
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
  it("⛔ conserva la cabecera del cliente tal cual, espacios incluidos: solo AÑADE la suya al final", () => {
    expect(conBetaDeEsfuerzo("oauth-2025-04-20, advisor-tool-2026-03-01")).toBe(
      `oauth-2025-04-20, advisor-tool-2026-03-01,${BETA_ESFUERZO}`,
    );
    expect(conBetaDeEsfuerzo(`a, ${BETA_ESFUERZO}`)).toBe(`a, ${BETA_ESFUERZO}`);
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

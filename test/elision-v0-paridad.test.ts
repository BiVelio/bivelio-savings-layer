import { describe, expect, it } from "vitest";

import {
  MINIMO_BYTES_CANDIDATO as SDK_MINIMO,
  V0_UMBRAL_EDAD_KB as SDK_UMBRAL,
  seleccionarElisionV0,
} from "../src/pipeline/elision.js";
import {
  MINIMO_BYTES_CANDIDATO as GW_MINIMO,
  V0_UMBRAL_EDAD_KB as GW_UMBRAL,
  aplicarPolitica,
  estadoNuevo,
  type BloqueSombra,
} from "../gateway/sombra.js";
import type { ChatMessage } from "../src/contracts/types.js";

/**
 * VERJA DE PARIDAD. La elisión v0 del SDK (`src/pipeline/elision.ts`) es una
 * REPLICA de la política v0 del carril sombra (`gateway/sombra.ts`,
 * `aplicarPolitica("v0", …)`), no una importación: la frontera de módulos va
 * gateway→src, nunca al revés. Esta verja compara las dos implementaciones sobre
 * los MISMOS bloques con las MISMAS edades, para que no se separen en silencio.
 *
 * El puente entre los dos modelos de edad: en el carril sombra
 * `edad = turno − nacimiento`; en el SDK `edad = nº de mensajes assistant
 * posteriores`. Aquí se construyen los dos lados con las MISMAS edades por
 * construcción y se exige que eliden el mismo conjunto.
 */

const cuerpo = (bytes: number) => "x".repeat(bytes); // ASCII → exactamente `bytes` bytes

/** Transcripción de 4 tool_results (R0..R3, más viejo primero) con edades
 *  4,3,2,1 por construcción: cada tool va precedido de un assistant con
 *  tool_calls y cierra un assistant final. */
function transcripcion(bytes: number): { messages: ChatMessage[]; idPorIndice: Map<number, string> } {
  const messages: ChatMessage[] = [{ role: "user", content: "analiza el repo" }];
  const idPorIndice = new Map<number, string>();
  for (let j = 0; j < 4; j++) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: `c${j}`, name: "read", arguments: "{}" }] });
    idPorIndice.set(messages.length, `R${j}`);
    messages.push({ role: "tool", content: cuerpo(bytes), toolCallId: `c${j}`, name: "read" });
  }
  messages.push({ role: "assistant", content: "resumen final" });
  return { messages, idPorIndice };
}

/** Los mismos 4 bloques para el carril sombra, con nacimientos que dan edades
 *  4,3,2,1 en el turno T=4. */
function ladoSombra(bytes: number): { bloques: BloqueSombra[]; estado: ReturnType<typeof estadoNuevo>; turno: number } {
  const bloques: BloqueSombra[] = [];
  const estado = estadoNuevo();
  const T = 4;
  for (let j = 0; j < 4; j++) {
    const clave = `R${j}`;
    bloques.push({ clave, tipo: "user:tool_result", marca: null, bytes, bytesV1: bytes, clase: "otro", esError: false });
    estado.nacimiento.set(clave, j); // edad = T − j  → 4,3,2,1
  }
  return { bloques, estado, turno: T };
}

function elididosSDK(bytes: number): Set<string> {
  const { messages, idPorIndice } = transcripcion(bytes);
  // keepUltimos=1 reproduce el v0 PURO del carril sombra: solo el último
  // tool_result queda protegido (el suelo de fidelidad ≥8 es del SDK en vivo, no
  // de la política v0 que se compara aquí).
  const eleccion = seleccionarElisionV0(messages, 1);
  return new Set(eleccion.indices.map((i) => idPorIndice.get(i)!));
}

function elididosSombra(bytes: number): Set<string> {
  const { bloques, estado, turno } = ladoSombra(bytes);
  const salida = aplicarPolitica("v0", bloques, estado, turno);
  const eliminados = new Set<string>();
  for (const b of salida) if (b.clave.endsWith(":e")) eliminados.add(b.clave.slice(0, -2));
  return eliminados;
}

describe("paridad v0: SDK == carril sombra", () => {
  it("las constantes del predicado son idénticas en los dos lados", () => {
    expect(SDK_MINIMO).toBe(GW_MINIMO);
    expect(SDK_UMBRAL).toBe(GW_UMBRAL);
  });

  // Barrido de tamaños: cada uno cruza el umbral edad×KB en un punto distinto,
  // así que el conjunto elidido cambia y la paridad se prueba de verdad.
  //   3000B → {R0,R1}   (R2 edad2: 5,86 < 8)
  //   5000B → {R0,R1,R2}(R2 edad2: 9,77 ≥ 8)
  //    900B → {}        (por debajo de 1 KB: nadie es candidato)
  for (const bytes of [900, 1500, 3000, 5000, 20000]) {
    it(`mismo conjunto elidido con tool_results de ${bytes} bytes`, () => {
      const sdk = elididosSDK(bytes);
      const sombra = elididosSombra(bytes);
      expect([...sdk].sort()).toEqual([...sombra].sort());
    });
  }

  it("casos esperados a mano (para que la paridad no sea «ambos rotos igual»)", () => {
    expect(elididosSDK(900)).toEqual(new Set()); // < 1 KB
    expect(elididosSDK(3000)).toEqual(new Set(["R0", "R1"]));
    expect(elididosSDK(5000)).toEqual(new Set(["R0", "R1", "R2"]));
  });
});

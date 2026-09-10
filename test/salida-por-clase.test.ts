/**
 * Verjas de la TAXONOMÍA de clases de tarea (benchmarks/salida/por-clase.ts)
 * sobre respuestas SINTÉTICAS. Fija dos cosas que, si se rompen, invalidan
 * cualquier cifra por clase:
 *   · EXCLUYENTE — ningún turno cae en dos clases (la clasificación devuelve
 *     una, y siempre la misma para la misma entrada).
 *   · EXHAUSTIVA — las clases SUMAN el total: peticiones y dinero de los
 *     estratos reconstruyen el agregado, sin fugas ni dobles cuentas.
 * Sin red y sin corpus: el corpus real jamás entra en un test.
 */
import { describe, expect, it } from "vitest";

import {
  CLASES,
  FAMILIAS,
  clasificar,
  POR_FAMILIA,
  charsDeHeredoc,
  familiaDeHerramienta,
  masaBashDeSse,
  masaVacia,
  techoDeClase,
  type Clase,
} from "../benchmarks/salida/por-clase.js";
import {
  acumuladorVacio,
  agregar,
  anatomiaDeSse,
  resumir,
  type AnatomiaRespuesta,
  type MedidaPeticion,
} from "../benchmarks/salida/anatomia-nucleo.js";

/** Un SSE sintético con la forma sondeada en las capturas del espía. */
function sse(eventos: [string, unknown][]): string {
  return eventos.map(([ev, d]) => `event: ${ev}\ndata: ${JSON.stringify(d)}`).join("\n\n") + "\n\n";
}

/** Respuesta con un bloque de texto y N llamadas a herramienta con su JSON. */
function respuesta(texto: string, llamadas: [string, string][]): AnatomiaRespuesta {
  const ev: [string, unknown][] = [["message_start", { message: { usage: { input_tokens: 10, output_tokens: 1 } } }]];
  let i = 0;
  if (texto) {
    ev.push(["content_block_start", { index: i, content_block: { type: "text", text: "" } }]);
    ev.push(["content_block_delta", { index: i, delta: { type: "text_delta", text: texto } }]);
    ev.push(["content_block_stop", { index: i }]);
    i += 1;
  }
  for (const [nombre, json] of llamadas) {
    ev.push(["content_block_start", { index: i, content_block: { type: "tool_use", id: `t${i}`, name: nombre, input: {} } }]);
    ev.push(["content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: json } }]);
    ev.push(["content_block_stop", { index: i }]);
    i += 1;
  }
  ev.push(["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } }]);
  return anatomiaDeSse(sse(ev));
}

const HERRAMIENTAS = [{ name: "Bash" }, { name: "Write" }, { name: "Read" }];
const CON = { tools: HERRAMIENTAS };
const SIN = { tools: [] };

describe("familias de herramienta", () => {
  it("clasifica lo que el corpus trae de verdad", () => {
    expect(familiaDeHerramienta("Write")).toBe("escritura");
    expect(familiaDeHerramienta("Edit")).toBe("escritura");
    expect(familiaDeHerramienta("Bash")).toBe("shell");
    expect(familiaDeHerramienta("Read")).toBe("lectura");
    expect(familiaDeHerramienta("WebFetch")).toBe("lectura");
    expect(familiaDeHerramienta("Agent")).toBe("orquestacion");
    expect(familiaDeHerramienta("AskUserQuestion")).toBe("orquestacion");
  });

  it("una herramienta desconocida cae en `otras`, jamás dentro de otra familia", () => {
    // Es LA propiedad que impide que una MCP nueva se cuele mañana dentro de
    // «escritura» e infle la clase que más dinero mueve.
    expect(familiaDeHerramienta("mcp__loquesea__hazlo")).toBe("otras");
    expect(familiaDeHerramienta("HerramientaDeMañana")).toBe("otras");
  });

  it("ninguna herramienta está declarada en dos familias", () => {
    // Si un nombre apareciera en dos listas, el índice se quedaría con la
    // última y la clase que más dinero mueve podría inflarse en silencio.
    const vistas = new Set<string>();
    const repetidas: string[] = [];
    for (const f of FAMILIAS) {
      for (const n of POR_FAMILIA[f]) {
        if (vistas.has(n)) repetidas.push(n);
        vistas.add(n);
      }
    }
    expect(repetidas).toEqual([]);
    for (const n of vistas) expect(FAMILIAS).toContain(familiaDeHerramienta(n));
  });
});

describe("la taxonomía está fijada", () => {
  it("una clase por familia, más prosa, interno y el residuo — y ni una más", () => {
    // Fijar el censo es lo que impide que alguien añada una clase y las cifras
    // por clase de un artefacto viejo dejen de sumar el total en silencio.
    expect(CLASES.length).toBe(FAMILIAS.length + 3);
    expect([...CLASES]).toEqual([
      "agente-escritura",
      "agente-shell",
      "agente-estructurado",
      "agente-lectura",
      "agente-orquestacion",
      "agente-otras",
      "agente-prosa",
      "interno-sin-herramientas",
      "sin-cuerpo",
    ]);
    expect(new Set(CLASES).size).toBe(CLASES.length);
  });

  it("cada familia alcanza su clase, y son todas distintas", () => {
    const alcanzadas = FAMILIAS.map((f) => {
      const nombre = POR_FAMILIA[f][0] ?? "mcp__desconocida__x";
      return clasificar(CON, respuesta("", [[nombre, '{"a":"' + "q".repeat(50) + '"}']])).clase;
    });
    expect(new Set(alcanzadas).size).toBe(FAMILIAS.length);
    for (const c of alcanzadas) expect(CLASES).toContain(c);
  });
});

describe("clasificar un turno", () => {
  it("sin cuerpo de respuesta no se inventa una clase", () => {
    expect(clasificar(CON, null).clase).toBe("sin-cuerpo");
  });

  it("sin herramientas declaradas es una llamada interna, mire lo que mire la respuesta", () => {
    // Prioridad deliberada: el llamador manda sobre lo producido.
    expect(clasificar(SIN, respuesta("un título", [])).clase).toBe("interno-sin-herramientas");
    expect(clasificar({ tools: undefined }, respuesta("", [])).clase).toBe("interno-sin-herramientas");
  });

  it("con herramientas y sin ningún tool_use es prosa de agente", () => {
    const c = clasificar(CON, respuesta("La respuesta final para el humano.", []));
    expect(c.clase).toBe("agente-prosa");
    expect(c.familia).toBeNull();
  });

  it("manda la familia que domina los CARACTERES, no el número de llamadas", () => {
    // Tres Read baratos contra un Write gordo: gana escritura. Es justo lo que
    // pasa en el corpus real y el motivo de repartir por masa y no por llamada.
    const a = respuesta("", [
      ["Read", '{"file_path":"/a"}'],
      ["Read", '{"file_path":"/b"}'],
      ["Read", '{"file_path":"/c"}'],
      ["Write", `{"file_path":"/x.ts","content":"${"x".repeat(2000)}"}`],
    ]);
    const c = clasificar(CON, a);
    expect(c.clase).toBe("agente-escritura");
    expect(c.familia).toBe("escritura");
    expect(c.purezaFamilia).toBeGreaterThan(0.9);
    expect(c.purezaFamilia).toBeLessThan(1);
  });

  it("un turno puro de shell tiene pureza 1", () => {
    const c = clasificar(CON, respuesta("Miro los ficheros.", [["Bash", '{"command":"ls -la"}']]));
    expect(c.clase).toBe("agente-shell");
    expect(c.purezaFamilia).toBe(1);
  });

  it("lectura y orquestación salen donde deben", () => {
    expect(clasificar(CON, respuesta("", [["Read", '{"file_path":"/a/b/c.ts"}']])).clase).toBe("agente-lectura");
    expect(clasificar(CON, respuesta("", [["Agent", `{"prompt":"${"y".repeat(500)}"}`]])).clase).toBe("agente-orquestacion");
    expect(clasificar(CON, respuesta("", [["mcp__x__y", '{"a":1}']])).clase).toBe("agente-otras");
  });

  it("es determinista: la misma entrada da siempre la misma clase", () => {
    const a = respuesta("t", [["Bash", '{"command":"x"}'], ["Read", '{"file_path":"/y"}']]);
    const primera = clasificar(CON, a);
    for (let i = 0; i < 5; i++) expect(clasificar(CON, a)).toEqual(primera);
  });

  it("el empate a cero caracteres se rompe por orden fijo, no al azar", () => {
    // Dos herramientas con input vacío: sin masa ni forma de desempatar por
    // llamadas, manda el orden declarado de FAMILIAS.
    const a = respuesta("", [["ExitPlanMode", ""], ["mcp__x__y", ""]]);
    const c = clasificar(CON, a);
    expect(CLASES).toContain(c.clase);
    expect(clasificar(CON, a).clase).toBe(c.clase);
  });
});

describe("la aritmética del reparto", () => {
  /** Una medida sintética: precio unitario limpio para poder sumar a mano. */
  function medida(model: string, tokensSalida: number, thinkingTokens: number, a: AnatomiaRespuesta | null): MedidaPeticion {
    return { model, tokensSalida, thinkingTokens, salidaUsd: tokensSalida / 1000, entradaUsd: 0.5, anatomia: a };
  }

  const turnos: { peticion: { tools: unknown }; m: MedidaPeticion }[] = [
    { peticion: CON, m: medida("m1", 3000, 1000, respuesta("hola", [["Bash", '{"command":"ls"}']])) },
    { peticion: CON, m: medida("m1", 5000, 500, respuesta("", [["Write", `{"content":"${"z".repeat(3000)}"}`]])) },
    { peticion: CON, m: medida("m2", 800, 0, respuesta("", [["Read", '{"file_path":"/a"}']])) },
    { peticion: CON, m: medida("m2", 1200, 300, respuesta("Una respuesta larga para el humano.", [])) },
    { peticion: SIN, m: medida("m2", 40, 0, respuesta("Título", [])) },
    { peticion: CON, m: medida("m1", 44, 0, null) },
  ];

  it("cada turno cae en UNA clase y todas las clases están declaradas", () => {
    const clases = turnos.map((t) => clasificar(t.peticion, t.m.anatomia).clase);
    for (const c of clases) expect(CLASES).toContain(c);
    expect(new Set(clases).size).toBe(6); // seis clases distintas en este banco
  });

  it("las clases SUMAN el total: peticiones, tokens y dinero", () => {
    const todo = acumuladorVacio();
    const porClase = new Map<Clase, ReturnType<typeof acumuladorVacio>>();
    for (const t of turnos) {
      const { clase } = clasificar(t.peticion, t.m.anatomia);
      let acum = porClase.get(clase);
      if (!acum) porClase.set(clase, (acum = acumuladorVacio()));
      agregar(acum, t.m);
      agregar(todo, t.m);
    }
    const g = resumir(todo);
    const partes = [...porClase.values()].map(resumir);
    expect(partes.reduce((s, r) => s + r.peticiones, 0)).toBe(g.peticiones);
    expect(partes.reduce((s, r) => s + r.tokensSalida.total, 0)).toBe(g.tokensSalida.total);
    expect(partes.reduce((s, r) => s + r.dinero.salidaUsd, 0)).toBeCloseTo(g.dinero.salidaUsd, 6);
    expect(partes.reduce((s, r) => s + r.dinero.entradaUsd, 0)).toBeCloseTo(g.dinero.entradaUsd, 6);
  });

  it("dentro de una clase, thinking + tool_use + prosa + otros + sinCuerpo = su salida", () => {
    const acum = acumuladorVacio();
    for (const t of turnos) agregar(acum, t.m);
    const r = resumir(acum);
    const p = r.dinero.porMasa;
    expect(p.thinking + p.text + p.tool_use + p.otros + p.sinCuerpo).toBeCloseTo(r.dinero.salidaUsd, 6);
    const c = r.dinero.porMasaCalibrado;
    expect(c.thinking + c.text + c.tool_use + c.otros + c.sinCuerpo).toBeCloseTo(r.dinero.salidaUsd, 6);
  });

  it("el turno sin cuerpo no reparte: su dinero va entero a `sinCuerpo`", () => {
    const acum = acumuladorVacio();
    agregar(acum, medida("m1", 44, 0, null));
    const r = resumir(acum);
    expect(r.dinero.porMasa.sinCuerpo).toBeCloseTo(0.044, 6);
    expect(r.dinero.porMasa.text + r.dinero.porMasa.tool_use + r.dinero.porMasa.thinking).toBe(0);
  });
});

describe("el techo aritmético", () => {
  const acum = acumuladorVacio();
  acum.peticiones = 0;
  agregar(acum, {
    model: "m1",
    tokensSalida: 10_000,
    thinkingTokens: 4_000,
    salidaUsd: 10,
    entradaUsd: 0,
    anatomia: respuesta("prosa".repeat(60), [["Write", `{"content":"${"w".repeat(1200)}"}`]]),
  });
  const r = resumir(acum);

  it("no promete nada que no esté en la masa medida", () => {
    const t = techoDeClase(r, 10);
    expect(t.salidaUsd).toBeCloseTo(10, 4);
    expect(t.usdPorDia).toBeCloseTo(1, 4);
    expect(t.siRecortaTodo["30%"]).toBeCloseTo(3, 4);
    // El thinking es exacto (tokens del usage), no un proxy de caracteres.
    expect(t.masaUsd.thinking).toBeCloseTo(4, 4);
    expect(t.siRecortaThinking["50%"]).toBeCloseTo(2, 4);
    expect(t.siRecortaProsa["30%"]).toBeCloseTo(t.masaUsd.prosa * 0.3, 4);
  });

  it("las tres masas no pueden pasarse de la salida de la clase", () => {
    const t = techoDeClase(r, 1);
    expect(t.masaUsd.thinking + t.masaUsd.prosa + t.masaUsd.toolUse).toBeLessThanOrEqual(t.salidaUsd + 1e-6);
  });

  it("con cero días no divide por cero", () => {
    expect(techoDeClase(r, 0).usdPorDia).toBeCloseTo(10, 4);
  });
});

describe("el JSON de Bash: orden o carga", () => {
  // De esto depende el veredicto de la clase que más dinero mueve: si el JSON
  // de Bash es sintaxis, se puede acortar; si es un fichero viajando dentro de
  // un heredoc, acortarlo es escribir peor.
  it("mide el cuerpo del heredoc y solo el cuerpo", () => {
    const c = "cat > /x/a.ts <<'EOF'\nlinea uno\nlinea dos\nEOF\necho ok";
    expect(charsDeHeredoc(c)).toBe("linea uno\nlinea dos".length);
  });

  it("un comando sin heredoc no aporta carga", () => {
    expect(charsDeHeredoc("ls -la && grep -n foo bar")).toBe(0);
    expect(charsDeHeredoc("git log --oneline | head -20")).toBe(0);
  });

  it("cuenta varios heredocs en el mismo comando, con y sin comillas", () => {
    expect(charsDeHeredoc("cat <<EOF > a\nAAA\nEOF\ncat <<'FIN' > b\nBBBB\nFIN")).toBe(7);
  });

  it("entiende `<<-` con marca sangrada y una marca que no es EOF", () => {
    expect(charsDeHeredoc("cat <<-EOF\n\tsangrado\n\tEOF")).toBe("\tsangrado".length);
    expect(charsDeHeredoc("python3 - <<PY\nprint(1)\nPY")).toBe("print(1)".length);
  });

  it("nunca cuenta más caracteres de los que tiene el comando", () => {
    // Un heredoc sin cierre (respuesta truncada) llega hasta el final, y ahí
    // acaba: la masa medida no puede pasarse de la masa real.
    const truncado = "cat <<EOF\nsin cierre porque la respuesta se cortó";
    expect(charsDeHeredoc(truncado)).toBeLessThanOrEqual(truncado.length);
    expect(charsDeHeredoc(truncado)).toBeGreaterThan(0);
  });

  it("recorre el SSE y solo mira las llamadas a Bash", () => {
    const comando = "cat > a <<'EOF'\ncontenido\nEOF";
    const json = JSON.stringify({ command: comando });
    const ev: [string, unknown][] = [
      ["content_block_start", { index: 0, content_block: { type: "tool_use", name: "Bash" } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, 10) } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: json.slice(10) } }],
      ["content_block_stop", { index: 0 }],
      // Un Write en la misma respuesta NO entra en la masa de Bash.
      ["content_block_start", { index: 1, content_block: { type: "tool_use", name: "Write" } }],
      ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"content":"xxxx"}' } }],
    ];
    const acum = masaVacia();
    masaBashDeSse(sse(ev), acum);
    expect(acum.comandos).toBe(1);
    expect(acum.chars).toBe(comando.length);
    expect(acum.charsHeredoc).toBe("contenido".length);
    expect(acum.conHeredoc).toBe(1);
    expect(acum.ilegibles).toBe(0);
  });

  it("un JSON truncado se cuenta como ilegible, no se inventa un comando", () => {
    const acum = masaVacia();
    masaBashDeSse(
      sse([
        ["content_block_start", { index: 0, content_block: { type: "tool_use", name: "Bash" } }],
        ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls -' } }],
      ]),
      acum,
    );
    expect(acum.comandos).toBe(1);
    expect(acum.ilegibles).toBe(1);
    expect(acum.chars).toBe(0);
  });

  it("acumula entre respuestas", () => {
    const uno = sse([
      ["content_block_start", { index: 0, content_block: { type: "tool_use", name: "Bash" } }],
      ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }],
    ]);
    const acum = masaVacia();
    masaBashDeSse(uno, acum);
    masaBashDeSse(uno, acum);
    expect(acum.comandos).toBe(2);
    expect(acum.chars).toBe(4);
    expect(acum.charsHeredoc).toBe(0);
  });
});

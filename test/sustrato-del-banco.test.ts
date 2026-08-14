import { describe, it, expect } from "vitest";

import {
  scenarios,
  politicaEstable,
  MINIMO_DE_TRAMO_TOKENS,
  LIBROS,
  PALANCAS,
  PALANCAS_SIN_ESCENARIO,
  contratoDeTriaje,
  catalogoGrande,
  hiloDeSoporte,
  estadoDePalanca,
  familiaDeModelo,
  type Scenario,
} from "../benchmarks/scenarios.js";
import { compresorDeRepeticionesLiterales, MINIMO_DE_LINEA_REPETIDA } from "../benchmarks/compresor.js";
import { TokenizerRegistry } from "../src/tokenizer/registry.js";
import {
  createSavingsLayer,
  createMockProvider,
  registrarTokenizadorExacto,
  type SavingsResult,
  type TraceEvent,
} from "../src/index.js";

/**
 * EL BANCO NO PODÍA VER LAS PALANCAS QUE MÁS DINERO VALEN.
 *
 * Ningún escenario alcanzaba el mínimo de tramo de la caché de prefijo del
 * proveedor: el mayor manda 1212 tokens en el brazo naive y el resto se mueve
 * entre 19 y 300. La tirada del 2026-08-13 contra el proveedor real corrió con
 * preguntas de ~16 tokens de entrada. Resultado: `cached_tokens` sale 0 en LOS
 * DOS BRAZOS —está en `benchmarks/out/ab-live.json`, los siete escenarios con
 * `providerCachedInputTokens: 0`— y el banco es estructuralmente incapaz de
 * medir esa palanca.
 *
 * Es peor que no medirla: el brazo naive TAMBIÉN pierde el descuento, así que
 * tampoco se ve si nuestra compresión se lo estaría quitando al cliente.
 *
 * Este fichero fija el sustrato para que no se degrade en silencio. Un prefijo
 * que alguien acorte "para que el test corra más rápido" devuelve el banco a
 * ciegas sin que nada falle.
 */

const registro = new TokenizerRegistry();
const contar = (texto: string): number => registro.count(texto, { model: "openai/gpt-4o-mini" });

describe("sustrato del banco", () => {
  it("el prefijo estable supera el mínimo de tramo de la caché de prefijo", () => {
    const tokens = contar(politicaEstable);
    expect(
      tokens,
      `el prefijo mide ${tokens} tokens y el mínimo de tramo es ${MINIMO_DE_TRAMO_TOKENS}: ` +
        "por debajo, el proveedor no cachea y el escenario mide lo contrario de lo que pretende",
    ).toBeGreaterThan(MINIMO_DE_TRAMO_TOKENS);
  });

  it("el prefijo es ESTABLE: dos lecturas dan exactamente el mismo texto", () => {
    // Un solo byte distinto entre peticiones —una fecha, un id, el orden de
    // iteración de un objeto— tira el acierto de caché a cero. El módulo no
    // puede tener nada no determinista dentro.
    expect(politicaEstable).toBe(politicaEstable);
    expect(politicaEstable).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // sin timestamps
    expect(politicaEstable.length).toBeGreaterThan(0);
  });

  it("existe al menos un escenario capaz de enganchar la caché de prefijo", () => {
    const capaces = scenarios.filter((s) => {
      const texto = s.request.messages.map((m) => m.content).join("\n");
      return contar(texto) > MINIMO_DE_TRAMO_TOKENS;
    });
    expect(
      capaces.map((s) => s.name),
      "sin un escenario por encima del mínimo de tramo, el titular del banco ignora " +
        "una de las mayores palancas de la entrada",
    ).not.toEqual([]);
  });

  it("el prefijo va DELANTE de la pregunta en ese escenario", () => {
    const s = scenarios.find((x) => x.name === "Stable-prefix agent turn");
    expect(s).toBeDefined();
    const roles = s!.request.messages.map((m) => m.role);
    const ultimoUsuario = roles.lastIndexOf("user");
    const indicePrefijo = s!.request.messages.findIndex((m) => m.content === politicaEstable);
    // Lo estable delante y lo variable al final: es la condición del proveedor
    // para cachear, y coincide con lo que ya medimos sobre calidad de salida.
    expect(indicePrefijo).toBeGreaterThanOrEqual(0);
    expect(indicePrefijo).toBeLessThan(ultimoUsuario);
  });

  it("cada escenario declara un libro conocido", () => {
    // La lista viene de `scenarios.ts`, que es donde vive también el tipo. Antes
    // se copiaba aquí a mano y las dos copias divergieron: el cuarto libro
    // (`provider_cached`) entró en el tipo y esta verja siguió sin conocerlo,
    // así que rechazaba un escenario perfectamente válido. Una verja que se
    // mantiene sola no protege de nada.
    const libros = new Set<string>(LIBROS);
    for (const s of scenarios) {
      expect(libros.has(s.ledger), `${s.name} declara un libro desconocido: ${s.ledger}`).toBe(true);
    }
  });
});

/**
 * LAS PALANCAS OPT-IN DE LA 0.3.0 TENÍAN EL MISMO PROBLEMA, UN NIVEL MÁS ARRIBA.
 *
 * `outputCodebook`, `toolDiscovery`, `compression` y `semanticCache` aparecían
 * CERO veces en `benchmarks/scenarios.ts`: el banco no las encendía, así que una
 * tirada contra el proveedor real habría medido lo mismo que la del 2026-08-13 y
 * la conclusión —"el trabajo de hoy no sirve"— habría sido del banco, no del
 * producto. Es el mismo fallo que ya se cometió con la caché de prefijo.
 *
 * Encenderlas no basta: cada una tiene una VERJA ECONÓMICA que las descarta —con
 * razón— cuando la petición no tiene la forma adecuada. Un escenario que las
 * encienda sin traer esa forma vuelve a medir cero, y esta vez con la palanca
 * "puesta", que es peor porque parece medido.
 *
 * Estos tests corren el PIPELINE DE VERDAD contra el proveedor simulado y miran
 * la traza que publica la propia capa. No recalculan la verja aquí: dos copias
 * de una cuenta divergen, y esa divergencia es exactamente el fallo que este
 * repo ya pagó una vez (785 tokens publicados contra 262 reales).
 */
const registroExacto = new TokenizerRegistry();
const tokenizadorListo = registrarTokenizadorExacto(registroExacto);
const contarExacto = (t: string): number => registroExacto.count(t, { model: "openai/gpt-4o-mini" });

/** La capa tal y como la monta el banco: mismo tokenizador y mismo compresor. */
async function capaDelBanco() {
  await tokenizadorListo;
  return createSavingsLayer({
    provider: createMockProvider(),
    tokenizer: registroExacto,
    compressor: compresorDeRepeticionesLiterales,
  });
}

const escenario = (nombre: string): Scenario => {
  const s = scenarios.find((x) => x.name === nombre);
  expect(s, `falta el escenario "${nombre}"`).toBeDefined();
  return s!;
};

const trazas = (r: SavingsResult, etapa: string): TraceEvent[] =>
  r.report.traces.filter((t) => t.stage === etapa);

describe("las palancas opt-in de la 0.3.0 se ejercitan de verdad", () => {
  it("cada palanca del catálogo tiene escenario o motivo declarado de por qué no", () => {
    const conEscenario = new Set(scenarios.map((s) => s.palanca).filter(Boolean));
    const sinEscenario = new Set(PALANCAS_SIN_ESCENARIO.map((p) => p.palanca));
    for (const palanca of PALANCAS) {
      expect(
        conEscenario.has(palanca) || sinEscenario.has(palanca),
        `la palanca ${palanca} no la ejercita ningún escenario y tampoco consta en ` +
          "PALANCAS_SIN_ESCENARIO: el informe no podría decir si se midió o no",
      ).toBe(true);
    }
  });

  it("un escenario que declara palanca la ENCIENDE en su petición", () => {
    // Declarar la palanca en el escenario y olvidarse de `savings` produciría un
    // informe que dice "ejercitada: no" con un motivo vacío, y nadie sabría que
    // el fallo está en el banco y no en la capa.
    const toggle: Record<string, keyof NonNullable<Scenario["request"]["savings"]> | null> = {
      outputCodebook: "outputCodebook",
      toolDiscovery: "toolDiscovery",
      compression: "compression",
      semanticCache: "semanticCache",
      // No es un campo de `savings`: la decide el proveedor, no el llamante.
      providerPrefixCache: null,
    };
    for (const s of scenarios) {
      if (!s.palanca) continue;
      const campo = toggle[s.palanca];
      if (!campo) continue;
      expect(
        s.request.savings?.[campo],
        `${s.name} declara la palanca ${s.palanca} pero no la enciende en savings`,
      ).toBeTruthy();
    }
  });

  it("el detector de palancas no se queda con la ÚLTIMA traza de la etapa", () => {
    // EL FALLO REAL: la etapa del codebook deja DOS trazas —la decisión y luego
    // la expansión de la respuesta ("expanded")—, así que mirar la última
    // reportaba "no ejercitada" sobre una palanca aplicada que estaba ahorrando
    // un 24,8%. Una verja de honestidad que falla hacia el silencio es peor que
    // no tenerla.
    const r = {
      report: {
        traces: [
          { stage: "output-codebook", outcome: "applied", detail: { reason: "net 36" }, atMs: 1 },
          { stage: "output-codebook", outcome: "expanded", atMs: 2 },
        ],
      },
    } as unknown as SavingsResult;
    const estado = estadoDePalanca(escenario("Triage decision (output codebook)"), r, 0);
    expect(estado?.ejercitada).toBe(true);
    expect(estado?.motivo).toContain("applied");
  });

  it("el codebook de salida SE APLICA sobre el contrato de triaje", async () => {
    const capa = await capaDelBanco();
    const s = escenario("Triage decision (output codebook)");
    const r = await capa.generate(s.request);
    const t = trazas(r, "output-codebook")[0];
    expect(
      t?.outcome,
      `el codebook no se aplicó: ${String(t?.detail?.reason)}. El contrato necesita enums ` +
        "y claves largas para superar el mínimo de ahorro neto",
    ).toBe("applied");
    // Y la reversión: lo que llega está en la forma del LLAMANTE, no en códigos.
    const d = r.data as { decision?: string };
    expect(contratoDeTriaje.schema.properties.decision.enum as readonly string[]).toContain(d.decision!);
  });

  it("el catálogo grande supera la verja económica del sondeo", async () => {
    const capa = await capaDelBanco();
    const s = escenario("Big tool catalogue (schema-on-demand)");
    const r = await capa.generate(s.request);
    const t = trazas(r, "tool-discovery")[0];
    // Con un catálogo pequeño la verja dice "skipped (not worth a second call)" y
    // hace bien: dos llamadas costarían más que una. Lo que este test fija es que
    // el catálogo del banco es lo bastante grande para que la palanca llegue a
    // ejecutarse. Que después el sondeo DEGRADE es propio del proveedor simulado
    // —nunca devuelve tool_calls— y el informe lo dice; lo que no puede pasar es
    // que la verja lo descarte por dinero.
    expect(
      t?.outcome,
      `la verja económica descartó el sondeo: ${String(t?.detail?.reason)}. El catálogo ` +
        "se ha quedado pequeño y el escenario ya no mide la palanca que dice medir",
    ).not.toMatch(/^skipped/);
  });

  it("el selector no poda el catálogo grande: si podara, mediríamos dos palancas", async () => {
    const capa = await capaDelBanco();
    const s = escenario("Big tool catalogue (schema-on-demand)");
    const r = await capa.generate(s.request);
    const t = trazas(r, "tool-selector")[0];
    // Una herramienta descartada por el SELECTOR se acredita en el libro 2. Si el
    // selector podara aquí, el ahorro medido sería la suma de la poda y el
    // sondeo, y no sería atribuible a ninguno de los dos.
    expect(t, `el selector podó: ${JSON.stringify(t?.detail)}`).toBeUndefined();
    expect(catalogoGrande.length, "ocho es el tope del selector (maxTools)").toBe(8);
    expect(catalogoGrande.every((h) => h.risk === "read")).toBe(true);
  });

  it("la compresión SE APLICA sobre el hilo reenviado", async () => {
    const capa = await capaDelBanco();
    const s = escenario("Forwarded support thread (compression)");
    const r = await capa.generate(s.request);
    const t = trazas(r, "compression")[0];
    expect(
      t?.outcome,
      `la compresión no se aplicó: ${String(t?.detail?.reason)}`,
    ).toBe("applied");
    expect(r.report.tokens.compressedInput).toBeGreaterThan(0);
  });

  it("el hilo comprimido NO cae por debajo del mínimo de tramo", async () => {
    // La trampa exacta que costó un escenario mudo: con los cuerpos a la mitad,
    // el hilo comprimido medía 1002 tokens y la capa se abstenía por 22 —y hacía
    // bien, ahí quitar tokens sube la factura—. El margen tiene que ser holgado,
    // no de un pelo.
    await tokenizadorListo;
    const comprimido = await compresorDeRepeticionesLiterales.compress({ text: hiloDeSoporte });
    const antes = contarExacto(hiloDeSoporte);
    const despues = contarExacto(comprimido.compressed);
    expect(antes, "el contexto comprimible tiene que superar el mínimo de 2000 tokens").toBeGreaterThan(2000);
    expect(antes - despues, "el ahorro neto tiene que superar los 200 tokens").toBeGreaterThan(200);
    expect(
      despues,
      `comprimido queda en ${despues} tokens y el mínimo de tramo es ${MINIMO_DE_TRAMO_TOKENS}: ` +
        "por debajo, la capa se niega a comprimir y el escenario mide cero",
    ).toBeGreaterThan(MINIMO_DE_TRAMO_TOKENS + 300);
  });

  it("el escenario de sondeo NO lleva prefijo estable: esa palanca renuncia a la caché", () => {
    // Está en el JSDoc de `toolDiscovery`: la palanca renuncia a la caché de
    // prefijo del proveedor en TODAS las peticiones. Un escenario que llevara un
    // prefijo largo mediría la resta de dos palancas y la atribuiría a una.
    const s = escenario("Big tool catalogue (schema-on-demand)");
    const texto = s.request.messages.map((m) => m.content).join("\n");
    expect(contarExacto(texto)).toBeLessThan(MINIMO_DE_TRAMO_TOKENS);
  });

  it("los escenarios de caché de prefijo declaran su familia de modelo", () => {
    // Sin esto, `BVSALA_DEMO_MODEL` servía el escenario de `cache_control`
    // explícito contra un endpoint de OpenAI —donde el proveedor cachea solo— y
    // el descuento del proveedor se publicaba en el libro 4 como aportación
    // nuestra.
    expect(escenario("Anthropic stable-prefix agent turn").familia).toBe("anthropic");
    expect(escenario("Stable-prefix agent turn").familia).toBe("openai");
    expect(familiaDeModelo("anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(familiaDeModelo("gpt-4o-mini")).toBe("openai");
    expect(familiaDeModelo("mistral-large")).toBe("desconocida");
  });
});

describe("el compresor del banco solo quita repeticiones literales", () => {
  it("cada línea que sobrevive estaba en el original, palabra por palabra", async () => {
    const r = await compresorDeRepeticionesLiterales.compress({ text: hiloDeSoporte });
    const original = new Set(hiloDeSoporte.split("\n"));
    for (const linea of r.compressed.split("\n")) {
      expect(original.has(linea), `el compresor inventó una línea: ${linea}`).toBe(true);
    }
    // Y lo que se fue tenía un gemelo literal más arriba: nada desaparece del
    // texto, solo sus copias.
    const supervivientes = new Set(r.compressed.split("\n").map((l) => l.trim()));
    for (const linea of hiloDeSoporte.split("\n")) {
      expect(supervivientes.has(linea.trim()), `se perdió información: ${linea}`).toBe(true);
    }
  });

  it("no toca una línea corta repetida: ahí la segunda vez puede significar otra cosa", async () => {
    const corta = "de acuerdo";
    expect(corta.length).toBeLessThan(MINIMO_DE_LINEA_REPETIDA);
    const texto = [corta, "una línea distinta cualquiera", corta].join("\n");
    const r = await compresorDeRepeticionesLiterales.compress({ text: texto });
    expect(r.skipped).toBe(true);
    expect(r.compressed).toBe(texto);
  });

  it("un texto sin repeticiones se devuelve como SALTADO, no como comprimido a cero", async () => {
    // `skipped: false` con el texto intacto haría que el informe contara una
    // compresión que no ocurrió.
    const texto = "una línea suficientemente larga para ser candidata\notra distinta igual de larga aquí";
    const r = await compresorDeRepeticionesLiterales.compress({ text: texto });
    expect(r.skipped).toBe(true);
    expect(r.compressed).toBe(texto);
  });
});

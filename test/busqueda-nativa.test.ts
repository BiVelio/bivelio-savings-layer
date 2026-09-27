import { describe, it, expect } from "vitest";

import {
  BUSQUEDA_ANTHROPIC,
  HERRAMIENTA_DE_BUSQUEDA as HERRAMIENTA_DEL_BANCO,
  UMBRAL_BUSQUEDA,
} from "../benchmarks/nativo.js";
import {
  HERRAMIENTA_DE_BUSQUEDA,
  LONGITUD_MAXIMA_DE_LA_CONSULTA,
  MAXIMO_DE_DIFERIDAS,
  MODELOS_CON_BUSQUEDA_NATIVA,
  RESULTADOS_POR_BUSQUEDA,
  UMBRAL_DOCUMENTADO,
  admiteBusquedaNativa,
  candidatasPorRiesgo,
  decidirBusquedaNativa,
  normalizarBusqueda,
  type EntradaDeBusquedaNativa,
} from "../src/router/busqueda-nativa.js";
import type { ToolDescriptor } from "../src/contracts/types.js";

/**
 * LA DECISIÓN «BÚSQUEDA NATIVA O SELECTOR», rama por rama.
 *
 * La regla que se prueba: la búsqueda del proveedor se usa solo donde se puede
 * mandar sin romper nada (adaptador propio, modelo de la tabla oficial, sin
 * contrato ni cascada) y, en `auto`, solo donde además sale a cuenta en el caso
 * MÁS ADVERSO: caché del catálogo siempre caliente y una búsqueda por petición
 * que carga las cinco definiciones más caras con la consulta más larga.
 */

// Sonnet 4.6: 3 $/M de entrada, 15 $/M de salida, lectura de caché al 0,1×.
const SONNET = { inputPer1k: 0.003, outputPer1k: 0.015, cachedInputPer1k: 0.0003 };

function catalogo(n: number, tokens: number): { id: string; tokens: number }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `herramienta_${i}`, tokens }));
}

function entrada(over: Partial<EntradaDeBusquedaNativa> = {}): EntradaDeBusquedaNativa {
  return {
    opciones: { modo: "auto", siempreCargadas: [], variante: "bm25" },
    capacidad: "oficial",
    modelo: "anthropic/claude-sonnet-4-6",
    herramientas: catalogo(150, 300),
    hayContrato: false,
    cascadaActiva: false,
    precio: SONNET,
    lecturaDeCache: 0.1,
    ...over,
  };
}

describe("la tabla de modelos y el umbral son los de la documentación, y los mismos que el banco", () => {
  it("la lista de modelos es EXACTAMENTE la del brazo B2 del banco", () => {
    // Dos copias de la misma tabla oficial: si una se actualiza y la otra no, el
    // banco mediría un producto distinto del que se vende.
    expect([...MODELOS_CON_BUSQUEDA_NATIVA].sort()).toEqual([...BUSQUEDA_ANTHROPIC].sort());
  });

  it("el umbral documentado y la herramienta BM25 coinciden con los del banco", () => {
    expect(UMBRAL_DOCUMENTADO).toEqual(UMBRAL_BUSQUEDA);
    expect(HERRAMIENTA_DE_BUSQUEDA.bm25).toEqual(HERRAMIENTA_DEL_BANCO);
  });

  it("las cotas son las de la página oficial", () => {
    expect(RESULTADOS_POR_BUSQUEDA).toBe(5);
    expect(LONGITUD_MAXIMA_DE_LA_CONSULTA).toEqual({ regex: 200, bm25: 500 });
    expect(MAXIMO_DE_DIFERIDAS).toBe(10_000);
    expect(HERRAMIENTA_DE_BUSQUEDA.regex).toEqual({
      type: "tool_search_tool_regex_20251119",
      name: "tool_search_tool_regex",
    });
  });
});

describe("admiteBusquedaNativa", () => {
  it("reconoce los modelos de la tabla, con prefijo de proveedor y con o sin fecha de instantánea", () => {
    for (const m of [
      "anthropic/claude-opus-5-5",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "anthropic/claude-sonnet-4-5-20250929",
      "claude-opus-4-5",
      "CLAUDE-FABLE-5-1",
    ]) {
      expect(admiteBusquedaNativa(m), m).toBe(true);
    }
  });

  it("NO reconoce lo que la tabla no lista: Sonnet 5, Opus 4.1, otros proveedores", () => {
    for (const m of ["claude-sonnet-5", "anthropic/claude-opus-4-1", "claude-3-5-haiku", "openai/gpt-6-astra", "gemini-3.8-flash"]) {
      expect(admiteBusquedaNativa(m), m).toBe(false);
    }
  });

  it("un prefijo de familia no hereda: `claude-opus-5-5-algo` no es `claude-opus-5-5`", () => {
    expect(admiteBusquedaNativa("claude-opus-5-5-algo")).toBe(false);
  });
});

describe("normalizarBusqueda", () => {
  it("la forma corta y la larga dicen lo mismo; por defecto BM25 y nada fijo", () => {
    expect(normalizarBusqueda(undefined)).toEqual({ modo: "off", siempreCargadas: [], variante: "bm25" });
    expect(normalizarBusqueda("auto")).toEqual({ modo: "auto", siempreCargadas: [], variante: "bm25" });
    expect(normalizarBusqueda({ mode: "always", alwaysLoaded: ["a", "a", "b"], variant: "regex" })).toEqual({
      modo: "always",
      siempreCargadas: ["a", "b"],
      variante: "regex",
    });
  });

  it("un valor que no se entiende APAGA la palanca: no se cambia el cuerpo por una errata", () => {
    expect(normalizarBusqueda("on" as never).modo).toBe("off");
    expect(normalizarBusqueda({ mode: "yes" } as never).modo).toBe("off");
    expect(normalizarBusqueda(null as never).modo).toBe("off");
  });
});

describe("decidirBusquedaNativa — los requisitos duros", () => {
  it("apagada no hace nada", () => {
    const d = decidirBusquedaNativa(entrada({ opciones: { modo: "off", siempreCargadas: [], variante: "bm25" } }));
    expect(d.aplicar).toBe(false);
  });

  it("sin herramientas no hay nada que buscar", () => {
    expect(decidirBusquedaNativa(entrada({ herramientas: [] })).aplicar).toBe(false);
  });

  it("un proveedor de terceros (sin capacidad declarada) nunca la recibe, y la razón nombra la de OpenAI", () => {
    const d = decidirBusquedaNativa(entrada({ capacidad: undefined }));
    expect(d.aplicar).toBe(false);
    expect(d.razon).toContain("Chat Completions");
  });

  it("un modelo fuera de la tabla no la recibe, ni siquiera en `always` (sería un 400)", () => {
    for (const modo of ["auto", "always"] as const) {
      const d = decidirBusquedaNativa(
        entrada({ opciones: { modo, siempreCargadas: [], variante: "bm25" }, modelo: "anthropic/claude-sonnet-5" }),
      );
      expect(d.aplicar, modo).toBe(false);
      expect(d.razon).toContain("claude-sonnet-5");
    }
  });

  it("con contrato de salida o con la cascada encendida, se queda el selector", () => {
    expect(decidirBusquedaNativa(entrada({ hayContrato: true })).aplicar).toBe(false);
    expect(decidirBusquedaNativa(entrada({ cascadaActiva: true })).aplicar).toBe(false);
  });

  it("una herramienta del llamante con el nombre de la de búsqueda la impide (dos homónimas son un 400)", () => {
    const d = decidirBusquedaNativa(entrada({ herramientas: [...catalogo(150, 300), { id: "tool_search_tool_bm25", tokens: 10 }] }));
    expect(d.aplicar).toBe(false);
    // Con la variante regex el nombre no choca.
    const r = decidirBusquedaNativa(
      entrada({
        opciones: { modo: "auto", siempreCargadas: [], variante: "regex" },
        herramientas: [...catalogo(150, 300), { id: "tool_search_tool_bm25", tokens: 10 }],
      }),
    );
    expect(r.aplicar).toBe(true);
  });

  it("si todo está en `alwaysLoaded` no hay nada que diferir", () => {
    const d = decidirBusquedaNativa(
      entrada({
        opciones: { modo: "always", siempreCargadas: ["a", "b"], variante: "bm25" },
        herramientas: [
          { id: "a", tokens: 10 },
          { id: "b", tokens: 10 },
        ],
      }),
    );
    expect(d.aplicar).toBe(false);
  });

  it("más diferidas que las que admite la API: se queda el selector", () => {
    const d = decidirBusquedaNativa(entrada({ opciones: { modo: "always", siempreCargadas: [], variante: "bm25" }, herramientas: catalogo(10_001, 50) }));
    expect(d.aplicar).toBe(false);
    expect(d.razon).toContain("10000");
  });

  it("`alwaysLoaded` ignora ids que no viajan y nunca fija el contrato", () => {
    const d = decidirBusquedaNativa(
      entrada({
        opciones: { modo: "always", siempreCargadas: ["herramienta_1", "no_existe", "bvsala_contract"], variante: "bm25" },
        herramientas: [...catalogo(20, 300), { id: "bvsala_contract", tokens: 50 }],
      }),
    );
    expect(d.aplicar).toBe(true);
    expect(d.siempreCargadas).toEqual(["herramienta_1"]);
    expect(d.diferidas).toBe(20);
  });
});

describe("decidirBusquedaNativa — `always` y `auto`", () => {
  it("`always` se aplica contra un proxy y con un catálogo pequeño: lo decidió el llamante", () => {
    const d = decidirBusquedaNativa(
      entrada({ opciones: { modo: "always", siempreCargadas: [], variante: "bm25" }, capacidad: "compatible", herramientas: catalogo(3, 100) }),
    );
    expect(d.aplicar).toBe(true);
    expect(d.ahorroDelPrefijo).toBeUndefined();
  });

  it("`auto` NO se aplica contra un host que no es el del proveedor (un proxy puede no reenviar los bloques)", () => {
    const d = decidirBusquedaNativa(entrada({ capacidad: "compatible" }));
    expect(d.aplicar).toBe(false);
    expect(d.razon).toContain('"always"');
  });

  it("`auto` respeta el umbral documentado: 9 herramientas pequeñas no llegan", () => {
    const d = decidirBusquedaNativa(entrada({ herramientas: catalogo(9, 300) }));
    expect(d.aplicar).toBe(false);
    expect(d.razon).toContain("documented");
  });

  it("`auto` con un catálogo mediano que NO paga una búsqueda por petición: se queda el selector", () => {
    // 20 × 300 = 6.000 tokens diferidos. Ahorro: 0,1 × 3 $/M × 6.000 = 0,0018 $.
    // Una búsqueda: 5 × 300 × 3 $/M + 500 × 15 $/M = 0,0045 + 0,0075 = 0,012 $.
    const d = decidirBusquedaNativa(entrada({ herramientas: catalogo(20, 300) }));
    expect(d.aplicar).toBe(false);
    expect(d.ahorroDelPrefijo).toBeCloseTo(0.0018, 10);
    expect(d.costeDeUnaBusqueda).toBeCloseTo(0.012, 10);
  });

  it("`auto` con un catálogo grande que SÍ la paga incluso en el peor caso", () => {
    // 150 × 300 = 45.000 tokens. Ahorro 0,0135 $ ≥ 0,012 $ de la búsqueda peor.
    const d = decidirBusquedaNativa(entrada());
    expect(d.aplicar).toBe(true);
    expect(d.diferidas).toBe(150);
    expect(d.tokensDiferidos).toBe(45_000);
    expect(d.ahorroDelPrefijo!).toBeGreaterThanOrEqual(d.costeDeUnaBusqueda!);
    expect(d.razon).toContain("credits nothing");
  });

  it("el peor caso usa las CINCO definiciones más grandes, no la media", () => {
    // 140 pequeñas y 5 enormes: la media engañaría; el peor caso carga las enormes.
    const herramientas = [...catalogo(140, 200), ...Array.from({ length: 5 }, (_, i) => ({ id: `grande_${i}`, tokens: 4_000 }))];
    const d = decidirBusquedaNativa(entrada({ herramientas }));
    const esperado = (5 * 4_000 * 0.003) / 1000 + (500 * 0.015) / 1000;
    expect(d.costeDeUnaBusqueda).toBeCloseTo(esperado, 12);
  });

  it("una lectura de caché más barata (Opus 5.5 a 0,05×) exige un catálogo más grande", () => {
    const opus = { inputPer1k: 0.004, outputPer1k: 0.02, cachedInputPer1k: 0.0002 };
    const conGenerico = decidirBusquedaNativa(entrada({ precio: opus, lecturaDeCache: 0.1 }));
    const conSuyo = decidirBusquedaNativa(entrada({ precio: opus, lecturaDeCache: 0.05 }));
    expect(conSuyo.ahorroDelPrefijo!).toBeCloseTo(conGenerico.ahorroDelPrefijo! / 2, 12);
  });

  it("la regex tiene una consulta más corta y por eso una búsqueda peor más barata", () => {
    const bm25 = decidirBusquedaNativa(entrada());
    const regex = decidirBusquedaNativa(entrada({ opciones: { modo: "auto", siempreCargadas: [], variante: "regex" } }));
    expect(regex.costeDeUnaBusqueda!).toBeLessThan(bm25.costeDeUnaBusqueda!);
  });

  it("las fijas NO cuentan como ahorro del prefijo: siguen dentro", () => {
    const sin = decidirBusquedaNativa(entrada());
    const con = decidirBusquedaNativa(
      entrada({ opciones: { modo: "auto", siempreCargadas: ["herramienta_0", "herramienta_1"], variante: "bm25" } }),
    );
    expect(con.tokensDiferidos).toBe(sin.tokensDiferidos - 600);
  });
});

describe("candidatasPorRiesgo — la misma verja de riesgo que el selector", () => {
  const leer = { id: "leer", intents: ["leer fichero"], risk: "read" } as ToolDescriptor;
  const borrar = { id: "borrar", intents: ["borrar fichero"], risk: "destructive" } as ToolDescriptor;
  const sinRiesgo = { id: "suelta", intents: ["algo"] } as unknown as ToolDescriptor;
  const mcp = (id: string) => ({ id, description: "x" }) as unknown as ToolDescriptor;

  it("con un catálogo tipado y una petición que no es acción, las de escritura no viajan", () => {
    expect(candidatasPorRiesgo([leer, borrar], false, false).map((t) => t.id)).toEqual(["leer"]);
  });

  it("en una acción viajan todas", () => {
    expect(candidatasPorRiesgo([leer, borrar], true, false).map((t) => t.id)).toEqual(["leer", "borrar"]);
  });

  it("una sin `risk` en un catálogo tipado se trata como el selector: no es de lectura", () => {
    expect(candidatasPorRiesgo([leer, sinRiesgo], false, false).map((t) => t.id)).toEqual(["leer"]);
  });

  it("con un catálogo sin tipar (MCP) o con el router apagado, viajan todas", () => {
    expect(candidatasPorRiesgo([mcp("a"), mcp("b")], false, false)).toHaveLength(2);
    expect(candidatasPorRiesgo([leer, borrar], false, true)).toHaveLength(2);
  });
});

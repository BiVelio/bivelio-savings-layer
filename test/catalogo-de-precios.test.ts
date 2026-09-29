import { describe, it, expect } from "vitest";

import { CATALOGO, claveDeCatalogo, precioDeLista, PRECIOS_AL_DIA } from "../src/pricing/catalogo.js";

/**
 * EL CATÁLOGO DE PRECIOS DE LISTA.
 *
 * POR QUÉ EXISTE. Este producto vende "ahorro que puedes contrastar con tu
 * factura", y hasta ahora había UN precio ilustrativo para todos los modelos: de
 * fábrica, ninguna cifra en dólares se correspondía con ninguna factura.
 *
 * ⚠️ EL RIESGO DE ESTE FICHERO ES EL OPUESTO AL DE NO TENERLO. Un modelo AUSENTE
 * cae en el ilustrativo Y AVISA, así que el cliente sabe que esa columna no vale.
 * Un modelo PRESENTE con el precio mal calla el aviso y entrega una cifra
 * confiada y falsa — el fallo exacto que este producto existe para no cometer.
 *
 * De ahí que estos tests vigilen sobre todo que NO se cuele lo que no toca.
 */

describe("el lookup", () => {
  it("encuentra por id exacto", () => {
    expect(precioDeLista("gpt-4o-mini")).toEqual(CATALOGO["gpt-4o-mini"]);
  });

  it("encuentra con prefijo de proveedor, que es como lo pide el contrato", () => {
    // El SDK documenta ids cualificados (`openai/gpt-4o-mini`), pero la tabla de
    // precios del proveedor usa el nombre desnudo. Los dos tienen que funcionar.
    expect(precioDeLista("openai/gpt-4o-mini")).toEqual(CATALOGO["gpt-4o-mini"]);
    expect(precioDeLista("anthropic/claude-haiku-4-5")).toEqual(CATALOGO["claude-haiku-4-5"]);
    // Con la fecha del catálogo: desde el 2027-01-01 rige su tramo anunciado
    // (test/vigencia-de-precios.test.ts).
    expect(precioDeLista("google/gemini-3.7-flash", Date.parse(`${PRECIOS_AL_DIA}T12:00:00Z`))).toEqual(CATALOGO["gemini-3.7-flash"]);
  });

  it("una instantánea fechada hereda el precio de su familia", () => {
    // Enumerar cada fecha sería una lista que envejece sola.
    expect(precioDeLista("gpt-4o-2024-08-06")).toEqual(CATALOGO["gpt-4o"]);
    expect(precioDeLista("claude-haiku-4-5-20251001")).toEqual(CATALOGO["claude-haiku-4-5"]);
    expect(precioDeLista("claude-sonnet-4-5-20250929")).toEqual(CATALOGO["claude-sonnet-4"]);
    expect(precioDeLista("gemini-3.5-flash-preview-0715")).toEqual(CATALOGO["gemini-3.5-flash"]);
  });

  it("`claude-opus-4` no se traga a la generación 4.5+, que cuesta un TERCIO", () => {
    // La herencia por prefijo aquí es una mentira de 3x: toda la generación
    // opus-4-5…opus-5 factura $5/$25 y el prefijo `claude-opus-4` la tarifaría
    // a $15/$75 — justo en el tráfico que un gateway `bvsala claude` mide.
    for (const m of ["claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]) {
      expect(precioDeLista(m), m).toEqual(CATALOGO[m]);
      expect(precioDeLista(m), m).not.toEqual(CATALOGO["claude-opus-4"]);
    }
    // Y la instantánea fechada hereda de SU versión, no de la vieja.
    expect(precioDeLista("claude-opus-4-8-20260115")).toEqual(CATALOGO["claude-opus-4-8"]);
    expect(precioDeLista("anthropic/claude-opus-5")).toEqual(CATALOGO["claude-opus-5"]);
  });

  it("las versiones menores de gpt-5 no se heredan entre sí: el precio SE MUEVE", () => {
    // `.` cuenta como separador, así que sin entrada propia `gpt-5.2` heredaría
    // el precio de `gpt-5` — y cuesta un 40% más. Cada 5.x visible va explícito.
    expect(precioDeLista("gpt-5.2")).toEqual(CATALOGO["gpt-5.2"]);
    expect(precioDeLista("gpt-5.2")).not.toEqual(CATALOGO["gpt-5"]);
    expect(precioDeLista("gpt-5.4")).not.toEqual(CATALOGO["gpt-5"]);
    // Los ids que usa Codex hoy resuelven a su entrada exacta.
    expect(precioDeLista("openai/gpt-5.3-codex")).toEqual(CATALOGO["gpt-5.3-codex"]);
    expect(precioDeLista("gpt-5.1-codex-mini")).toEqual(CATALOGO["gpt-5.1-codex-mini"]);
  });

  it("`gemini-3.5-flash` no se traga a `gemini-3.5-flash-lite`, que cuesta cinco veces menos", () => {
    // Mismo peligro que gpt-4/gpt-4o: la clave corta es prefijo de la larga y
    // solo el orden por longitud impide tarifar el lite a precio del grande.
    expect(precioDeLista("gemini-3.5-flash-lite")).toEqual(CATALOGO["gemini-3.5-flash-lite"]);
    expect(precioDeLista("gemini-3.5-flash-lite")).not.toEqual(CATALOGO["gemini-3.5-flash"]);
  });

  it("`gpt-4` no se traga a `gpt-4o`, que cuesta doce veces menos", () => {
    // Aquí lo que protege es el ORDEN por longitud —`gpt-4o` se prueba antes que
    // `gpt-4`— no la guarda de separador. Se deja escrito porque es el caso que
    // más caro sale si alguien reordena esa lista: 0,03/1K en vez de 0,0025.
    expect(precioDeLista("gpt-4o")).toEqual(CATALOGO["gpt-4o"]);
    expect(precioDeLista("gpt-4o")).not.toEqual(CATALOGO["gpt-4"]);
    expect(precioDeLista("gpt-4o-mini")).not.toEqual(CATALOGO["gpt-4"]);
    expect(precioDeLista("gpt-4-turbo")).toEqual(CATALOGO["gpt-4-turbo"]);
  });

  it("⛔ un nombre que SIGUE con letras no hereda: exige separador", () => {
    // Esto sí es la guarda, y una mutación demostró que el test anterior NO la
    // probaba: con `startsWith` a secas, un modelo futuro llamado `gpt-4omni` o
    // `claude-haiku-4-5x` heredaría el precio de otra familia en silencio. El
    // catálogo tiene que decir "no lo conozco" y dejar que salte el aviso.
    for (const m of ["gpt-4omni", "gpt-4oX", "claude-haiku-4-5x", "gpt-4turbo"]) {
      expect(precioDeLista(m), m).toBeUndefined();
    }
    // Y con separador sí hereda, que es para lo que existe.
    expect(precioDeLista("gpt-4o-2024-08-06")).toEqual(CATALOGO["gpt-4o"]);
  });

  it("⛔ un modelo desconocido devuelve undefined, NO un precio inventado", () => {
    // Devolver algo aquí callaría el aviso del pipeline, que es la única señal
    // que tiene el cliente de que esa columna no es su factura.
    for (const m of ["modelo-que-no-existe", "llama-3", "gemini-2.0-flash", "", "gpt", "claude"]) {
      expect(precioDeLista(m)).toBeUndefined();
    }
  });
});

describe("la forma del catálogo", () => {
  it("todo precio es positivo y la salida cuesta más que la entrada", () => {
    // No es una ley física, pero se cumple en todos los proveedores que cubrimos,
    // y un valor invertido es el síntoma de haber copiado mal la columna.
    for (const [modelo, p] of Object.entries(CATALOGO)) {
      expect(p.inputPer1k, modelo).toBeGreaterThan(0);
      expect(p.outputPer1k, modelo).toBeGreaterThan(0);
      expect(p.outputPer1k, modelo).toBeGreaterThan(p.inputPer1k);
    }
  });

  it("⛔ la entrada cacheada siempre es MÁS BARATA que la normal", () => {
    // Si fuera al revés, el "ahorro" por caché del proveedor saldría negativo y
    // el panel enseñaría una pérdida donde hubo un ahorro.
    for (const [modelo, p] of Object.entries(CATALOGO)) {
      if (p.cachedInputPer1k === undefined) continue;
      expect(p.cachedInputPer1k, modelo).toBeLessThan(p.inputPer1k);
      expect(p.cachedInputPer1k, modelo).toBeGreaterThan(0);
    }
  });

  it("⛔ ningún precio tiene pinta de estar en dólares por MILLÓN", () => {
    // El error de copia más fácil: las tarifas se publican por millón y el
    // `CostModel` es por mil. Un factor 1000 de más pasa desapercibido en una
    // revisión y multiplica por mil el ahorro anunciado.
    for (const [modelo, p] of Object.entries(CATALOGO)) {
      expect(p.inputPer1k, `${modelo}: ¿por millón en vez de por mil?`).toBeLessThan(1);
      expect(p.outputPer1k, `${modelo}: ¿por millón en vez de por mil?`).toBeLessThan(1);
    }
  });

  it("cubre las familias que de verdad se usan", () => {
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "claude-sonnet-4", "claude-haiku-4-5"]) {
      expect(CATALOGO[m], m).toBeTruthy();
    }
  });

  it("las filas nuevas del 2026-09-27, con las cifras de las páginas OFICIALES (USD por 1M → por 1K)", () => {
    // Anthropic (platform.claude.com/docs/en/about-claude/pricing): Opus 5.5
    // $4 / $0.20 / $20 — la lectura a 0,05×, ni el 10% de la casa ni el 0,025× de Fable 5.1.
    expect(CATALOGO["claude-opus-5-5"]).toEqual({ inputPer1k: 0.004, outputPer1k: 0.02, cachedInputPer1k: 0.0002 });
    expect(CATALOGO["claude-opus-5-5"]!.cachedInputPer1k! / CATALOGO["claude-opus-5-5"]!.inputPer1k).toBeCloseTo(0.05, 12);
    // OpenAI (developers.openai.com/api/docs/pricing, «Standard», contexto corto).
    expect(CATALOGO["gpt-6-astra"]).toEqual({ inputPer1k: 0.01, outputPer1k: 0.05, cachedInputPer1k: 0.001 });
    expect(CATALOGO["gpt-6-sol"]).toEqual({ inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 });
    expect(CATALOGO["gpt-6-luna"]).toEqual({ inputPer1k: 0.0001, outputPer1k: 0.0005, cachedInputPer1k: 0.00001 });
    // Google (ai.google.dev/gemini-api/docs/pricing, tier de pago, texto).
    expect(CATALOGO["gemini-3.8-flash"]).toEqual({ inputPer1k: 0.00075, outputPer1k: 0.00375, cachedInputPer1k: 0.000075 });
    expect(CATALOGO["gemini-3.6-flash"]).toEqual(CATALOGO["gemini-3.8-flash"]);
    expect(CATALOGO["gemini-3.1-flash-lite"]).toEqual({ inputPer1k: 0.00025, outputPer1k: 0.0015, cachedInputPer1k: 0.000025 });
    expect(CATALOGO["gemini-3-flash-preview"]).toEqual({ inputPer1k: 0.0005, outputPer1k: 0.003, cachedInputPer1k: 0.00005 });
  });

  it("Sonnet 5.5 (2026-09-29), con las cifras de la página OFICIAL: $2 / $0.20 / $10, la lista de Sonnet 5", () => {
    // platform.claude.com/docs/en/about-claude/pricing: «Claude Sonnet 5.5 |
    // $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok».
    expect(CATALOGO["claude-sonnet-5-5"]).toEqual({ inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 });
    expect(CATALOGO["claude-sonnet-5-5"]!.cachedInputPer1k! / CATALOGO["claude-sonnet-5-5"]!.inputPer1k).toBeCloseTo(0.1, 12);
    // Su propia clave, no la de Sonnet 5 por herencia (hoy cuestan lo mismo;
    // el día que no, la herencia mentiría en silencio).
    expect(claveDeCatalogo("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(claveDeCatalogo("anthropic/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(claveDeCatalogo("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("⛔ la versión menor no hereda: Opus 5.5 no es Opus 5, ni gpt-6-luna es gpt-5.6-luna", () => {
    expect(precioDeLista("claude-opus-5-5")).not.toEqual(CATALOGO["claude-opus-5"]);
    expect(claveDeCatalogo("claude-opus-5-5-20260901")).toBe("claude-opus-5-5");
    expect(claveDeCatalogo("anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(claveDeCatalogo("gpt-6-luna")).toBe("gpt-6-luna");
    // Una gpt-6 que no está en la tabla no hereda de nadie: sin fila, avisa.
    expect(precioDeLista("gpt-6-pro")).toBeUndefined();
    expect(precioDeLista("gpt-6")).toBeUndefined();
  });

  it("la generación 5.1 de Fable/Mythos lee la caché a 0.025x, no al 10%", () => {
    // La excepción oficial de Anthropic (2026-09-06): $0.25/MTok de lectura con
    // entrada a $10. Si alguien «normaliza» estas filas al 10% de la casa, la
    // lectura —la masa mayor del tráfico de terminales— se mide 4x más cara.
    for (const m of ["claude-fable-5-1", "claude-mythos-5-1"]) {
      expect(CATALOGO[m]?.cachedInputPer1k, m).toBe(0.00025);
      expect(CATALOGO[m]?.inputPer1k, m).toBe(0.01);
    }
    // Y la generación 5 sin punto sigue al 10%: la excepción es SOLO de la 5.1.
    expect(CATALOGO["claude-fable-5"]!.cachedInputPer1k).toBe(0.001);
    expect(CATALOGO["claude-mythos-5"]!.cachedInputPer1k).toBe(0.001);
  });

  it("la serie o: las cifras de la tabla Standard oficial de OpenAI (2026-09-25), y solo las que caben en las verjas", () => {
    // USD por 1M en la página → por 1K aquí. o3-pro NO publica lectura de caché:
    // el campo se omite (sus tokens cacheados se tarifan a entrada).
    expect(CATALOGO["o3"]).toEqual({ inputPer1k: 0.002, outputPer1k: 0.008, cachedInputPer1k: 0.0005 });
    expect(CATALOGO["o3-mini"]).toEqual({ inputPer1k: 0.0011, outputPer1k: 0.0044, cachedInputPer1k: 0.00055 });
    expect(CATALOGO["o4-mini"]).toEqual({ inputPer1k: 0.0011, outputPer1k: 0.0044, cachedInputPer1k: 0.000275 });
    expect(CATALOGO["o3-pro"]).toEqual({ inputPer1k: 0.02, outputPer1k: 0.08 });
    // Las instantáneas con fecha heredan de SU fila (o3-mini, no o3).
    expect(precioDeLista("o3-mini-2025-01-31")).toEqual(CATALOGO["o3-mini"]);
    expect(precioDeLista("o3-2025-04-16")).toEqual(CATALOGO["o3"]);
    expect(precioDeLista("o3-pro-2025-06-10")).toEqual(CATALOGO["o3-pro"]);
    // Fuera a propósito (ver el comentario del catálogo): o1 y o1-pro no caben
    // en los techos del ingest, y o1-mini ya no tiene fuente. Sin clave `o1`
    // ninguno puede heredar nada.
    for (const m of ["o1", "o1-2024-12-17", "o1-mini", "o1-pro", "openai/o1"]) {
      expect(precioDeLista(m), m).toBeUndefined();
    }
  });

  it("⛔ un id con fila VETADA no hereda la de su pariente: deep-research no es o3 a otro nombre", () => {
    // Sin el veto, `o3-deep-research` heredaría la fila de `o3` (un sufijo de
    // letra es «alias» para el emparejador) y se tarifaría a un quinto de lo
    // que factura, con el aviso de «sin precio» callado.
    for (const m of ["o3-deep-research", "o3-deep-research-2025-06-26", "openai/o3-deep-research", "o4-mini-deep-research"]) {
      expect(precioDeLista(m), m).toBeUndefined();
      expect(claveDeCatalogo(m), m).toBeUndefined();
    }
    // Y el veto no toca a nadie más.
    expect(precioDeLista("o3")).toEqual(CATALOGO["o3"]);
    expect(precioDeLista("o4-mini-2025-04-16")).toEqual(CATALOGO["o4-mini"]);
  });

  it("⛔ otra MODALIDAD de Gemini no hereda la fila de texto de su pariente (TTS e imagen, página oficial del 2026-09-27)", () => {
    // Las filas de gemini-3.8-flash y gemini-3.1-flash-lite (2026-09-27) harían
    // que estos ids heredaran por sufijo de letra un precio de TEXTO que no es el
    // suyo. La página oficial (https://ai.google.dev/gemini-api/docs/pricing)
    // publica: 3.8 Flash TTS $0.50 / $9.00 audio / $0.125; 3.8 Flash-Lite TTS
    // $0.50 / $6.00 audio / $0.125; 3.1 Flash Lite Image $30 por 1M de salida de
    // imagen. Sin precio propio: `undefined`, que avisa, en cualquier fecha.
    const AL_DIA = Date.parse(`${PRECIOS_AL_DIA}T12:00:00Z`);
    const ENE_2027 = Date.parse("2027-01-01T12:00:00Z");
    for (const m of [
      "gemini-3.8-flash-tts",
      "google/gemini-3.8-flash-tts",
      "gemini-3.8-flash-tts-preview",
      "gemini-3.8-flash-lite-tts",
      "gemini-3.1-flash-lite-image",
      "gemini-3.1-flash-lite-image-preview",
    ]) {
      expect(precioDeLista(m), m).toBeUndefined();
      expect(precioDeLista(m, AL_DIA), m).toBeUndefined();
      expect(precioDeLista(m, ENE_2027), m).toBeUndefined();
      expect(claveDeCatalogo(m), m).toBeUndefined();
    }
    // El alias legítimo del MISMO modelo sigue heredando, y los parientes siguen
    // en su fila.
    expect(claveDeCatalogo("gemini-3.1-flash-lite-preview")).toBe("gemini-3.1-flash-lite");
    expect(precioDeLista("gemini-3.1-flash-lite-preview", AL_DIA)).toBe(CATALOGO["gemini-3.1-flash-lite"]);
    expect(precioDeLista("gemini-3.1-flash-lite", AL_DIA)).toBe(CATALOGO["gemini-3.1-flash-lite"]);
    expect(precioDeLista("gemini-3.8-flash", AL_DIA)).toBe(CATALOGO["gemini-3.8-flash"]);
    expect(precioDeLista("google/gemini-3.8-flash-latest", AL_DIA)).toBe(CATALOGO["gemini-3.8-flash"]);
  });

  it("⛔ los pro y cyber de OpenAI no heredan la fila base: la página oficial les publica otro precio", () => {
    // https://developers.openai.com/api/docs/pricing (2026-09-27): gpt-5.5-pro y
    // gpt-5.4-pro $30 / $180, gpt-5.2-pro $21 / $168, gpt-5-pro $15 / $120,
    // gpt-5.5-cyber y gpt-5.6-cyber $12.50 / $75. Heredando, gpt-5.5-pro salía a
    // $5 / $30: seis veces por debajo de la factura.
    for (const m of [
      "gpt-5.5-pro",
      "openai/gpt-5.5-pro",
      "gpt-5.4-pro",
      "gpt-5.2-pro",
      "gpt-5-pro",
      "gpt-5-pro-2025-10-06",
      "gpt-5.5-cyber",
      "gpt-5.6-cyber",
    ]) {
      expect(precioDeLista(m), m).toBeUndefined();
      expect(claveDeCatalogo(m), m).toBeUndefined();
    }
    for (const base of ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5"]) {
      expect(precioDeLista(base), base).toBe(CATALOGO[base]);
    }
    expect(precioDeLista("gpt-5-2025-08-07")).toBe(CATALOGO["gpt-5"]);
  });

  it("deja por escrito de cuándo son los precios", () => {
    // Sin fecha, dentro de un año nadie sabe si revisarlos o fiarse.
    expect(PRECIOS_AL_DIA).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("las claves no llevan prefijo de proveedor", () => {
    // El lookup ya lo quita; tenerlo aquí duplicaría entradas y rompería el
    // emparejamiento por familia.
    for (const k of Object.keys(CATALOGO)) expect(k).not.toContain("/");
  });
});

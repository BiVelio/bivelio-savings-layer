import { describe, it, expect } from "vitest";

import { costeMedido, informeMedido } from "../gateway/medidor.js";
import {
  ahorroDeRebaja,
  decidirRebaja,
  fraccionNueva,
  huellaDe,
  MemoriaDePrefijos,
  parsearMensajes,
  PRIMA_1H,
  PRIMA_5M,
  rebajarTtlDeCache,
  UMBRAL_REESCRITURA,
} from "../gateway/tarifa.js";

/**
 * LA PALANCA DE TARIFA — la que ahorra dinero sin tocar un token.
 *
 * Se prueban las tres piezas por separado (rebaja del cuerpo, decisión por
 * ritmo, aritmética del ahorro) y luego el nudo que de verdad importa: que el
 * informe medido deje de escribir un 0 € estructural cuando la palanca actuó,
 * y que lo siga escribiendo cuando no.
 */

const cuerpoDe = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

const PETICION = {
  model: "claude-opus-5",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hola", cache_control: { type: "ephemeral", ttl: "1h" } }],
    },
  ],
  system: [{ type: "text", text: "sistema", cache_control: { type: "ephemeral", ttl: "1h" } }],
  tools: [{ name: "leer", cache_control: { type: "ephemeral", ttl: "1h" } }],
};

describe("rebajarTtlDeCache", () => {
  it("reescribe a 5m todas las marcas de 1h — system, messages y tools", () => {
    const r = rebajarTtlDeCache(cuerpoDe(PETICION));
    expect(r).not.toBeNull();
    expect(r?.rebajadas).toBe(3);
    expect(r?.yaEran5m).toBe(0);
    const salida = JSON.parse(r!.cuerpo.toString("utf8"));
    expect(JSON.stringify(salida)).not.toContain('"1h"');
    expect(JSON.stringify(salida).match(/"ttl":"5m"/g)).toHaveLength(3);
  });

  it("NO toca un solo token del contenido: solo cambia el ttl", () => {
    const r = rebajarTtlDeCache(cuerpoDe(PETICION));
    const salida = JSON.parse(r!.cuerpo.toString("utf8"));
    const sinTtl = (o: unknown): unknown => JSON.parse(JSON.stringify(o).replace(/"ttl":"[^"]*"/g, '"ttl":"X"'));
    expect(sinTtl(salida)).toEqual(sinTtl(PETICION));
  });

  it("devuelve null —reenviar intacto— si no hay ni una marca de 1h", () => {
    expect(rebajarTtlDeCache(cuerpoDe({ model: "claude-opus-5", messages: [{ role: "user", content: "x" }] }))).toBeNull();
  });

  it("devuelve null ante cuerpo comprimido, JSON roto o forma que no es /v1/messages", () => {
    expect(rebajarTtlDeCache(cuerpoDe(PETICION), "zstd")).toBeNull();
    expect(rebajarTtlDeCache(Buffer.from("{no json", "utf8"))).toBeNull();
    expect(rebajarTtlDeCache(cuerpoDe({ model: "claude-opus-5" }))).toBeNull();
    expect(rebajarTtlDeCache(cuerpoDe([1, 2, 3]))).toBeNull();
  });

  it("cuenta como 5m preexistente tanto el ttl explícito como el ausente (defecto de la API)", () => {
    const mixto = {
      model: "claude-opus-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } }] },
        { role: "user", content: [{ type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "5m" } }] },
        { role: "user", content: [{ type: "text", text: "c", cache_control: { type: "ephemeral" } }] },
      ],
    };
    const r = rebajarTtlDeCache(cuerpoDe(mixto));
    expect(r?.rebajadas).toBe(1);
    expect(r?.yaEran5m).toBe(2);
  });
});

describe("la decisión mira el PREFIJO, no el reloj", () => {
  const MARCA = { cache_control: { type: "ephemeral", ttl: "1h" } };
  const sistema = [{ type: "text", text: "sistema ".repeat(2_000), ...MARCA }];
  const tools = [{ name: "leer", description: "d ".repeat(4_000) }];
  const msg = (role: string, text: string, marca = false) => ({
    role,
    content: [{ type: "text", text, ...(marca ? MARCA : {}) }],
  });
  const cuerpo = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
    model: "claude-opus-5",
    system: sistema,
    tools,
    messages,
    ...extra,
  });
  const gordo = "x".repeat(40_000);
  // Diez turnos ya cacheados: el prefijo de un hilo a media sesión.
  const historial: unknown[] = [];
  for (let i = 0; i < 10; i++) historial.push(msg("user", gordo + i), msg("assistant", gordo + "r" + i));
  const anterior = huellaDe(cuerpo([...historial, msg("user", "última pregunta", true)]));

  it("sin turno anterior: todo es nuevo → arranque en frío → rebaja", () => {
    expect(fraccionNueva(undefined, anterior)).toBe(1);
    expect(decidirRebaja({ fraccionNueva: 1 })).toBe(true);
  });

  it("turno encadenado: solo el delta es nuevo, muy por debajo del umbral → NO rebaja", () => {
    const actual = huellaDe(
      cuerpo([...historial, msg("user", "última pregunta"), msg("assistant", "respuesta"), msg("user", "siguiente", true)]),
    );
    const f = fraccionNueva(anterior, actual);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(0.02);
    expect(decidirRebaja({ fraccionNueva: f })).toBe(false);
  });

  it("la marca de caché que se mueve de mensaje NO rompe el prefijo", () => {
    // Mismo historial, la marca pasa del mensaje 20 al 22: el hash sin marcas
    // es idéntico, así que solo cuentan como nuevos los dos mensajes de cola.
    const conMarcaMovida = huellaDe(
      cuerpo([...historial, msg("user", "última pregunta"), msg("assistant", "r"), msg("user", "s", true)]),
    );
    const sinMarcaMovida = huellaDe(
      cuerpo([...historial, msg("user", "última pregunta", true), msg("assistant", "r"), msg("user", "s")]),
    );
    expect(fraccionNueva(anterior, conMarcaMovida)).toBeCloseTo(fraccionNueva(anterior, sinMarcaMovida), 12);
  });

  it("compactación / historial reescrito: la mayor parte es nueva → rebaja", () => {
    const compactado = huellaDe(cuerpo([msg("user", "resumen de lo anterior " + gordo), msg("user", "sigue", true)]));
    const f = fraccionNueva(anterior, compactado);
    expect(f).toBeGreaterThan(UMBRAL_REESCRITURA);
    expect(decidirRebaja({ fraccionNueva: f })).toBe(true);
  });

  it("cambio de system o de tools: el prefijo se rompe en el primer byte → todo nuevo", () => {
    const otroSystem = huellaDe(cuerpo(anterior === undefined ? [] : [...historial], { system: "otro" }));
    expect(fraccionNueva(anterior, otroSystem)).toBe(1);
    const otrasTools = huellaDe(cuerpo([...historial], { tools: [{ name: "escribir" }] }));
    expect(fraccionNueva(anterior, otrasTools)).toBe(1);
  });

  it("el umbral tiene margen: el equilibrio con un 2 % de fallos está en el 3 % del cuerpo", () => {
    // Ganancia por rebajar = fracción escrita × 0,75; pérdida esperada = p(fallo)
    // × fracción leída × 1,15. Un turno encadenado (2 % nuevo) pierde; una
    // escritura del 30 % gana con holgura incluso con un 20 % de fallos.
    const esperanza = (f: number, p: number) => f * (PRIMA_1H - PRIMA_5M) - p * (1 - f) * (PRIMA_5M - 0.1);
    expect(esperanza(0.02, 0.02)).toBeLessThan(0);
    expect(esperanza(UMBRAL_REESCRITURA, 0.02)).toBeGreaterThan(0);
    expect(esperanza(UMBRAL_REESCRITURA, 0.2)).toBeGreaterThan(0);
    expect(decidirRebaja({ fraccionNueva: 0.02 })).toBe(false);
    expect(decidirRebaja({ fraccionNueva: UMBRAL_REESCRITURA })).toBe(true);
  });

  it("parsearMensajes devuelve null ante comprimido, JSON roto o forma ajena", () => {
    expect(parsearMensajes(cuerpoDe(PETICION), "gzip")).toBeNull();
    expect(parsearMensajes(Buffer.from("{no", "utf8"))).toBeNull();
    expect(parsearMensajes(cuerpoDe({ model: "m" }))).toBeNull();
    expect(parsearMensajes(cuerpoDe(PETICION))).not.toBeNull();
  });
});

describe("ahorroDeRebaja", () => {
  it("es la resta entre dos tarifas públicas sobre el MISMO conteo", () => {
    // 100.000 tokens de escritura a $0,005/1k de entrada: 2× = $1,00 · 1,25× = $0,625.
    const ahorro = ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0.005, yaEran5m: 0, herramientaDeServidor: false });
    expect(ahorro).toBeCloseTo(100 * 0.005 * (PRIMA_1H - PRIMA_5M), 10);
    expect(ahorro).toBeCloseTo(0.375, 10);
  });

  it("declara 0 —y no miente— si el cliente ya traía marcas de 5m propias", () => {
    expect(ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0.005, yaEran5m: 1, herramientaDeServidor: false })).toBe(0);
  });

  it("declara 0 si la petición declaraba herramientas de servidor: la API escribe su resultado a 5 min por su cuenta", () => {
    expect(ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0.005, yaEran5m: 0, herramientaDeServidor: true })).toBe(0);
  });

  it("declara 0 sin escritura o sin precio", () => {
    expect(ahorroDeRebaja({ cacheEscrita5m: 0, inputPer1k: 0.005, yaEran5m: 0, herramientaDeServidor: false })).toBe(0);
    expect(ahorroDeRebaja({ cacheEscrita5m: 100_000, inputPer1k: 0, yaEran5m: 0, herramientaDeServidor: false })).toBe(0);
  });
});

describe("MemoriaDePrefijos", () => {
  const h = huellaDe({ model: "m", messages: [{ role: "user", content: "hola" }] });
  it("recuerda la última huella y olvida lo que ya caducó (una hora: la caché también)", () => {
    const m = new MemoriaDePrefijos(3, 60_000);
    m.anotar("a", h, 1_000);
    expect(m.ultima("a", 2_000)).toBe(h);
    expect(m.ultima("a", 1_000 + 60_001)).toBeUndefined();
    expect(m.ultima("desconocida", 2_000)).toBeUndefined();
  });

  it("está ACOTADA: un gateway de escritorio no crece sin techo", () => {
    const m = new MemoriaDePrefijos(3, 60_000);
    for (const k of ["a", "b", "c", "d", "e"]) m.anotar(k, h, 1_000);
    expect(m.tamano).toBe(3);
    expect(m.ultima("a", 1_000)).toBeUndefined();
    expect(m.ultima("e", 1_000)).toBe(h);
  });
});

describe("el 0 € estructural del informe medido", () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200_000,
    cache_creation_input_tokens: 100_000,
  };

  it("SIN palanca sigue escribiendo baseline == actual y netSavings 0", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-1", "claude-opus-5", medido!) as unknown as {
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.netSavings).toBe(0);
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
  });

  it("CON palanca el baseline es el mismo usage a la tarifa que el cliente pidió", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-2", "claude-opus-5", medido!, undefined, null, {
      rebajadas: 3,
      yaEran5m: 0,
      herramientaDeServidor: false,
    }) as unknown as {
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    // 100.000 tokens escritos a 1,25× en vez de 2×: $0,375 de sobrecoste evitado.
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.baselineEstimate - inf.cost.actual).toBeCloseTo(0.375, 9);
    expect(inf.cost.netSavings).toBeGreaterThan(0);
    expect(inf.cost.netSavings).toBeLessThanOrEqual(1);
    expect(inf.cost.netSavings).toBeCloseTo(0.375 / inf.cost.baselineEstimate, 9);
  });

  it("tráfico de SUSCRIPCIÓN con la rebaja aplicada: baseline == actual y netSavings 0 (sin factura por tokens no se acredita)", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-s", "claude-opus-5", medido!, undefined, null, { rebajadas: 1, yaEran5m: 0, herramientaDeServidor: false }, null, true) as unknown as {
      cost: { baselineEstimate: number; actual: number; netSavings: number; basis: string };
    };
    expect(inf.cost.basis).toBe("measured");
    expect(inf.cost.netSavings).toBe(0);
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
  });

  it("con atribución sucia (marcas 5m del cliente) NO se cobra nada", () => {
    const medido = costeMedido("claude-opus-5", usage);
    const inf = informeMedido("req-3", "claude-opus-5", medido!, undefined, null, {
      rebajadas: 1,
      yaEran5m: 2,
      herramientaDeServidor: false,
    }) as unknown as { cost: { netSavings: number; baselineEstimate: number; actual: number } };
    expect(inf.cost.netSavings).toBe(0);
    expect(inf.cost.baselineEstimate).toBe(inf.cost.actual);
  });
});

describe("la costura entre las dos palancas", () => {
  it("componen sin pisarse: los diales añaden context_management, la tarifa rebaja el ttl", async () => {
    const { ajustarDiales } = await import("../gateway/palanca.js");
    const original = cuerpoDe(PETICION);
    const conDiales = ajustarDiales(original, undefined);
    expect(conDiales).not.toBeNull();
    // El cuerpo que sale de los diales es JSON plano: la codificación original
    // dejó de describirlo, por eso el servidor pasa "identity" a partir de aquí.
    const conAmbas = rebajarTtlDeCache(conDiales!.cuerpo, "identity");
    expect(conAmbas).not.toBeNull();
    const salida = JSON.parse(conAmbas!.cuerpo.toString("utf8"));
    expect(salida.context_management).toBeDefined();
    expect(JSON.stringify(salida)).not.toContain('"1h"');
    expect(conAmbas!.rebajadas).toBe(3);
  });

  it("la rebaja NO toca el cuerpo si llega comprimido — reenviar intacto manda", () => {
    expect(rebajarTtlDeCache(cuerpoDe(PETICION), "gzip")).toBeNull();
  });
});

describe("herramientas diferidas (búsqueda de herramientas de Claude Code)", () => {
  const base = { name: "Bash", description: "shell", input_schema: { type: "object", properties: {} } };
  // Prefijo realista: en una sesión de Claude Code el historial pesa decenas de KB;
  // el tool_result que trae la herramienta diferida es una fracción mínima.
  const mensajes = [
    { role: "user", content: [{ type: "text", text: "lee example.com ".repeat(2_000) }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "select:WebFetch" } }] },
  ];
  const antes = huellaDe({ model: "m", tools: [base], messages: mensajes });

  it("una herramienta con defer_loading:true añadida a tools NO rompe el prefijo", () => {
    const diferida = { name: "WebFetch", description: "fetch", input_schema: { type: "object", properties: {} }, defer_loading: true };
    const despues = huellaDe({
      model: "m",
      tools: [base, diferida],
      messages: [...mensajes, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "WebFetch" }] }] }],
    });
    expect(despues.tools).toBe(antes.tools);
    const f = fraccionNueva(antes, despues);
    expect(f).toBeGreaterThan(0);
    expect(f).toBeLessThan(0.5); // solo el mensaje nuevo es nuevo
    expect(decidirRebaja({ fraccionNueva: f })).toBe(false);
  });

  it("una herramienta NO diferida añadida a tools sí rompe el prefijo (como hasta ahora)", () => {
    const normal = { name: "WebFetch", description: "fetch", input_schema: { type: "object", properties: {} } };
    const despues = huellaDe({ model: "m", tools: [base, normal], messages: mensajes });
    expect(despues.tools).not.toBe(antes.tools);
    expect(fraccionNueva(antes, despues)).toBe(1);
  });
});
